// 一次性腳本：生成本地美化版工時匯出樣本（與 server.js /api/admin/worktime/export 同邏輯）
const path = require('path');
const ROOT = path.resolve(__dirname);
process.chdir(ROOT);
process.env.PORT = '3577';
process.env.DATA_DIR = path.join(ROOT, '.e2e-data-wt-style');
const { spawn } = require('child_process');
const fs = require('fs');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch('http://127.0.0.1:3577' + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ab = await r.arrayBuffer();
  return { code: r.status, cookie: r.headers.get('set-cookie') ? r.headers.get('set-cookie').split(';')[0] : null, buf: Buffer.from(ab) };
}

(async () => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  const srv = spawn(process.execPath, ['server.js'], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await req('GET', '/api/health'); break; } catch { await wait(250); } }
    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    if (al.code !== 200) throw new Error('admin login ' + al.code);
    const emps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'employees.json'), 'utf8')) || [];
    let el = null, emp = null;
    for (const e of emps) {
      const lg = await req('POST', '/api/auth/employee-login', { empNumber: e.emp_number, password: '0000' });
      if (lg.code === 200 && lg.cookie) { el = lg; emp = e; break; }
    }
    if (!el) throw new Error('無員工可登入');
    const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
    for (const date of days) {
      const sub = await req('POST', '/api/worktime/records', {
        date,
        schedule_in: '08:00', actual_in: '08:00', off_time: '18:30',
        day_status: '正常上班', ignore_conflict: true,
        members: [{ emp_id: emp.id }],
        jobs: [
          { client_no: 'J1001', start: '09:00', end: '11:30', types: ['PC'], night_allowance: false, remarks: '' },
          { client_no: 'J1002', start: '14:00', end: '16:30', types: ['TC'], night_allowance: date === '2026-09-22', remarks: date === '2026-09-22' ? '夜急單跟進' : '' }
        ],
        remark: ''
      }, el.cookie);
      if (sub.code !== 200) throw new Error('submit ' + date + ' -> ' + sub.code + ' ' + sub.buf);
    }
    const exp = await req('GET', '/api/admin/worktime/export?from=2026-09-21&to=2026-09-27', null, al.cookie);
    if (exp.code !== 200) throw new Error('export ' + exp.code);
    const out = path.join(ROOT, '..', 'outputs', 'worktime_export_sample.xlsx');
    fs.writeFileSync(out, exp.buf);
    console.log('SAMPLE_OK', out, exp.buf.length, 'bytes');
  } finally {
    srv.kill();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
})();
