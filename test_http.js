const http = require('http');
const BASE = 'http://127.0.0.1:3000';

function req(path, method, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request(BASE + path, { method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, setCookie: res.headers['set-cookie'], body: d }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('/api/auth/employee-login', 'POST', { empNumber: 'ST273', password: '0000' });
  console.log('LOGIN', login.code, login.body);
  const cookie = login.setCookie ? login.setCookie.map(c => c.split(';')[0]).join('; ') : null;
  console.log('COOKIE:', cookie ? 'yes' : 'NO');

  const a = await req('/api/allowance/me', 'GET', null, cookie);
  console.log('\n--- /api/allowance/me ---', a.code);
  console.log(a.body);

  const o = await req('/api/worktime/my-ot?month=2026-09', 'GET', null, cookie);
  console.log('\n--- /api/worktime/my-ot?month=2026-09 ---', o.code);
  console.log(o.body);

  const o2 = await req('/api/worktime/my-ot?month=2026-05', 'GET', null, cookie);
  console.log('\n--- /api/worktime/my-ot?month=2026-05 (no data) ---', o2.code);
  console.log(o2.body);
})();
