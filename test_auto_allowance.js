// test_auto_allowance.js — 驗證 auto-mark hook 邏輯（唔碰線上 Redis）
// 模擬 server.js 入面嘅 applyAllowanceEvent：load 現有 store → apply 事件 → save
const AAL = require('./allowance_logic.js');

const EMP = ['ST140', 'ST396', 'ST405', 'ST021'];

function applyAllowanceEvent(store, empNumber, topicId, examYM, passed) {
  if (!AAL.ALLOWANCE_TOPICS.includes(Number(topicId))) return store;
  if (!store[empNumber]) return store; // 非 eligible
  const rec = store[empNumber][topicId];
  if (rec && rec.history && rec.history.some(h =>
    h.exam_month === examYM && (passed ? String(h.result).startsWith('pass') : h.result === 'fail'))) {
    return store; // double-apply guard
  }
  AAL.applyExamEvent(store, empNumber, topicId, examYM, passed);
  return store;
}

function total(store, emp, ym) { return AAL.allowanceForMonth(store, emp, ym).total; }

// ---- 建立 baseline（同上線 seed：2026-02 ~ 2028-12，ST396/ST405 蒼蠅鼠患7月不合格）----
const store = AAL.newStore();
AAL.seedSteadyState(store, EMP, AAL.ALLOWANCE_TOPICS, '2026-02', '2028-12');
for (const e of ['ST396', 'ST405']) AAL.applyExamEvent(store, e, 7, '2026-07', false);

console.log('=== baseline 2026-09 ===');
console.log('ST140 09 =', total(store, 'ST140', '2026-09'), '(expect 2400)');
console.log('ST396 09 =', total(store, 'ST396', '2026-09'), '(expect 2000, 7-9 suspended)');
console.log('ST396 10 =', total(store, 'ST396', '2026-10'), '(expect 2400, seed window 覆蓋)');

// ---- Test A: ST140 白蟻(topic3) 9月合格（自動批改級別 submit 即觸發）----
applyAllowanceEvent(store, 'ST140', 3, '2026-09', true);
console.log('\n=== Test A: ST140 白蟻 9月合格 ===');
console.log('ST140 topic3 active_end =', store.ST140[3].active_end, '(expect 2028-12, seed 主導，無真空檔)');
console.log('ST140 09 =', total(store, 'ST140', '2026-09'), '(expect 2400)');

// ---- Test B: ST140 蒼蠅鼠患(topic7) 9月不合格（將來真實不合格要靠 hook 捉）----
applyAllowanceEvent(store, 'ST140', 7, '2026-09', false);
console.log('\n=== Test B: ST140 蒼蠅鼠患 9月不合格 ===');
console.log('ST140 09 =', total(store, 'ST140', '2026-09'), '(expect 2000)');
console.log('ST140 10 =', total(store, 'ST140', '2026-10'), '(expect 2000)');
console.log('ST140 11 =', total(store, 'ST140', '2026-11'), '(expect 2000)');
console.log('ST140 12 =', total(store, 'ST140', '2026-12'), '(expect 2400, 停 3 個月後復)');

// ---- Test C: double-apply guard（admin 重批改/重提交唔應該加多條 suspension）----
const before = store.ST140[7].suspensions.length;
applyAllowanceEvent(store, 'ST140', 7, '2026-09', false);
const after = store.ST140[7].suspensions.length;
console.log('\n=== Test C: double-apply guard ===');
console.log('suspensions before/after =', before, '/', after, '(expect 1 / 1, 防重複)');

// ---- Test D: 補考合格（ST140 12月重考 topic7 合格）----
applyAllowanceEvent(store, 'ST140', 7, '2026-12', true);
console.log('\n=== Test D: ST140 12月補考合格 ===');
console.log('ST140 topic7 active_end =', store.ST140[7].active_end, '(expect 2027-05, 由12月+5)');
console.log('ST140 12 =', total(store, 'ST140', '2026-12'), '(expect 2400)');

// ---- Test E: 非 allowance topic 應被 skip（topic 5/6 唔計）----
const t5 = applyAllowanceEvent(store, 'ST140', 5, '2026-09', true);
console.log('\n=== Test E: topic 5 非津貼卷 skip ===');
console.log('ST140 有冇 topic5 entry =', !!t5.ST140[5], '(expect false)');

console.log('\nALL TESTS DONE');
