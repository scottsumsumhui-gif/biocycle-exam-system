const https = require('https');
const bcrypt = require('bcryptjs');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const USER = 'ST140', PW = '61583398';

function req(path, method, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const o = new URL(BASE + path);
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (cookie) headers['Cookie'] = cookie;
    const r = https.request({ hostname: o.hostname, path: o.pathname, method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'], body: d }));
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('/api/auth/admin-login', 'POST', { username: USER, password: PW });
  const ok = login.body.includes('"success":true') || login.body.includes('"success": true');
  if (!ok) { console.log('LOGIN FAIL:', login.code, login.body); return; }
  const cookie = login.cookie ? login.cookie.map(c => c.split(';')[0]).join('; ') : null;
  const emp = await req('/api/admin/employees', 'GET', null, cookie);
  let j;
  try { j = JSON.parse(emp.body); } catch (e) { console.log('EMP PARSE FAIL:', emp.code, emp.body.slice(0,300)); return; }
  if (!j.success) { console.log('EMP FAIL:', emp.code, JSON.stringify(j).slice(0,300)); return; }
  const arr = j.employees || [];
  const def = [];
  const noHash = [];
  for (const e of arr) {
    if (!e.password_hash) { noHash.push(e); continue; }
    if (bcrypt.compareSync('0000', e.password_hash)) def.push(e);
  }
  console.log('TOTAL_EMPLOYEES:', arr.length);
  console.log('ON_DEFAULT_0000:', def.length);
  def.forEach(e => console.log('  DEFAULT ->', e.emp_number, e.name, '| level:', e.level, '| group:', e.group_name));
  console.log('NO_HASH:', noHash.length);
  noHash.forEach(e => console.log('  NOHASH ->', e.emp_number, e.name));
  if (def.length === 0 && noHash.length === 0) console.log('RESULT: ALL good, nobody on default 0000');
})();
