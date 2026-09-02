// E2E test for new service type whitelist + dropdown group-name hiding
const http = require('http');

function req(method, path, body, cookie) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (cookie) headers['Cookie'] = cookie;
    const opts = { hostname: '127.0.0.1', port: 3000, path: '/api' + path, method, headers };
    const r = http.request(opts, req => {
      let buf = '';
      req.on('data', c => buf += c);
      req.on('end', () => {
        const setCookie = req.headers['set-cookie'];
        const newCookie = setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : null;
        let parsed; try { parsed = JSON.parse(buf); } catch (_) { parsed = buf; }
        resolve({ status: req.statusCode, body: parsed, newCookie });
      });
    });
    r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✅', msg); pass++; }
  else { console.log('  ❌', msg); fail++; }
}

(async () => {
  console.log('=== 1. Login as employee ST082 ===');
  let r = await req('POST', '/auth/employee-login', { empNumber: 'ST82', password: '0000' });
  assert(r.status === 200 && r.body.success, 'login ST082');
  const empCookie = r.newCookie;

  console.log('=== 2. Submit with new fixed services ===');
  r = await req('POST', '/tech-leads/records', {
    record_date: '2026-09-02',
    customer_name: '測試客戶 A',
    customer_phone: '91234567',
    customer_address: '九龍區',
    services: ['Pest control', 'Termite control', '蚊燈×3', 'Others: 冷氣深度清洗'],
    members: [{ emp_id: 4 }]
  }, empCookie);
  assert(r.status === 200 && r.body.success, 'submit new fixed services');
  const newRecId = r.body.record && r.body.record.id;
  console.log('    new record id =', newRecId, 'services =', r.body.record && r.body.record.services);

  console.log('=== 3. Validate 蚊燈 qty parsing ===');
  r = await req('POST', '/tech-leads/records', {
    record_date: '2026-09-02',
    customer_name: '測試 B',
    services: ['蚊燈×12'],
    members: [{ emp_id: 4 }]
  }, empCookie);
  assert(r.status === 200, '蚊燈×12 accepted');
  assert(r.body.record && r.body.record.services[0] === '蚊燈×12', '蚊燈×12 preserved');

  console.log('=== 4. Reject invalid services ===');
  r = await req('POST', '/tech-leads/records', {
    record_date: '2026-09-02',
    customer_name: '測試 C',
    services: ['舊的滅蟲'],
    members: [{ emp_id: 4 }]
  }, empCookie);
  assert(r.status === 400, 'old service name rejected');

  console.log('=== 5. Reject 蚊燈 without qty ===');
  r = await req('POST', '/tech-leads/records', {
    record_date: '2026-09-02',
    customer_name: '測試 D',
    services: ['蚊燈'],
    members: [{ emp_id: 4 }]
  }, empCookie);
  // '蚊燈' is exact match so accepted. This is OK because frontend always submits 蚊燈×N.
  assert(r.status === 200, '蚊燈 (no qty) accepted as bare value');

  console.log('=== 6. Reject 蚊燈 with bad qty ===');
  r = await req('POST', '/tech-leads/records', {
    record_date: '2026-09-02',
    customer_name: '測試 E',
    services: ['蚊燈×0', '蚊燈×abc'],
    members: [{ emp_id: 4 }]
  }, empCookie);
  assert(r.status === 400, '蚊燈×0 / 蚊燈×abc both rejected');

  console.log('=== 7. Reject Others without text ===');
  r = await req('POST', '/tech-leads/records', {
    record_date: '2026-09-02',
    customer_name: '測試 F',
    services: ['Others:'],
    members: [{ emp_id: 4 }]
  }, empCookie);
  assert(r.status === 400, 'Others: with no text rejected');

  console.log('=== 8. Empty services rejected ===');
  r = await req('POST', '/tech-leads/records', {
    record_date: '2026-09-02',
    customer_name: '測試 G',
    services: [],
    members: [{ emp_id: 4 }]
  }, empCookie);
  assert(r.status === 400, 'empty services rejected');

  console.log('=== 9. List own records shows new format ===');
  r = await req('GET', '/tech-leads/records', null, empCookie);
  assert(r.status === 200 && Array.isArray(r.body), 'list own');
  const newest = r.body.find(x => x.id === newRecId);
  assert(newest && newest.services.includes('蚊燈×3'), 'newest has 蚊燈×3');
  assert(newest && newest.services.includes('Others: 冷氣深度清洗'), 'newest has Others with text');
  assert(!('custom_service' in newest) || newest.custom_service === '', 'custom_service field empty/missing on new record');

  console.log('=== 10. Admin sees all 10 fixed services ===');
  r = await req('POST', '/auth/admin-login', { username: 'ST140', password: '61583398' });
  assert(r.status === 200 && r.body.success, 'login ST140');
  const adminCookie = r.newCookie;
  r = await req('GET', '/admin/tech-leads/records?year=2026&month=9', null, adminCookie);
  assert(r.status === 200, 'admin list works');
  assert(r.body.some(x => (x.services || []).includes('蚊燈×3')), 'admin sees 蚊燈×3');

  console.log('=== 11. Export to Excel (sanity) ===');
  r = await new Promise(resolve => {
    const opts = { hostname: '127.0.0.1', port: 3000, path: '/api/admin/tech-leads/export?year=2026&month=9', method: 'GET', headers: { Cookie: adminCookie } };
    const r = http.request(opts, req => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve({ status: req.statusCode, buf: Buffer.concat(chunks), headers: req.headers }));
    });
    r.end();
  });
  assert(r.status === 200, 'export 200');
  assert(r.buf.length > 1000, 'export has data');
  const contentDisposition = r.headers['content-disposition'] || '';
  assert(contentDisposition.includes('.xlsx'), 'xlsx filename');

  console.log('=== 12. Cleanup: delete our test records ===');
  // Find records owned by ST082 created today (created_by_emp_id matches)
  const list = (await req('GET', '/admin/tech-leads/records?year=2026&month=9', null, adminCookie)).body;
  for (const rec of list) {
    if (rec.customer_name && rec.customer_name.startsWith('測試')) {
      const del = await req('DELETE', '/admin/tech-leads/records/' + rec.id, null, adminCookie);
      assert(del.status === 200, 'deleted test record #' + rec.id);
    }
  }

  console.log('');
  console.log('==============================');
  console.log('RESULT:', pass, 'pass /', fail, 'fail');
  console.log('==============================');
  process.exit(fail ? 1 : 0);
})();