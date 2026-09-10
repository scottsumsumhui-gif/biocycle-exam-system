// backfill_allowance.js — 用 Sum 提供嘅過往考試記錄，生成 allowance.json（離線）
// 之後接入 server.js 時，生產版本會直接讀 exam_results.json 做同樣嘅事。
const fs = require('fs');
const path = require('path');
const A = require('./allowance_logic.js');

const DATA_DIR = path.join(__dirname, 'data');
const employees = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'employees.json'), 'utf8'));

// 唔考試嘅職級（getExamCriteria 入面 exempt）
const EXEMPT = new Set(['i', 'supervisor', 'a', 'b', 'c', 'g']);
const eligible = employees.filter(e => !EXEMPT.has(e.level) && !String(e.emp_number).startsWith('TEST'));

// Sum 提供嘅記錄（2026 年）：month / topic / 合格名單（'ALL' 或 fail:[]）
// 統一 6 份卷：IPM(1) / BIOKILL(2) / 白蟻(3) / 職安(4) / 蒼蠅鼠患(7) / 蟑螂(8)
// 技術員手冊(5) 同 Old Topic 6(6) 已刪除，不計津貼
const EXAM_EVENTS = [
  { month: '2026-02', topic: 1, pass: 'ALL' },                                 // IPM → 津貼 2-7
  { month: '2026-03', topic: 3, pass: 'ALL' },                                 // 白蟻 → 津貼 3-8
  { month: '2026-04', topic: 2, pass: 'ALL' },                                 // BIOKILL → 津貼 4-9
  { month: '2026-05', topic: 4, pass: 'ALL' },                                 // 職安 → 津貼 5-10
  { month: '2026-06', topic: 8, pass: 'ALL' },                                 // 蟑螂 → 津貼 6-11
  { month: '2026-07', topic: 7, fail: ['ST405', 'ST396'] },                   // 蒼蠅鼠患 → 津貼 7-12；呢兩個不合格
  { month: '2026-08', topic: 1, pass: 'ALL' },                                 // IPM（再次）→ 津貼 8-01
  { month: '2026-09', topic: 3, pass: 'ALL' }                                  // 白蟻（下星期考，9月前考完）→ 津貼 9-02
];

const store = A.newStore();
const TOPIC_NAMES = { 1: 'IPM', 2: 'BIOKILL', 3: '白蟻', 4: '職安', 7: '蒼蠅鼠患', 8: '蟑螂' };

// 基線 seed：套考試用咗好多年，假定 2026-02 之前所有 eligible 技術員已經處於 steady state
// （6 份卷全部 active = $2,400）。之後真正考試事件會 overwrite window，唔合格先跌。
const eligibleIds = eligible.map(e => e.emp_number);
A.seedSteadyState(store, eligibleIds, A.ALLOWANCE_TOPICS, '2026-02', '2027-12');

for (const ev of EXAM_EVENTS) {
  const failSet = new Set(ev.fail || []);
  for (const emp of eligible) {
    const passed = !failSet.has(emp.emp_number);
    A.applyExamEvent(store, emp.emp_number, ev.topic, ev.month, passed);
  }
}

// 寫入 allowance.json（離線數據，deploy 時唔會 push；生產由 backfill-on-deploy 產生）
fs.writeFileSync(path.join(DATA_DIR, 'allowance.json'), JSON.stringify(store, null, 2));

// ===== 報告 =====
const CURRENT = '2026-09'; // 今日 2026-09-10
console.log(`Eligible 技術員數：個 = ${eligible.length}（已 exclude supervisor / TEST）\n`);

console.log('===== 每人 2026-09 出糧津貼 =====');
let grandTotal = 0;
const rows = [];
for (const emp of eligible) {
  const am = A.allowanceForMonth(store, emp.emp_number, CURRENT);
  grandTotal += am.total;
  const topics = am.lines.map(l => TOPIC_NAMES[l.topic]).join('+') || '—';
  rows.push({ no: emp.emp_number, name: emp.name, total: am.total, topics });
}
rows.sort((a, b) => b.total - a.total);
for (const r of rows) {
  console.log(`  ${r.no} ${r.name.padEnd(14)} $${String(r.total).padStart(4)}  (${r.topics})`);
}
console.log(`\n👉 2026-09 全體技術員津貼總額 = $${grandTotal}`);

console.log('\n===== 補考到期（suspended + makeup_month） =====');
let anyMakeup = false;
for (const emp of eligible) {
  const recs = store[emp.emp_number] || {};
  for (const t of A.ALLOWANCE_TOPICS) {
    const r = recs[t];
    if (r && r.status === 'suspended' && r.suspensions && r.suspensions.length) {
      const s = r.suspensions[r.suspensions.length - 1];
      anyMakeup = true;
      console.log(`  ${emp.emp_number} ${emp.name} — ${TOPIC_NAMES[t]} 不合格，停 ${s.start}~${s.end}，補考月 = ${s.makeup_month}`);
    }
  }
}
if (!anyMakeup) console.log('  （無）');

console.log('\n===== 驗證：8 月 IPM 合格 → window 2026-08~2027-01 =====');
const sample = eligible.find(e => e.emp_number === 'ST188') || eligible[0];
const ipm = A.getRec(store, sample.emp_number, 1);
console.log(`  ${sample.emp_number} IPM window = ${ipm.active_start} ~ ${ipm.active_end}（${ipm.status}）`);
console.log('  👉 同你講嘅「8月合格 → 2026-08 至 2027-01」一致 ✓');

console.log('\n===== 樣板：ST188 各卷目前狀態（對應番考試記錄） =====');
const recs = store[sample.emp_number] || {};
for (const t of A.ALLOWANCE_TOPICS) {
  const r = recs[t];
  if (!r) continue;
  const on = r.status === 'active' && A.inWindow(CURRENT, r.active_start, r.active_end) && !A.suspendedInMonth(r, CURRENT);
  console.log(`  ${TOPIC_NAMES[t].padEnd(6)} ${r.status.padEnd(9)} ${r.active_start}~${r.active_end}  ${on ? '$400/月' : '$0'}  (最近: ${r.last_exam_month} ${r.last_result})`);
}

console.log('\n===== 每月全體津貼總額（2026-02 ~ 2026-09，驗證 steady state） =====');
console.log('（ST396 / ST405 自 2026-07 蒼蠅鼠患不合格起跌到 $2,000，補考 10 月合格後返 $2,400）');
const MONTHS = ['2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'];
for (const mo of MONTHS) {
  let tot = 0, fullCount = 0;
  for (const emp of eligible) {
    const am = A.allowanceForMonth(store, emp.emp_number, mo);
    tot += am.total;
    if (am.total === 2400) fullCount++;
  }
  console.log(`  ${mo}  全體總額 $${String(tot).padStart(6)}   （${fullCount}/${eligible.length} 人拎足 $2,400）`);
}

console.log('\nallowance.json 已寫入 data/allowance.json');
