// backup_online_questions.js — 由生產 (Railway/Redis) 拉題庫備份落本地
// 用途：用戶一直喺線上版改題庫（存 Redis），推 code 前先做一份備份，防止萬一唔見。
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'https://biocycle-exam-system-production.up.railway.app';
const ADMIN_USER = process.env.ADMIN_USER || 'ST140';
const ADMIN_PASS = process.env.ADMIN_PASS || '61583398';
const TOPICS = [1, 2, 3, 4, 5, 6, 7, 8];
const OUT_DIR = path.join(__dirname, 'backups');

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) Login 拎 session cookie
  const loginRes = await fetch(BASE + '/api/auth/admin-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS })
  });
  const loginJson = await loginRes.json();
  if (!loginJson.success) {
    console.error('❌ Login 失敗：', loginJson.error);
    process.exit(1);
  }
  const setCookie = loginRes.headers.get('set-cookie');
  const sid = setCookie ? setCookie.split(';')[0] : '';
  console.log('✅ Login OK，session =', sid.slice(0, 12) + '...');

  const cookieHeader = sid;
  const auth = { headers: { 'Cookie': cookieHeader } };

  const backup = { meta: { base: BASE, exported_at: new Date().toISOString(), by: ADMIN_USER }, questions: {}, topics: null, examConfig: null };

  // 2) 逐 topic 拉 MC + 問答
  for (const tid of TOPICS) {
    const res = await fetch(BASE + '/api/admin/questions/' + tid, auth);
    const j = await res.json();
    if (!j.success) {
      console.error(`⚠️ topic ${tid} 讀取失敗：`, j.error);
      backup.questions[tid] = { error: j.error };
      continue;
    }
    backup.questions[tid] = { mc: j.mc, essay: j.essay, mcCount: j.mcCount, essayCount: j.essayCount };
    console.log(`✅ topic ${tid}: MC=${j.mcCount}, 問答=${j.essayCount}`);
  }

  // 3) topics.json
  try {
    const r = await fetch(BASE + '/api/topics', auth);
    const j = await r.json();
    backup.topics = j.topics || j;
    console.log('✅ topics.json 已備份');
  } catch (e) { console.error('⚠️ topics 讀取失敗：', e.message); }

  // 4) exam-config
  try {
    const r = await fetch(BASE + '/api/admin/exam-config', auth);
    const j = await r.json();
    backup.examConfig = j.config || j;
    console.log('✅ exam-config 已備份');
  } catch (e) { console.error('⚠️ exam-config 讀取失敗：', e.message); }

  // 5) 寫檔
  const outFile = path.join(OUT_DIR, `online_questions_backup_${ts()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(backup, null, 2), 'utf-8');
  console.log('\n📦 備份完成 ->', outFile);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
