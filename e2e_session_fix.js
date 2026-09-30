// e2e：修復 (1) 員工/管理員分開 cookie 名，唔會互揜 session；(2) /api 加 no-store 禁快取
const path = require('path');
const ROOT = path.resolve(__dirname);
process.chdir(ROOT);
process.env.PORT = '3586';
const { spawn } = require('child_process');
const fs = require('fs');
const DATA = path.join(ROOT, 'data');
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
let pass = 0, fail = 0;
function check(name, ok, extra) { console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : '')); ok ? pass++ : fail++; }
async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch('http://127.0.0.1:3586' + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  let j = null; try { j = await r.json(); } catch (e) {}
  return { code: r.status, cookie: sc ? sc.split(';')[0] : null, body: j, cc: r.headers.get('cache-control') };
}
(async () => {
  const FILES = ['sessions.json'];
  const backup = {};
  for (const f of FILES) { const fp = path.join(DATA, f); backup[f] = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null; }
  const srv = spawn(process.execPath, ['server.js'], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { const r = await fetch('http://127.0.0.1:3586/api/health'); if (r.ok) break; } catch { await wait(250); } }
    // no-store header on /api
    const h = await fetch('http://127.0.0.1:3586/api/health');
    check('/api 有 no-store 禁快取', (h.headers.get('cache-control') || '').includes('no-store'), h.headers.get('cache-control'));

    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    const el = await req('POST', '/api/auth/employee-login', { empNumber: 'ST82', password: '0000' });
    check('admin 登入', al.code === 200 && !!al.cookie);
    check('員工登入', el.code === 200 && !!el.cookie);
    check('admin cookie 用 admin_session_id', !!al.cookie && al.cookie.startsWith('admin_session_id=') && !al.cookie.startsWith('session_id='));
    check('員工 cookie 用 session_id', !!el.cookie && el.cookie.startsWith('session_id=') && !el.cookie.includes('admin_session_id'));

    // 分隔：員工 cookie 入唔到 admin 路由；admin cookie 入唔到員工路由
    const empToAdmin = await req('GET', '/api/admin/commission/records', null, el.cookie);
    check('員工 cookie 入 admin 路由 → 401（分隔）', empToAdmin.code === 401, 'code=' + empToAdmin.code);
    const adminToEmp = await req('GET', '/api/tech-leads/records', null, al.cookie);
    check('admin cookie 入員工路由 → 401（分隔）', adminToEmp.code === 401, 'code=' + adminToEmp.code);
    const empOk = await req('GET', '/api/tech-leads/records', null, el.cookie);
    check('員工 cookie 入員工路由 → 200', empOk.code === 200);
    const adminOk = await req('GET', '/api/admin/tech-leads/records', null, al.cookie);
    check('admin cookie 入 admin 路由 → 200', adminOk.code === 200);

    // 同一 browser 先 employee 再 admin（模擬同一 domain 兩個 cookie 共存不互揜）
    const both = el.cookie + '; ' + al.cookie;
    const empStill = await req('GET', '/api/tech-leads/records', null, both);
    const adminStill = await req('GET', '/api/admin/tech-leads/records', null, both);
    check('兩個 cookie 共存：員工路由仍 200', empStill.code === 200);
    check('兩個 cookie 共存：admin 路由仍 200', adminStill.code === 200);

    // 頁面 script 語法檢查
    const vm = require('vm');
    for (const f of ['public/index.html', 'public/admin.html']) {
      const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      let allOk = true, firstErr = '';
      for (const b of blocks) { try { new vm.Script(b[1]); } catch (e) { allOk = false; firstErr = e.message; } }
      check(f + ' 所有 script 可解析', allOk, firstErr);
    }
    console.log('\n===== session-fix: ' + pass + ' PASS / ' + fail + ' FAIL =====');
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.error('E2E ERROR', e); process.exitCode = 1; }
  finally {
    srv.kill(); await wait(300);
    for (const f of FILES) { const fp = path.join(DATA, f); if (backup[f] === null) { try { fs.unlinkSync(fp); } catch (e) {} } else fs.writeFileSync(fp, backup[f], 'utf8'); }
  }
})();
