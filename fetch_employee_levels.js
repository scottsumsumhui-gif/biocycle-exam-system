const https = require('https');
const fs = require('fs');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
const DIR = 'C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system';

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
  if (!login.body.includes('"success":true')) { console.log('LOGIN FAIL', login.body); return; }
  const cookie = login.cookie && login.cookie[0].split(';')[0];
  console.log('LOGIN OK');

  const resp = await req('GET', '/api/admin/employees', null, cookie);
  let json;
  try { json = JSON.parse(resp.body); } catch (e) { console.log('PARSE FAIL', e.message, resp.body.slice(0, 300)); return; }
  if (!json.success) { console.log('EMP FAIL', json); return; }

  const emps = json.employees || [];
  const levels = json.jobLevels || [];
  console.log('EMP COUNT:', emps.length, '| JOB LEVELS:', levels.map(l => l.key + '=' + l.label).join(', '));

  // 1) raw json
  fs.writeFileSync(DIR + '/employees_levels_raw.json', JSON.stringify({ jobLevels: levels, employees: emps }, null, 2));

  // 2) CSV (UTF-8 BOM for Excel) — editable: new_level_key blank for user
  const levelMap = {};
  levels.forEach(l => { levelMap[l.key] = l.label; });
  const esc = s => (s == null ? '' : String(s).replace(/"/g, '""'));
  let csv = '﻿emp_number,name,current_level_key,current_level_label,group_name,new_level_key\n';
  emps.forEach(e => {
    csv += [
      e.emp_number,
      esc(e.name),
      e.level,
      esc(levelMap[e.level] || e.level),
      esc(e.group_name || ''),
      '' // 留畀用戶填新職級
    ].join(',') + '\n';
  });
  fs.writeFileSync(DIR + '/employees_levels_edit.csv', csv);

  // 3) markdown table
  let md = '# 員工職級 LIST (線上版 prod)\n\n';
  md += '**可用職級選項 (job_levels)：' + levels.map(l => `${l.key} (${l.label})`).join(' / ') + '**\n\n';
  md += '| 員工編號 | 姓名 | 現職級 key | 現職級 label | 組別 | 新職級 key (填返) |\n';
  md += '|---|---|---|---|---|---|\n';
  emps.forEach(e => {
    md += `| ${e.emp_number} | ${esc(e.name)} | ${e.level} | ${esc(levelMap[e.level] || e.level)} | ${esc(e.group_name || '')} |  |\n`;
  });
  md += `\n\n共 ${emps.length} 人。\n`;
  md += '\n## 用法\n';
  md += '- 編輯 `employees_levels_edit.csv` 嘅 `new_level_key` 欄（填 junior/senior/supervisor/d 等），save 後交返俾我，我幫你批量 `PUT /api/admin/employees/:id` 更新。\n';
  md += '- 注意：改 `level` 會影響該員嘅考試題型（junior=20MC / senior=20MC / d=20MC / supervisor=20MC+3作文）。\n';
  fs.writeFileSync(DIR + '/employees_levels_list.md', md);

  console.log('WRITTEN: employees_levels_edit.csv / employees_levels_list.md / employees_levels_raw.json');
  // print short summary
  const byLevel = {};
  emps.forEach(e => { byLevel[e.level] = (byLevel[e.level] || 0) + 1; });
  console.log('BY LEVEL:', JSON.stringify(byLevel));
})();
