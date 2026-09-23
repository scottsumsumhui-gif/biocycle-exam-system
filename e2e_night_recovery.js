// e2e：開夜番晏（夜急單遲收，翌日提早收工）— 2026-09-23
// 規則：剔咗「開夜番晏」→ 無論幾點返工，OT 由 18:00 起計；20:00 後照舊深夜價；
//       星期六（5h 標準）唔會被拉長（min 規則）；flag 每人獨立剔，唔跟隊 sync（唔影響隊友）。
// 用本地檔案模式（無 Redis），port 3021，跑完還原 data/worktime.json
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcryptjs = require('bcryptjs');

const DIR = __dirname;
const NODE = process.execPath;
const PORT = 3021;
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
  const wtBackup = fs.existsSync(wtPath) ? fs.readFileSync(wtPath) : null;

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

    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    const ac = al.cookie;
    check('admin login', al.code === 200 && !!ac, al.body.slice(0, 100));
    const el = await req('POST', '/api/auth/employee-login', { empNumber: A.emp_number, password: '0000' });
    const ec = el.cookie;
    check('employee login ' + A.emp_number, el.code === 200 && !!ec, el.body.slice(0, 100));
    const elB = await req('POST', '/api/auth/employee-login', { empNumber: B.emp_number, password: '0000' });
    const ecB = elB.cookie;
    check('employee login ' + B.emp_number, elB.code === 200 && !!ecB, elB.body.slice(0, 100));

    // 揀一個平日（今日或之前 6 日內，避開星期日）同上一個星期六
    let weekday = null;
    for (let i = 0; i <= 6; i++) {
      const d = hkDate(-i);
      if (new Date(d + 'T00:00:00+08:00').getDay() !== 0) { weekday = d; break; }
    }
    let saturday = null;
    for (let i = 0; i <= 6; i++) {
      const d = hkDate(-i);
      if (new Date(d + 'T00:00:00+08:00').getDay() === 6) { saturday = d; break; }
    }
    console.log('平日=' + weekday + ' 星期六=' + saturday);

    // ===== 1) 無剔：OT 照舊由 20:00 起計 =====
    let s1 = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', schedule_in: '10:00', actual_in: '10:00', off_time: '21:00',
      remark: 'e2e recovery baseline', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    check('提交無剔記錄', s1.code === 200, s1.body.slice(0, 200));
    let rec = j(s1.body).record;
    check('無剔：OT=1h（20:00-21:00）', rec && rec.ot_hours === 1, rec && rec.ot_hours);
    check('無剔：21:00 收工嗰 1h 屬 night（20:00 分界）', rec && rec.ot_evening_hours === 0 && rec.ot_night_hours === 1, rec);

    // ===== 2) 剔咗：OT 由 18:00 起計 =====
    const s2 = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', night_recovery: true,
      schedule_in: '10:00', actual_in: '10:00', off_time: '21:00',
      remark: 'e2e recovery flag', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    rec = j(s2.body).record;
    check('剔咗：OT=3h（18:00-21:00）', rec && rec.ot_hours === 3, rec && rec.ot_hours);
    check('剔咗：evening 2h + night 1h', rec && rec.ot_evening_hours === 2 && rec.ot_night_hours === 1, rec);

    // 2b) 19:00 收工（無 OT 情況下本來 0）→ 1h evening OT
    const s2b = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', night_recovery: true,
      schedule_in: '10:00', actual_in: '10:00', off_time: '19:00',
      remark: 'e2e recovery 19:00', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    rec = j(s2b.body).record;
    check('剔咗 19:00 收工：OT=1h', rec && rec.ot_hours === 1, rec && rec.ot_hours);
    check('剔咗 19:00：全 evening', rec && rec.ot_evening_hours === 1 && rec.ot_night_hours === 0, rec);

    // 2c) 18:00 收工：OT=0（準 6 點，唔計 OT）
    const s2c = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', night_recovery: true,
      schedule_in: '10:00', actual_in: '10:00', off_time: '18:00',
      remark: 'e2e recovery 18:00', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    rec = j(s2c.body).record;
    check('剔咗 18:00 收工：OT=0', rec && rec.ot_hours === 0, rec && rec.ot_hours);

    // 2d) 遲返工 12:00 + 21:00 收工：OT 由 18:00 計（無論幾點返工）
    const s2d = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', night_recovery: true,
      schedule_in: '12:00', actual_in: '12:00', off_time: '21:00',
      remark: 'e2e recovery late in', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    rec = j(s2d.body).record;
    check('遲返工 12:00：OT=3h', rec && rec.ot_hours === 3, rec && rec.ot_hours);

    // 2e) 無論 schedule 幾多，無剔時 19:00 收工 OT=0（對照）
    const s2e = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', night_recovery: false,
      schedule_in: '10:00', actual_in: '10:00', off_time: '19:00',
      remark: 'e2e no flag 19:00', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    rec = j(s2e.body).record;
    check('無剔 19:00 收工：OT=0（對照）', rec && rec.ot_hours === 0, rec && rec.ot_hours);

    // ===== 3) 星期六：標準 5h，flag 唔會拉長標準窗口 =====
    const s3 = await req('POST', '/api/worktime/records', {
      date: saturday, day_status: '正常上班', night_recovery: true,
      schedule_in: '10:00', actual_in: '10:00', off_time: '16:30',
      remark: 'e2e recovery sat', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    rec = j(s3.body).record;
    check('星期六剔咗：OT=1.5h（15:00-16:30，同無剔一樣）', rec && rec.ot_hours === 1.5, rec && rec.ot_hours);

    // ===== 4) 每人獨立剔：B 有自己記錄（無剔），A 交全隊 + 剔咗 → B 唔受影響 =====
    // B 先自己交一份（10:00-21:00 無剔 → OT 1h）
    const sb = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', schedule_in: '10:00', actual_in: '10:00', off_time: '21:00',
      remark: 'e2e B own', ignore_conflict: true, jobs: [], members: [{ emp_id: B.id }]
    }, ecB);
    check('B 自己交（無剔 OT=1h）', sb.code === 200 && j(sb.body).record.ot_hours === 1, sb.body.slice(0, 200));

    // A 交連隊員 + 剔咗（要有起碼一張可同步單，syncTeamJobs 先會跑）
    const sa = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', night_recovery: true,
      schedule_in: '11:00', actual_in: '11:00', off_time: '20:30',
      remark: 'e2e A team', ignore_conflict: true,
      jobs: [{ client_no: 'E2E-NR-1', start: '11:30', end: '12:30', types: ['其他'], remarks: '', no_sync: false, night_allowance: false }],
      members: [{ emp_id: A.id }, { emp_id: B.id }]
    }, ec);
    check('A 交全隊（剔咗）', sa.code === 200, sa.body.slice(0, 200));

    const adm = j((await req('GET', '/api/admin/worktime/records?month=' + weekday.slice(0, 7), null, ac)).body);
    const recB = (adm.records || []).find(r => r.emp_id === B.id && r.date === weekday);
    check('B flag 不受 A 影響，保持 false', recB && recB.night_recovery === false, recB && recB.night_recovery);
    check('B OT 保持 1h（用 B 自己時間 10:00-21:00，無 flag）', recB && recB.ot_hours === 1, recB && recB.ot_hours);
    const recA = (adm.records || []).find(r => r.emp_id === A.id && r.date === weekday);
    check('A flag=true（自己剔）', recA && recA.night_recovery === true, recA && recA.night_recovery);
    check('A OT=2.5h（18:00-20:30）', recA && recA.ot_hours === 2.5, recA && recA.ot_hours);

    // ===== 5) 獨立性：A 再交改無剔 → 只 A 變，B 唔受影響 =====
    const sa2 = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', night_recovery: false,
      schedule_in: '11:00', actual_in: '11:00', off_time: '20:30',
      remark: 'e2e A team unflag', ignore_conflict: true,
      jobs: [{ client_no: 'E2E-NR-1', start: '11:30', end: '12:30', types: ['其他'], remarks: '', no_sync: false, night_allowance: false }],
      members: [{ emp_id: A.id }, { emp_id: B.id }]
    }, ec);
    check('A 再交（無剔）', sa2.code === 200, sa2.body.slice(0, 200));
    const adm2 = j((await req('GET', '/api/admin/worktime/records?month=' + weekday.slice(0, 7), null, ac)).body);
    const recB2 = (adm2.records || []).find(r => r.emp_id === B.id && r.date === weekday);
    check('B flag 仍 false（A 改唔到 B）', recB2 && recB2.night_recovery === false, recB2 && recB2.night_recovery);
    check('B OT 仍 1h', recB2 && recB2.ot_hours === 1, recB2 && recB2.ot_hours);
    const recA2 = (adm2.records || []).find(r => r.emp_id === A.id && r.date === weekday);
    check('A flag 變回 false（自己改）', recA2 && recA2.night_recovery === false, recA2 && recA2.night_recovery);
    check('A OT 打回 0h（標準 21:00 收，20:30 走無 OT）', recA2 && recA2.ot_hours === 0, recA2 && recA2.ot_hours);

    // ===== 6) 員工 PUT 修改自己記錄：flag 保持 =====
    const myRecs = j((await req('GET', '/api/worktime/records?from=' + weekday + '&to=' + weekday, null, ec)).body);
    const mine = (myRecs.records || [])[0];
    const pid = await req('PUT', '/api/worktime/records/' + mine.id, {
      date: weekday, day_status: '正常上班', night_recovery: true,
      schedule_in: '10:00', actual_in: '10:00', off_time: '20:00',
      remark: 'e2e put', jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    const recP = j(pid.body).record;
    check('PUT 後 flag=true + OT=2h', recP && recP.night_recovery === true && recP.ot_hours === 2, recP && [recP.night_recovery, recP.ot_hours]);

    // ===== 7) 出糧表照計到（monthly-ot 有 evening/night 分欄）=====
    const mo = j((await req('GET', '/api/admin/worktime/monthly-ot?month=' + weekday.slice(0, 7), null, ac)).body);
    check('monthly-ot 正常返回', mo && mo.success === true && Array.isArray(mo.reports), mo && mo.success);
    const moA = (mo.reports || []).find(x => x.emp_number === A.emp_number);
    check('出糧表 A 君有 OT 時數（special=20:00後）', moA && typeof moA.total_special_hours === 'number' && typeof moA.total_normal_hours === 'number', moA && [moA.total_normal_hours, moA.total_special_hours]);
    check('出糧表 A 君 normal+special 對上記錄 OT', moA && moA.total_normal_hours + moA.total_special_hours >= 2, moA && [moA.total_normal_hours, moA.total_special_hours]);

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
