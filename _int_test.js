const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const worktimeCompare = require('./worktime_compare');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// compact mock worktime records (covers team01/02/07/11 of the 06-10 PDF)
function rec(emp_id, date, actual_in, off_time, members, jobs) {
  return {
    date, day_status: '正常上班', holiday_work: false, actual_in, off_time,
    members: members.map(m => ({ emp_id: m.id, emp_name: m.name, emp_number: 'ST' + m.id })),
    emp_number: 'ST' + emp_id, emp_name: members.find(m => m.id === emp_id) ? members.find(m => m.id === emp_id).name : '',
    jobs: jobs.map(j => ({ client_no: j.no, start: j.start, end: j.end, types: j.types }))
  };
}
const t01 = [{ id: 320, name: 'LEUNG CHIN NAM' }, { id: 435, name: 'Cheuk Chun Cheung' }, { id: 396, name: 'LING WAI TAK' }];
const t02 = [{ id: 199, name: 'CHAN CHU MING' }, { id: 273, name: 'CHAN WING HONG' }, { id: 444, name: 'NG KIT YING' }];
const t07 = [{ id: 82, name: 'LEE KIN FAI' }, { id: 418, name: 'Lo Chun Wai' }];
const t11 = [{ id: 65, name: 'LEE KWOK KEUNG RYAN' }, { id: 340, name: 'MO KWAN LAI EDDIE' }];
const recs = [
  rec(320, '2026-10-06', '08:30', '18:00', t01, [{ no: '62711', start: '10:00', end: '11:00', types: ['滅蟲'] }]),
  rec(435, '2026-10-06', '08:30', '18:00', t01, [{ no: '62711', start: '10:00', end: '11:00', types: ['滅蟲'] }]),
  rec(396, '2026-10-06', '08:45', '18:00', t01, []),
  rec(199, '2026-10-06', '09:00', '17:30', t02, [{ no: '70354', start: '09:30', end: '10:00', types: ['滅蟲'] }, { no: '99999', start: '15:00', end: '16:00', types: ['滅蟲'] }]),
  rec(273, '2026-10-06', '09:00', '18:00', t02, [{ no: '70354', start: '09:30', end: '10:00', types: ['滅蟲'] }]),
  rec(444, '2026-10-06', '09:00', '18:00', t02, [{ no: '94224', start: '10:00', end: '11:00', types: ['滅蟲'] }]),
  rec(82, '2026-10-06', '08:00', '18:00', t07, [{ no: '55000', start: '14:00', end: '15:00', types: ['滅蟲'] }]),
  rec(418, '2026-10-06', '08:00', '18:00', t07, [{ no: '55000', start: '14:00', end: '15:00', types: ['滅蟲'] }]),
  rec(65, '2026-10-06', '09:00', '19:00', t11, [{ no: '11111', start: '10:00', end: '11:00', types: ['滅蟲'] }])
];

app.post('/api/admin/worktime/compare', upload.array('pdfs', 30), async (req, res) => {
  try {
    const files = (req.files || []).filter(f => f && f.buffer && /\.pdf$/i.test(f.originalname || ''));
    if (!files.length) return res.status(400).json({ error: 'no pdf' });
    const apptDays = [];
    for (const f of files) { const ap = await worktimeCompare.parseAppointmentPdfBuffer(f.buffer, f.originalname || ''); if (ap.datekey) apptDays.push(ap); }
    const teamOff = worktimeCompare.analyzeTeamOff(recs);
    const apptVsWt = worktimeCompare.analyzeApptVsWorktime(recs, apptDays);
    const firstLast = worktimeCompare.analyzeFirstLast(recs, apptDays);
    const buf = Buffer.from(await worktimeCompare.buildCombinedWorkbook({ teamOff, apptVsWt, firstLast, meta: { generatedAt: 'TEST', dateRange: '2026-10-06', pdfCount: apptDays.length, recordCount: recs.length } }));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="test.xlsx"');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const server = app.listen(0, async () => {
  const port = server.address().port;
  try {
    const fd = new FormData();
    fd.append('pdfs', new Blob([fs.readFileSync('C:/Users/Sum/Desktop/Appointment/Appointment_06-10-2026.pdf')], { type: 'application/pdf' }), 'Appointment_06-10-2026.pdf');
    const r = await fetch(`http://localhost:${port}/api/admin/worktime/compare`, { method: 'POST', body: fd });
    console.log('status', r.status, '| content-type', r.headers.get('content-type'), '| disposition', r.headers.get('content-disposition'));
    const ab = await r.arrayBuffer();
    const out = path.join(__dirname, '_int_out.xlsx');
    fs.writeFileSync(out, Buffer.from(ab));
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(ab));
    console.log('sheets:', wb.worksheets.map(w => w.name + '(' + w.rowCount + 'r)').join(', '));
    console.log('INTEGRATION TEST OK');
  } catch (e) {
    console.error('INT ERR', e);
  } finally {
    server.close();
  }
});
