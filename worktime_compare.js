'use strict';
/*
 * worktime_compare.js
 * 將 3 個 Python 對比工具 (compare_teams / compare_appt_worktime / compare_first_last)
 * 移植到 Node，供後台「工時對比報告」使用。
 *
 * 輸入：
 *   - records : worktime.json 的陣列（每筆 = 一位技術員一日記錄）
 *   - apptDays: parseAppointmentPdfBuffer 的結果陣列（每日一份 PDF）
 *
 * 輸出：
 *   - analyzeTeamOff(records)                 -> 分析 1：同隊下班時間對比
 *   - analyzeApptVsWorktime(records, apptDays)-> 分析 2：排單 vs 記錄（單號）
 *   - analyzeFirstLast(records, apptDays)     -> 分析 3：第一 / 尾單 vs 上下班
 *   - buildCombinedWorkbook(...)              -> exceljs 產生封面 + 3 sheet 的 xlsx buffer
 */

const ExcelJS = require('exceljs');
const pdfParse = require('pdf-parse');

// ---------- 常數 ----------
const LEAVE_STATUSES = ['大假', '病假', '生日假', '其他'];

// ---------- 工具 ----------
function normId(s) {
  if (s == null) return '';
  const digits = String(s).replace(/\D/g, '');
  const stripped = digits.replace(/^0+/, '');
  return stripped || digits;
}

// 'HH:MM' -> 分鐘；'00:00' -> 1440（跨午夜）
function toMin(t) {
  if (t == null || t === '' || t === '—') return null;
  if (t === '00:00') return 1440;
  const parts = String(t).split(':');
  if (parts.length < 2) return null;
  const v = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  return v === 0 ? 1440 : v;
}

