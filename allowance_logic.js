// allowance_logic.js — 技術員考試津貼計算 (offline logic, 之後會接入 server.js)
// 規則（2026-09-10 與 Sum 確認，更新為 6 份卷）：
//   - 6 個 topic (1,2,3,4,7,8)：IPM、BIOKILL、白蟻、職安、蒼蠅鼠患、蟑螂
//   - 技術員手冊(5) 同 Old Topic 6(6) 不計津貼
//   - 合格 → 嗰份卷每月 $400，由考試月計 6 個月（考試月 +5）；下一次同卷考試續期，window 連續唔會有真空檔
//   - 不合格 → 停嗰份卷 3 個月 $400（考試月 +2 = 3 個月 $0），+3 個月安排補考
//   - 補考合格 → 接回正常 cycle 唔重計：由 fail 月起重回 6 個月 window（補返停咗嗰 3 個月），下一場正常考試仍喺 fail月+7
//   - 6 個 topic 每年輪 2 次（每 6 個月考一次），所以全合格 steady state = 每個月 $2,400
//
// 模型重點（2026-09-10 修正）：
//   - 每 (員工,卷) 記錄一條 active interval [active_start, active_end]（合格會 merge 延長，唔 overwrite）
//   - 唔合格會加一條 suspension 區間（局部停津貼），唔影響其他月份
//   - 咁樣「套考試用咗好多年」嘅員工，可以 seed 一個好闊嘅 active interval 當 baseline，
//     之後真正考試事件只會 merge window / 加 suspension，唔會由零砌起（唔會 2月400/3月800）

const ALLOWANCE_TOPICS = [1, 2, 3, 4, 7, 8]; // 6 份卷
const ALLOWANCE_AMOUNT = 400;                   // 每卷每月 HKD
const ALLOWANCE_MONTHS = 6;                      // 合格津貼月份數
const SUSPEND_MONTHS = 3;                        // 不合格停津貼月份數
const MAKEUP_OFFSET = 3;                         // 補考安排月份偏移

function parseYM(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { y, m };
}
function fmtYM(y, m) {
  return `${y}-${String(m).padStart(2, '0')}`;
}
// 'YYYY-MM' + n 個月（支援跨年）
function addMonths(ym, n) {
  const { y, m } = parseYM(ym);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmtYM(ny, nm);
}
// a 到 b 相差幾多個月（b - a）
function monthsBetween(a, b) {
  const A = parseYM(a), B = parseYM(b);
  return (B.y - A.y) * 12 + (B.m - A.m);
}
function inWindow(ym, start, end) {
  return monthsBetween(start, ym) >= 0 && monthsBetween(ym, end) >= 0;
}
function minYM(a, b) { return monthsBetween(a, b) <= 0 ? b : a; }
function maxYM(a, b) { return monthsBetween(a, b) <= 0 ? a : b; }

// 根據一次考試事件計出津貼 window
function computeFromExam(examMonth, passed) {
  if (passed) {
    return {
      allowance_start: examMonth,
      allowance_end: addMonths(examMonth, ALLOWANCE_MONTHS - 1),
      status: 'active',
      makeup_month: null
    };
  }
  return {
    allowance_start: examMonth,
    allowance_end: addMonths(examMonth, SUSPEND_MONTHS - 1),
    status: 'suspended',
    makeup_month: addMonths(examMonth, MAKEUP_OFFSET)
  };
}

// 狀態 store: { [empId]: { [topicId]: record } }
function newStore() { return {}; }
function getRec(store, empId, topicId) {
  return (store[empId] || {})[topicId] || null;
}

// 判斷 targetMonth 係咪喺某個 suspension 區間內（停津貼嗰幾個月）
function suspendedInMonth(rec, targetMonth) {
  if (!rec || !rec.suspensions) return false;
  return rec.suspensions.some(s => inWindow(targetMonth, s.start, s.end));
}

// 基線 seed：假設某啲員工喺 baseline 之前已經處於 steady state（所有卷 active）
// 用於 backfill 一間用咗好多年嘅公司 —— 唔係由零砌起，避免「2月400 / 3月800」
// active_start..active_end 係一段好闊嘅 active window；之後真正考試事件會 merge window，
// 唔合格就加 suspension 區間（局部停津貼），唔影響其他月份。
function seedSteadyState(store, empIds, topics, fromMonth, endMonth) {
  for (const empId of empIds) {
    if (!store[empId]) store[empId] = {};
    for (const t of topics) {
      store[empId][t] = {
        topic_id: t,
        active_start: fromMonth,
        active_end: endMonth,
        suspensions: [],
        status: 'active',
        last_exam_month: 'SEED',
        last_result: 'pass (historical baseline)',
        history: [{
          exam_month: 'SEED',
          result: 'pass (historical baseline)',
          active_start: fromMonth,
          active_end: endMonth,
          status: 'active'
        }]
      };
    }
  }
  return store;
}

