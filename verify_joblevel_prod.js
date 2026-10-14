const https = require('https');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
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
  const cookie = login.cookie && login.cookie[0].split(';')[0];
  console.log('LOGIN code:', login.code, '| hasCookie:', !!cookie, '| body:', login.body.slice(0, 120));
  // employees
  const empRaw = await req('GET', '/api/admin/employees', null, cookie);
  console.log('EMP code:', empRaw.code, '| body head:', empRaw.body.slice(0, 200));
  const emp = await req('GET', '/api/admin/employees', null, cookie);
  const ej = JSON.parse(emp.body);
  const emps = ej.employees || [];
  const jl = ej.jobLevels || [];
  const validKeys = new Set(jl.map(l => l.key));
  const onInvalid = emps.filter(e => !validKeys.has(e.level));
  console.log('EMP total:', emps.length, '| on-invalid-key:', onInvalid.length, onInvalid.map(e => e.emp_number + ':' + e.level).join(',') || '(none)');
  const byLevel = {};
  emps.forEach(e => { byLevel[e.level] = (byLevel[e.level] || 0) + 1; });
  console.log('BY LEVEL:', JSON.stringify(byLevel));
  // guarantee mgmt on new exempt keys
  const mgmt = emps.filter(e => ['AAM', 'DGM', 'GM', 'OPM'].includes(e.level));
  console.log('MGMT (expect exempt):', mgmt.map(e => e.emp_number + '=' + e.level).join(', '));
  const tech = emps.filter(e => ['D.supervisor', 'senior', 'junior', 'P.junior', 'P.senior', 'PD.supervisor', 'P.supervisor', 'supervisor'].includes(e.level));
  console.log('TECH count (expect get allowance):', tech.length);

  // allowance admin view: check mgmt exempt + a tech gets 2400
  const al = await req('GET', '/api/admin/allowance?month=2026-09', null, cookie);
  const alj = JSON.parse(al.body);
  const rows = alj.rows || [];
  const find = n => rows.find(r => r.emp_number === n);
  ['GH', 'Helen', 'Jackson', 'ST065', 'ST140', 'ST340'].forEach(n => {
    const r = find(n);
    console.log('ALLOWANCE', n, '->', r ? ('$' + r.total + ' active=' + r.activeCount) : 'NOT IN LIST (exempt OK)');
  });
  const st273 = find('ST273');
  console.log('ALLOWANCE ST273 (junior tech) ->', st273 ? '$' + st273.total + ' active=' + st273.activeCount : '?');
  const st082 = find('ST082');
  console.log('ALLOWANCE ST082 (D.supervisor) ->', st082 ? '$' + st082.total + ' active=' + st082.activeCount : '?');

  // guaranteed_pay levels migrated
  const gp = await req('GET', '/api/admin/guaranteed-pay?month=2026-09', null, cookie);
  const gpj = JSON.parse(gp.body);
  console.log('GP levels keys:', gpj.levels ? Object.keys(gpj.levels).join(',') : '(n/a)');
  console.log('GP D.supervisor:0/1 =', gpj.levels ? (gpj.levels['D.supervisor:0'] + '/' + gpj.levels['D.supervisor:1']) : '?', '| old d:0/1 =', gpj.levels ? (gpj.levels['d:0'] ?? 'gone') + '/' + (gpj.levels['d:1'] ?? 'gone') : '?');

  console.log('DONE');
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
