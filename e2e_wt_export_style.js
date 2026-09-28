// e2e：工時記錄 Excel 匯出樣式（ExcelJS 框線／粗體／填色）— 2026-09-28
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const NODE = process.execPath;
const PORT = 3031;
const BASE = 'http://127.0.0.1:' + PORT;
const ExcelJS = require('exceljs');
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' | got: ' + JSON.stringify(extra) : '')); }
}

function hkDate(offsetDays) {
  const d = new Date();
  const hk = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000 + (offsetDays || 0) * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${hk.getFullYear()}-${p(hk.getMonth() + 1)}-${p(hk.getDate())}`;
}
const isSun = d => new Date(d + 'T00:00:00+08:00').getDay() === 0;

async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.get('set-cookie');
  return { code: r.status, cookie: setCookie ? setCookie.split(';')[0] : null, body: await r.text() };
}

function waitServer(tries) {
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { clearInterval(t); resolve(); } } catch (e) {}
      if (--tries <= 0) { clearInterval(t); reject(new Error('server not up')); }
    }, 500);
  });
}

(async () => {
  const wtPath = path.join(DIR, 'data', 'worktime.json');
  const wtBackup = fs.existsSync(wtPath) ? fs.readFileSync(wtPath) : null;
  const child = spawn(NODE, ['server.js'], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitServer(40);
    const emps = j(fs.readFileSync(path.join(DIR, 'data', 'employees.json'), 'utf8')) || [];
    let ec = null, A = null;
    for (const e of emps) {
      const lg = await req('POST', '/api/auth/employee-login', { empNumber: e.emp_number, password: '0000' });
      if (lg.code === 200 && lg.cookie) { ec = lg.cookie; A = e; break; }
    }
    check('員工登入成功', !!ec, ec ? A.emp_number : '無員工可用');

    // 過去 7 日內搵 3 個唔係星期日嘅日期提交（有 job、有 remark）
    const dates = [];
    for (let o = 1; o <= 7 && dates.length < 3; o++) {
      const d = hkDate(-o);
      if (!isSun(d)) dates.push(d);
    }
    for (const date of dates) {
      const rec = {
        date, day_status: '正常上班', schedule_in: '10:00', actual_in: '10:00', off_time: '18:30',
        jobs: [{ client_no: 'J-' + date.slice(8), start: '10:30', end: '12:00', types: ['PC'], night_allowance: false, remarks: 'e2e 樣式測試' }],
        members: [{ emp_id: A.id }], remark: 'e2e 備註', ignore_conflict: true
      };
      const r = await req('POST', '/api/worktime/records', rec, ec);
      check('提交 ' + date, r.code === 200, r.body.slice(0, 120));
    }

    const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
    check('admin 登入', al.code === 200 && !!al.cookie, al.body.slice(0, 100));

    const from = dates[dates.length - 1], to = dates[0];
    const exp = await fetch(BASE + '/api/admin/worktime/export?from=' + from + '&to=' + to, { headers: { Cookie: al.cookie } });
    check('匯出 HTTP 200', exp.status === 200, exp.status);
    const ab = Buffer.from(await exp.arrayBuffer());
    const xlsxPath = path.join(DIR, 'tmp_wt_export_test.xlsx');
    fs.writeFileSync(xlsxPath, ab);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(ab);
    const ws = wb.worksheets[0];
    check('有 worksheet', !!ws, wb.worksheets.length);
    if (ws) {
      check('標題 A1 粗體 14pt', ws.getCell('A1').font && ws.getCell('A1').font.bold === true && ws.getCell('A1').font.size === 14, JSON.stringify(ws.getCell('A1').font));
      check('標題合併 A1:J1', (ws.model.merges || []).some(m => m.includes('A1') && m.includes('J1')), JSON.stringify(ws.model.merges));
      check('A1 有框', ws.getCell('A1').border && ws.getCell('A1').border.top && ws.getCell('A1').border.top.style === 'thin', JSON.stringify(ws.getCell('A1').border));

      // 搵 job header 行（單號）驗證填色 + 粗體
      let jobHdr = null, totalsRow = null, dayRow = null;
      ws.eachRow((row, num) => {
        const v = row.getCell(1).value;
        if (v === '單號') jobHdr = row;
        if (v === '本週合計') totalsRow = row;
        if (v === '日期') dayRow = row;
      });
      check('搵到「單號」表頭行', !!jobHdr);
      if (jobHdr) {
        const f = jobHdr.getCell(1).fill;
        check('單號表頭填色 D9E1F2', f && f.fgColor && f.fgColor.argb === 'FFD9E1F2', JSON.stringify(f));
        check('單號表頭粗體', jobHdr.getCell(1).font && jobHdr.getCell(1).font.bold === true, JSON.stringify(jobHdr.getCell(1).font));
      }
      check('搵到「本週合計」行', !!totalsRow);
      if (totalsRow) {
        const f = totalsRow.getCell(1).fill;
        check('合計行填色 FFF2CC', f && f.fgColor && f.fgColor.argb === 'FFFFF2CC', JSON.stringify(f));
        check('合計行粗體', totalsRow.getCell(1).font && totalsRow.getCell(1).font.bold === true, JSON.stringify(totalsRow.getCell(1).font));
      }
      check('搵到「日期」行', !!dayRow);
      if (dayRow) {
        check('日期行標籤粗體', dayRow.getCell(1).font && dayRow.getCell(1).font.bold === true, JSON.stringify(dayRow.getCell(1).font));
        check('日期行有框', dayRow.getCell(5).border && dayRow.getCell(5).border.bottom && dayRow.getCell(5).border.bottom.style === 'thin', JSON.stringify(dayRow.getCell(5).border));
      }

      // 分隔空行：第 2 個「日期」行嘅上一行必須完全空（冇值、冇框）
      const dayRows = [];
      ws.eachRow((row, num) => { if (row.getCell(1).value === '日期') dayRows.push(num); });
      check('有 ≥2 個日期行', dayRows.length >= 2, dayRows.length);
      if (dayRows.length >= 2) {
        const prevNum = dayRows[1] - 1;
        const prev = ws.getRow(prevNum);
        let prevEmpty = true;
        for (let c = 1; c <= 10; c++) if (prev.getCell(c).value != null) prevEmpty = false;
        check('日期行之間有分隔空行（row ' + prevNum + '）', prevEmpty);
        check('空行冇框線', !(prev.getCell(5).border && prev.getCell(5).border.top && prev.getCell(5).border.top.style), JSON.stringify(prev.getCell(5).border));
        const fillA = prev.getCell(1).fill;
        check('分隔條填灰 BFBFBF', fillA && fillA.pattern === 'solid' && fillA.fgColor && fillA.fgColor.argb === 'FFBFBFBF', JSON.stringify(fillA));
      }
    }

    // 舊 XLSX 匯出（月度 OT）確認無整爛 — 只檢查 endpoint 存在回應
    const mo = await fetch(BASE + '/api/admin/worktime/monthly-ot/export?month=' + hkDate(0).slice(0, 7), { headers: { Cookie: al.cookie } });
    check('月度 OT 匯出仍 200', mo.status === 200, mo.status);

    fs.unlinkSync(xlsxPath);
    console.log('\n===== wt-export-style: ' + pass + ' PASS / ' + fail + ' FAIL =====');
  } catch (e) {
    console.log('ERROR', e.message); fail++;
  } finally {
    if (wtBackup) fs.writeFileSync(wtPath, wtBackup); else if (fs.existsSync(wtPath)) fs.unlinkSync(wtPath);
    child.kill();
  }
  process.exit(fail ? 1 : 0);
})();
