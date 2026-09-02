#!/usr/bin/env node
// E2E test for job levels CRUD + employee validation + rename to 服務銷售
const http = require('http');

const BASE = 'http://localhost:3000';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const u = new URL(BASE + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        const newCookie = setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : null;
        let json;
        try { json = JSON.parse(buf); } catch (_) { json = buf; }
        resolve({ status: res.statusCode, body: json, newCookie, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(cond, label) {
  if (!cond) { console.log('  ✗ FAIL', label); process.exit(1); }
  console.log('  ✓', label);
}

(async () => {
  let cookie = null;
  let pass = 0, fail = 0;
  const T = (label, fn) => {
    return fn().then(ok => ok ? (pass++, assert(true, label)) : (fail++, assert(false, label))).catch(e => { fail++; console.log('  ✗ FAIL', label, '-', e.message); });
  };

  // 1. Login as ST140 (super)
  console.log('--- 1. Login as super admin ST140 ---');
  let r = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  assert(r.status === 200 && r.body.success, 'login as ST140');
  cookie = r.newCookie;
  console.log('  perms:', JSON.stringify(r.body.permissions));

  // 2. GET /api/admin/job-levels — should return 3 defaults
  console.log('--- 2. GET /api/admin/job-levels ---');
  r = await req('GET', '/api/admin/job-levels', null, cookie);
  assert(r.status === 200 && r.body.jobLevels && r.body.jobLevels.length === 3, '3 default job levels');
  console.log('  levels:', r.body.jobLevels.map(l => l.key + ':' + l.label).join(', '));
  const hasJunior = r.body.jobLevels.find(l => l.key === 'junior');
  const hasSenior = r.body.jobLevels.find(l => l.key === 'senior');
  const hasSupervisor = r.body.jobLevels.find(l => l.key === 'supervisor');
  assert(hasJunior && hasSenior && hasSupervisor, 'all 3 built-ins present');

  // 3. POST /api/admin/job-levels — add new level
  console.log('--- 3. POST add new level "intern" ---');
  r = await req('POST', '/api/admin/job-levels', {
    key: 'intern', label: '實習生', description: '跟車實習', order: 0
  }, cookie);
  assert(r.status === 200 && r.body.success, 'POST new level');
  r = await req('GET', '/api/admin/job-levels', null, cookie);
  const intern = r.body.jobLevels.find(l => l.key === 'intern');
  assert(intern && intern.label === '實習生', 'intern level exists');

  // 4. POST invalid key (uppercase) — should fail
  console.log('--- 4. POST invalid key (uppercase) ---');
  r = await req('POST', '/api/admin/job-levels', {
    key: 'BadKey!', label: 'bad'
  }, cookie);
  assert(!r.body.success && r.body.error.includes('key'), 'invalid key rejected');

  // 5. POST duplicate key — should fail
  console.log('--- 5. POST duplicate key ---');
  r = await req('POST', '/api/admin/job-levels', {
    key: 'junior', label: '重複'
  }, cookie);
  assert(!r.body.success && r.body.error.includes('已存在'), 'duplicate key rejected');

  // 6. PUT update label
  console.log('--- 6. PUT update label ---');
  r = await req('PUT', '/api/admin/job-levels/intern', {
    label: '實習技術員', description: '跟車實習三個月'
  }, cookie);
  assert(r.status === 200 && r.body.success, 'PUT update label');
  r = await req('GET', '/api/admin/job-levels', null, cookie);
  const intern2 = r.body.jobLevels.find(l => l.key === 'intern');
  assert(intern2.label === '實習技術員', 'label updated');

  // 7. GET /api/admin/employees — should include level_label
  console.log('--- 7. GET employees with level_label ---');
  r = await req('GET', '/api/admin/employees', null, cookie);
  assert(r.status === 200 && Array.isArray(r.body.employees), 'GET employees');
  assert(r.body.jobLevels && r.body.jobLevels.length === 4, 'employees response has 4 jobLevels');
  const sample = r.body.employees[0];
  assert(sample.level_label, 'employee has level_label');
  console.log('  sample:', sample.emp_number, '/', sample.level, '/', sample.level_label);

  // 8. POST employee with new level 'intern' — should work
  console.log('--- 8. POST employee with new level intern ---');
  const testEmpNum = 'TESTJL' + Date.now().toString().slice(-5);
  r = await req('POST', '/api/admin/employees', {
    empNumber: testEmpNum, name: '實習生測試', level: 'intern',
    group: 'A', password: '0000'
  }, cookie);
  assert(r.status === 200 && r.body.success, 'POST employee with intern level');
  r = await req('GET', '/api/admin/employees', null, cookie);
  const newEmp = r.body.employees.find(e => e.emp_number === testEmpNum);
  assert(newEmp && newEmp.level === 'intern', 'employee created with intern level');

  // 9. POST employee with invalid level — should fail
  console.log('--- 9. POST employee with invalid level ---');
  r = await req('POST', '/api/admin/employees', {
    empNumber: 'BAD' + Date.now(), name: 'X', level: 'nonsense', group: 'A'
  }, cookie);
  assert(!r.body.success && r.body.error.includes('職級'), 'invalid level rejected on POST');

  // 10. PUT employee to intern level — should work
  console.log('--- 10. PUT employee to intern ---');
  r = await req('PUT', '/api/admin/employees/' + newEmp.id, {
    name: newEmp.name, empNumber: newEmp.emp_number, level: 'junior', group: 'A'
  }, cookie);
  assert(r.status === 200 && r.body.success, 'PUT update level');

  // 11. DELETE in use level — should fail
  console.log('--- 11. DELETE in-use level intern (now used by new emp after re-update) ---');
  r = await req('PUT', '/api/admin/employees/' + newEmp.id, {
    name: newEmp.name, empNumber: newEmp.emp_number, level: 'intern', group: 'A'
  }, cookie);
  assert(r.body.success, 'PUT back to intern');
  r = await req('DELETE', '/api/admin/job-levels/intern', null, cookie);
  assert(!r.body.success && r.body.error.includes('使用'), 'in-use level deletion rejected');

  // 12. Move employee off intern, then DELETE intern
  console.log('--- 12. Move emp to junior, then DELETE intern ---');
  r = await req('PUT', '/api/admin/employees/' + newEmp.id, {
    name: newEmp.name, empNumber: newEmp.emp_number, level: 'junior', group: 'A'
  }, cookie);
  assert(r.body.success, 'moved emp to junior');
  r = await req('DELETE', '/api/admin/job-levels/intern', null, cookie);
  assert(r.body.success, 'intern deleted');
  r = await req('GET', '/api/admin/job-levels', null, cookie);
  assert(r.body.jobLevels.length === 3, 'back to 3 levels');
  assert(!r.body.jobLevels.find(l => l.key === 'intern'), 'intern removed');

  // 13. Cleanup: delete test employee
  console.log('--- 13. Cleanup test employee ---');
  r = await req('DELETE', '/api/admin/employees/' + newEmp.id, null, cookie);
  assert(r.body.success, 'test emp deleted');

  // 14. Non-super admin tries to add — should 403. Skip password reset (would corrupt data);
// rely on existing RBAC test (test_rbac.js) to cover super-vs-non-super authorization.
  console.log('--- 14. Non-super authorization (skipped, covered by test_rbac.js) ---');
  console.log('  (skipped to avoid mutating real admin password hashes)');

  console.log('');
  console.log('==============================');
  console.log('ALL E2E PASS:', pass, '/', pass + fail);
  console.log('==============================');
})();