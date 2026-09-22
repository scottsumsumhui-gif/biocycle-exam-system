// e2e：夜急單津貼批准流程（2026-09-22）
// 流程：pending 唔計入出糧表 → admin 批准先計 → 拒絕唔計 → 可改判
// 用本地檔案模式（無 Redis），port 3020，跑完還原 data/worktime.json
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcryptjs = require('bcryptjs');

const DIR = __dirname;
const NODE = process.execPath;
const PORT = 3020;
const BASE = 'http://127.0.0.1:' + PORT;
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' | got: ' + JSON.stringify(extra) : '')); }
}

function hkToday() {
  const d = new Date();
  const hk = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${hk.getFullYear()}-${p(hk.getMonth() + 1)}-${p(hk.getDate())}`;
}

async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.get('set-cookie');
  return { code: r.status, cookie: setCookie ? setCookie.split(';')[0] : null, body: await r.text() };
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
  const decPath = path.join(DIR, 'data', 'night_job_approvals.json');
  const wtBackup = fs.existsSync(wtPath) ? fs.readFileSync(wtPath) : null;
  if (fs.existsSync(decPath)) fs.unlinkSync(decPath);

  // 揀兩個有 OT 職級、密碼 0000 嘅員工
  const emps = j(fs.readFileSync(path.join(DIR, 'data', 'employees.json'), 'utf8')) || [];
  const OT_LEVELS = ['P.junior', 'junior', 'P.senior', 'senior', 'PD.supervisor', 'D.supervisor', 'supervisor'];
  const cand = emps.filter(e => e.password_hash && bcryptjs.compareSync('0000', e.password_hash) && OT_LEVELS.includes(e.level));
  if (cand.length < 2) { console.log('搵唔到兩個 pw=0000 且有 OT 職級嘅員工，終止'); process.exit(1); }
  const [A, B] = cand;
  console.log('測試員工：' + A.emp_number + ' ' + A.name + ' + ' + B.emp_number + ' ' + B.name);

  const child = spawn(NODE, ['server.js'], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitServer(40);
    console.log('server up on ' + PORT);

    // admin login
    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    const ac = al.cookie;
    check('admin login', al.code === 200 && !!ac, al.body.slice(0, 100));

    // employee login
    const el = await req('POST', '/api/auth/employee-login', { empNumber: A.emp_number, password: '0000' });
    const ec = el.cookie;
    check('employee login ' + A.emp_number, el.code === 200 && !!ec, el.body.slice(0, 100));

    const today = hkToday();
    const month = today.slice(0, 7);

    // 員工提交：A單(同步,2人) + B單(私單,1人)，都係夜急單
    const sub = await req('POST', '/api/worktime/records', {
      date: today, day_status: '正常上班', schedule_in: '09:00', actual_in: '09:00', off_time: '23:00',
      remark: 'e2e night jobs', ignore_conflict: true,
      jobs: [
        { client_no: 'E2E-NJ-A', start: '21:00', end: '22:00', types: ['其他'], remarks: '夜急A', no_sync: false, night_allowance: true },
        { client_no: 'E2E-NJ-B', start: '22:00', end: '23:00', types: ['其他'], remarks: '夜急B', no_sync: true, night_allowance: true }
      ],
      members: [{ emp_id: A.id }, { emp_id: B.id }]
    }, ec);
    check('員工提交夜急單', sub.code === 200, sub.body.slice(0, 200));

    // 1) 提交後：兩張都 pending，出糧表津貼 = 0
    let r1 = j((await req('GET', '/api/admin/worktime/monthly-ot?month=' + month, null, ac)).body);
    check('night_jobs 有 A + B', (r1.night_jobs || []).filter(n => ['E2E-NJ-A', 'E2E-NJ-B'].includes(n.client_no)).length === 2, r1.night_jobs);
    const njA = r1.night_jobs.find(n => n.client_no === 'E2E-NJ-A');
    const njB = r1.night_jobs.find(n => n.client_no === 'E2E-NJ-B');
    check('A pending', njA && njA.status === 'pending', njA);
    check('B pending', njB && njB.status === 'pending', njB);
    check('A heads=2', njA && njA.heads === 2, njA);
    check('B heads=1', njB && njB.heads === 1, njB);
    const me1 = r1.reports.find(x => x.emp_number === A.emp_number);
    check('未批准：A君津貼=0', me1 && me1.night_allowance_hkd === 0, me1 && me1.night_allowance_hkd);
    check('pending 計數=2', r1.night_pending === 2, r1.night_pending);

    // 2) 批准 A → A君+隊友 各 $150
    const d1 = await req('POST', '/api/admin/worktime/night-jobs/decide', { date: today, client_no: 'E2E-NJ-A', action: 'approve' }, ac);
    check('批准 A', d1.code === 200 && j(d1.body).success, d1.body.slice(0, 150));
    let r2 = j((await req('GET', '/api/admin/worktime/monthly-ot?month=' + month, null, ac)).body);
    const me2 = r2.reports.find(x => x.emp_number === A.emp_number);
    const mt2 = r2.reports.find(x => x.emp_number === B.emp_number);
    check('批准後 A君津貼=150', me2 && me2.night_allowance_hkd === 150, me2 && me2.night_allowance_hkd);
    check('批准後隊友津貼=150', mt2 && mt2.night_allowance_hkd === 150, mt2 && mt2.night_allowance_hkd);
    check('A 已批准', r2.night_jobs.find(n => n.client_no === 'E2E-NJ-A').status === 'approved');
    check('pending 計數=1', r2.night_pending === 1, r2.night_pending);

    // 3) 拒絕 B → 唔計
    const d2 = await req('POST', '/api/admin/worktime/night-jobs/decide', { date: today, client_no: 'E2E-NJ-B', action: 'reject' }, ac);
    check('拒絕 B', d2.code === 200, d2.body.slice(0, 150));
    let r3 = j((await req('GET', '/api/admin/worktime/monthly-ot?month=' + month, null, ac)).body);
    const me3 = r3.reports.find(x => x.emp_number === A.emp_number);
    check('拒絕 B 後 A君津貼仍=150（B無份）', me3 && me3.night_allowance_hkd === 150, me3 && me3.night_allowance_hkd);
    check('B 已拒絕', r3.night_jobs.find(n => n.client_no === 'E2E-NJ-B').status === 'rejected');

    // 4) 改判：A 轉拒絕 → 歸零；再批准 → 返 150
    await req('POST', '/api/admin/worktime/night-jobs/decide', { date: today, client_no: 'E2E-NJ-A', action: 'reject' }, ac);
    let r4 = j((await req('GET', '/api/admin/worktime/monthly-ot?month=' + month, null, ac)).body);
    check('改判拒絕 A 後津貼=0', r4.reports.find(x => x.emp_number === A.emp_number).night_allowance_hkd === 0);
    await req('POST', '/api/admin/worktime/night-jobs/decide', { date: today, client_no: 'E2E-NJ-A', action: 'approve' }, ac);
    let r5 = j((await req('GET', '/api/admin/worktime/monthly-ot?month=' + month, null, ac)).body);
    check('改判批准 A 後津貼=150', r5.reports.find(x => x.emp_number === A.emp_number).night_allowance_hkd === 150);

    // 5) 參數驗證
    const bad1 = await req('POST', '/api/admin/worktime/night-jobs/decide', { date: today, client_no: 'X', action: 'hack' }, ac);
    check('錯 action 擋截', bad1.code === 400, bad1.code);
    const bad2 = await req('POST', '/api/admin/worktime/night-jobs/decide', { date: 'bad', client_no: 'X', action: 'approve' }, ac);
    check('錯日期擋截', bad2.code === 400, bad2.code);

    // 6) 遷移標記
    const dec = j(fs.readFileSync(decPath, 'utf8'));
    check('決定檔已標記 migrated', dec && dec.__migrated === true);
    check('決定人記錄咗', dec && dec[today + '|E2E-NJ-A'] && !!dec[today + '|E2E-NJ-A'].by_name, dec && dec[today + '|E2E-NJ-A']);

    console.log('\n===== 結果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  } catch (e) {
    console.error('E2E ERROR:', e && e.stack || e); fail++;
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 800));
    if (wtBackup) fs.writeFileSync(wtPath, wtBackup); else { try { fs.unlinkSync(wtPath); } catch (e) {} }
    if (fs.existsSync(decPath)) fs.unlinkSync(decPath);
    console.log('已還原 worktime.json + 清除 night_job_approvals.json');
  }
  process.exit(fail ? 1 : 0);
})();
