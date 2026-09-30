// e2e：服務銷售狀態（已查閱/已簽約/不簽約）+ 渠網佣金已批核
// 注意：server.js 寫死 DATA_DIR=__dirname/data（env 唔生效），測試前備份兩個檔、測完還原
const path = require('path');
const ROOT = path.resolve(__dirname);
process.chdir(ROOT);
process.env.PORT = '3582';
const { spawn } = require('child_process');
const fs = require('fs');
const DATA = path.join(ROOT, 'data');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
let pass = 0, fail = 0;
function check(name, ok, extra) { console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : '')); ok ? pass++ : fail++; }
async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch('http://127.0.0.1:3582' + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { code: r.status, cookie: r.headers.get('set-cookie') ? r.headers.get('set-cookie').split(';')[0] : null, body: j };
}

(async () => {
  // 備份將會被測試寫到嘅兩個檔
  const FILES = ['tech_leads.json', 'commission_records.json', 'sessions.json'];
  const backup = {};
  for (const f of FILES) {
    const fp = path.join(DATA, f);
    backup[f] = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null;
  }
  const srv = spawn(process.execPath, ['server.js'], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await req('GET', '/api/health'); break; } catch { await wait(250); } }
    // 登入（本地 data 有 ST82）
    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    check('admin 登入', al.code === 200 && !!al.cookie);
    const el = await req('POST', '/api/auth/employee-login', { empNumber: 'ST82', password: '0000' });
    check('員工登入', el.code === 200 && !!el.cookie, el.body && el.body.error);
    if (!al.cookie || !el.cookie) throw new Error('no cookie');

    // ===== 服務銷售狀態 =====
    const mk = await req('POST', '/api/tech-leads/records', { record_date: '2026-09-30', customer_name: 'E2E測試客戶', services: ['Pest control'], members: [{ emp_id: el.body.employee.id }] }, el.cookie);
    check('員工開服務銷售記錄', mk.code === 200 && mk.body.success && mk.body.record.id >= 1, JSON.stringify(mk.body).slice(0, 120));
    const leadId = mk.body.record.id;

    const st1 = await req('PUT', `/api/admin/tech-leads/records/${leadId}/status`, { status: '已查閱' }, al.cookie);
    check('admin 設「已查閱」', st1.code === 200 && st1.body.record.sales_status === '已查閱' && !!st1.body.record.sales_status_at, JSON.stringify(st1.body).slice(0, 160));
    const st2 = await req('PUT', `/api/admin/tech-leads/records/${leadId}/status`, { status: '已簽約' }, al.cookie);
    check('admin 改「已簽約」', st2.code === 200 && st2.body.record.sales_status === '已簽約');
    const st3 = await req('PUT', `/api/admin/tech-leads/records/${leadId}/status`, { status: '不簽約' }, al.cookie);
    check('admin 改「不簽約」', st3.code === 200 && st3.body.record.sales_status === '不簽約');
    const stBad = await req('PUT', `/api/admin/tech-leads/records/${leadId}/status`, { status: '亂噉嚟' }, al.cookie);
    check('無效狀態 400', stBad.code === 400);
    const st404 = await req('PUT', '/api/admin/tech-leads/records/99999/status', { status: '已查閱' }, al.cookie);
    check('唔存在記錄 404', st404.code === 404);
    const stEmp = await req('PUT', `/api/admin/tech-leads/records/${leadId}/status`, { status: '已查閱' }, el.cookie);
    check('員工唔可以改狀態', stEmp.code !== 200, 'code=' + stEmp.code);
    const empView = await req('GET', '/api/tech-leads/records', null, el.cookie);
    check('員工睇到狀態', empView.code === 200 && empView.body.some(r => r.id === leadId && r.sales_status === '不簽約'));
    const stClear = await req('PUT', `/api/admin/tech-leads/records/${leadId}/status`, { status: '' }, al.cookie);
    check('清空狀態返未處理', stClear.code === 200 && (stClear.body.record.sales_status == null) && stClear.body.record.sales_status_at == null);

    // ===== 渠網佣金已批核 =====
    const cmk = await req('POST', '/api/commission/records', { record_date: '2026-09-30', customer_code: 'E2E01', members: [{ emp_id: el.body.employee.id, sales: 2, installs: 1 }] }, el.cookie);
    check('員工開渠網佣金記錄', cmk.code === 200 && cmk.body.success && cmk.body.record.id >= 1, JSON.stringify(cmk.body).slice(0, 120));
    const commId = cmk.body.record.id;

    const ap1 = await req('PUT', `/api/admin/commission/records/${commId}/approve`, { approved: true }, al.cookie);
    check('admin 批核', ap1.code === 200 && ap1.body.record.approved === true && !!ap1.body.record.approved_at && !!ap1.body.record.approved_by, JSON.stringify(ap1.body).slice(0, 180));
    const empComm = await req('GET', '/api/commission/records', null, el.cookie);
    check('員工睇到已批核', empComm.code === 200 && empComm.body.some(r => r.id === commId && r.approved === true));
    const apOff = await req('PUT', `/api/admin/commission/records/${commId}/approve`, { approved: false }, al.cookie);
    check('admin 取消批核', apOff.code === 200 && apOff.body.record.approved === false && apOff.body.record.approved_at == null);
    const apEmp = await req('PUT', `/api/admin/commission/records/${commId}/approve`, { approved: true }, el.cookie);
    check('員工唔可以批核', apEmp.code !== 200, 'code=' + apEmp.code);
    const ap404 = await req('PUT', '/api/admin/commission/records/99999/approve', { approved: true }, al.cookie);
    check('批核唔存在記錄 404', ap404.code === 404);

    // 前端頁面 script 語法檢查
    const vm = require('vm');
    for (const f of ['public/admin.html', 'public/index.html']) {
      const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      let allOk = true, firstErr = '';
      for (const b of blocks) {
        try { new vm.Script(b[1]); } catch (e) { allOk = false; firstErr = e.message; }
      }
      check(f + ' 所有 script 可解析', allOk, firstErr);
    }

    console.log('\n===== comm-status: ' + pass + ' PASS / ' + fail + ' FAIL =====');
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('E2E ERROR', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    await wait(300);
    // 還原測試檔（移除 e2e 加嘅記錄）
    for (const f of FILES) {
      const fp = path.join(DATA, f);
      if (backup[f] === null) { try { fs.unlinkSync(fp); } catch (e) {} }
      else fs.writeFileSync(fp, backup[f], 'utf8');
    }
  }
})();
