// e2e：公眾假期自動判斷 + 新狀態（生日假/其他）— 2026-09-28
// 規則：
//  1) 狀態多咗「生日假」「其他」，同 大假/病假 一樣唔使填時間、OT=0
//  2) 香港公眾假期（政府憲報 2026/2027）系統自動判斷：當日交記錄唔使揀「公眾假期」，
//     server 自動當公眾假期；開工就 tick holiday_work → 全部時間計 OT
// 用本地檔案模式（無 Redis），port 3022，跑完還原 data/worktime.json
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcryptjs = require('bcryptjs');

const DIR = __dirname;
const NODE = process.execPath;
const PORT = 3022;
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
  if (!cand.length) { console.log('搵唔到 pw=0000 且有 OT 職級嘅員工，終止'); process.exit(1); }
  const A = cand[0];
  console.log('測試員工：' + A.emp_number + ' ' + A.name);

  const child = spawn(NODE, ['server.js'], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitServer(40);
    console.log('server up on ' + PORT);

    const el = await req('POST', '/api/auth/employee-login', { empNumber: A.emp_number, password: '0000' });
    const ec = el.cookie;
    check('employee login ' + A.emp_number, el.code === 200 && !!ec, el.body.slice(0, 100));

    // ===== 1) meta：新狀態 + 假期表 =====
    const meta = j((await req('GET', '/api/worktime/meta', null, ec)).body);
    check('statuses 含 生日假', meta.statuses && meta.statuses.includes('生日假'), meta.statuses);
    check('statuses 含 其他', meta.statuses && meta.statuses.includes('其他'), meta.statuses);
    check('holidays 2026 有 09-26 中秋節翌日', meta.holidays && meta.holidays['2026'] && meta.holidays['2026']['09-26'] === '中秋節翌日', meta.holidays && meta.holidays['2026'] && meta.holidays['2026']['09-26']);
    check('holidays 2026 有 10-01 國慶日', meta.holidays && meta.holidays['2026'] && meta.holidays['2026']['10-01'] === '國慶日');
    check('holidays 2027 有 02-06 年初一', meta.holidays && meta.holidays['2027'] && meta.holidays['2027']['02-06'] === '農曆年初一');

    // 搵一個 7 日內嘅公眾假期（2026-09-26 中秋節翌日，星期六）
    let holiday = null;
    for (let i = 0; i <= 6; i++) {
      const d = hkDate(-i);
      const mmdd = d.slice(5);
      const y = meta.holidays && meta.holidays[d.slice(0, 4)];
      if (y && y[mmdd]) { holiday = d; break; }
    }
    check('搵到 7 日內公眾假期', !!holiday, holiday);
    if (!holiday) { console.log('無假期可測，跳過假期段'); }

    // 搵一個 7 日內非星期日、非假期嘅平日
    let weekday = null;
    for (let i = 0; i <= 6; i++) {
      const d = hkDate(-i);
      if (new Date(d + 'T00:00:00+08:00').getDay() === 0) continue;
      const y = meta.holidays && meta.holidays[d.slice(0, 4)];
      if (y && y[d.slice(5)]) continue;
      weekday = d; break;
    }
    console.log('平日=' + weekday + ' 假期=' + holiday);

    // ===== 2) 生日假：唔使填時間、OT=0 =====
    const s2 = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '生日假', remark: 'e2e birthday', ignore_conflict: true, jobs: [], members: []
    }, ec);
    check('生日假提交成功（唔使時間）', s2.code === 200, s2.body.slice(0, 200));
    let rec = j(s2.body).record;
    check('生日假 OT=0 / duty=0', rec && rec.ot_hours === 0 && rec.total_duty_hours === 0, rec);

    // ===== 3) 其他：一樣處理 =====
    const s3 = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '其他', remark: 'e2e other', ignore_conflict: true, jobs: [], members: []
    }, ec);
    check('其他提交成功（唔使時間）', s3.code === 200, s3.body.slice(0, 200));
    rec = j(s3.body).record;
    check('其他 OT=0 / duty=0', rec && rec.ot_hours === 0 && rec.total_duty_hours === 0, rec);

    // ===== 4) 公眾假期自動判斷：明明交「正常上班」無時間 → server 自動當公眾假期 =====
    if (holiday) {
      const s4 = await req('POST', '/api/worktime/records', {
        date: holiday, day_status: '正常上班', remark: 'e2e holiday auto', ignore_conflict: true, jobs: [], members: []
      }, ec);
      check('假期日交「正常上班」無時間 → 成功（自動當公眾假期）', s4.code === 200, s4.body.slice(0, 250));
      rec = j(s4.body).record;
      check('day_status 自動變公眾假期', rec && rec.day_status === '公眾假期', rec && rec.day_status);
      check('假期無開工 OT=0', rec && rec.ot_hours === 0, rec && rec.ot_hours);

      // ===== 5) 假期開工：全部時間計 OT =====
      const s5 = await req('POST', '/api/worktime/records', {
        date: holiday, day_status: '公眾假期', holiday_work: true,
        schedule_in: '10:00', actual_in: '10:00', off_time: '16:00',
        remark: 'e2e holiday work', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
      }, ec);
      check('假期開工提交成功', s5.code === 200, s5.body.slice(0, 250));
      rec = j(s5.body).record;
      check('假期開工 OT=6h（10:00-16:00 全計）', rec && rec.ot_hours === 6, rec && rec.ot_hours);
      check('假期開工 standard=0', rec && rec.standard_hours === 0, rec && rec.standard_hours);

      // ===== 6) 假期日交「正常上班」但有時間 → 都自動當公眾假期（OT 全計）=====
      const s6 = await req('POST', '/api/worktime/records', {
        date: holiday, day_status: '正常上班',
        schedule_in: '10:00', actual_in: '11:00', off_time: '15:00',
        remark: 'e2e holiday normal-status', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
      }, ec);
      check('假期日正常上班+時間 → 成功', s6.code === 200, s6.body.slice(0, 250));
      rec = j(s6.body).record;
      check('day_status 自動公眾假期', rec && rec.day_status === '公眾假期', rec && rec.day_status);
      check('OT=4h（11:00-15:00 用 actual_in）', rec && rec.ot_hours === 4, rec && rec.ot_hours);
    }

    // ===== 7) 回歸：平日正常 OT 計法不變 =====
    const s7 = await req('POST', '/api/worktime/records', {
      date: weekday, day_status: '正常上班', schedule_in: '10:00', actual_in: '10:00', off_time: '21:00',
      remark: 'e2e holiday regression', ignore_conflict: true, jobs: [], members: [{ emp_id: A.id }]
    }, ec);
    rec = j(s7.body).record;
    check('平日回歸：OT=1h（20:00-21:00）', rec && rec.ot_hours === 1, rec && rec.ot_hours);
    check('平日回歸：standard=10h', rec && rec.standard_hours === 10, rec && rec.standard_hours);
  } finally {
    child.kill();
    if (wtBackup) fs.writeFileSync(wtPath, wtBackup);
    else if (fs.existsSync(wtPath)) fs.unlinkSync(wtPath);
    console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
    process.exit(fail ? 1 : 0);
  }
})();
