const https = require('https');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const PW = process.argv[2];
if (!PW) { console.error('usage: node backup_questions.js <adminPassword>'); process.exit(2); }

function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, headers: { 'Content-Type': 'application/json' }, hostname: new URL(BASE).host, path: p };
    if (cookie) opts.headers['Cookie'] = cookie;
    const r = https.request(opts, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'] ? res.headers['set-cookie'][0].split(';')[0] : null, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: PW });
  if (login.code !== 200) { console.error('LOGIN FAILED', login.body.slice(0, 120)); process.exit(1); }
  const cookie = login.cookie;
  const topics = { 1: 'IPM', 2: 'BioKill', 3: 'Termite', 4: 'OccSafe', 7: 'FliesRodents', 8: 'Cockroaches' };
  const out = {};
  for (const t of Object.keys(topics)) {
    const r = await req('GET', `/api/admin/questions/${t}`, null, cookie);
    if (r.code === 200) {
      const o = JSON.parse(r.body);
      out[t] = { name: topics[t], mc: o.mc || [], essay: o.essay || [] };
      console.log(`topic ${t} (${topics[t]}): MC ${out[t].mc.length}, Essay ${out[t].essay.length}`);
    } else {
      console.log(`topic ${t}: FETCH FAIL ${r.code}`);
    }
  }
  // backup with date stamp
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fn = `questions_backup_${stamp}.json`;
  require('fs').writeFileSync(fn, JSON.stringify(out, null, 2), 'utf-8');
  console.log('BACKUP WROTE', fn);
  // also dump topic 2 (BioKill) head for inspection
  const bk = out['2'];
  console.log('\n=== BioKill (topic 2) MC head 5 (new format reference) ===');
  for (let i = 0; i < Math.min(5, bk.mc.length); i++) console.log(JSON.stringify(bk.mc[i], null, 1));
  console.log('=== BioKill (topic 2) Essay head 3 ===');
  for (let i = 0; i < Math.min(3, bk.essay.length); i++) console.log(JSON.stringify(bk.essay[i], null, 1));
})();
