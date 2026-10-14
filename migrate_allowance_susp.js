// migrate_allowance_susp.js — 修正 allowance store 內 suspension 區間去符合新規則
// 舊規則（錯）：停津貼 = [失敗月, 失敗月+2]（3 個月），補考月無關 → 補考延後時會提早恢復派錢
// 新規則（正確）：停津貼 = [失敗月+1, 補考月]，補考合格後補考月+1 恢復
//   → 標準情況（補考 = 失敗月+3）剛好仍然係 3 個月；補考延後時停津貼會自動延至補考月
//
// 用法：node migrate_allowance_susp.js         → dry run（只印 diff）
//       node migrate_allowance_susp.js apply   → 寫入 prod 並驗證
const https = require('https');
const fs = require('fs');
const AAL = require('./allowance_logic.js');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const APPLY = process.argv[2] === 'apply';
const OUT = 'allowance_raw_store.json';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const r = https.request(BASE + path, { method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'], body: d }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  if (!login.body.includes('"success":true')) { console.log('LOGIN FAIL', login.body.slice(0, 200)); return; }
  const cookie = login.cookie[0].split(';')[0];
  console.log('LOGIN OK');

  const bak = await req('GET', '/api/admin/backup/export', null, cookie);
  const json = JSON.parse(bak.body);
  const store = json.data['allowance.json'];
  fs.writeFileSync(OUT, JSON.stringify(store, null, 2));
  console.log('FETCHED store, emps =', Object.keys(store).length);

  let changed = 0;
  const report = [];
  for (const emp of Object.keys(store)) {
    for (const t of Object.keys(store[emp])) {
      const rec = store[emp][t];
      if (!rec || !Array.isArray(rec.suspensions)) continue;
      for (const s of rec.suspensions) {
        if (s.rule === 'v2') { report.push(`${emp} T${t} (已 v2, skip)`); continue; }
        const failMonth = s.fail_month || s.start; // 舊資料 start == 失敗月
        const newStart = AAL.addMonths(failMonth, 1);
        const newEnd = s.makeup_month || AAL.addMonths(failMonth, 3);
        const before = `${s.start}~${s.end}`;
        s.fail_month = failMonth;
        s.start = newStart;
        s.end = newEnd;
        s.rule = 'v2';
        changed++;
        report.push(`${emp} T${t} fail=${failMonth}  停發 ${before}  →  ${newStart}~${newEnd}  (補考 ${s.makeup_month || '-'})`);
      }
    }
  }

  console.log('\n=== 更改 (' + changed + ') ===');
  if (!report.length) console.log('(冇 suspension 需要改)');
  for (const r of report) console.log('  ' + r);

  if (!APPLY) { console.log('\n[DRY RUN] 未寫入。加 apply 參數才會 import 上 prod。'); return; }

  const imp = await req('POST', '/api/admin/allowance/import', { store }, cookie);
  console.log('\nIMPORT code=' + imp.code, imp.body.slice(0, 200));

  for (const m of ['2026-09', '2026-10', '2026-11']) {
    const chk = await req('GET', '/api/admin/allowance?month=' + m, null, cookie);
    const cj = JSON.parse(chk.body);
    console.log('\n=== ' + m + ' 全體總額 $' + cj.grandTotal + ' ===');
    for (const en of ['ST396', 'ST405']) {
      const row = (cj.rows || []).find(r => r.emp_number === en);
      if (!row) continue;
      console.log('  ' + en + ' total=$' + row.total + ' (' + row.activeCount + '/6)');
      if (m === '2026-09') {
        for (const b of row.breakdown) {
          console.log('      ' + b.name.padEnd(6) + ' window=' + b.window + ' | active=' + b.active + ' | 停發中=' + b.suspendedNow + ' | susp=' + JSON.stringify(b.suspensions.map(s => s.start + '~' + s.end)));
        }
      }
    }
  }
})();