// 合格 → merge active window（連續續期，唔會有真空檔）；唔合格 → 加 suspension 區間
function applyExamEvent(store, empId, topicId, examMonth, passed) {
  if (!store[empId]) store[empId] = {};
  const c = computeFromExam(examMonth, passed);
  const rec = store[empId][topicId] || { topic_id: topicId, active_start: examMonth, active_end: examMonth, suspensions: [], history: [] };
  rec.topic_id = topicId;
  rec.last_exam_month = examMonth;
  rec.last_result = passed ? 'pass' : 'fail';
  if (passed) {
    // merge active window（續期）
    rec.active_start = minYM(rec.active_start, examMonth);
    rec.active_end = maxYM(rec.active_end, c.allowance_end);
    rec.status = 'active';
  } else {
    // 加 suspension interval（局部停津貼）
    rec.suspensions = rec.suspensions || [];
    rec.suspensions.push({
      start: c.allowance_start,
      end: c.allowance_end,
      makeup_month: c.makeup_month,
      makeup_done_month: null,
      result: 'fail'
    });
    rec.status = 'suspended';
  }
  rec.history = rec.history || [];
  rec.history.push({
    exam_month: examMonth,
    result: passed ? 'pass' : 'fail',
    active_start: rec.active_start,
    active_end: rec.active_end,
    status: rec.status,
    makeup_month: passed ? null : c.makeup_month
  });
  store[empId][topicId] = rec;
  return store;
}

// 補考合格：接回正常 cycle 唔重計（由 fail 月起重回 6 個月 window，補返停咗嗰 3 個月），
// 並標記對應 suspension 已補考解決（該 suspension 仍保留以反映停津貼嗰幾個月）
function applyMakeupPass(store, empId, topicId, makeupMonth) {
  const rec = getRec(store, empId, topicId);
  if (!rec || rec.status !== 'suspended') return store;
  const failMonth = rec.suspensions.length ? rec.suspensions[rec.suspensions.length - 1].start : makeupMonth;
  rec.status = 'active';
  rec.active_start = minYM(rec.active_start, failMonth);
  rec.active_end = maxYM(rec.active_end, addMonths(failMonth, ALLOWANCE_MONTHS - 1));
  rec.last_result = 'pass'; // via makeup
  // 標記最近一個未補考嘅 suspension 已解決
  for (let i = rec.suspensions.length - 1; i >= 0; i--) {
    if (!rec.suspensions[i].makeup_done_month) { rec.suspensions[i].makeup_done_month = makeupMonth; break; }
  }
  rec.history = rec.history || [];
  rec.history.push({
    exam_month: makeupMonth,
    result: 'pass(makeup)',
    active_start: rec.active_start,
    active_end: rec.active_end,
    status: 'active',
    makeup_month: null
  });
  return store;
}

// 補考都唔合格：再停 3 個月，+3 個月再排補考
function applyMakeupFail(store, empId, topicId, makeupMonth) {
  const rec = getRec(store, empId, topicId);
  if (!rec) return store;
  rec.suspensions = rec.suspensions || [];
  rec.suspensions.push({
    start: makeupMonth,
    end: addMonths(makeupMonth, SUSPEND_MONTHS - 1),
    makeup_month: addMonths(makeupMonth, MAKEUP_OFFSET),
    makeup_done_month: null,
    result: 'fail(makeup)'
  });
  rec.status = 'suspended';
  rec.history = rec.history || [];
  rec.history.push({
    exam_month: makeupMonth,
    result: 'fail(makeup)',
    active_start: rec.active_start,
    active_end: rec.active_end,
    status: 'suspended',
    makeup_month: addMonths(makeupMonth, MAKEUP_OFFSET)
  });
  return store;
}

// 計某員工喺 targetMonth 嘅津貼總額同明細
function allowanceForMonth(store, empId, targetMonth) {
  const recs = store[empId] || {};
  const lines = [];
  let total = 0;
  for (const t of ALLOWANCE_TOPICS) {
    const r = recs[t];
    if (r && inWindow(targetMonth, r.active_start, r.active_end) && !suspendedInMonth(r, targetMonth)) {
      lines.push({ topic: t, amount: ALLOWANCE_AMOUNT });
      total += ALLOWANCE_AMOUNT;
    }
  }
  return { total, lines, activeCount: lines.length };
}

module.exports = {
  ALLOWANCE_TOPICS, ALLOWANCE_AMOUNT, ALLOWANCE_MONTHS, SUSPEND_MONTHS, MAKEUP_OFFSET,
  addMonths, monthsBetween, inWindow, computeFromExam, minYM, maxYM,
  newStore, applyExamEvent, applyMakeupPass, applyMakeupFail, allowanceForMonth, getRec, seedSteadyState, suspendedInMonth
};
