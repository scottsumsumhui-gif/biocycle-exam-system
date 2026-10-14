// 一次性本地 E2E 測試：seed 數據 → 測新 employee endpoints → 之後由 shell git restore 還原
const fs = require('fs');
const bcrypt = require('bcryptjs');
const AAL = require('./allowance_logic.js');

const DATA = 'data';
const emps = JSON.parse(fs.readFileSync(DATA + '/employees.json', 'utf8'));
const RATED = ['e', 'junior', 'f', 'senior', 'h', 'd', 'i', 'supervisor'];
const emp = emps.find(e => e.level === 'junior') || emps.find(e => RATED.includes(e.level));
if (!emp) { console.log('NO suitable employee found'); process.exit(1); }
console.log('TEST EMP:', emp.emp_number, '|', emp.name, '| level:', emp.level, '| id:', emp.id);

// 1) 強制該員工本地密碼為 0000（測試後 git restore）
emp.password_hash = bcrypt.hashSync('0000', 10);
fs.writeFileSync(DATA + '/employees.json', JSON.stringify(emps, null, 2));

// 2) seed allowance：steady state + topic7 於 2026-07 不合格（suspended + 補考 2026-10）
const store = AAL.seedSteadyState({}, [emp.emp_number], [1, 2, 3, 4, 7, 8], '2026-02', '2028-12');
AAL.applyExamEvent(store, emp.emp_number, 7, '2026-07', false);
fs.writeFileSync(DATA + '/allowance.json', JSON.stringify(store, null, 2));
console.log('seeded allowance.json: topics', Object.keys(store[emp.emp_number]).join(','), '| topic7 suspended');

// 3) seed worktime 2026-09（3 日 OT）
const recs = [
  { id: 9001, emp_id: emp.id, date: '2026-09-01', day_status: '正常上班', schedule_in: '09:00', actual_in: '09:00', off_time: '20:30' },
  { id: 9002, emp_id: emp.id, date: '2026-09-03', day_status: '正常上班', schedule_in: '09:00', actual_in: '09:00', off_time: '22:00' },
  { id: 9003, emp_id: emp.id, date: '2026-09-08', day_status: '正常上班', schedule_in: '09:00', actual_in: '09:00', off_time: '23:00' }
];
fs.writeFileSync(DATA + '/worktime.json', JSON.stringify(recs, null, 2));
console.log('seeded worktime.json: 3 records for emp_id', emp.id);
console.log('EMP_NUMBER_FOR_LOGIN=' + emp.emp_number);
