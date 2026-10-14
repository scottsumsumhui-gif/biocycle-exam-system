const A = require('./allowance_logic.js');
const f = (m) => { const c = A.computeFromExam(m, false); return 'fail ' + m + ' -> 停 ' + c.allowance_start + '~' + c.allowance_end + ' 補考 ' + c.makeup_month; };
const p = (m) => { const c = A.computeFromExam(m, true); return 'pass ' + m + ' -> 津貼 ' + c.allowance_start + '~' + c.allowance_end; };
const mf = (m) => { console.log('  makeupFail ' + m + ' -> 再停 ' + m + '~' + A.addMonths(m, 2) + ' 再補考 ' + A.addMonths(m, 3)); };
console.log(p('2026-02'));
console.log(f('2026-04'));   // BIOKILL standard
console.log(f('2026-07'));   // 蒼蠅鼠患 standard
mf('2026-10');              // makeup fail example

// ST396/ST405 例外 data (from prod migration) simulated
const store = A.newStore();
A.seedSteadyState(store, ['ST396'], [1, 2, 3, 4, 7, 8], '2026-03', '2028-12');
const setExc = (emp, t, s, e, mk) => {
  const r = store[emp][t];
  r.suspensions = [{ fail_month: s.slice(0, 7), start: s, end: e, makeup_month: mk, makeup_done_month: null, result: 'fail' }];
  r.status = 'suspended'; r.active_start = s; r.active_end = e;
};
setExc('ST396', 2, '2026-05', '2026-10', '2026-10'); // BIOKILL
setExc('ST396', 7, '2026-08', '2026-10', '2026-10'); // 蒼蠅鼠患
for (const mm of ['2026-09', '2026-10', '2026-11']) {
  const r = A.allowanceForMonth(store, 'ST396', mm);
  console.log('ST396 @' + mm + ' = $' + r.total + ' (' + r.activeCount + '/6)');
}