// 等長字串 edit distance（差一個位 = 1）
function editDist(a, b) {
  if (a === b) return 0;
  if (a.length !== b.length) return 99;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// worktime 日期 'YYYY-MM-DD' -> 'M/D'（同 Appointment PDF 的 datekey）
function worktimeDateToKey(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return date;
  return parseInt(m[2], 10) + '/' + parseInt(m[3], 10);
}

// =====================================================================
//  PDF 解析
// =====================================================================
// 從 PDF 文字抽取：datekey、各 team block（tech + slots）、以及所有排單單號
function parseAppointmentText(text, filename) {
  // --- datekey：優先從正文 "Tuesday, 2026/10/06" 取，其次從檔名 "DD-MM-YYYY" ---
  let datekey = null;
  const hm = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(text || '');
  if (hm) {
    datekey = parseInt(hm[2], 10) + '/' + parseInt(hm[3], 10);
  } else if (filename) {
    const fm = /(\d{2})-(\d{2})-(\d{4})/.exec(filename);
    if (fm) datekey = parseInt(fm[2], 10) + '/' + parseInt(fm[1], 10);
  }

  const lines = (text || '').split('\n');
  const blocks = [];
  let cur = null;
  const contractSet = new Set();

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    const blk = /^(\d{2})$/.exec(ln);
    if (blk && i + 1 < lines.length && /technician/i.test(lines[i + 1])) {
      if (cur) blocks.push(cur);
      cur = { no: blk[1], techs: [], slots: [] };
      const tline = lines[i + 1].trim();
      // 例：Technician1.2.3.320 LEUNG CHIN NAM435 Cheuk Chun Cheung396 LING WAI TAK
      const techRe = /(\d{3,4})\s+([A-Za-z][A-Za-z .'-]*?)(?=\d{3,4}\s|$)/g;
      let tm;
      while ((tm = techRe.exec(tline)) !== null) {
        const id = tm[1];
        const name = tm[2].trim();
        if (name) cur.techs.push({ id, normId: normId(id), name });
      }
      i++; // 跳過 techn 行
      continue;
    }
    if (cur !== null) {
      const slot = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(.*)$/.exec(ln);
      if (slot) {
        const start = slot[1];
        const end = slot[2];
        const rest = slot[3].trim();
        let has = false;
        let contract = null;
        if (rest && !/^xxx/i.test(rest)) {
          const cm = /^(\d{3,5})/.exec(rest);
          if (cm) {
            has = true;
            contract = cm[1];
            contractSet.add(contract);
          }
        }
        cur.slots.push({ start, end, has, contract });
      }
    }
  }
  if (cur) blocks.push(cur);

  // 保險：再掃一次全文，確保所有排單單號都入集（不受 block 解析遺漏影響）
  const cRe = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(\d{3,5})/g;
  let m;
  while ((m = cRe.exec(text || '')) !== null) contractSet.add(m[3]);

  return { datekey, blocks, contracts: contractSet };
}

async function parseAppointmentPdfBuffer(buf, filename) {
  const data = await pdfParse(buf);
  return parseAppointmentText(data.text, filename);
}

// =====================================================================
//  分析 1：同隊下班時間對比
// =====================================================================
function analyzeTeamOff(records) {
  // off[(normId, datekey)] = offtime or null
  const off = new Map();
  // teams[datekey][crewKey] = [{normId, name}]
  const teams = new Map();

  for (const r of records || []) {
    const dk = worktimeDateToKey(r.date);
    const nid = normId(r.emp_number);
    const isLeave = LEAVE_STATUSES.includes(r.day_status);
    const offTime = (!isLeave && r.off_time && !/^\s*$/.test(r.off_time)) ? r.off_time : null;
    if (nid) off.set(nid + '|' + dk, offTime);

    const members = Array.isArray(r.members) ? r.members : [];
    if (members.length === 0) continue;
    const key = members.map(m => normId(m.emp_number)).sort().join(',');
    if (!key) continue;
    if (!teams.has(dk)) teams.set(dk, new Map());
    const tmap = teams.get(dk);
    if (!tmap.has(key)) {
      tmap.set(key, members.map(m => ({ normId: normId(m.emp_number), name: m.emp_name || '' })));
    }
  }

  const results = [];
  const anomalies = [];
  let mismatches = 0;
  let allConsistent = true;

  const dks = [...teams.keys()].sort();
  for (const dk of dks) {
    const tmap = teams.get(dk);
    const keys = [...tmap.keys()].sort();
    for (const key of keys) {
      const members = tmap.get(key);
      const recs = members.map(m => ({ name: m.name, o: off.get(m.normId + '|' + dk) }));
      const worked = recs.filter(x => x.o);
      const listedNoRec = recs.filter(x => !x.o);
      const offs = new Set(worked.map(x => x.o));
      const consistent = offs.size <= 1 && worked.length >= 1;
      if (!consistent) {
        allConsistent = false;
        mismatches++;
      }
      const status = consistent ? '✅一致' : '❌唔同';
      const names = members.map(m => m.name).join('、');
      const offtimes = recs.map(x => `${x.name}=${x.o || '—'}`).join(' | ');
      results.push({
        date: dk, count: members.length, names, offtimes, status,
        detail: consistent ? '' : '下班時間有差異'
      });
      for (const x of listedNoRec) {
        anomalies.push({ date: dk, name: x.name || '(無名)', note: '隊員欄有列出但無下班記錄（可能放假/未填）' });
      }
    }
  }
  return { results, anomalies, allConsistent, mismatches };
}

// =====================================================================
//  分析 2：排單 (Appointment) vs 記錄 (Worktime) 單號對比
// =====================================================================
function analyzeApptVsWorktime(records, apptDays) {
  // wtByDate[datekey][contract] = { type, tech, start, end, delivery }
  const wtByDate = new Map();
  for (const r of records || []) {
    const dk = worktimeDateToKey(r.date);
    if (!wtByDate.has(dk)) wtByDate.set(dk, new Map());
    const wd = wtByDate.get(dk);
    for (const j of (r.jobs || [])) {
      const no = (j.client_no || '').trim();
      if (!no) continue;
      const types = Array.isArray(j.types) ? j.types : [];
      const delivery = types.includes('送貨');
      // 同一單號可能被多人記；以最後一筆覆蓋（或合併 type）
      const prev = wd.get(no);
      if (!prev) {
        wd.set(no, { type: types.join('+'), tech: r.emp_name || '', start: j.start || '', end: j.end || '', delivery });
      } else {
        prev.type = [...new Set((prev.type ? prev.type.split('+') : []).concat(types))].join('+');
        prev.delivery = prev.delivery && delivery;
      }
    }
  }

  const summary = [];
  const missingRows = [];
  const extraRows = [];
  const typoRows = [];

  const allDates = new Set([...wtByDate.keys(), ...apptDays.map(a => a.datekey)]);
  for (const dk of [...allDates].sort()) {
    const wd = wtByDate.get(dk) || new Map();
    const ad = (apptDays.find(a => a.datekey === dk) || {}).contracts || new Set();

    const deliveries = new Set([...wd.keys()].filter(n => wd.get(n).delivery));
    const service = new Set([...wd.keys()].filter(n => !deliveries.has(n)));

    const missing = [...ad].filter(n => !service.has(n)); // 排咗單但無記錄
    const extra = [...service].filter(n => !ad.has(n));    // 記錄咗但無排

    // 疑似錯字：missing 同 extra 之間 edit distance = 1
    const typoPairs = new Set();
    const addPair = (mno, eno) => {
      const a = mno < eno ? mno + '|' + eno : eno + '|' + mno;
      typoPairs.add(a);
    };
    for (const mno of missing) {
      for (const eno of extra) if (editDist(mno, eno) === 1) addPair(mno, eno);
      for (const sno of service) if (editDist(mno, sno) === 1) addPair(mno, sno);
    }
    const typoList = [...typoPairs].map(p => p.split('|'));

    const typoAppt = new Set(typoList.map(p => p[0]));
    const typoWt = new Set(typoList.map(p => p[1]));
    const realMissing = missing.filter(m => !typoAppt.has(m));
    const realExtra = extra.filter(e => !typoWt.has(e));

    for (const mno of realMissing) missingRows.push({ date: dk, no: mno, note: '' });
    for (const eno of realExtra) {
      const v = wd.get(eno);
      extraRows.push({ date: dk, no: eno, type: v ? v.type : '', tech: v ? v.tech : '', note: '' });
    }
    for (const [ap, wp] of typoList) typoRows.push({ date: dk, apptNo: ap, wtNo: wp });

    summary.push({
      date: dk, apptN: ad.size, serviceN: service.size, deliveryN: deliveries.size,
      missingN: realMissing.length, extraN: realExtra.length, typoN: typoList.length
    });
  }

  return { summary, missingRows, extraRows, typoRows };
}

// =====================================================================
//  分析 3：第一 / 尾單 (Appointment) vs 上下班 (Worktime)
// =====================================================================
function analyzeFirstLast(records, apptDays) {
  const rows = [];
  const anomalies = [];

  for (const ap of apptDays) {
    const dk = ap.datekey;
    if (!dk) continue;
    for (const b of ap.blocks) {
      const techs = b.techs || [];
      if (techs.length === 0) continue;
      const jobSlots = b.slots.filter(s => s.has);
      const first = jobSlots.length ? jobSlots[0].start : '—';
      const last = jobSlots.length ? jobSlots[jobSlots.length - 1].end : '—';

      const ons = new Set();
      const offs = new Set();
      const missing = [];
      const per = [];
      for (const t of techs) {
        const rec = (records || []).find(r =>
          worktimeDateToKey(r.date) === dk && normId(r.emp_number) === t.normId);
        const on = rec && rec.actual_in ? rec.actual_in : null;
        const off = rec && rec.off_time ? rec.off_time : null;
        if (on) ons.add(on);
        if (off) offs.add(off);
        if (!rec || !rec.actual_in) missing.push(t.name);
        const shortName = (t.name || '').split(/\s+/)[0];
        per.push(`${shortName}(${on || '—'}/${off || '—'})`);
      }
      const on = ons.size ? [...ons].sort().join('/') : '—';
      const off = offs.size ? [...offs].sort().join('/') : '—';
      const nameStr = techs.map(t => t.name).join('、');

      let lateOpen = '';
      let earlyOff = '';
      let offInconsist = '';
      if (first !== '—' && on !== '—') {
        const fm = toMin(first);
        for (const o of ons) {
          const om = toMin(o);
          if (om != null && fm != null && om > fm) { lateOpen = `遲到開工(${o}>第一單${first})`; break; }
        }
      }
      if (last !== '—' && off !== '—') {
        const lm = toMin(last);
        for (const o of offs) {
          const om = toMin(o);
          if (om != null && lm != null && om < lm) { earlyOff = `早走(${o}<尾單${last})`; break; }
        }
      }
      if (offs.size > 1) offInconsist = `同隊放工唔一致(${off})`;

      let note = '';
      if (first === '—') note = '排單無單(無排job)';
      if (missing.length) note = (note ? note + '; ' : '') + '無worktime記錄:' + missing.join('、');

      const flag = (lateOpen || earlyOff || offInconsist) ? '❌' : '✅';
      rows.push({
        date: dk, team: b.no, names: nameStr, first, on, last, off, flag,
        lateOpen, earlyOff, offInconsist, note
      });
      if (flag === '❌') {
        anomalies.push({
          date: dk, team: b.no, names: nameStr, first, on, last, off,
          lateOpen, earlyOff, offInconsist, per: per.join(' ')
        });
      }
    }
  }
  return { rows, anomalies };
}

// =====================================================================
//  產生合併 xlsx (封面 + 3 sheet)
// =====================================================================
function styleHeader(ws, rowNum, ncols, color) {
  for (let c = 1; c <= ncols; c++) {
    const cell = ws.getCell(rowNum, c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    cell.alignment = { vertical: 'middle' };
  }
}

async function buildCombinedWorkbook({ teamOff, apptVsWt, firstLast, meta }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BIOCYCLE';
  wb.created = new Date();

  // ---------- 封面 ----------
  const cover = wb.addWorksheet('封面');
  cover.columns = [{ width: 4 }, { width: 40 }, { width: 40 }];
  cover.getCell('B2').value = 'BIOCYCLE 工時對比報告';
  cover.getCell('B2').font = { bold: true, size: 18 };
  cover.getCell('B4').value = '生成時間'; cover.getCell('C4').value = meta.generatedAt || new Date().toLocaleString('zh-HK');
  cover.getCell('B5').value = '對比日期範圍'; cover.getCell('C5').value = meta.dateRange || '—';
  cover.getCell('B6').value = '上載 Appointment PDF 數量'; cover.getCell('C6').value = meta.pdfCount || 0;
  cover.getCell('B7').value = 'Worktime 記錄數量'; cover.getCell('C7').value = meta.recordCount || 0;

  cover.getCell('B9').value = '★ 分析 1：同隊下班時間對比'; cover.getCell('B9').font = { bold: true, size: 13 };
  cover.getCell('B10').value = '檢查隊數'; cover.getCell('C10').value = teamOff.results.length;
  cover.getCell('B11').value = '下班時間唔同嘅隊'; cover.getCell('C11').value = teamOff.mismatches;
  cover.getCell('B12').value = '名單有但無記錄（可能放假）'; cover.getCell('C12').value = teamOff.anomalies.length;

  cover.getCell('B14').value = '★ 分析 2：排單 vs 記錄（單號）'; cover.getCell('B14').font = { bold: true, size: 13 };
  const totMissing = apptVsWt.missingRows.length;
  const totExtra = apptVsWt.extraRows.length;
  const totTypo = apptVsWt.typoRows.length;
  cover.getCell('B15').value = '缺記錄（排單無做）'; cover.getCell('C15').value = totMissing;
  cover.getCell('B16').value = '多記錄（無排）'; cover.getCell('C16').value = totExtra;
  cover.getCell('B17').value = '疑似錯字'; cover.getCell('C17').value = totTypo;

  cover.getCell('B19').value = '★ 分析 3：第一 / 尾單 vs 上下班'; cover.getCell('B19').font = { bold: true, size: 13 };
  cover.getCell('B20').value = '檢查隊次'; cover.getCell('C20').value = firstLast.rows.length;
  cover.getCell('B21').value = '異常隊次'; cover.getCell('C21').value = firstLast.anomalies.length;

  // ---------- Sheet 1：同隊下班對比 ----------
  const ws1 = wb.addWorksheet('同隊下班對比');
  ws1.columns = [
    { width: 12 }, { width: 6 }, { width: 40 }, { width: 50 }, { width: 10 }, { width: 22 }
  ];
  const h1 = ['日期', '人數', '隊員', '下班時間', '狀態', '備註'];
  ws1.addRow(h1); styleHeader(ws1, 1, h1.length, 'FF305496');
  for (const r of teamOff.results) {
    ws1.addRow([r.date, r.count, r.names, r.offtimes, r.status, r.detail]);
    const row = ws1.lastRow;
    const stCell = row.getCell(5);
    if (r.status.includes('唔同')) {
      stCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      stCell.font = { bold: true, color: { argb: 'FF9C0006' } };
    } else {
      stCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
      stCell.font = { bold: true, color: { argb: 'FF006100' } };
    }
  }
  if (teamOff.anomalies.length) {
    ws1.addRow([]);
    ws1.addRow(['異常（名單有但無下班記錄）']);
    ws1.lastRow.font = { bold: true, color: { argb: 'FFC00000' } };
    const h1b = ['日期', '姓名', '說明'];
    ws1.addRow(h1b); styleHeader(ws1, ws1.lastRow.number, h1b.length, 'FFC00000');
    for (const a of teamOff.anomalies) ws1.addRow([a.date, a.name, a.note]);
  }

  // ---------- Sheet 2：排單 vs 記錄 ----------
  const ws2 = wb.addWorksheet('排單vs記錄');
  ws2.columns = [
    { width: 12 }, { width: 10 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }
  ];
  ws2.addRow(['總結']); ws2.lastRow.font = { bold: true, size: 13 };
  const h2 = ['日期', '排單單數', '服務記錄數', '送貨數', '缺記錄', '多記錄', '疑似錯字'];
  ws2.addRow(h2); styleHeader(ws2, ws2.lastRow.number, h2.length, 'FF305496');
  for (const s of apptVsWt.summary) {
    ws2.addRow([s.date, s.apptN, s.serviceN, s.deliveryN, s.missingN, s.extraN, s.typoN]);
  }
  const addSection = (title, headers, rows, color) => {
    ws2.addRow([]);
    ws2.addRow([title]); ws2.lastRow.font = { bold: true, size: 12, color: { argb: 'FF' + color.slice(2) } };
    ws2.addRow(headers); styleHeader(ws2, ws2.lastRow.number, headers.length, color);
    for (const r of rows) ws2.addRow(r);
  };
  addSection('疑似錯字（差一個位）', ['日期', '排單單號', '記錄單號'],
    apptVsWt.typoRows.map(t => [t.date, t.apptNo, t.wtNo]), 'FFB45309');
  addSection('缺記錄(排單無做)', ['日期', '單號', '備註'],
    apptVsWt.missingRows.map(t => [t.date, t.no, t.note]), 'FFC00000');
  addSection('多記錄(無排)', ['日期', '單號', '工作類型', '技術員', '備註'],
    apptVsWt.extraRows.map(t => [t.date, t.no, t.type, t.tech, t.note]), 'FF7030A0');

  // ---------- Sheet 3：第一尾單對比 ----------
  const ws3 = wb.addWorksheet('第一尾單對比');
  ws3.columns = [
    { width: 8 }, { width: 5 }, { width: 28 }, { width: 13 }, { width: 12 }, { width: 13 },
    { width: 12 }, { width: 7 }, { width: 18 }, { width: 16 }, { width: 20 }, { width: 30 }
  ];
  const h3 = ['日期', '隊', '隊員', '第一單(排單)', '上班(工時)', '尾單(排單)', '下班(工時)', '結果', '遲到開工', '早走', '同隊放工唔一致', '備註'];
  ws3.addRow(h3); styleHeader(ws3, 1, h3.length, 'FF305496');
  for (const r of firstLast.rows) {
    ws3.addRow([r.date, r.team, r.names, r.first, r.on, r.last, r.off, r.flag, r.lateOpen, r.earlyOff, r.offInconsist, r.note]);
    if (r.flag === '❌') {
      for (let c = 1; c <= h3.length; c++) {
        ws3.lastRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      }
    }
  }
  if (firstLast.anomalies.length) {
    ws3.addRow([]);
    ws3.addRow(['異常明細']); ws3.lastRow.font = { bold: true, size: 12, color: { argb: 'FFC00000' } };
    const h3b = ['日期', '隊', '隊員', '第一單', '上班', '尾單', '下班', '遲到開工', '早走', '同隊放工唔一致', '每人上下班'];
    ws3.addRow(h3b); styleHeader(ws3, ws3.lastRow.number, h3b.length, 'FFC00000');
    for (const a of firstLast.anomalies) {
      ws3.addRow([a.date, a.team, a.names, a.first, a.on, a.last, a.off, a.lateOpen, a.earlyOff, a.offInconsist, a.per]);
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

module.exports = {
  normId, toMin, editDist, worktimeDateToKey,
  parseAppointmentText, parseAppointmentPdfBuffer,
  analyzeTeamOff, analyzeApptVsWorktime, analyzeFirstLast,
  buildCombinedWorkbook
};

// 直接執行時做本地測試（node worktime_compare.js <pdf> [mockRecords.json]）
if (require.main === module) {
  (async () => {
    const fs = require('fs');
    const pdfPath = process.argv[2];
    if (!pdfPath) { console.error('用法: node worktime_compare.js <pdf> [records.json]'); process.exit(1); }
    const buf = fs.readFileSync(pdfPath);
    const ap = await parseAppointmentPdfBuffer(buf, pdfPath);
    console.log('datekey:', ap.datekey, '| blocks:', ap.blocks.length, '| contracts:', ap.contracts.size);
    for (const b of ap.blocks) {
      console.log(`  team ${b.no}: techs=[${b.techs.map(t => t.id + ':' + t.name).join(', ')}] slots=${b.slots.length} hasJob=${b.slots.filter(s => s.has).length}`);
    }
    console.log('contracts sample:', [...ap.contracts].slice(0, 15).join(', '));
  })();
}
