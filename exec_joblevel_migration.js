const https = require('https');
const fs = require('fs');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const DIR = 'C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system';

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

// 舊 key -> 新 key（按 prod 實際 label：e=見習技術員→P.junior, f=見習高級技術員→P.senior, h=見習技術員副主管→PD.supervisor, i=見習技術員主管→P.supervisor；f 併入 P.senior 後刪）
const RENAME = {
  a: 'AAM', c: 'DGM', g: 'GM', b: 'OPM', d: 'D.supervisor',
  e: 'P.junior', f: 'P.senior', h: 'PD.supervisor', i: 'P.supervisor'
};
const NEW_KEYS = [
  { key: 'AAM', label: 'Assistant Accounting Manager' },
  { key: 'DGM', label: 'DGM' },
  { key: 'GM', label: 'GM' },
  { key: 'OPM', label: '技術員經理' },
  { key: 'D.supervisor', label: '技術員副主管' },
  { key: 'P.senior', label: '見習高級技術員' },
  { key: 'PD.supervisor', label: '見習技術員副主管' },
  { key: 'P.supervisor', label: '見習技術員主管' },
  { key: 'P.junior', label: '見習技術員' }
];
const OLD_KEYS_DEL = ['a', 'b', 'c', 'd', 'e', 'g', 'h', 'i', 'f'];

(async () => {
  // 0) 等 deploy：poll health 最多 120s
  let waited = 0;
  while (waited < 120000) {
    try { const h = await req('GET', '/api/health'); if (h.body.includes('"redis"')) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 5000)); waited += 5000;
  }
  console.log('[0] health ready after', waited, 'ms');

  // 1) login
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  if (!login.body.includes('"success":true')) { console.log('LOGIN FAIL', login.body); return; }
  const cookie = login.cookie && login.cookie[0].split(';')[0];
  console.log('[1] LOGIN OK');

  // 2) backup export
  const bk = await req('GET', '/api/admin/backup/export', null, cookie);
  const bkPath = DIR + '/joblevel_backup_' + Date.now() + '.json';
  fs.writeFileSync(bkPath, bk.body);
  console.log('[2] BACKUP saved ->', bkPath, '(', bk.body.length, 'bytes )');

  // 3) GET current employees + job_levels
  const empResp = await req('GET', '/api/admin/employees', null, cookie);
  const empJson = JSON.parse(empResp.body);
  if (!empJson.success) { console.log('EMP FAIL', empJson); return; }
  const emps = empJson.employees || [];
  const jobLevels = empJson.jobLevels || [];
  const haveKey = k => jobLevels.some(l => l.key === k);
  console.log('[3] employees:', emps.length, '| jobLevels:', jobLevels.map(l => l.key).join(','));

  // 3.5) 等 deploy：probe 一個含句點嘅 key，直到新 code (容許句點) 生效
  let deployReady = false;
  for (let t = 0; t < 240000; t += 5000) {
    const pr = await req('POST', '/api/admin/job-levels', { key: 'z.probe', label: 'probe' }, cookie);
    const b = pr.body;
    if (b.includes('"success":true')) { await req('DELETE', '/api/admin/job-levels/z.probe', null, cookie); deployReady = true; break; }
    if (b.includes('句點')) { deployReady = true; break; } // 新 code 已 reject 但用新 msg → 新 code live
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!deployReady) { console.log('DEPLOY NOT READY (timeout) — 請等 Railway 部署 b655bea 後再跑'); return; }
  console.log('[3.5] deploy ready (新 code 容許句點)');

  // 4) POST 9 new keys (skip if exists)
  console.log('[4] POST new keys:');
  for (const nk of NEW_KEYS) {
    if (haveKey(nk.key)) { console.log('   skip (exists):', nk.key); continue; }
    const r = await req('POST', '/api/admin/job-levels', nk, cookie);
    console.log('   ', nk.key, '->', r.code, r.body.slice(0, 120));
  }

  // 5) PUT employees whose level is in RENAME map
  console.log('[5] PUT employees:');
  const puts = [];
  for (const e of emps) {
    if (RENAME[e.level]) puts.push({ id: e.id, emp_number: e.emp_number, name: e.name, from: e.level, to: RENAME[e.level] });
  }
  console.log('   matched', puts.length, 'employees:', puts.map(p => p.emp_number + ':' + p.from + '->' + p.to).join(', '));
  for (const p of puts) {
    const r = await req('PUT', '/api/admin/employees/' + p.id, { level: p.to }, cookie);
    console.log('   ', p.emp_number, '->', r.code, r.body.slice(0, 100));
    if (!r.body.includes('"success":true')) console.log('   !! PUT FAIL', p);
  }

  // 6) DELETE 9 old keys
  console.log('[6] DELETE old keys:');
  for (const ok of OLD_KEYS_DEL) {
    const r = await req('DELETE', '/api/admin/job-levels/' + ok, null, cookie);
    console.log('   ', ok, '->', r.code, r.body.slice(0, 120));
  }

  // 7) VERIFY
  console.log('[7] VERIFY:');
  const v = await req('GET', '/api/admin/employees', null, cookie);
  const vj = JSON.parse(v.body);
  const vemps = vj.employees || [];
  const vlevels = vj.jobLevels || [];
  const leftOld = vemps.filter(e => RENAME[e.level] || e.level === 'f');
  const presentOldKeys = vlevels.filter(l => OLD_KEYS_DEL.includes(l.key)).map(l => l.key);
  console.log('   employee count:', vemps.length);
  console.log('   employees still on old key:', leftOld.length, leftOld.map(e => e.emp_number + ':' + e.level).join(', ') || '(none)');
  console.log('   old job_level keys remaining:', presentOldKeys.length, presentOldKeys.join(',') || '(none)');
  console.log('   jobLevels now:', vlevels.map(l => l.key).join(','));
  // print moved employees
  puts.forEach(p => {
    const ne = vemps.find(e => e.emp_number === p.emp_number);
    console.log('   check', p.emp_number, p.name, '-> level=', ne ? ne.level : '?', '(expect', p.to + ')');
  });
  console.log('DONE');
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
