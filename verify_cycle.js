// verify_cycle.js — 驗證「全部合格」steady state：apply 到邊個月就 query 邊個月（模擬該月當下狀態）
const A = require('./allowance_logic.js');

const ROTATION = [1, 3, 2, 4, 8, 7]; // IPM→白蟻→BIOKILL→職安→蟑螂→蒼蠅鼠患
const store = A.newStore();
const EMP = 'TEST001';
const NAMES = { 1:'IPM', 2:'BIOKILL', 3:'白蟻', 4:'職安', 7:'蒼蠅鼠患', 8:'蟑螂' };

console.log('月份    每月津貼    Active 卷');
for (let i = 0; i < 14; i++) {
  const month = A.addMonths('2026-01', i + 1); // i=0 → 2026-02
  const topic = ROTATION[i % 6];
  A.applyExamEvent(store, EMP, topic, month, true); // 該月考試（全部合格）
  const am = A.allowanceForMonth(store, EMP, month); // query 該月當下
  const names = am.lines.map(l => NAMES[l.topic]).join(',');
  console.log(`${month}  $${String(am.total).padStart(4)}     ${am.activeCount}卷 (${names})`);
}
