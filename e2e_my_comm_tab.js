// e2e：記錄頁「佣金狀態」tab — 技術員睇到自己有份嘅佣金記錄狀態
// 重點：lead 記錄過濾放寬做「自己入 OR 自己係隊員」；無關同事唔睇到
const path = require('path');
const ROOT = path.resolve(__dirname);
process.chdir(ROOT);
process.env.PORT = '3584';
const { spawn } = require('child_process');
const fs = require('fs');
const DATA = path.join(ROOT, 'data');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
let pass = 0, fail = 0;
function check(name, ok, extra) { console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : '')); ok ? pass++ : fail++; }
async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch('http://127.0.0.1:3584' + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { code: r.status, cookie: r.headers.get('set-cookie') ? r.headers.get('set-cookie').split(';')[0] : null, body: j };
}

(async () => {
  const FILES = ['tech_leads.json', 'commission_records.json', 'sessions.json'];
  const backup = {};
  for (const f of FILES) {
    const fp = path.join(DATA, f);
    backup[f] = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null;
  }
  const srv = spawn(process.execPath, ['server.js'], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await req('GET', '/api/health'); break; } catch { await wait(250); } }
    // 揀兩個員工 A / B
    const emps = JSON.parse(fs.readFileSync(path.join(DATA, 'employees.json'), 'utf8'));
    check('本地有至少 2 個員工', emps.length >= 2);
    const A = emps[0], B = emps[1];
    const la = await req('POST', '/api/auth/employee-login', { empNumber: A.emp_number, password: '0000' });
    const lb = await req('POST', '/api/auth/employee-login', { empNumber: B.emp_number, password: '0000' });
    check('員工 A(' + A.emp_number + ') 登入', la.code === 200 && !!la.cookie, la.body && la.body.error);
    check('員工 B(' + B.emp_number + ') 登入', lb.code === 200 && !!lb.cookie, lb.body && lb.body.error);
    if (!la.cookie || !lb.cookie) throw new Error('no cookie');
    const aid = la.body.employee.id, bid = lb.body.employee.id;

    // ===== 服務銷售：A 入單，隊員係 B =====
    const mk1 = await req('POST', '/api/tech-leads/records', { record_date: '2026-09-30', customer_name: 'E2E共用單', services: ['Pest control'], members: [{ emp_id: bid }] }, la.cookie);
    check('A 開單（隊員 B）', mk1.code === 200 && mk1.body.success, JSON.stringify(mk1.body).slice(0, 120));
    const sharedId = mk1.body.record.id;
    const mk2 = await req('POST', '/api/tech-leads/records', { record_date: '2026-09-30', customer_name: 'E2E私人單', services: ['Pest control'], members: [{ emp_id: aid }] }, la.cookie);
    check('A 開單（隊員自己）', mk2.code === 200 && mk2.body.success);
    const privateId = mk2.body.record.id;

    // 放寬後：B 應該睇到 shared（佢係隊員），唔應該睇到 private
    const vb = await req('GET', '/api/tech-leads/records', null, lb.cookie);
    const bSeesShared = vb.body.some(r => r.id === sharedId);
    const bSeesPrivate = vb.body.some(r => r.id === privateId);
    check('B 睇到自己係隊員嘅單（放寬後）', bSeesShared);
    check('B 唔睇到同佢無關嘅單（私隱）', !bSeesPrivate);
    const va = await req('GET', '/api/tech-leads/records', null, la.cookie);
    check('A（入數人）兩筆都睇到', va.body.some(r => r.id === sharedId) && va.body.some(r => r.id === privateId));

    // admin 設狀態，B 都睇到狀態
    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    check('admin 登入', al.code === 200 && !!al.cookie);
    await req('PUT', `/api/admin/tech-leads/records/${sharedId}/status`, { status: '已簽約' }, al.cookie);
    const vb2 = await req('GET', '/api/tech-leads/records', null, lb.cookie);
    check('B 睇到「已簽約」狀態', vb2.body.some(r => r.id === sharedId && r.sales_status === '已簽約'));

    // ===== 渠網佣金：A 入單，隊員 B；B 睇到 + 批核狀態 =====
    const cmk = await req('POST', '/api/commission/records', { record_date: '2026-09-30', customer_code: 'E2E02', members: [{ emp_id: bid, sales: 1, installs: 0 }] }, la.cookie);
    check('A 開渠網佣金（隊員 B）', cmk.code === 200 && cmk.body.success, JSON.stringify(cmk.body).slice(0, 120));
    const commId = cmk.body.record.id;
    const vcb = await req('GET', '/api/commission/records', null, lb.cookie);
    check('B 睇到自己佣金記錄（未批核）', vcb.body.some(r => r.id === commId && !r.approved));
    await req('PUT', `/api/admin/commission/records/${commId}/approve`, { approved: true }, al.cookie);
    const vcb2 = await req('GET', '/api/commission/records', null, lb.cookie);
    check('B 睇到「已批核」', vcb2.body.some(r => r.id === commId && r.approved === true));

    // 前端頁面 script 語法檢查
    const vm = require('vm');
    for (const f of ['public/index.html', 'public/admin.html']) {
      const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      let allOk = true, firstErr = '';
      for (const b of blocks) {
        try { new vm.Script(b[1]); } catch (e) { allOk = false; firstErr = e.message; }
      }
      check(f + ' 所有 script 可解析', allOk, firstErr);
    }
    // UI 元素檢查
    const idx = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
    check('有「佣金狀態」tab 按鈕', idx.includes("switchMyTab('comm')") && idx.includes('myTabComm'));
    check('有 myCommPane', idx.includes('id="myCommPane"'));
    check('有 loadMyCommissionStatus', idx.includes('async function loadMyCommissionStatus'));

    console.log('\n===== my-comm-tab: ' + pass + ' PASS / ' + fail + ' FAIL =====');
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('E2E ERROR', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    await wait(300);
    for (const f of FILES) {
      const fp = path.join(DATA, f);
      if (backup[f] === null) { try { fs.unlinkSync(fp); } catch (e) {} }
      else fs.writeFileSync(fp, backup[f], 'utf8');
    }
  }
})();
