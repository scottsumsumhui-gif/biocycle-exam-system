// online_generate_allowance.js — 用線上真實員工名單生成完整津貼 store 並 import
// 用法：node online_generate_allowance.js
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const fs = require('fs');
const AAL = require('./allowance_logic.js');
const EXEMPT = new Set(['a', 'b', 'c', 'g', 'supervisor', 'i']);

(async () => {
  const lg = await fetch(BASE + '/api/auth/admin-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ST140', password: '61583398' })
  });
  const cookie = lg.headers.get('set-cookie');
  if (!cookie) { console.log('LOGIN FAIL', lg.status); return; }

  const e = await fetch(BASE + '/api/admin/employees', { headers: { Cookie: cookie } });
  const ej = await e.json();
  const list = ej.employees || ej || [];
  const eligible = list.filter(x => !EXEMPT.has(x.level) && !String(x.emp_number || '').startsWith('TEST'));
  console.log('線上 eligible 員工:', eligible.length, '(總', list.length, '人)');

  // seed steady state（全部合格 baseline，2026-02 起 $2,400）
  const store = AAL.newStore();
  AAL.seedSteadyState(store, eligible.map(x => x.emp_number), AAL.ALLOWANCE_TOPICS, '2026-02', '2028-12');

  // ST396 / ST405 蒼蠅鼠患 7 月不合格 → 停 7-9 月 + 補考 10 月
  for (const emp of ['ST396', 'ST405']) {
    if (store[emp]) AAL.applyExamEvent(store, emp, 7, '2026-07', false);
  }

  fs.writeFileSync('data/allowance_online.json', JSON.stringify(store, null, 2));
  console.log('本地備份已寫 data/allowance_online.json (', Object.keys(store).length, '人)');

  const imp = await fetch(BASE + '/api/admin/allowance/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ store })
  });
  console.log('import:', imp.status, JSON.stringify(await imp.json()));

  const a = await fetch(BASE + '/api/admin/allowance?month=2026-09', { headers: { Cookie: cookie } });
  const aj = await a.json();
  console.log('2026-09 驗證 => grandTotal=$' + aj.grandTotal,
    '| rows=' + aj.rows.length,
    '| $2400=' + aj.rows.filter(r => r.total === 2400).length,
    '| $2000=' + aj.rows.filter(r => r.total === 2000).length,
    '| makeupDue=' + aj.makeupDue.length);
})().catch(e => console.log('ERR', e.message));
