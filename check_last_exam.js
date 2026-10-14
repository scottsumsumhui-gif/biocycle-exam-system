// 查上次考試（Topic 8）有無出 Q4（MC index 3）
// 用法: node check_last_exam.js <adminPassword>
const https = require('https');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const PW = process.argv[2];
if (!PW) { console.error('usage: node check_last_exam.js <adminPassword>'); process.exit(2); }

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

// === 同 server.js selectExamQuestions 一模一樣嘅邏輯 ===
function selectMC(mcQuestions, emp, tid, monthVal, mcCount) {
  const seen = new Set();
  const uniqueMC = [];
  for (const q of mcQuestions) {
    if (!q || !q.question) continue;
    const key = q.question.split('\n')[0].trim();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueMC.push(q);
  }
  const seedNum = tid * 10000 + emp.id * 100 + monthVal;
  for (let i = uniqueMC.length - 1; i > 0; i--) {
    const j = (seedNum + i * 7 + 13) % (i + 1);
    [uniqueMC[i], uniqueMC[j]] = [uniqueMC[j], uniqueMC[i]];
  }
  return uniqueMC.slice(0, mcCount);
}

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: PW });
  if (login.code !== 200) { console.error('LOGIN FAILED', login.body.slice(0, 120)); process.exit(1); }
  const cookie = login.cookie;

  const cfg = JSON.parse((await req('GET', '/api/admin/exam-config', null, cookie)).body).configs || [];
  const resultsRaw = JSON.parse((await req('GET', '/api/admin/results', null, cookie)).body);
  const results = resultsRaw.results || resultsRaw.data || (Array.isArray(resultsRaw) ? resultsRaw : []);
  const emps = JSON.parse((await req('GET', '/api/admin/employees', null, cookie)).body).employees || [];
  const t8 = JSON.parse((await req('GET', '/api/admin/questions/8', null, cookie)).body);
  const mc8 = t8.mc || [];

  console.log('=== 考試配置（近 6 個）===');
  const sorted = [...cfg].sort((a, b) => (b.year - a.year) || (b.month - a.month));
  for (const c of sorted.slice(0, 6)) console.log(`  ${c.year}-${String(c.month).padStart(2, '0')} topic=${c.topic_id} active=${c.is_active} ${c.start_date}~${c.end_date}`);

  // 揀「上次考試」：有成績記錄入面最新嘅 year/month/topic
  const byMonth = {};
  for (const r of results) {
    const k = `${r.year}-${String(r.month).padStart(2, '0')}`;
    byMonth[k] = byMonth[k] || { year: r.year, month: r.month, topics: {} };
    byMonth[k].topics[r.topic_id] = (byMonth[k].topics[r.topic_id] || 0) + 1;
  }
  const months = Object.values(byMonth).sort((a, b) => (b.year - a.year) || (b.month - a.month));
  console.log('\n=== 有成績嘅考試月份 ===');
  for (const m of months.slice(0, 6)) console.log(`  ${m.year}-${String(m.month).padStart(2, '0')}: topics`, m.topics);

  const last = months[0];
  if (!last) { console.log('無任何考試成績'); process.exit(0); }
  const topicIds = Object.keys(last.topics).map(Number);
  console.log(`\n>>> 上次考試 = ${last.year}-${String(last.month).padStart(2, '0')}, topic = ${topicIds.join(',')}`);

  for (const tid of topicIds) {
    const tData = JSON.parse((await req('GET', `/api/admin/questions/${tid}`, null, cookie)).body);
    const mc = tData.mc || [];
    const lastResults = results.filter(r => r.year === last.year && r.month === last.month && r.topic_id === tid);
    console.log(`\n=== Topic ${tid}: ${lastResults.length} 人考咗，題庫 MC ${mc.length} 題，每人出 ${20} 條 ===`);

    let hitCount = 0;
    const hitList = [], missList = [];
    for (const r of lastResults) {
      const emp = emps.find(e => e.id === r.employee_id);
      const name = emp ? `${emp.emp_number} ${emp.name}` : `id#${r.employee_id}`;
      const selected = selectMC(mc, { id: r.employee_id }, tid, last.month, 20);
      const idx = selected.findIndex(q => q === undefined ? false : mc.indexOf(q));
      // 搵 MC index 3（即 Q4，8-3）有無喺 selection 入面（用 question 文字對比最穩陣）
      const q4 = mc[3];
      const hasQ4 = q4 && selected.some(s => s.question === q4.question && JSON.stringify(s.options) === JSON.stringify(q4.options));
      (hasQ4 ? hitList : missList).push(name);
      if (hasQ4) hitCount++;
    }
    console.log(`\nQ4（index 3）出現喺 ${hitCount}/${lastResults.length} 人嘅試卷：`);
    console.log('  有出嘅員工: ' + (hitList.join(', ') || '(無)'));
    console.log('  無出嘅員工: ' + (missList.join(', ') || '(無)'));
    console.log('\n  Q4 原文: ' + JSON.stringify((mc[3] || {}).question || ''));
    console.log('  Q4 選項數: ' + (((mc[3] || {}).options || []).length) + ', correct=' + ((mc[3] || {}).correct));
  }
})();
