// test_allowance.js — 離線模擬，驗證津貼 logic（唔會寫入任何 data 檔）
const A = require('./allowance_logic.js');

const TOPIC_NAMES = {
  1: 'IPM', 2: 'BIOKILL', 3: '白蟻', 4: '職安', 5: '技術員手冊', 7: '蒼蠅鼠患', 8: '蟑螂'
};

console.log('===== 場景 A：7 個月循環，全部合格，睇「最多 6 份卷同時有津貼」 =====');
console.log('員工 STX 喺 2026-01 ~ 2026-07 逐個月 pass 唔同卷（1,2,3,4,5,7,8）\n');
const storeA = A.newStore();
const seq = [1, 2, 3, 4, 5, 7, 8];
seq.forEach((t, i) => {
  const m = `2026-${String(i + 1).padStart(2, '0')}`;
  A.applyExamEvent(storeA, 'STX', t, m, true);
});
let hdr = '月份 |';
A.ALLOWANCE_TOPICS.forEach(t => hdr += ` ${TOPIC_NAMES[t]}|`);
hdr += ' 同月有津貼數';
console.log(hdr);
for (let mo = 1; mo <= 12; mo++) {
  const ym = `2026-${String(mo).padStart(2, '0')}`;
  let row = `${ym} |`;
  A.ALLOWANCE_TOPICS.forEach(t => {
    const r = A.getRec(storeA, 'STX', t);
    const on = r && r.status === 'active' && A.inWindow(ym, r.allowance_start, r.allowance_end);
    row += on ? '  $400|' : '      |';
  });
  const cnt = A.allowanceForMonth(storeA, 'STX', ym).activeCount;
  row += `      ${cnt}`;
  console.log(row);
}
console.log('\n👉 結論：峰值 = 6 份卷同時有津貼，第 7 份永遠喺個 1 個月空檔（7月cycle vs 6月window）。');

console.log('\n===== 場景 B1：IPM 合格（對返你個 August 例子） =====');
const storeB1 = A.newStore();
A.applyExamEvent(storeB1, 'STY', 1, '2026-08', true);
const r1 = A.getRec(storeB1, 'STY', 1);
console.log(`STY 2026-08 IPM 合格 → 津貼 ${r1.allowance_start} 至 ${r1.allowance_end}（6 個月，每月 $400）`);
console.log('👉 即 2026-08 ~ 2027-01，同你講嘅一致。');

console.log('\n===== 場景 B2：IPM 不合格 → 停 3 個月 → 補考合格（接回 cycle 唔重計） =====');
const storeB2 = A.newStore();
A.applyExamEvent(storeB2, 'STZ', 1, '2026-08', false);
const rf = A.getRec(storeB2, 'STZ', 1);
console.log(`STZ 2026-08 IPM 不合格 → 停 ${rf.allowance_start} 至 ${rf.allowance_end}（$0），補考月 = ${rf.makeup_month}`);
console.log('每月津貼（補考前）：');
for (const ym of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']) {
  const am = A.allowanceForMonth(storeB2, 'STZ', ym);
  console.log(`  ${ym}: $${am.total}（${am.activeCount} 卷）`);
}
// 2026-11 補考合格
A.applyMakeupPass(storeB2, 'STZ', 1, '2026-11');
const rp = A.getRec(storeB2, 'STZ', 1);
console.log(`\n2026-11 補考合格 → 接回 cycle：window ${rp.allowance_start} 至 ${rp.allowance_end}（由 fail 月 2026-08 起重回 6 個月，補返停咗嗰 3 個月）`);
console.log('每月津貼（補考後）：');
for (const ym of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']) {
  const am = A.allowanceForMonth(storeB2, 'STZ', ym);
  console.log(`  ${ym}: $${am.total}（${am.activeCount} 卷）`);
}
console.log('\n👉 補考合格 = 津貼 window 同「8月直接合格」完全一樣（Aug~Jan），只係遲咗發；下一場正常 IPM 仍喺 2027-03（fail月+7）。');

console.log('\n===== 場景 C：同時 6 卷 active 嘅員工，某月出糧總額 =====');
const storeC = A.newStore();
// 模擬一個「全合格、喺 2026-06 有 6 卷 active」嘅員工（對返場景 A 嘅 2026-06）
[1, 2, 3, 4, 5, 7, 8].forEach((t, i) => A.applyExamEvent(storeC, 'STW', t, `2026-${String(i + 1).padStart(2, '0')}`, true));
const amC = A.allowanceForMonth(storeC, 'STW', '2026-06');
console.log(`STW 2026-06 出糧：$${amC.total}（${amC.activeCount} 卷 active × $400）`);
console.log('👉 上限 = 6 × $400 = $2,400/月。');
