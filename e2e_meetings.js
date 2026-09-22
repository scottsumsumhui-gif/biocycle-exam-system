// e2e：會議記錄（2026-09-22）
// 流程：admin 上傳 → 員工前台睇到 → 排序（新日期先）→ 驗證擋截 → 員工冇權上傳 → 刪除
// 本地檔案模式（無 Redis），port 3021，跑完還原 data/meeting_records.json
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
  const mPath = path.join(DIR, 'data', 'meeting_records.json');
  const mBackup = fs.existsSync(mPath) ? fs.readFileSync(mPath) : null;

  const child = spawn(NODE, ['server.js'], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitServer(40);
    console.log('server up on ' + PORT);

    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    const ac = al.cookie;
    check('admin login', al.code === 200 && !!ac, al.body.slice(0, 100));

    const el = await req('POST', '/api/auth/employee-login', { empNumber: 'ST320', password: '0000' });
    let ec = el.cookie;
    if (!ec) {
      // 後備：搵一個 pw=0000 員工
      const bcryptjs = require('bcryptjs');
      const emps = j(fs.readFileSync(path.join(DIR, 'data', 'employees.json'), 'utf8')) || [];
      const c = emps.find(e => e.password_hash && bcryptjs.compareSync('0000', e.password_hash));
      if (!c) throw new Error('搵唔到測試員工');
      const el2 = await req('POST', '/api/auth/employee-login', { empNumber: c.emp_number, password: '0000' });
      ec = el2.cookie;
    }
    check('employee login', el.code === 200 && !!ec, el.body.slice(0, 100));

    // 1) 開始時：員工睇 → 空
    let r1 = j((await req('GET', '/api/meetings', null, ec)).body);
    check('員工 GET /api/meetings success', r1 && r1.success === true, r1);
    check('開始時 0 份會議', (r1.meetings || []).length === 0, r1.meetings);

    // 2) admin 上傳兩份（一份 9/20、一份 9/15，測排序）
    const c1 = await req('POST', '/api/admin/meetings', { title: '九月技術會議', date: '2026-09-20', content: '第一份內容\n第二行' }, ac);
    check('admin 上傳 #1', c1.code === 200 && j(c1.body).success, c1.body.slice(0, 150));
    const m1 = j(c1.body).meeting || {};
    check('記錄有 id', !!m1.id, m1);
    check('記錄有上傳人', !!m1.by_name, m1);
    const c2 = await req('POST', '/api/admin/meetings', { title: '九月中層會議', date: '2026-09-15', content: '較早嘅會議' }, ac);
    check('admin 上傳 #2', c2.code === 200 && j(c2.body).success, c2.body.slice(0, 150));
    const m2 = j(c2.body).meeting || {};

    // 3) 員工睇到 2 份，新日期排先
    let r2 = j((await req('GET', '/api/meetings', null, ec)).body);
    check('員工睇到 2 份', (r2.meetings || []).length === 2, r2.meetings && r2.meetings.length);
    check('排序：9/20 排先', r2.meetings[0] && r2.meetings[0].title === '九月技術會議', r2.meetings && r2.meetings.map(x => x.title));
    check('內容完整（含換行）', r2.meetings[0] && r2.meetings[0].content === '第一份內容\n第二行', r2.meetings[0] && r2.meetings[0].content);

    // 4) 驗證擋截
    const b1 = await req('POST', '/api/admin/meetings', { title: '', date: '2026-09-20', content: 'x' }, ac);
    check('空標題擋截', b1.code === 400, b1.code);
    const b2 = await req('POST', '/api/admin/meetings', { title: 'x', date: '20/09/2026', content: 'x' }, ac);
    check('錯日期擋截', b2.code === 400, b2.code);
    const b3 = await req('POST', '/api/admin/meetings', { title: 'x', date: '2026-09-20', content: '  ' }, ac);
    check('空內容擋截', b3.code === 400, b3.code);

    // 5) 員工冇權上傳／刪除
    const ePost = await req('POST', '/api/admin/meetings', { title: 'hack', date: '2026-09-20', content: 'x' }, ec);
    check('員工 POST admin 端點被擋', ePost.code === 403 || ePost.code === 401, ePost.code);
    const eDel = await req('DELETE', '/api/admin/meetings/' + m1.id, null, ec);
    check('員工 DELETE 被擋', eDel.code === 403 || eDel.code === 401, eDel.code);

    // 6) 刪除：成功 → 再刪 404 → 列表歸 1
    const d1 = await req('DELETE', '/api/admin/meetings/' + m1.id, null, ac);
    check('admin 刪除 #1', d1.code === 200 && j(d1.body).success, d1.body.slice(0, 100));
    const d2 = await req('DELETE', '/api/admin/meetings/' + m1.id, null, ac);
    check('重複刪除 404', d2.code === 404, d2.code);
    let r3 = j((await req('GET', '/api/meetings', null, ec)).body);
    check('刪除後剩 1 份', (r3.meetings || []).length === 1, r3.meetings && r3.meetings.length);
    check('剩低係 9/15 嗰份', r3.meetings[0] && r3.meetings[0].title === '九月中層會議');

    // 7) 未登入被擋
    const anon = await req('GET', '/api/meetings');
    check('未登入 GET 被擋', anon.code === 401 || anon.code === 403, anon.code);

    console.log('\n===== 結果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  } catch (e) {
    console.error('E2E ERROR:', e && e.stack || e); fail++;
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 800));
    if (mBackup) fs.writeFileSync(mPath, mBackup); else { try { fs.unlinkSync(mPath); } catch (e) {} }
    console.log('已還原 meeting_records.json');
  }
  process.exit(fail ? 1 : 0);
})();
