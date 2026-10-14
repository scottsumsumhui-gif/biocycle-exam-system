// 唯讀檢查 prod 匯出（不修改任何資料）
const ExcelJS = require('exceljs');
const PROD = 'https://biocycle-exam-system-production.up.railway.app';

async function req(method, p, body, cookie) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(PROD + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ab = await r.arrayBuffer();
  return { code: r.status, cookie: r.headers.get('set-cookie') ? r.headers.get('set-cookie').split(';')[0] : null, buf: Buffer.from(ab) };
}
function reqText(method, p, body, cookie) {
  return req(method, p, body, cookie);
}

(async () => {
  const al = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  console.log('admin login:', al.code, 'cookie:', al.cookie, 'body:', al.buf.slice(0, 200).toString());
  const exp = await req('GET', '/api/admin/worktime/export?from=2026-09-01&to=2026-09-30', null, al.cookie);
  console.log('export:', exp.code, exp.buf.length, 'bytes', exp.buf.slice(0, 120).toString());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(exp.buf);
  const ws = wb.worksheets[0];
  console.log('sheet:', ws.name);
  for (let i = 1; i <= 30; i++) {
    const row = ws.getRow(i);
    const vals = [];
    for (let c = 1; c <= 6; c++) { const v = row.getCell(c).value; vals.push(v == null ? '' : String(v).slice(0, 18)); }
    console.log(String(i).padStart(2), '|', vals.join(' | '));
  }
})();
