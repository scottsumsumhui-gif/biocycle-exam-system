// e2e：工時記錄窗口放寬（前後各 30 日）— 2026-09-28
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const NODE = process.execPath;
const PORT = 3029;
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
const isSun = d => new Date(d + 'T00:00:00+08:00').getDay() === 0;
function firstNonSun(offsets) { for (const o of offsets) { const d = hkDate(o); if (!isSun(d)) return d; } return null; }

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
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { clearInterval(t); resolve(); } } catch (e) {}
      if (--tries <= 0) { clearInterval(t); reject(new Error('server not up')); }
    }, 500);
  });
}

(async () => {
  const wtPath = path.join(DIR, 'data', 'worktime.json');
  const wtBackup = fs.existsSync(wtPath) ? fs.readFileSync(wtPath) : null;
  const child = spawn(NODE, ['server.js'], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitServer(40);
    const emps = j(fs.readFileSync(path.join(DIR, 'data', 'employees.json'), 'utf8')) || [];
    let ec = null, A = null;
    for (const e of emps) {
      const lg = await req('POST', '/api/auth/employee-login', { empNumber: e.emp_number, password: '0000' });
      if (lg.code === 200 && lg.cookie) { ec = lg.cookie; A = e; break; }
    }
    check('員工登入成功', !!ec, ec ? A.emp_number : '無員工可用 0000 登入');

    const make = (date) => ({ date, day_status: '正常上班', schedule_in: '10:00', actual_in: '10:00', off_time: '18:00', jobs: [], members: [{ emp_id: A.id }], ignore_conflict: true });

    const fOk = firstNonSun(Array.from({ length: 30 }, (_, i) => i + 1));
    const rf = await req('POST', '/api/worktime/records', make(fOk), ec);
    check('未來 ' + fOk + '（≤30日）可提交', rf.code === 200, rf.body.slice(0, 120));

    const fNo = firstNonSun(Array.from({ length: 10 }, (_, i) => i + 31));
    const rf2 = await req('POST', '/api/worktime/records', make(fNo), ec);
    check('未來 ' + fNo + '（>30日）被擋', rf2.code === 400 && /前後 30/.test(rf2.body), rf2.body.slice(0, 120));

    const pOk = firstNonSun(Array.from({ length: 30 }, (_, i) => -(i + 1)));
    const rp = await req('POST', '/api/worktime/records', make(pOk), ec);
    check('過去 ' + pOk + '（≤30日）可提交', rp.code === 200, rp.body.slice(0, 120));

    const pNo = firstNonSun(Array.from({ length: 10 }, (_, i) => -(i + 31)));
    const rp2 = await req('POST', '/api/worktime/records', make(pNo), ec);
    check('過去 ' + pNo + '（>30日）被擋', rp2.code === 400 && /前後 30/.test(rp2.body), rp2.body.slice(0, 120));

    const today = hkDate(0);
    const rt = await req('POST', '/api/worktime/records', make(today), ec);
    check('今日 ' + today + ' 可提交', rt.code === 200, rt.body.slice(0, 120));

    console.log('\n===== future-window: ' + pass + ' PASS / ' + fail + ' FAIL =====');
  } catch (e) {
    console.log('ERROR', e.message); fail++;
  } finally {
    if (wtBackup) fs.writeFileSync(wtPath, wtBackup); else if (fs.existsSync(wtPath)) fs.unlinkSync(wtPath);
    child.kill();
  }
  process.exit(fail ? 1 : 0);
})();
