// 打卡對賬核心邏輯（可被 server.js 同 test script 共用）
// 用法：parseAttendance(bufOrPath) -> 結構化打卡 rows；reconcileAttendance(attRows, wtRecs, opts) -> {summary, mismatches}
const XLSX = require('xlsx');

const WT_PRESENT = ['正常上班', '留守公司', '公眾假期'];
const WT_LEAVE = ['大假', '病假', '生日假', '其他'];

function pad2(n) { return String(n).padStart(2, '0'); }

function excelDateToISO(serial) {
  if (typeof serial === 'number' && serial > 40000) {
    const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  if (typeof serial === 'string') {
    const s = serial.trim();
    // 已經係 YYYY-MM-DD 或 YYYY/MM/DD
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  }
  return null;
}

function hmToMin(v) {
  if (typeof v === 'number') return Math.round(v * 24 * 60); // Excel 時間小數
  if (typeof v === 'string') {
    const s = v.trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (m) return (+m[1]) * 60 + (+m[2]);
  }
  return null;
}

function parseCell(rows, header, rowArr, name) {
  const idx = header.indexOf(name);
  return idx >= 0 ? rowArr[idx] : undefined;
}

// 解析打卡 xlsx -> 結構化 array（不過濾 S008，保留 employer 等資訊）
function parseAttendance(bufOrPath) {
  const wb = typeof bufOrPath === 'string'
    ? XLSX.readFile(bufOrPath)
    : XLSX.read(bufOrPath, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h == null ? '' : h).trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.length || (r.length === 1 && r[0] == null)) continue;
    const rawDate = parseCell(rows, header, r, 'Date');
    const date = excelDateToISO(rawDate);
    if (!date) continue;
    const placement = String(parseCell(rows, header, r, 'Placement Number') || '').trim();
    const employer = String(parseCell(rows, header, r, 'Employer') || '').trim();
    const shift = String(parseCell(rows, header, r, 'Shift') || '').trim();
    const status = String(parseCell(rows, header, r, 'Attendance Status') || '').trim();
    const inTime = parseCell(rows, header, r, 'In Time');
    const outTime = parseCell(rows, header, r, 'Out Time');
    const workedRaw = parseCell(rows, header, r, 'Worked Hrs');
    const workedMin = hmToMin(workedRaw);
    const nameRaw = String(parseCell(rows, header, r, 'Employee Name') || '').trim();
    out.push({
      emp_number: placement,
      employer,
      emp_name: nameRaw,
      date,
      shift,
      status,
      in_time: inTime == null ? '' : String(inTime).trim(),
      out_time: outTime == null ? '' : String(outTime).trim(),
      worked_min: workedMin == null ? 0 : workedMin,
    });
  }
  return out;
}

