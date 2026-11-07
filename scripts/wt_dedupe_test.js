// dedupeWorktimeJobs() 單元測試：由 server.js 抽出函數源碼執行，唔使啟動 server。
// 重點：只去重完全相同／空殼；兩張內容唔同嘅同號單必須兩張都留低（唔可以誤刪資料）。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = src.indexOf('function dedupeWorktimeJobs(jobs) {');
if (start < 0) throw new Error('搵唔到 dedupeWorktimeJobs');
let depth = 0, end = -1;
for (let i = start; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const dedupe = new Function(src.slice(start, end) + '; return dedupeWorktimeJobs;')();

const job = (no, o = {}) => Object.assign({
  client_no: no, start: '', end: '', types: [], remarks: '', no_sync: false, night_allowance: false
}, o);
const full = no => job(no, { start: '09:00', end: '10:00', types: ['PC'], remarks: 'done' });

const cases = [
  ['完全相同嘅 6 張 × 2 → 淨返 6',
    [...Array(6)].map((_, i) => full('A' + (i + 1))).concat([...Array(6)].map((_, i) => full('A' + (i + 1)))),
    r => r.length === 6],
  ['空殼（得單號）+ 完整單 → 留完整嗰張',
    [job('A1'), full('A1')],
    r => r.length === 1 && r[0].start === '09:00' && r[0].remarks === 'done'],
  ['⭐ 同單號但時間／類型唔同 → 兩張都留（唔誤刪）',
    [full('A1'), job('A1', { start: '14:00', end: '15:00', types: ['TC'], remarks: '第二次' })],
    r => r.length === 2],
  ['唔同單號 → 全部保留',
    [full('A1'), full('A2'), full('A3')],
    r => r.length === 3],
  ['無單號嘅完全相同單 → 去一張',
    [job(''), job('')],
    r => r.length === 1],
  ['夜急單標記唔同 → 兩張都留',
    [full('A1'), Object.assign(full('A1'), { night_allowance: true })],
    r => r.length === 2],
  ['空 array / undefined → 唔會壞',
    [], r => Array.isArray(r) && r.length === 0]
];

let pass = 0;
for (const [name, input, ok] of cases) {
  const out = dedupe(input);
  const good = ok(out);
  console.log((good ? 'PASS' : 'FAIL') + ' | ' + name + ' | out=' + out.length);
  if (good) pass++;
}
console.log('=== ' + pass + '/' + cases.length + ' passed ===');
process.exit(pass === cases.length ? 0 : 1);
