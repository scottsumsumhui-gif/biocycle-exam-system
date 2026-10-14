// 等 Railway deploy 完，驗證 prod 津貼顯示 = 逐卷真津貼期
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  const cookie = login.cookie[0].split(';')[0];

  let ok = false;
  for (let i = 1; i <= 12; i++) {
    const r = await req('GET', '/api/admin/allowance?month=2026-09', null, cookie);
    const j = JSON.parse(r.body);
    const row = (j.rows || []).find(x => x.emp_number === 'ST405');
    const ipm = row && row.breakdown.find(b => b.topic === 1);
    if (ipm && ipm.window !== '2026-02~2028-12') { ok = true; console.log('DEPLOY OK (第 ' + i + ' 次檢查)'); break; }
    console.log('等 deploy... (' + i + ') IPM window =', ipm ? ipm.window : 'n/a');
    await sleep(15000);
  }
  if (!ok) { console.log('⚠️ 未見新 code'); return; }

  const r = await req('GET', '/api/admin/allowance?month=2026-09', null, cookie);
  const j = JSON.parse(r.body);
  console.log('\n=== 2026-09 全體總額 $' + j.grandTotal + ' | 人數 ' + j.rows.length + ' ===');
  console.log('=== makeupDue ===');
  for (const m of j.makeupDue) console.log(' ', m.emp_number, m.name, m.topic_name, '補考', m.makeup_month, '| 停發', m.suspended_window);
  for (const en of ['ST396', 'ST405', 'ST273']) {
    const row = j.rows.find(x => x.emp_number === en);
    if (!row) continue;
    console.log('\n--- ' + en + ' ' + row.name + ' @2026-09 total $' + row.total + ' ---');
    for (const b of row.breakdown) {
      const susp = (b.suspensions || []).map(s => s.start + '~' + s.end + '(補考' + s.makeup_month + ')').join(',') || '-';
      console.log('  ' + String(b.name).padEnd(8), '津貼期=' + b.window, '| active=' + b.active, '| 停發中=' + b.suspendedNow, '| 停發=' + susp, '| 上次=' + b.lastExamMonth + '/' + b.lastResult);
    }
  }
})();
