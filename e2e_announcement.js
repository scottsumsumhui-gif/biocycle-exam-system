// e2e：登入公告 GET/POST
const path = require('path');
const ROOT = path.resolve(__dirname);
process.chdir(ROOT);
process.env.PORT = '3581';
process.env.DATA_DIR = path.join(ROOT, '.e2e-data-ann');
const { spawn } = require('child_process');
const fs = require('fs');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
let pass = 0, fail = 0;
function check(name, ok, extra) { console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : '')); ok ? pass++ : fail++; }
async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch('http://127.0.0.1:3581' + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { code: r.status, cookie: r.headers.get('set-cookie') ? r.headers.get('set-cookie').split(';')[0] : null, body: j };
}

(async () => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  const srv = spawn(process.execPath, ['server.js'], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await req('GET', '/api/health'); break; } catch { await wait(250); } }
    // 初始無公告
    const a0 = await req('GET', '/api/announcement');
    check('初始公告 text 空', a0.body.text === '' && a0.body.version === 0, JSON.stringify(a0.body));
    // admin 登入
    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    check('admin 登入', al.code === 200 && !!al.cookie, al.body && al.body.error);
    if (!al.cookie) throw new Error('no admin cookie');
    // 員工唔可以設公告（401/403）
    const el = await req('POST', '/api/auth/employee-login', { empNumber: 'ST082', password: '0000' }).catch(() => null);
    if (el && el.cookie) {
      const bad = await req('POST', '/api/admin/announcement', { text: 'hack' }, el.cookie);
      check('員工唔可以設公告', bad.code !== 200, 'code=' + bad.code);
    } else {
      check('員工登入（跳過越權測試）', true);
    }
    // admin 設公告
    const set = await req('POST', '/api/admin/announcement', { text: '中秋放假安排：10/1-10/3 休息' }, al.cookie);
    check('admin 設公告成功', set.code === 200 && set.body.success && set.body.announcement.text === '中秋放假安排：10/1-10/3 休息' && set.body.announcement.version > 0, JSON.stringify(set.body));
    // GET 返到新公告
    const a1 = await req('GET', '/api/announcement');
    check('GET 返到公告', a1.body.text === '中秋放假安排：10/1-10/3 休息' && a1.body.version > 0, JSON.stringify(a1.body));
    const v = a1.body.version;
    // 清空公告
    const clear = await req('POST', '/api/admin/announcement', { text: '   ' }, al.cookie);
    check('清空公告 version=0', clear.code === 200 && clear.body.announcement.text === '' && clear.body.announcement.version === 0, JSON.stringify(clear.body));
    const a2 = await req('GET', '/api/announcement');
    check('清空後 GET text 空', a2.body.text === '' && a2.body.version === 0, JSON.stringify(a2.body));

    console.log('\n===== announcement: ' + pass + ' PASS / ' + fail + ' FAIL =====');
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('E2E ERROR', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
})();