// 對賬：attRows(打卡結構化) + wtRecs(worktime.json array) + opts
// opts: { exemptAdmins:['ST065',...], lateToleranceMin:30, scopeEmployer:'S008' }
function reconcileAttendance(attRows, wtRecs, opts = {}) {
  const exempt = new Set(opts.exemptAdmins || []);
  const lateTol = opts.lateToleranceMin != null ? opts.lateToleranceMin : 30;
  const scope = opts.scopeEmployer || 'S008';

  // 打卡側：只對 scope 雇主 + 真正出勤日（worked_min > 0）
  const attMap = {}; // emp_number -> date -> row
  let attMin = '9999-99-99', attMax = '0000-00-00';
  for (const a of attRows) {
    if (scope && !String(a.employer).includes(scope)) continue;
    if (exempt.has(a.emp_number)) continue;
    if (a.worked_min <= 0) continue; // 真正出勤先計（worked=0 嘅假期/休息日唔算）
    if (a.date < attMin) attMin = a.date;
    if (a.date > attMax) attMax = a.date;
    (attMap[a.emp_number] = attMap[a.emp_number] || {});
    attMap[a.emp_number][a.date] = a;
  }

  // 系統側：只對 ST（S008）+ 只對打卡文件涵蓋嘅日期範圍（避免 9 月/11 月等無關月份變 mismatch）
  const wtMap = {}; // emp_number -> date -> {present, status}
  for (const w of wtRecs) {
    const en = w.emp_number || '';
    if (!en.startsWith('ST')) continue;
    if (exempt.has(en)) continue;
    if (w.date < attMin || w.date > attMax) continue; // 超出打卡覆蓋範圍就唔對
    const tdh = Number(w.total_duty_hours) || 0;
    // 出勤：正常上班/留守公司 必須有當值時數（tdh>0）；公眾假期開工都要 tdh>0。
    // 否則當係空白 stub / 未填時間（如 syncTeamJobs 自動開嘅空 record），唔當出勤。
    const present = (w.day_status === '正常上班' || w.day_status === '留守公司' ||
      w.day_status === '公眾假期') && tdh > 0;
    const kind = present ? 'present' : (WT_LEAVE.includes(w.day_status) ? 'leave' : 'none');
    (wtMap[en] = wtMap[en] || {});
    wtMap[en][w.date] = { present, kind, day_status: w.day_status, actual_in: w.actual_in || '', schedule_in: w.schedule_in || '', off_time: w.off_time || '' };
  }

  const mismatches = [];
  const counts = { 打卡有系統無: 0, 系統有打卡無: 0, 時間對唔上: 0, 狀態對唔上: 0 };

  const allEmps = new Set([...Object.keys(attMap), ...Object.keys(wtMap)]);
  for (const emp of allEmps) {
    const aDates = attMap[emp] || {};
    const wDates = wtMap[emp] || {};
    const allDates = new Set([...Object.keys(aDates), ...Object.keys(wDates)]);
    for (const date of allDates) {
      const a = aDates[date];
      const w = wDates[date];
      const name = (a && a.emp_name) || (w ? (wtRecs.find(r => r.emp_number === emp && r.date === date) || {}).emp_name : '') || '';

      if (a && w) {
        if (w.kind === 'present') {
          // 對時間
          const aMin = hmToMin(a.in_time);
          const wMin = hmToMin(w.actual_in) != null ? hmToMin(w.actual_in) : hmToMin(w.schedule_in);
          if (aMin != null && wMin != null && aMin > wMin + lateTol) {
            mismatches.push({ emp_number: emp, emp_name: name, date, type: '時間對唔上',
              att_in: a.in_time || '', wt_in: w.actual_in || w.schedule_in || '',
              att_status: a.status, wt_status: w.day_status,
              detail: `打卡入卡 ${a.in_time} 遲過系統上班 ${w.actual_in || w.schedule_in} 超過 ${lateTol} 分鐘` });
            counts['時間對唔上']++;
          }
          // 時間 OK，唔計 mismatch
        } else if (w.kind === 'leave') {
          mismatches.push({ emp_number: emp, emp_name: name, date, type: '狀態對唔上',
            att_in: a.in_time || '', wt_in: w.actual_in || w.schedule_in || '',
            att_status: a.status, wt_status: w.day_status,
            detail: `打卡顯示出勤（${a.status}）但系統記錄為「${w.day_status}」` });
          counts['狀態對唔上']++;
        }
        // w.kind==='none'（系統無記錄 block）但打卡有出勤 -> 當「打卡有系統無」? 系統無 record 但係有 block？
        // worktime.json 無 day_status='none' 呢個值；none 即係 map 入面無 record。所以 w 存在就唔會 none。
      } else if (a && !w) {
        mismatches.push({ emp_number: emp, emp_name: name, date, type: '打卡有系統無',
          att_in: a.in_time || '', wt_in: '',
          att_status: a.status, wt_status: '',
          detail: `打卡 ${date} 有出勤（${a.status}）但系統完全無呢日記錄` });
        counts['打卡有系統無']++;
      } else if (!a && w) {
        if (w.kind === 'present') {
          mismatches.push({ emp_number: emp, emp_name: name, date, type: '系統有打卡無',
            att_in: '', wt_in: w.actual_in || w.schedule_in || '',
            att_status: '', wt_status: w.day_status,
            detail: `系統 ${date} 記錄「${w.day_status}」但打卡無出勤記錄` });
          counts['系統有打卡無']++;
        }
        // w.kind==='leave' 且打卡無 -> 雙方都無出勤，OK
      }
    }
  }

  const summary = {
    scope,
    lateToleranceMin: lateTol,
    exemptAdmins: [...exempt],
    打卡出勤日數: Object.values(attMap).reduce((s, d) => s + Object.keys(d).length, 0),
    系統出勤日數: Object.values(wtMap).reduce((s, d) => s + Object.values(d).filter(x => x.present).length, 0),
    例外總數: mismatches.length,
    分類統計: counts,
  };
  return { summary, mismatches };
}

module.exports = { parseAttendance, reconcileAttendance, excelDateToISO, hmToMin };
