// 快速測試：月度 OT 出糧表 Excel 加「狀態」欄（2026-09-24）
// 注入病假/大假記錄 → 匯出 xlsx → 驗 header + 該日狀態顯示。用 port 3023，跑完還原 worktime.json
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const bcryptjs = require('bcryptjs');

const DIR = __dirname;
const NODE = process.execPath;
const PORT = 3023;
const BASE = 'http://127.0.0.1:' + PORT;
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' | got: ' + JSON.stringify(extra) : '')); }
}

function hkDate(offsetDays) {
  const d = new Date();
  const hk = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000 + (offsetDays || 0) * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${hk.getFullYear()}-${p(hk.getMonth() + 1)}-${p(hk.getDate())}`;
}

async function req(method, p, body, cookie, raw) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { code: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  return { code: r.status, cookie: r.headers.get('set-cookie') ? r.headers.get('set-cookie').split(';')[0] : null, body: await r.text() };
}

function waitServer(tries) {
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { clearInterval(t); resolve(); } } catch (e) {}
      if (--tries <= 0) { clearInterval(t); reject(new Error('server not up')); }
    }, 500);
  });
}

(async () => {
  const wtPath = path.join(DIR, 'data', 'worktime.json');
  const wtBackup = fs.existsSync(wtPath) ? fs.readFileSync(wtPath) : null;

  const emps = j(fs.readFileSync(path.join(DIR, 'data', 'employees.json'), 'utf8')) || [];
  const OT_LEVELS = ['P.junior', 'junior', 'P.senior', 'senior', 'PD.supervisor', 'D.supervisor', 'supervisor'];
  const cand = emps.filter(e => e.password_hash && bcryptjs.compareSync('0000', e.password_hash) && OT_LEVELS.includes(e.level));
  if (!cand.length) { console.log('搵唔到測試員工，終止'); process.exit(1); }
  const A = cand[0];

  // 注入：本月一條病假 + 一條大假 + 一條正常上班
  const month = hkDate(0).slice(0, 7);
  const d1 = hkDate(-1), d2 = hkDate(-2), d3 = hkDate(-3);
  const inject = [
    { id: 990001, emp_id: A.id, emp_number: A.emp_number, emp_name: A.name, date: d1, day_status: '病假', schedule_in: '', actual_in: '', off_time: '', remark: '', jobs: [], members: [], total_duty_hours: 0, standard_hours: 0, ot_hours: 0, ot_evening_hours: 0, ot_night_hours: 0 },
    { id: 990002, emp_id: A.id, emp_number: A.emp_number, emp_name: A.name, date: d2, day_status: '大假', schedule_in: '', actual_in: '', off_time: '', remark: '', jobs: [], members: [], total_duty_hours: 0, standard_hours: 0, ot_hours: 0, ot_evening_hours: 0, ot_night_hours: 0 },
    { id: 990003, emp_id: A.id, emp_number: A.emp_number, emp_name: A.name, date: d3, day_status: '正常上班', schedule_in: '08:00', actual_in: '08:00', off_time: '18:15', remark: '', jobs: [], members: [], total_duty_hours: 10.25, standard_hours: 10, ot_hours: 0.25, ot_evening_hours: 0.25, ot_night_hours: 0 }
  ];
  const cur = j(fs.readFileSync(wtPath, 'utf8')) || [];
  fs.writeFileSync(wtPath, JSON.stringify(cur.concat(inject)));

  const child = spawn(NODE, ['server.js'], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitServer(40);
    console.log('server up on ' + PORT + '，測試員工 ' + A.emp_number + '，月份 ' + month);

    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    check('admin login', al.code === 200 && !!al.cookie, al.body.slice(0, 100));

    const ex = await req('GET', '/api/admin/worktime/monthly-ot/export?month=' + month, null, al.cookie, true);
    check('export 200', ex.code === 200 && ex.buf.length > 1000, ex.code);

    const wb = XLSX.read(ex.buf, { type: 'buffer' });
    const sheetName = wb.SheetNames.find(n => n.includes(A.name) || n.includes(A.emp_number)) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const header = aoa[3] || [];
    check('header 第5欄 = 狀態', header[4] === '狀態', header);

    const rows = aoa.filter(r => Array.isArray(r) && /^20\d{2}-/.test(String(r[0])));
    const sick = rows.find(r => r[0] === d1);
    const annual = rows.find(r => r[0] === d2);
    const normal = rows.find(r => r[0] === d3);
    check('病假日顯示「病假」', sick && sick[4] === '病假', sick);
    check('大假日顯示「大假」', annual && annual[4] === '大假', annual);
    check('正常日顯示「正常上班」+ 欄位對齊（normal_hours 0.25 落第6欄、day_total 22 落第10欄）', normal && normal[4] === '正常上班' && normal[5] === 0.25 && normal[9] === 22, normal);
    check('每行欄數 = 10', rows.every(r => r.length === 10), rows.map(r => r.length));

    // monthly-ot API 都帶 status（員工 my-ot 頁將來可用）
    const mo = j((await req('GET', '/api/admin/worktime/monthly-ot?month=' + month, null, al.cookie)).body);
    const rep = (mo.reports || []).find(x => x.emp_number === A.emp_number);
    const drec = (rep.days || []).find(x => x.date === d1);
    check('API days 帶 status=病假', drec && drec.status === '病假', drec);

    console.log('\n===== 結果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  } catch (e) {
    console.error('E2E ERROR:', e && e.stack || e); fail++;
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 800));
    if (wtBackup) fs.writeFileSync(wtPath, wtBackup); else { try { fs.unlinkSync(wtPath); } catch (e) {} }
    console.log('已還原 worktime.json');
  }
  process.exit(fail ? 1 : 0);
})();
