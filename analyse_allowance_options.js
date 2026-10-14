// 分析：津貼窗口收窄 vs 保持 baseline，對每月津貼總額嘅影響
// 新公式（用戶 2026-09-15 確認）：合格 → 津貼期 = 考試月+1 ~ 考試月+6
// 不合格 → 停 3 個月 [考試月, +2]，補考 +3
const fs = require('fs');
const DIR = 'C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system';
const TOPICS = [1, 2, 3, 4, 7, 8];
const NAMES = { 1: 'IPM', 2: 'BIOKILL', 3: '白蟻', 4: '職安', 7: '蒼蠅鼠患', 8: '蟑螂' };
const EXEMPT = new Set(['i', 'supervisor', 'a', 'b', 'c', 'g']);
const AMT = 400;

// 2026 anchor（2月考 IPM）下每個 topic 嘅第一個津貼窗口 = 考試月+1 ~ +6
const WIN = {
  1: ['2026-03', '2026-08'], // 2月考
  3: ['2026-04', '2026-09'], // 3月考
  2: ['2026-05', '2026-10'], // 4月考
  4: ['2026-06', '2026-11'], // 5月考
  8: ['2026-07', '2026-12'], // 6月考
  7: ['2026-08', '2027-01'], // 7月考
};

function ix(ym) { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); }
function inWin(ym, s, e) { const i = ix(ym); return ix(s) <= i && i <= ix(e); }
function addM(ym, n) { const t = ix(ym) + n; return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0'); }
function maxYM(a, b) { return ix(a) >= ix(b) ? a : b; }

const raw = JSON.parse(fs.readFileSync(DIR + '/allowance_raw_store.json', 'utf8'));
const emps = JSON.parse(fs.readFileSync(DIR + '/data/employees.json', 'utf8'));
const eligible = emps.filter(e => !EXEMPT.has(e.level) && !String(e.emp_number || '').startsWith('TEST'));

// 真實考試事件（由 raw store 抽出，非 SEED）
const events = [];
for (const emp of Object.keys(raw)) {
  for (const t of TOPICS.map(String)) {
    const r = raw[emp][t]; if (!r) continue;
    for (const h of (r.history || [])) {
      if (h.exam_month === 'SEED') continue;
      events.push({ emp, topic: Number(t), month: h.exam_month, passed: String(h.result).startsWith('pass') });
    }
  }
}
// 補上用戶指示：ST396 / ST405 4月 BIOKILL 不合格（現時 data 冇）
for (const e of ['ST396', 'ST405']) events.push({ emp: e, topic: 2, month: '2026-04', passed: false });

// ---- 建 A 版 store：逐卷真窗口 ----
function buildA() {
  const st = {};
  for (const emp of Object.keys(raw)) {
    st[emp] = {};
    for (const t of TOPICS) {
      st[emp][t] = { window: [WIN[t][0], WIN[t][1]], suspensions: [], history: [] };
    }
  }
  for (const ev of events) {
    const r = st[ev.emp][ev.topic]; if (!r) continue;
    if (ev.passed) {
      r.window[1] = maxYM(r.window[1], addM(ev.month, 6));
    } else {
      r.suspensions.push({ start: ev.month, end: addM(ev.month, 2), makeup: addM(ev.month, 3) });
    }
  }
  return st;
}
// ---- 建 B 版 store：keep baseline 闊窗口 ----
function buildB() {
  const st = {};
  for (const emp of Object.keys(raw)) {
    st[emp] = {};
    for (const t of TOPICS) st[emp][t] = { window: ['2026-02', '2028-12'], suspensions: [], history: [] };
  }
  for (const ev of events) {
    if (ev.passed) continue;
    const r = st[ev.emp][ev.topic]; if (!r) continue;
    r.suspensions.push({ start: ev.month, end: addM(ev.month, 2), makeup: addM(ev.month, 3) });
  }
  return st;
}

function total(st, emp, month) {
  let n = 0; const got = [];
  for (const t of TOPICS) {
    const r = st[emp] && st[emp][t]; if (!r) continue;
    const susp = r.suspensions.some(s => inWin(month, s.start, s.end));
    if (inWin(month, r.window[0], r.window[1]) && !susp) { n += AMT; got.push(NAMES[t]); }
  }
  return { total: n, count: n / AMT, got };
}

const A = buildA(), B = buildB();
const months = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];

console.log('=== A 版：逐卷真窗口（anchor 2026-02 IPM）===');
console.log('topic windows:');
for (const t of TOPICS) console.log('  ' + NAMES[t].padEnd(8), A[Object.keys(A)[0]][t].window.join(' ~ '));
console.log('  (但有真實 pass 會自動延長)');
console.log('');
console.log('TOKEN|員工|職級|' + months.map(m => m.slice(5) + '月').join('|'));
let sumA = {}, sumB = {};
for (const m of months) { sumA[m] = 0; sumB[m] = 0; }
for (const emp of eligible) {
  const en = emp.emp_number;
  const ra = months.map(m => total(A, en, m));
  const rb = months.map(m => total(B, en, m));
  months.forEach((m, i) => { sumA[m] += ra[i].total; sumB[m] += rb[i].total; });
  const flag = ra.some((r, i) => r.total !== rb[i].total) ? ' *' : '';
  console.log([en, emp.name, emp.level, ...months.map((m, i) => '$' + ra[i].total + '/' + rb[i].total), flag].join(' | '));
}
console.log('');
console.log('TOKEN|A 版總額|' + months.map(m => '$' + sumA[m]).join('|'));
console.log('TOKEN|B 版總額|' + months.map(m => '$' + sumB[m]).join('|'));
console.log('TOKEN|人數(非豁免)|' + eligible.length);
console.log('');
console.log('=== 2026-09 逐卷狀態（A 版）===');
for (const emp of eligible.slice(0, 3)) {
  const r = total(A, emp.emp_number, '2026-09');
  const miss = TOPICS.filter(t => !r.got.includes(NAMES[t])).map(t => NAMES[t]);
  console.log(emp.emp_number, emp.name, '= $' + r.total, '| 冇派:', miss.join(',') || '無');
}
