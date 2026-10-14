const https = require('https');
const fs = require('fs');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const DIR = 'C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system';
const CSV = process.argv[2] || (DIR + '/employees_levels_edit.csv');
const APPLY = process.argv[3] === 'apply';

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
  if (!fs.existsSync(CSV)) { console.log('CSV NOT FOUND', CSV); return; }
  const raw = fs.readFileSync(CSV, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '');
  const header = lines[0].split(',');
  const iEmp = header.indexOf('emp_number');
  const iNew = header.indexOf('new_level_key');
  if (iEmp < 0 || iNew < 0) { console.log('CSV 缺少 emp_number / new_level_key 欄'); return; }

  const changes = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const emp = cols[iEmp].trim();
    const nw = (cols[iNew] || '').trim();
    if (nw) changes.push({ emp, newLevel: nw });
  }
  console.log('CSV 中填咗新職級嘅行:', changes.length);
  if (changes.length === 0) { console.log('無需要改動（new_level_key 全空）'); return; }

  const login = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  if (!login.body.includes('"success":true')) { console.log('LOGIN FAIL'); return; }
  const cookie = login.cookie[0].split(';')[0];

  const resp = await req('GET', '/api/admin/employees', null, cookie);
  const json = JSON.parse(resp.body);
  const emps = json.employees || [];
  const byNum = {};
  emps.forEach(e => { byNum[e.emp_number] = e; });
  const validKeys = new Set((json.jobLevels || []).map(l => l.key));

  for (const c of changes) {
    const e = byNum[c.emp];
    if (!e) { console.log('  ✗ 找不到員工', c.emp); continue; }
    if (!validKeys.has(c.newLevel)) { console.log(`  ✗ ${c.emp} 職級無效: ${c.newLevel}`); continue; }
    if (e.level === c.newLevel) { console.log(`  = ${c.emp} (${e.name}) 已經係 ${c.newLevel}, skip`); continue; }
    if (!APPLY) {
      console.log(`  [DRY] ${c.emp} (${e.name}) ${e.level} -> ${c.newLevel}`);
      continue;
    }
    const r = await req('PUT', '/api/admin/employees/' + e.id, { level: c.newLevel }, cookie);
    const j = JSON.parse(r.body);
    console.log(`  ${j.success ? '✓' : '✗'} ${c.emp} (${e.name}) ${e.level} -> ${c.newLevel} ${j.success ? '' : j.error || r.body}`);
  }
  console.log(APPLY ? 'DONE (已套用)' : 'DRY RUN 完成，加 apply 參數執行實際更新');
})();
