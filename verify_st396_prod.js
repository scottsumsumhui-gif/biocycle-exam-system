// 驗證 prod：ST396 / ST405 喺 2026-09 / 10 / 11 嘅津貼金額
// 預期：9月 $1600、10月 $1600、11月 $2400（10月補考合格後 11月恢復全數）
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

  // 等 deploy：IPM window 唔再係假 baseline
  let ok = false;
  for (let i = 1; i <= 14; i++) {
    const r = await req('GET', '/api/admin/allowance?month=2026-09', null, cookie);
    const j = JSON.parse(r.body);
    const row = (j.rows || []).find(x => x.emp_number === 'ST405');
    const ipm = row && row.breakdown.find(b => b.topic === 1);
    if (ipm && ipm.window !== '2026-02~2028-12') { ok = true; console.log('DEPLOY OK (第 ' + i + ' 次檢查)'); break; }
    console.log('等 deploy... (' + i + ') IPM window =', ipm ? ipm.window : 'n/a');
    await sleep(15000);
  }
  if (!ok) { console.log('未見新 code，放棄'); return; }

  for (const mm of ['2026-09', '2026-10', '2026-11']) {
    const r = await req('GET', '/api/admin/allowance?month=' + mm, null, cookie);
    const j = JSON.parse(r.body);
    console.log('\n===== ' + mm + ' 全體總額 $' + j.grandTotal + ' =====');
    for (const en of ['ST396', 'ST405', 'ST273']) {
      const row = (j.rows || []).find(x => x.emp_number === en);
      if (!row) { console.log('  ' + en + ' (無資料)'); continue; }
      const paid = row.breakdown.filter(b => b.active && !b.suspendedNow).map(b => b.name);
      console.log('  ' + en + ' ' + (row.name || '') + ' = $' + row.total + '  [' + paid.join(',') + ']');
    }
  }

  // ST396 詳細（2026-09）
  const r9 = await req('GET', '/api/admin/allowance?month=2026-09', null, cookie);
  const j9 = JSON.parse(r9.body);
  const s = (j9.rows || []).find(x => x.emp_number === 'ST396');
  console.log('\n--- ST396 @2026-09 逐卷 ---');
  for (const b of s.breakdown) {
    const susp = (b.suspensions || []).map(x => x.start + '~' + x.end + '(補考' + x.makeup_month + ')').join(',') || '-';
    console.log('  ' + String(b.name).padEnd(10), '津貼期=' + b.window, '| active=' + b.active, '| 停發中=' + b.suspendedNow, '| 停發=' + susp);
  }
  console.log('\n--- makeupDue ---');
  for (const m of (j9.makeupDue || [])) console.log('  ' + m.emp_number, m.name, m.topic_name, '補考', m.makeup_month, '| 停發', m.suspended_window);
})();
