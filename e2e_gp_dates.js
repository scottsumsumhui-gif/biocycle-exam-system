// 快速測試：GP 參考數據顯示違規日期 + auto-incidents 更新過時記錄（2026-09-24）
// 場景：A 員工上月有 1 日病假 → 帶入（note 有日期）→ 之後再補 3 日病假 → 再帶入 → auto 記錄更新為 4 日 + 新日期
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const NODE = process.execPath;
const PORT = 3026;
const BASE = 'http://127.0.0.1:' + PORT;
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' | got: ' + JSON.stringify(extra) : '')); }
}

async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
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
  const gpPath = path.join(DIR, 'data', 'guaranteed_pay.json');
  const wtBackup = fs.existsSync(wtPath) ? fs.readFileSync(wtPath) : null;
  const gpBackup = fs.existsSync(gpPath) ? fs.readFileSync(gpPath) : null;

  const emps = j(fs.readFileSync(path.join(DIR, 'data', 'employees.json'), 'utf8')) || [];
  const A = emps.find(e => e.emp_number && !String(e.emp_number).startsWith('TEST'));
  if (!A) { console.log('搵唔到測試員工，終止'); process.exit(1); }
  const empNo = String(A.emp_number);

  // 上個月 1 日病假 + 1 日遲到
  const now = new Date();
  const hk = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const p2 = n => String(n).padStart(2, '0');
  const ym = hk.getFullYear() + '-' + p2(hk.getMonth() + 1);
  const py = hk.getMonth() === 0 ? hk.getFullYear() - 1 : hk.getFullYear();
  const pm = hk.getMonth() === 0 ? 12 : hk.getMonth();
  const prevYm = py + '-' + p2(pm);
  const mk = (id, day, status, sched, actual) => ({
    id, emp_id: A.id, emp_number: empNo, emp_name: A.name, date: prevYm + '-' + p2(day),
    day_status: status, schedule_in: sched, actual_in: actual, off_time: '', remark: '', jobs: [], members: [],
    total_duty_hours: 0, standard_hours: 0, ot_hours: 0, ot_evening_hours: 0, ot_night_hours: 0
  });
  const cur = j(fs.readFileSync(wtPath, 'utf8')) || [];
  fs.writeFileSync(wtPath, JSON.stringify(cur.concat([
    mk(993001, 5, '病假', '', ''),
    mk(993002, 6, '正常上班', '08:00', '09:00') // 遲到 1 小時
  ])));

  const child = spawn(NODE, ['server.js'], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitServer(40);
    console.log('server up on ' + PORT + '，測試員工 ' + empNo + '，參考月 ' + prevYm);

    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    check('admin login', al.code === 200 && !!al.cookie, al.body.slice(0, 100));

    // ===== 1) refs 有日期 =====
    const g1 = j((await req('GET', '/api/admin/guaranteed-pay?month=' + ym, null, al.cookie)).body);
    const row1 = (g1.rows || []).find(r => r.emp_number === empNo);
    check('refs.sickDates 有上個月病假日期', row1 && row1.refs.sickDates.includes(prevYm + '-05'), row1 && row1.refs);
    check('refs.sickDays=1', row1 && row1.refs.sickDays === 1, row1 && row1.refs.sickDays);
    check('refs.lateDates 有遲到日期', row1 && row1.refs.lateDates.includes(prevYm + '-06'), row1 && row1.refs.lateDates);

    // ===== 2) 一鍵帶入 → note 有日期 =====
    const ai1 = j((await req('POST', '/api/admin/guaranteed-pay/auto-incidents', { month: ym }, al.cookie)).body);
    check('帶入 success', ai1 && ai1.success === true, ai1 && ai1.error);
    const addedSick = (ai1.added || []).find(x => x.emp_number === empNo && x.category === '病假');
    check('帶入病假 note = 「1 日（M/D）」含日期', !!addedSick && /1 日（\d+\/\d+）/.test(addedSick.detail), addedSick && addedSick.detail);
    const gpNow = j(fs.readFileSync(gpPath, 'utf8'));
    const incSick1 = gpNow.incidents.find(i => String(i.emp_number) === empNo && i.month === prevYm && i.category === '病假');
    check('incident note 顯示「1 日（M/D）」', incSick1 && /^\d+ 日（\d+\/\d+）$/.test(incSick1.note), incSick1 && incSick1.note);

    // ===== 3) 再補 3 日病假 → 再帶入 → auto 記錄自動更新為 4 日 =====
    const cur2 = j(fs.readFileSync(wtPath, 'utf8')) || [];
    fs.writeFileSync(wtPath, JSON.stringify(cur2.concat([mk(993003, 10, '病假', '', ''), mk(993004, 11, '病假', '', ''), mk(993005, 12, '病假', '', '')])));
    const g2 = j((await req('GET', '/api/admin/guaranteed-pay?month=' + ym, null, al.cookie)).body);
    const row2 = (g2.rows || []).find(r => r.emp_number === empNo);
    check('refs.sickDays 更新=4', row2 && row2.refs.sickDays === 4, row2 && row2.refs.sickDays);
    check('refs.sickDates 有 4 個日期', row2 && row2.refs.sickDates.length === 4, row2 && row2.refs.sickDates);

    const ai2 = j((await req('POST', '/api/admin/guaranteed-pay/auto-incidents', { month: ym }, al.cookie)).body);
    check('再帶入 success', ai2 && ai2.success === true, ai2 && ai2.error);
    const updSick = (ai2.updated || []).find(x => x.emp_number === empNo && x.category === '病假');
    check('帶入回報 updated 病假', !!updSick, ai2.updated);
    const gpAfter = j(fs.readFileSync(gpPath, 'utf8'));
    const sickInc = gpAfter.incidents.filter(i => String(i.emp_number) === empNo && i.month === prevYm && i.category === '病假');
    check('病假 incident 冇重複（得 1 條）', sickInc.length === 1, sickInc.length);
    check('病假 incident note 更新=「4 日」+ 日期', sickInc.length === 1 && sickInc[0].note.startsWith('4 日（'), sickInc.length && sickInc[0].note);

    // ===== 4) 手動記錄（source≠auto）唔會被改 =====
    const gpManual = j(fs.readFileSync(gpPath, 'utf8'));
    const man = gpManual.incidents.find(i => String(i.emp_number) === empNo && i.month === prevYm && i.category === '遲到');
    if (man) { man.source = 'manual'; man.note = '人手批示'; fs.writeFileSync(gpPath, JSON.stringify(gpManual)); }
    const ai3 = j((await req('POST', '/api/admin/guaranteed-pay/auto-incidents', { month: ym }, al.cookie)).body);
    check('再帶入 success (3rd)', ai3 && ai3.success === true, ai3 && ai3.error);
    const gpFinal = j(fs.readFileSync(gpPath, 'utf8'));
    const manAfter = gpFinal.incidents.find(i => String(i.emp_number) === empNo && i.month === prevYm && i.category === '遲到');
    if (man) check('manual 記錄 note 唔會被自動改', manAfter && manAfter.note === '人手批示', manAfter && manAfter.note);
  } catch (e) {
    fail++; console.log('EXCEPTION ' + e.message);
  } finally {
    child.kill('SIGKILL');
    if (wtBackup) fs.writeFileSync(wtPath, wtBackup); else { try { fs.unlinkSync(wtPath); } catch (e) {} }
    if (gpBackup) fs.writeFileSync(gpPath, gpBackup); else { try { fs.unlinkSync(gpPath); } catch (e) {} }
  }
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})();
