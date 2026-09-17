// scan_allowance_orphans.js — 掃描「考試記錄已經 delete 咗，但津貼 store 仲留低標記」嘅孤兒個案
// 判定：allowance record 嘅 history entry（exam_month != SEED）+ audit source，
//       對返 exam_results.json 有冇 (員工, 卷, 年-月) 嘅記錄。
//       audit source = exam-submit / grade-essay 但冇對應成績記錄 → **高置信孤兒**（真係 delete 咗）
//       audit source = seed / backfill / migrate / admin-makeup → 人手或非線上事件，只列作參考
const https = require('https');
const fs = require('fs');
const path = require('path');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const DIR = 'C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system';
const TOPIC_NAMES = { 1: 'IPM', 2: 'BIOKILL', 3: '白蟻', 4: '職安', 7: '蒼蠅鼠患', 8: '蟑螂' };

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

(async () => {
  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  if (!login.body.includes('"success":true')) { console.log('LOGIN FAIL'); return; }
  const cookie = login.cookie && login.cookie[0].split(';')[0];

  const bak = await req('GET', '/api/admin/backup/export', null, cookie);
  const json = JSON.parse(bak.body);
  const data = json.data || {};
  const store = data['allowance.json'] || {};
  const results = data['exam_results.json'] || [];
  const employees = data['employees.json'] || [];

  fs.writeFileSync(path.join(DIR, `allowance_scan_snapshot_${Date.now()}.json`), JSON.stringify(store, null, 2));

  const empById = {};
  employees.forEach(e => { empById[e.id] = e; });

  // 建立 (empNumber|topic|YYYY-MM) -> [result] index
  const idx = {};
  for (const r of results) {
    const e = empById[r.employee_id];
    if (!e) continue;
    const ym = `${r.year}-${String(r.month).padStart(2, '0')}`;
    const k = `${e.emp_number}|${r.topic_id}|${ym}`;
    (idx[k] = idx[k] || []).push(r);
  }

  console.log('employees:', employees.length, '| exam_results:', results.length, '| allowance emp:', Object.keys(store).length);
  console.log('\n=== 孤兒掃描（津貼有標記、但考試記錄已刪）===');

  const orphans = [];
  const soft = [];
  for (const empNo of Object.keys(store)) {
    for (const t of Object.keys(store[empNo] || {})) {
      const rec = store[empNo][t];
      const hist = (rec.history || []).filter(h => h.exam_month && h.exam_month !== 'SEED');
      for (const h of hist) {
        const k = `${empNo}|${t}|${h.exam_month}`;
        if (idx[k] && idx[k].length) continue;
        const srcs = (rec.audit || []).filter(a => a.exam_month === h.exam_month).map(a => a.source).join(',') || '(no audit)';
        const emp = employees.find(e => e.emp_number === empNo);
        const line = {
          emp: empNo, name: emp ? emp.name : '', topic: Number(t), topicName: TOPIC_NAMES[t],
          exam_month: h.exam_month, result: h.result, sources: srcs,
          status: rec.status, susp: (rec.suspensions || []).filter(s => s.fail_month === h.exam_month)
        };
        // 線上考試提交產生、但成績記錄唔見咗 → 高置信孤兒
        if (/exam-submit|grade-essay/.test(srcs)) orphans.push(line);
        else soft.push(line);
      }
    }
  }

  const show = arr => arr.forEach(o => {
    const w = o.susp.length ? ` 停發 ${o.susp[0].start}~${o.susp[0].end} 補考${o.susp[0].makeup_month || '-'}` : '';
    console.log(`  ${o.emp} ${o.name} | ${o.topicName}(T${o.topic}) | ${o.exam_month} ${o.result} | src=${o.sources} | status=${o.status}${w}`);
  });

  console.log(`\n[A] 高置信孤兒（由線上交卷產生，成績記錄已被 delete）: ${orphans.length}`);
  show(orphans);
  console.log(`\n[B] 其他（seed/migrate/admin-makeup/無 audit，可能係人手或非線上事件）: ${soft.length}`);
  show(soft.slice(0, 40));
  if (soft.length > 40) console.log(`  ...仲有 ${soft.length - 40} 條`);
})();
