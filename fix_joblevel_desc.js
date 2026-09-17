// fix_joblevel_desc.js — 修正職級 description 入面「已取消嘅問答題」殘留文字
// 做法：先 GET /api/admin/job-levels 睇 prod 現況，按 server.js getExamCriteria() 嘅真相
//       計出正確 description，再逐個 PUT 上去（只改有需要嘅）。
// 用法：node fix_joblevel_desc.js [--apply]   （冇 --apply = dry-run）
const https = require('https');
const fs = require('fs');
const path = require('path');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const DIR = 'C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system';
const APPLY = process.argv.includes('--apply');

function req(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const r = https.request(BASE + urlPath, { method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'], body: d }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };

// 對齊 server.js getExamCriteria()：一律 20 題選擇題，問答題已全面取消
const JUNIOR = '考試：20題選擇題，最多錯4題（答對16題／80%合格）';  // junior / P.junior
const SENIOR = '考試：20題選擇題，最多錯2題（答對18題／90%合格）';  // senior/D.supervisor/P.senior/PD.supervisor
const EXEMPT = '不用考試（管理職級）';                             // supervisor/P.supervisor/AAM/DGM/GM/OPM

const WANT = {
  junior: JUNIOR, 'P.junior': JUNIOR,
  senior: SENIOR, 'D.supervisor': SENIOR, 'P.senior': SENIOR, 'PD.supervisor': SENIOR,
  supervisor: EXEMPT, 'P.supervisor': EXEMPT, AAM: EXEMPT, DGM: EXEMPT, GM: EXEMPT, OPM: EXEMPT
};

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  if (!login.body.includes('"success":true')) { console.log('LOGIN FAIL'); return; }
  const cookie = login.cookie && login.cookie[0].split(';')[0];

  const r = await req('GET', '/api/admin/job-levels', null, cookie);
  const d = j(r.body);
  if (!d || !d.jobLevels) { console.log('FETCH FAIL', r.code, r.body.slice(0, 200)); return; }

  const list = d.jobLevels.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  fs.writeFileSync(path.join(DIR, `joblevels_before_desc_${Date.now()}.json`), JSON.stringify(list, null, 2));
  console.log('PROD 職級數:', list.length, '\n');

  const changes = [];
  for (const lv of list) {
    const want = WANT[lv.key];
    const cur = lv.description || '';
    const stale = /問答|作文|essay/i.test(cur);
    if (want === undefined) {
      console.log(`? ${lv.key.padEnd(14)} ${lv.label.padEnd(10)} 無對應規則，跳過 — 「${cur}」`);
      continue;
    }
    if (cur === want) {
      console.log(`= ${lv.key.padEnd(14)} ${lv.label.padEnd(10)} 已正確 — 「${cur}」`);
      continue;
    }
    console.log(`${stale ? '!' : '*'} ${lv.key.padEnd(14)} ${lv.label.padEnd(10)}`);
    console.log(`    OLD: ${cur}`);
    console.log(`    NEW: ${want}`);
    changes.push({ key: lv.key, label: lv.label, description: want, order: lv.order });
  }

  console.log(`\n需要更新: ${changes.length} 個`);
  if (!APPLY) { console.log('[DRY RUN] 加 --apply 落實'); return; }

  for (const c of changes) {
    const u = await req('PUT', `/api/admin/job-levels/${encodeURIComponent(c.key)}`, { description: c.description }, cookie);
    const ud = j(u.body);
    console.log(`PUT ${c.key} -> ${u.code} ${ud && ud.success ? 'OK' : JSON.stringify(ud)}`);
  }

  const after = j((await req('GET', '/api/admin/job-levels', null, cookie)).body);
  fs.writeFileSync(path.join(DIR, `joblevels_after_desc_${Date.now()}.json`), JSON.stringify(after.jobLevels, null, 2));
  console.log('\n=== 更新後 ===');
  after.jobLevels.slice().sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach(l => console.log(`${l.key.padEnd(14)} ${l.label.padEnd(10)} ${l.description || '(空)'}`));
  const left = after.jobLevels.filter(l => /問答|作文|essay/i.test(l.description || ''));
  console.log(left.length ? `\n⚠️ 仲有 ${left.length} 條含問答題字眼` : '\n✅ 已無「問答題」殘留');
})();
