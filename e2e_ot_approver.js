// e2e：月度 OT 夜急單津貼「批准人」欄位 + 入頁自動計算（2026-09-24）
// 規則：批准決定存 night_job_approvals.json（by_name/at），monthly-ot items 同 Excel 匯出要帶「批准人／批准日期」。
// 本地檔案模式，port 3022，跑完還原 data/worktime.json + data/night_job_approvals.json
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, 'node_modules', 'xlsx'));

const DIR = __dirname;
const NODE = process.execPath;
const PORT = 3022;
const BASE = 'http://127.0.0.1:' + PORT;
const j = s => { try { return JSON.parse(s); } catch { return null; } };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' | got: ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

function hkDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = n => String(n).padStart(2, '0');
  const hk = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return `${hk.getFullYear()}-${p(hk.getMonth() + 1)}-${p(hk.getDate())}`;
}

async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  return { code: r.status, cookie: sc ? sc.split(';')[0] : null, body: await r.text() };
}

function waitServer(tries) {
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) { clearInterval(t); resolve(); }
      } catch (e) {}
      if (--tries <= 0) { clearInterval(t); reject(new Error('server not up')); }
    }, 500);
  });
}

(async () => {
  const wtPath = path.join(DIR, 'data', 'worktime.json');
  const naPath = path.join(DIR, 'data', 'night_job_approvals.json');
  const wtBackup = fs.existsSync(wtPath) ? fs.readFileSync(wtPath) : null;
  const naBackup = fs.existsSync(naPath) ? fs.readFileSync(naPath) : null;

  const emps = j(fs.readFileSync(path.join(DIR, 'data', 'employees.json'), 'utf8')) || [];
  const bcryptjs = require(path.join(DIR, 'node_modules', 'bcryptjs'));
  const A = emps.find(e => e.password_hash && bcryptjs.compareSync('0000', e.password_hash));
  check('搵到 pw=0000 員工', !!A);

  const child = spawn(NODE, ['server.js'], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  child.stdout.on('data', d => process.stderr.write('[out] ' + d));
  try {
    await waitServer(40);
    console.log('server up on ' + PORT);

    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    const ac = al.cookie;
    check('admin login', al.code === 200 && !!ac, al.body.slice(0, 100));
    const el = await req('POST', '/api/auth/employee-login', { empNumber: A.emp_number, password: '0000' });
    const ec = el.cookie;
    check('employee login ' + A.emp_number, el.code === 200 && !!ec, el.body.slice(0, 100));

    // 揀一個平日
    let weekday = null;
    for (let i = 0; i <= 6; i++) {
      const d = hkDate(-i);
      if (new Date(d + 'T00:00:00+08:00').getDay() !== 0) { weekday = d; break; }
    }
    console.log('平日=' + weekday);
    const month = weekday.slice(0, 7);

    // 1) ST037 交一條含夜急單嘅記錄
    const s1 = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', schedule_in: '10:00', actual_in: '10:00', off_time: '23:00',
      remark: 'e2e ot-approver', ignore_conflict: true,
      jobs: [{ client_no: 'E2E-APPR-1', start: '22:00', end: '22:30', types: ['其他'], remarks: '', no_sync: false, night_allowance: true }],
      members: [{ emp_id: A.id }]
    }, ec);
    check('提交夜急單記錄', s1.code === 200, s1.body.slice(0, 200));

    // 2) admin 批准
    const d1 = await req('POST', '/api/admin/worktime/night-jobs/decide', { date: weekday, client_no: 'E2E-APPR-1', action: 'approve' }, ac);
    check('admin 批准', d1.code === 200 && j(d1.body).status === 'approved', d1.body.slice(0, 200));

    // 3) monthly-ot API：item 要帶 approved_by / approved_at
    const mo = await req('GET', '/api/admin/worktime/monthly-ot?month=' + month, null, ac);
    const data = j(mo.body);
    check('monthly-ot 200', mo.code === 200 && data.success, mo.code);
    const rep = (data.reports || []).find(r => (r.night_allowance_items || []).some(i => i.client_no === 'E2E-APPR-1'));
    check('搵到含 E2E-APPR-1 嘅員工報表', !!rep);
    const item = rep && (rep.night_allowance_items || []).find(i => i.client_no === 'E2E-APPR-1');
    check('item 有 approved_by（非空字串）', item && typeof item.approved_by === 'string' && item.approved_by && item.approved_by !== '—', item && item.approved_by);
    check('item 有 approved_at（YYYY-MM-DD）', item && /^\d{4}-\d{2}-\d{2}$/.test(item.approved_at || ''), item && item.approved_at);

    // 4) Excel 匯出：夜急單段要有「批准人」「批准日期」欄
    const exRes = await fetch(BASE + '/api/admin/worktime/monthly-ot/export?month=' + month, { headers: { Cookie: ac } });
    check('export 200', exRes.status === 200, exRes.status);
    const buf = Buffer.from(await exRes.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });
    console.log('  sheets: ' + wb.SheetNames.join(', '));
    let foundHeader = false, foundApprover = false;
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
      for (const row of aoa) {
        const cells = (row || []).map(c => String(c));
        if (cells.includes('批准人') && cells.includes('批准日期')) foundHeader = true;
        if (cells.includes('E2E-APPR-1')) { foundApprover = cells.length >= 6 && String(cells[4] || '').trim().length > 0; console.log('    row:', JSON.stringify(cells)); }
      }
    }
    check('Excel 有「批准人／批准日期」欄', foundHeader);
    check('Excel 該行顯示批准人', foundApprover, item && item.approved_by);

    console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  } catch (e) {
    console.error('FATAL', e); fail++;
  } finally {
    child.kill();
    if (wtBackup) fs.writeFileSync(wtPath, wtBackup); else { try { fs.unlinkSync(wtPath); } catch {} }
    if (naBackup) fs.writeFileSync(naPath, naBackup); else { try { fs.unlinkSync(naPath); } catch {} }
    process.exit(fail ? 1 : 0);
  }
})();
