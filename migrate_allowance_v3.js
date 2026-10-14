// migrate_allowance_v3.js — 將 prod allowance store 嘅 suspension 區間統一為 v3 規則
//
// v3 規則（2026-09-16 與 Sum 確認）：
//   不合格 → 停發期 = 考試月+1 ~ 考試月+3（3 個月 $0，考試月當月照計）
//             補考月 = 考試月+4
//   補考合格 → 由補考月+1 起重新派 6 個月
//
// 舊規則（要修正）：
//   v1（無 tag）: 停發期 = 考試月 ~ 考試月+2，補考月 = 考試月+3（考試當月都停）
//   v2（rule='v2'）: 停發期 = 考試月+1 ~ 補考月（補考延後會自動延長）← 已廢棄嘅講法
//
// ⚠️ 例外：已逾期但仍未補考嘅個案（補考月已過去，makeup_done_month 仍係 null）
//    → 保留 prod 現狀，唔用 formula 重算，否則補考月會倒退成過去（Sum 2026-09-16 決定）。
//      呢類個案需人手安排補考。
//
// 用法：node migrate_allowance_v3.js         → dry run（只印 diff，唔寫入）
//       node migrate_allowance_v3.js apply   → 寫入 prod 並驗證
const https = require('https');
const fs = require('fs');
const AAL = require('./allowance_logic.js');

const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const APPLY = process.argv[2] === 'apply';
const RULE_TAG = 'v3';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const r = https.request(BASE + path, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'], body: d }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// 今日（HK）YYYY-MM，用嚟判斷補考月係咪已經過去
function todayHK() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  if (!login.body.includes('"success":true')) {
    console.log('LOGIN FAIL', login.body.slice(0, 300));
    return;
  }
  const cookie = login.cookie[0].split(';')[0];
  console.log('LOGIN OK');

  const bak = await req('GET', '/api/admin/backup/export', null, cookie);
  const json = JSON.parse(bak.body);
  const store = json.data['allowance.json'];
  if (!store) {
    console.log('NO allowance.json in backup');
    return;
  }
  // 每次 run 都留一份 before 快照（rollback 用）
  const stamp = Date.now();
  fs.writeFileSync(`allowance_before_v3_${stamp}.json`, JSON.stringify(store, null, 2));
  console.log('backup -> allowance_before_v3_' + stamp + '.json');
  console.log('emps =', Object.keys(store).length);
  const THIS_MONTH = todayHK();
  console.log('this month (HK) =', THIS_MONTH);

  let changed = 0;
  let skippedOverdue = 0;
  const report = [];

  for (const emp of Object.keys(store)) {
    for (const t of Object.keys(store[emp])) {
      const rec = store[emp][t];
      if (!rec || !Array.isArray(rec.suspensions)) continue;
      for (const s of rec.suspensions) {
        if (s.rule === RULE_TAG) {
          report.push(`  ${emp} T${t}  (已 ${RULE_TAG}, skip)`);
          continue;
        }
        // 失敗月：v2 有 fail_month；v1 冇，用 start 反推（v1 嘅 start == 失敗月）
        const failMonth = s.fail_month || s.start;
        const want = AAL.computeFromExam(failMonth, false);

        // ⚠️ 逾期未補考個案：呢個 suspension 未補考（makeup_done_month 為 null），
        //    而且按 formula 重算後嘅新補考月會**倒退成過去／今個月**（即原本嘅安排已經延後過），
        //    就保留 prod 現狀，唔重算 —— 否則補考月會變成一個已過去嘅月份。
        //    呢類個案需人手安排補考。（Sum 2026-09-16 決定）
        const notYetTaken = !s.makeup_done_month;
        const newMakeupInPast = AAL.monthsBetween(want.makeup_month, THIS_MONTH) >= 0;
        const wouldRegress = s.makeup_month && AAL.monthsBetween(want.makeup_month, s.makeup_month) > 0;

        if (notYetTaken && newMakeupInPast && wouldRegress) {
          skippedOverdue++;
          report.push(
            `  ${emp} T${t}  fail=${failMonth}  ⚠️ 逾期未補考（現補考月 ${s.makeup_month}，公式會倒退到 ${want.makeup_month}）→ 保留現狀`
          );
          continue;
        }

        const before = `停 ${s.start}~${s.end}   補考 ${s.makeup_month || '-'}`;
        const after = `停 ${want.allowance_start}~${want.allowance_end}   補考 ${want.makeup_month}`;

        s.fail_month = failMonth;
        s.start = want.allowance_start;
        s.end = want.allowance_end;
        s.makeup_month = want.makeup_month;
        s.rule = RULE_TAG;

        changed++;
        const same = before === after;
        report.push(`  ${emp} T${t}  fail=${failMonth}  ${before}  ->  ${same ? '(不變) ' : ''}${after}`);
      }
      // 若該卷已補考完成，status 應為 active
      if (rec.suspensions.some((s) => s.makeup_done_month)) rec.status = 'active';
    }
  }

  console.log('\n=== 更改 (' + changed + ' 條 suspension)，保留 (' + skippedOverdue + ' 條逾期) ===');
  if (!report.length) console.log('  (冇 suspension)');
  report.forEach((r) => console.log(r));

  if (!APPLY) {
    console.log('\n[DRY RUN] 未寫入。加 apply 參數才會 import 上 prod。');
    return;
  }

  const imp = await req('POST', '/api/admin/allowance/import', { store }, cookie);
  console.log('\nIMPORT code=' + imp.code, imp.body.slice(0, 200));

  // 驗證：逐月睇受影響員工
  const months = ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'];
  for (const m of months) {
    const chk = await req('GET', '/api/admin/allowance?month=' + m, null, cookie);
    let cj;
    try { cj = JSON.parse(chk.body); } catch (e) { console.log(m + ' parse fail'); continue; }
    console.log('\n=== ' + m + '  全體總額 $' + cj.grandTotal + ' ===');
    for (const en of ['ST396', 'ST405', 'ST418']) {
      const row = (cj.rows || []).find((r) => r.emp_number === en);
      if (!row) continue;
      console.log('  ' + en + '  total=$' + row.total + '  (' + row.activeCount + '/6)');
    }
  }

  // 驗證：store 內容
  const chk2 = await req('GET', '/api/admin/backup/export', null, cookie);
  const store2 = JSON.parse(chk2.body).data['allowance.json'];
  fs.writeFileSync(`allowance_after_v3_${stamp}.json`, JSON.stringify(store2, null, 2));
  console.log('\nafter snapshot -> allowance_after_v3_' + stamp + '.json');
  let left = 0;
  for (const emp of Object.keys(store2)) {
    for (const t of Object.keys(store2[emp])) {
      const rec = store2[emp][t];
      if (!rec || !Array.isArray(rec.suspensions)) continue;
      for (const s of rec.suspensions) if (s.rule !== RULE_TAG) { left++; console.log('  仍有舊 rule:', emp, t, JSON.stringify(s)); }
    }
  }
  console.log('剩餘非 ' + RULE_TAG + ' 嘅 suspension:', left);
})();
