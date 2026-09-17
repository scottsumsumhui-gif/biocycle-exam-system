// patch_allowance_revert.js — 人手撤銷某個津貼考試事件的 prod 數據修補
// 用途：Admin 喺後台 DELETE 咗考試記錄，但 allowance.json 殘留 orphan suspension 時，補做還原。
// 用法：node patch_allowance_revert.js <EMP> <TOPIC> <YYYY-MM> [--apply]
//       冇 --apply = dry-run，只列印會點改，唔寫入 prod。
const https = require('https');
const fs = require('fs');
const path = require('path');
const AAL = require('./allowance_logic.js');

const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const DIR = 'C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system';
const EMP = process.argv[2] || 'ST418';
const TOPIC = Number(process.argv[3] || 3);
const EXAM_MONTH = process.argv[4] || '2026-09';
const APPLY = process.argv.includes('--apply');

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
const TOPIC_NAMES = { 1: 'IPM', 2: 'BIOKILL', 3: '白蟻', 4: '職安', 7: '蒼蠅鼠患', 8: '蟑螂' };

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  if (!login.body.includes('"success":true')) { console.log('LOGIN FAIL', login.body.slice(0, 300)); return; }
  const cookie = login.cookie && login.cookie[0].split(';')[0];
  console.log('LOGIN OK');

  const bak = await req('GET', '/api/admin/backup/export', null, cookie);
  let json;
  try { json = JSON.parse(bak.body); } catch (e) { console.log('BACKUP PARSE FAIL', bak.body.slice(0, 300)); return; }
  const store = json.data && json.data['allowance.json'];
  if (!store) { console.log('NO allowance.json'); return; }

  const snap = path.join(DIR, `allowance_before_revert_${EMP}_T${TOPIC}_${Date.now()}.json`);
  fs.writeFileSync(snap, JSON.stringify(store, null, 2));
  console.log('SNAPSHOT ->', snap);
  console.log('EMP COUNT', Object.keys(store).length);

  const rec = (store[EMP] || {})[TOPIC];
  if (!rec) { console.log(`NO RECORD for ${EMP} topic ${TOPIC}`); return; }

  console.log('\n=== BEFORE ===');
  console.log(`${EMP} T${TOPIC} ${TOPIC_NAMES[TOPIC]} status=${rec.status} window=${rec.active_start}~${rec.active_end}`);
  console.log('last_exam_month =', rec.last_exam_month, '| last_result =', rec.last_result);
  console.log('suspensions:', JSON.stringify(rec.suspensions));
  console.log('history:', JSON.stringify(rec.history.map(h => `${h.exam_month}:${h.result}`)));
  console.log('audit:', JSON.stringify((rec.audit || []).map(a => `${a.exam_month}:${a.result}@${a.source}`)));

  const beforeJSON = JSON.stringify(rec);
  const rev = AAL.revertExamEvent(store, EMP, TOPIC, EXAM_MONTH);
  console.log('\n=== REVERT RESULT ===');
  console.log(JSON.stringify(rev));

  if (!rev.changed) { console.log('\nNOTHING TO REVERT — abort.'); return; }

  const rec2 = store[EMP][TOPIC];
  // 清埋 audit 入面屬於該考試月嘅痕跡（UI 嘅「markedAt / markedSource」係讀 audit）
  const auditBefore = (rec2.audit || []).length;
  rec2.audit = (rec2.audit || []).filter(a => a.exam_month !== EXAM_MONTH);
  rec2.last_auto_update = new Date().toISOString();
  rec2.audit.push({
    at: new Date().toISOString(),
    source: 'manual-revert',
    actor: 'ST140',
    exam_month: EXAM_MONTH,
    result: 'reverted',
    note: `Admin 已人手刪除 ${EXAM_MONTH} 嘅考試記錄，同步撤銷津貼標記`
  });

  console.log('\n=== AFTER ===');
  console.log(`${EMP} T${TOPIC} ${TOPIC_NAMES[TOPIC]} status=${rec2.status} window=${rec2.active_start}~${rec2.active_end}`);
  console.log('last_exam_month =', rec2.last_exam_month, '| last_result =', rec2.last_result);
  console.log('suspensions:', JSON.stringify(rec2.suspensions));
  console.log('history:', JSON.stringify(rec2.history.map(h => `${h.exam_month}:${h.result}`)));
  console.log('audit:', JSON.stringify(rec2.audit.map(a => `${a.exam_month}:${a.result}@${a.source}`)));
  console.log('audit removed:', auditBefore - (rec2.audit.length - 1));
  console.log('record changed:', beforeJSON !== JSON.stringify(rec2));

  if (!APPLY) {
    console.log('\n[DRY RUN] 未寫入 prod。要落實請加 --apply');
    return;
  }

  const imp = await req('POST', '/api/admin/allowance/import', { store }, cookie);
  console.log('\nIMPORT code', imp.code, imp.body.slice(0, 300));

  const after = path.join(DIR, `allowance_after_revert_${EMP}_T${TOPIC}_${Date.now()}.json`);
  fs.writeFileSync(after, JSON.stringify(store, null, 2));
  console.log('AFTER SNAPSHOT ->', after);

  // 驗證：睇該員工喺停發期頭一個月嘅津貼
  const checkMonth = AAL.addMonths(EXAM_MONTH, 1);
  const chk = await req('GET', `/api/admin/allowance?month=${checkMonth}`, null, cookie);
  let cj; try { cj = JSON.parse(chk.body); } catch (e) { console.log('VERIFY PARSE FAIL'); return; }
  const row = (cj.rows || []).find(r => r.emp_number === EMP);
  if (!row) { console.log('VERIFY: no row for', EMP); return; }
  const bk = row.breakdown.find(b => b.topic === TOPIC);
  console.log(`\n=== VERIFY ${checkMonth} ===`);
  console.log(`${EMP} total=${row.total} activeCount=${row.activeCount}`);
  console.log(`T${TOPIC} ${TOPIC_NAMES[TOPIC]} active=${bk.active} suspendedNow=${bk.suspendedNow} lastExam=${bk.lastExamMonth} lastResult=${bk.lastResult}`);
  console.log('all breakdown:', row.breakdown.map(b => `${b.name}:${b.active ? 'OK' : 'X'}`).join(' | '));
})();
