const fs = require('fs');
const path = require('path');
const mod = require('./worktime_compare');

(async () => {
  const pdfPath = 'C:/Users/Sum/Desktop/Appointment/Appointment_06-10-2026.pdf';
  const buf = fs.readFileSync(pdfPath);
  const ap = await mod.parseAppointmentPdfBuffer(buf, pdfPath);
  const apptDays = [ap];

  // ---- mock worktime records ----
  function rec(emp_number, emp_name, emp_id, date, actual_in, off_time, members, jobs, day_status) {
    return {
      date, day_status: day_status || '正常上班', holiday_work: false,
      actual_in, off_time,
      members: members.map(m => ({ emp_id: m.id, emp_name: m.name, emp_number: 'ST' + m.id })),
      emp_number: 'ST' + emp_id, emp_name,
      jobs: jobs.map(j => ({ client_no: j.no, start: j.start, end: j.end, types: j.types }))
    };
  }
  const team01 = [{ id: 320, name: 'LEUNG CHIN NAM' }, { id: 435, name: 'Cheuk Chun Cheung' }, { id: 396, name: 'LING WAI TAK' }];
  const team02 = [{ id: 199, name: 'CHAN CHU MING' }, { id: 273, name: 'CHAN WING HONG' }, { id: 444, name: 'NG KIT YING' }];
  const team07 = [{ id: 82, name: 'LEE KIN FAI' }, { id: 418, name: 'Lo Chun Wai' }];
  const team11 = [{ id: 65, name: 'LEE KWOK KEUNG RYAN' }, { id: 340, name: 'MO KWAN LAI EDDIE' }];

  const records = [];
  // team01: off consistent (18:00), but 396 actual_in 08:45; jobs include 94223,62711
  records.push(rec('ST320', 'LEUNG CHIN NAM', 320, '2026-10-06', '08:30', '18:00', team01,
    [{ no: '62711', start: '10:00', end: '11:00', types: ['滅蟲'] }]));
  records.push(rec('ST435', 'Cheuk Chun Cheung', 435, '2026-10-06', '08:30', '18:00', team01,
    [{ no: '62711', start: '10:00', end: '11:00', types: ['滅蟲'] }]));
  records.push(rec('ST396', 'LING WAI TAK', 396, '2026-10-06', '08:45', '18:00', team01,
    []));

  // team02: off INCONSISTENT (199=17:30, 273=18:00, 444=18:00) -> team-off mismatch
  // also: appt has 91865 but no wt job -> missing; wt has 99999 not in appt -> extra; typo 94223 vs 94224
  records.push(rec('ST199', 'CHAN CHU MING', 199, '2026-10-06', '09:00', '17:30', team02,
    [{ no: '70354', start: '09:30', end: '10:00', types: ['滅蟲'] }, { no: '99999', start: '15:00', end: '16:00', types: ['滅蟲'] }]));
  records.push(rec('ST273', 'CHAN WING HONG', 273, '2026-10-06', '09:00', '18:00', team02,
    [{ no: '70354', start: '09:30', end: '10:00', types: ['滅蟲'] }]));
  records.push(rec('ST444', 'NG KIT YING', 444, '2026-10-06', '09:00', '18:00', team02,
    [{ no: '94224', start: '10:00', end: '11:00', types: ['滅蟲'] }])); // 94224 ~ appt 94223 typo

  // team07: leading-zero id 082; off 18:00 but appt last job ends 20:00 -> earlyOff flag
  records.push(rec('ST82', 'LEE KIN FAI', 82, '2026-10-06', '08:00', '18:00', team07,
    [{ no: '55000', start: '14:00', end: '15:00', types: ['滅蟲'] }]));
  records.push(rec('ST418', 'Lo Chun Wai', 418, '2026-10-06', '08:00', '18:00', team07,
    [{ no: '55000', start: '14:00', end: '15:00', types: ['滅蟲'] }]));

  // team11: leading-zero 065; one member (340) missing worktime record -> note
  records.push(rec('ST65', 'LEE KWOK KEUNG RYAN', 65, '2026-10-06', '09:00', '19:00', team11,
    [{ no: '11111', start: '10:00', end: '11:00', types: ['滅蟲'] }]));
  // 340 not recorded

  // ---- run analyses ----
  const teamOff = mod.analyzeTeamOff(records);
  const apptVsWt = mod.analyzeApptVsWorktime(records, apptDays);
  const firstLast = mod.analyzeFirstLast(records, apptDays);

  console.log('=== 分析1 同隊下班 ===');
  console.log('results:', teamOff.results.length, 'mismatches:', teamOff.mismatches, 'anomalies:', teamOff.anomalies.length);
  teamOff.results.forEach(r => console.log(`  [${r.count}人] ${r.status} ${r.date} ${r.names} | ${r.offtimes}`));
  console.log('anomalies:', JSON.stringify(teamOff.anomalies));

  console.log('=== 分析2 排單vs記錄 ===');
  console.log('summary:', apptVsWt.summary);
  console.log('typoRows:', apptVsWt.typoRows);
  console.log('missingRows (first 5):', apptVsWt.missingRows.slice(0, 5));
  console.log('extraRows:', apptVsWt.extraRows);

  console.log('=== 分析3 第一尾單 ===');
  console.log('rows:', firstLast.rows.length, 'anomalies:', firstLast.anomalies.length);
  firstLast.rows.forEach(r => console.log(`  ${r.date} team${r.team} ${r.names} first=${r.first} on=${r.on} last=${r.last} off=${r.off} flag=${r.flag} ${r.lateOpen} ${r.earlyOff} ${r.offInconsist} ${r.note}`));

  // ---- build workbook ----
  const outPath = path.join('C:/Users/Sum/WorkBuddy/2026-06-28-22-52-03/exam-system', '_compare_test.xlsx');
  const wbBuf = await mod.buildCombinedWorkbook({
    teamOff, apptVsWt, firstLast,
    meta: { generatedAt: 'TEST', dateRange: '2026-10-06', pdfCount: 1, recordCount: records.length }
  });
  fs.writeFileSync(outPath, wbBuf);
  console.log('=== workbook written:', outPath, wbBuf.length, 'bytes ===');

  // verify by re-opening
  const ExcelJS = require('exceljs');
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(wbBuf);
  console.log('sheets:', wb2.worksheets.map(w => w.name + '(' + w.rowCount + 'r)').join(', '));
})().catch(e => { console.error('TEST ERR', e); process.exit(1); });
