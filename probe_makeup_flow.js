// 查 prod：ST396/ST405 職級 / group / 有無作文；同 10 月 exam config 狀態
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
  const cookie = login.cookie[0].split(';')[0];

  const emp = await req('GET', '/api/admin/employees', null, cookie);
  const emps = JSON.parse(emp.body);
  const arr = Array.isArray(emps) ? emps : (emps.employees || []);
  for (const en of ['ST396', 'ST405']) {
    const e = arr.find(x => x.emp_number === en);
    if (!e) { console.log(en, 'not found'); continue; }
    console.log(en, '| name=' + e.name, '| level=' + e.level, '| group=' + (e.group || '-'), '| active=' + e.is_active);
  }

  // 現有 exam config
  const cfg = await req('GET', '/api/admin/exam-config', null, cookie);
  let cj; try { cj = JSON.parse(cfg.body); } catch (e) { console.log('exam-config raw:', cfg.body.slice(0, 300)); cj = null; }
  if (cj) {
    const list = Array.isArray(cj) ? cj : (cj.configs || cj.data || []);
    console.log('\n=== exam config (' + list.length + ') ===');
    for (const c of list) {
      console.log('  id=' + c.id, 'topic=' + c.topic_id + '/' + (c.topic_name || ''), c.year + '-' + String(c.month).padStart(2, '0'),
        '| start=' + c.start_date, 'end=' + c.end_date, '| active=' + c.is_active, '| groups=' + JSON.stringify(c.groups));
    }
  }

  // 10 月津貼（睇 makeupDue）
  const al = await req('GET', '/api/admin/allowance?month=2026-10', null, cookie);
  const aj = JSON.parse(al.body);
  console.log('\n=== makeupDue @2026-10 ===');
  for (const m of (aj.makeupDue || [])) console.log('  ' + m.emp_number, m.name, m.topic_name, '補考', m.makeup_month, '| 停發', m.suspended_window);
})();
