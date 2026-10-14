const https = require('https');
const fs = require('fs');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const OUT = 'C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system/allowance_raw_store.json';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const r = https.request(BASE + path, { method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'], body: d }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  if (!login.body.includes('"success":true')) { console.log('LOGIN FAIL', login.body); return; }
  const cookie = login.cookie && login.cookie[0].split(';')[0];
  console.log('LOGIN OK, cookie set');

  const bak = await req('GET', '/api/admin/backup/export', null, cookie);
  console.log('BACKUP code', bak.code, 'len', bak.body.length);
  let json;
  try { json = JSON.parse(bak.body); } catch (e) { console.log('PARSE FAIL', e.message, bak.body.slice(0, 300)); return; }
  const allow = json.data && json.data['allowance.json'];
  if (!allow) { console.log('NO allowance.json in backup'); return; }

  fs.writeFileSync(OUT, JSON.stringify(allow, null, 2));
  const keys = Object.keys(allow);
  console.log('EMP KEYS:', keys.length);
  console.log('EXPORTED ->', OUT);
  // show one sample structure
  const sk = keys[0];
  console.log('SAMPLE KEY:', sk);
  console.log(JSON.stringify(allow[sk], null, 2).slice(0, 1800));
})();
