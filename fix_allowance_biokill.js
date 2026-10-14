// 修正 ST396 / ST405 嘅 BIOKILL (topic 2) 記錄
// 背景（2026-09-15 用戶口述）：
//   - 4月 BIOKILL 唔合格 → 正常停 3 個月 (2026-04~2026-06)
//   - 原本應 7 月補考，但漏咗安排 → 10 月一次過補考 BIOKILL + 蒼蠅鼠患
//   - 剛好 10 月本身就係 BIOKILL 正常考試月，所以補考月寫 2026-10
// 用法：node fix_allowance_biokill.js        → 只印 diff（dry run）
//       node fix_allowance_biokill.js apply  → 寫入 prod
const https = require('https');
const fs = require('fs');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const APPLY = process.argv[2] === 'apply';
const EMP_NO = ['ST396', 'ST405'];
const NEW_SUSP = { start: '2026-04', end: '2026-06', makeup_month: '2026-10', makeup_done_month: null, result: 'fail' };

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
  fs.writeFileSync('allowance_raw_store.json', JSON.stringify(store, null, 2));
  console.log('FETCHED store, emps =', Object.keys(store).length);

  const nowIso = new Date().toISOString();
  for (const en of EMP_NO) {
    if (!store[en]) { console.log(en, 'NOT IN STORE — skip'); continue; }
    const r = store[en]['2'];
    if (!r) { console.log(en, 'no topic2 — skip'); continue; }
    r.suspensions = r.suspensions || [];
    const dup = r.suspensions.some(s => s.start === NEW_SUSP.start && s.end === NEW_SUSP.end);
    if (dup) { console.log(en, 'T2 suspension 已經存在 — skip'); }
    else {
      r.suspensions.push(Object.assign({}, NEW_SUSP));
      r.status = 'suspended';
      r.last_exam_month = '2026-04';
      r.last_result = 'fail';
      r.history = r.history || [];
      r.history.push({
        exam_month: '2026-04', result: 'fail',
        active_start: r.active_start, active_end: r.active_end,
        status: 'suspended', makeup_month: '2026-10'
      });
      r.last_auto_update = nowIso;
      r.audit = r.audit || [];
      r.audit.push({ at: nowIso, source: 'admin-manual-fix', actor: 'ST140', exam_month: '2026-04', result: 'fail' });
      console.log(en, 'T2 BIOKILL → 已加 suspension', JSON.stringify(NEW_SUSP));
    }
    // T7 蒼蠅鼠患：確認補考月 = 2026-10（漏咗 7 月補考）
    const r7 = store[en]['7'];
    if (r7 && r7.suspensions) {
      for (const s of r7.suspensions) {
        if (s.makeup_month !== '2026-10') { console.log(en, 'T7 makeup', s.makeup_month, '→ 2026-10'); s.makeup_month = '2026-10'; }
      }
      const last7 = r7.history && r7.history[r7.history.length - 1];
      if (last7 && last7.exam_month === '2026-07') last7.makeup_month = '2026-10';
      console.log(en, 'T7 蒼蠅鼠患 suspension =', JSON.stringify(r7.suspensions));
    }
  }

  // 印最終狀態
  for (const en of EMP_NO) {
    const t2 = store[en]['2'], t7 = store[en]['7'];
    console.log('--- ' + en + ' ---');
    console.log('  T2 BIOKILL  status=' + t2.status + ' window=' + t2.active_start + '~' + t2.active_end + ' susp=' + JSON.stringify(t2.suspensions));
    console.log('  T7 蒼蠅鼠患  status=' + t7.status + ' window=' + t7.active_start + '~' + t7.active_end + ' susp=' + JSON.stringify(t7.suspensions));
  }

  if (!APPLY) { console.log('\n[DRY RUN] 未寫入。加 apply 參數才會 import 上 prod。'); return; }

  const imp = await req('POST', '/api/admin/allowance/import', { store }, cookie);
  console.log('\nIMPORT code=' + imp.code, imp.body.slice(0, 200));

  // 驗證
  const chk = await req('GET', '/api/admin/allowance?month=2026-09', null, cookie);
  const cj = JSON.parse(chk.body);
  const row = (cj.rows || []).find(r => r.emp_number === 'ST396');
  if (row) {
    console.log('\n驗證 ST396 @2026-09: total=$' + row.total);
    for (const b of row.breakdown) console.log('  ' + b.name.padEnd(8), 'window=' + b.window, '| active=' + b.active, '| suspendedNow=' + b.suspendedNow, '| lastExam=' + b.lastExamMonth + '/' + b.lastResult);
  }
})();
