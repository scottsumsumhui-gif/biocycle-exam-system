// e2e_revert_test.js — 端到端驗證「後台 DELETE 成績記錄 → 自動還原津貼」
// 用測試員工 ST411（津貼 6 卷全 active）做完整來回：
//   1) 員工身份交一份全錯嘅卷（topic 3 白蟻）→ 津貼應標 fail
//   2) Admin DELETE 嗰條成績記錄 → 新 code 應自動 revert，津貼返去 active
// 全程只會新增一條臨時成績記錄，測完即刻 delete，淨效果 = 零改動。
const https = require('https');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const EMP_NO = process.argv[2] || 'ST411';
const EMP_PW = process.argv[3] || '0000';
const TOPIC = 3; // 白蟻

function req(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const r = https.request(BASE + urlPath, { method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'], body: d }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };

async function topicState(cookie, emp, month) {
  const r = await req('GET', `/api/admin/allowance?month=${month}`, null, cookie);
  const d = j(r.body);
  const row = (d && d.rows || []).find(x => x.emp_number === emp);
  if (!row) return null;
  const b = row.breakdown.find(x => x.topic === TOPIC);
  return { total: row.total, activeCount: row.activeCount, active: b.active, suspendedNow: b.suspendedNow, lastExam: b.lastExamMonth, lastResult: b.lastResult, window: b.window };
}

(async () => {
  // ---- 員工登入 ----
  const el = await req('POST', '/api/auth/employee-login', { empNumber: EMP_NO, password: EMP_PW });
  const eld = j(el.body);
  if (!eld || !eld.success) { console.log('EMPLOYEE LOGIN FAIL:', el.body.slice(0, 200)); return; }
  const ecookie = el.cookie && el.cookie[0].split(';')[0];
  console.log(`1) ${EMP_NO} 員工登入 OK`);

  const cur = j((await req('GET', '/api/exam/current', null, ecookie)).body);
  console.log('   /api/exam/current ->', JSON.stringify({ available: cur.available, reason: cur.reason, alreadyTaken: cur.alreadyTaken, topicId: cur.config && cur.config.topicId }));

  // ---- Admin 登入（用嚟查/刪）----
  const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  const acookie = al.cookie && al.cookie[0].split(';')[0];
  const nowYM = new Date();
  const ym = `${nowYM.getUTCFullYear()}-${String(nowYM.getUTCMonth() + 1).padStart(2, '0')}`;
  const checkYM = `${nowYM.getUTCFullYear()}-${String(nowYM.getUTCMonth() + 2).padStart(2, '0')}`; // 下個月 = 停發頭一個月
  console.log('   考試月 =', ym, '| 檢查月 =', checkYM);

  const before = await topicState(acookie, EMP_NO, checkYM);
  console.log('2) DELETE 前 :', JSON.stringify(before));

  // ---- 交一份全錯嘅卷（mcAnswers 空 = 全錯）----
  const sub = await req('POST', '/api/exam/submit', { topicId: TOPIC, mcAnswers: {}, essayAnswers: {}, timeUsed: 1 }, ecookie);
  const sd = j(sub.body);
  if (!sd || !sd.success) { console.log('SUBMIT FAIL:', sub.body.slice(0, 300)); return; }
  console.log('3) 交卷（全錯）-> mcCorrect =', sd.result.mcCorrect, '/', sd.result.mcTotal, '| passed =', sd.result.totalPassed);

  const mid = await topicState(acookie, EMP_NO, checkYM);
  console.log('4) 交卷後 :', JSON.stringify(mid));

  // ---- 搵條新記錄 ----
  const rs = j((await req('GET', `/api/admin/results?month=${nowYM.getUTCMonth() + 1}&year=${nowYM.getUTCFullYear()}&topicId=${TOPIC}`, null, acookie)).body);
  const mine = (rs.results || []).find(r => r.emp_number === EMP_NO);
  if (!mine) { console.log('搵唔到臨時成績記錄，abort（可能已存在記錄未清）'); return; }
  console.log('5) 臨時成績記錄 id =', mine.id, '| passed =', mine.passed, '| submitted_at =', mine.submitted_at);

  // ---- Admin DELETE（觸發新嘅 revert 邏輯）----
  const del = await req('DELETE', `/api/admin/results/${mine.id}`, null, acookie);
  const dd = j(del.body);
  console.log('6) DELETE 回應:', del.code, JSON.stringify(dd));
  console.log('   >>> allowanceReverted =', JSON.stringify(dd && dd.allowanceReverted));

  const after = await topicState(acookie, EMP_NO, checkYM);
  console.log('7) DELETE 後 :', JSON.stringify(after));

  // ---- 結論 ----
  console.log('\n=== 結論 ===');
  const ok = before && mid && after &&
    mid.active === false && mid.suspendedNow === true &&
    after.active === true && after.suspendedNow === false &&
    after.total === before.total && after.activeCount === before.activeCount;
  console.log(ok
    ? '✅ PASS：delete 成績記錄後津貼自動還原，前後完全一致（冇殘留孤兒停發）'
    : '❌ FAIL：還原邏輯冇生效，檢查部署或 code');
  if (!ok) {
    console.log('   期望：交卷後 active=false/suspendedNow=true；delete 後回到', JSON.stringify(before));
  }
})();
