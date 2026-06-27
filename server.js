const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ====== JSON FILE DATABASE ======
function loadJSON(file, defaultVal) {
  const fp = path.join(DATA_DIR, file);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch(e) {}
  return defaultVal ? JSON.parse(JSON.stringify(defaultVal)) : [];
}

function saveJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
}

// Initialize data files
if (!fs.existsSync(path.join(DATA_DIR, 'admins.json'))) {
  const hash = bcrypt.hashSync('61583398', 10);
  saveJSON('admins.json', [{ id: 1, username: 'ST140', password_hash: hash, display_name: 'Super Admin', is_super: 1, created_at: new Date().toISOString() }]);
}

if (!fs.existsSync(path.join(DATA_DIR, 'topics.json'))) {
  saveJSON('topics.json', [
    { id: 1, name: 'IPM 綜合害蟲管理', name_en: 'IPM Integrated Pest Management', order_num: 1 },
    { id: 2, name: 'BIOKILL', name_en: 'BioKill Products & Methods', order_num: 2 },
    { id: 3, name: '白蟻治理', name_en: 'Termite Treatment', order_num: 3 },
    { id: 4, name: '職業安全', name_en: 'Occupational Safety', order_num: 4 },
    { id: 5, name: '技術員手冊', name_en: 'Technician Manual', order_num: 5 },
    { id: 6, name: '害蟲、蒼蠅及鼠患', name_en: 'Insect Pests, Flies & Rodent Control', order_num: 6 }
  ]);
}

// Ensure other data files exist
for (const f of ['employees.json', 'sessions.json', 'exam_results.json', 'essay_answers.json', 'exam_config.json']) {
  if (!fs.existsSync(path.join(DATA_DIR, f))) saveJSON(f, []);
}

console.log('JSON database initialized in: ' + DATA_DIR);

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: get current LOCAL time string (GMT+8 Hong Kong)
function nowStr() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// Helper: get expiry time (current local + 8 hours)
function expiresAtStr() {
  const d = new Date(Date.now() + 16 * 3600000); // 8hr timezone + 8hr expiry
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// Auth middleware
function authRequired(userType) {
  return (req, res, next) => {
    const sessionId = req.cookies.session_id;
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const sessions = loadJSON('sessions.json', []);
    const session = sessions.find(s => s.id === sessionId && s.user_type === userType && s.expires_at > nowStr());
    if (!session) return res.status(401).json({ error: 'Session expired or invalid' });

    req.session = session;
    next();
  };
}

// ===== AUTH ROUTES =====

app.post('/api/auth/employee-login', (req, res) => {
  const { empNumber, password } = req.body;
  if (!empNumber || !password) return res.json({ success: false, error: '請輸入員工編號及密碼' });

  const employees = loadJSON('employees.json', []);
  const emp = employees.find(e => e.emp_number === empNumber);
  if (!emp) return res.json({ success: false, error: '員工編號不存在' });
  if (!bcrypt.compareSync(password, emp.password_hash))
    return res.json({ success: false, error: '密碼不正確' });

  const sessionId = uuidv4();
  const sessions = loadJSON('sessions.json', []);
  sessions.push({
    id: sessionId, user_type: 'employee', user_id: emp.id,
    username: emp.emp_number, created_at: nowStr(),
    expires_at: expiresAtStr()
  });
  saveJSON('sessions.json', sessions);

  res.cookie('session_id', sessionId, { maxAge: 8 * 3600000, httpOnly: true });
  res.json({
    success: true,
    employee: { id: emp.id, empNumber: emp.emp_number, name: emp.name, level: emp.level, group: emp.group_name }
  });
});

app.post('/api/auth/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: '請輸入用戶名及密碼' });

  const admins = loadJSON('admins.json', []);
  const admin = admins.find(a => a.username === username);
  if (!admin) return res.json({ success: false, error: '用戶名不存在' });
  if (!bcrypt.compareSync(password, admin.password_hash))
    return res.json({ success: false, error: '密碼不正確' });

  const sessionId = uuidv4();
  const sessions = loadJSON('sessions.json', []);
  sessions.push({
    id: sessionId, user_type: 'admin', user_id: admin.id,
    username: admin.username, created_at: nowStr(),
    expires_at: expiresAtStr()
  });
  saveJSON('sessions.json', sessions);

  res.cookie('session_id', sessionId, { maxAge: 8 * 3600000, httpOnly: true });
  res.json({ success: true, admin: { id: admin.id, username: admin.username, displayName: admin.display_name, isSuper: admin.is_super } });
});

app.post('/api/auth/change-password', authRequired('employee'), (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const employees = loadJSON('employees.json', []);
  const idx = employees.findIndex(e => e.id === req.session.user_id);
  const emp = employees[idx];
  if (!emp || !bcrypt.compareSync(currentPassword, emp.password_hash))
    return res.json({ success: false, error: '當前密碼不正確' });
  if (newPassword.length < 4)
    return res.json({ success: false, error: '新密碼至少4位' });

  emp.password_hash = bcrypt.hashSync(newPassword, 10);
  saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.post('/api/auth/admin-change-password', authRequired('admin'), (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admins = loadJSON('admins.json', []);
  const idx = admins.findIndex(a => a.id === req.session.user_id);
  const admin = admins[idx];
  if (!bcrypt.compareSync(currentPassword, admin.password_hash))
    return res.json({ success: false, error: '當前密碼不正確' });

  admin.password_hash = bcrypt.hashSync(newPassword, 10);
  saveJSON('admins.json', admins);
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.cookies.session_id;
  if (sessionId) {
    let sessions = loadJSON('sessions.json', []);
    sessions = sessions.filter(s => s.id !== sessionId);
    saveJSON('sessions.json', sessions);
  }
  res.clearCookie('session_id');
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  const sessionId = req.cookies.session_id;
  if (!sessionId) return res.json({ authenticated: false });

  const sessions = loadJSON('sessions.json', []);
  const session = sessions.find(s => s.id === sessionId && s.expires_at > nowStr());
  if (!session) return res.json({ authenticated: false });

  let userInfo = {};
  if (session.user_type === 'employee') {
    const employees = loadJSON('employees.json', []);
    const emp = employees.find(e => e.id === session.user_id);
    if (emp) userInfo = { empNumber: emp.emp_number, name: emp.name, level: emp.level, group: emp.group_name };
  } else {
    const admins = loadJSON('admins.json', []);
    const adm = admins.find(a => a.id === session.user_id);
    if (adm) userInfo = { username: adm.username, displayName: adm.display_name, isSuper: adm.is_super };
  }

  res.json({ authenticated: true, userType: session.user_type, user: userInfo });
});

// ===== EMPLOYEE EXAM ROUTES =====

app.get('/api/exam/current', authRequired('employee'), (req, res) => {
  const employees = loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === req.session.user_id);
  if (!emp) return res.json({ available: false, error: 'Employee not found' });

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const configs = loadJSON('exam_config.json', []);
  const config = configs.find(c =>
    c.month === currentMonth && c.year === currentYear &&
    c.is_active === 1 &&
    c.start_date <= nowStr() && c.end_date >= nowStr()
  );

  if (!config) return res.json({ available: false, reason: '當月沒有開放的考試' });

  const results = loadJSON('exam_results.json', []);
  const existingResult = results.find(r =>
    r.employee_id === emp.id && r.topic_id === config.topic_id && r.month === currentMonth && r.year === currentYear
  );

  let mcCount = 20, maxWrong = 4, hasEssay = false, essayCount = 0;
  switch (emp.level) {
    case 'senior': mcCount = 20; maxWrong = 2; break;
    case 'supervisor': mcCount = 20; maxWrong = 2; hasEssay = true; essayCount = 3; break;
  }

  const topics = loadJSON('topics.json', []);
  const topic = topics.find(t => t.id === config.topic_id);

  res.json({
    available: !existingResult,
    alreadyTaken: !!existingResult,
    existingResult: existingResult || null,
    config: {
      topicId: config.topic_id,
      topicName: topic?.name || `Topic ${config.topic_id}`,
      topicNameEn: topic?.name_en || '',
      startDate: config.start_date,
      endDate: config.end_date,
      month: config.month,
      year: config.year
    },
    employeeLevel: emp.level,
    mcCount, maxWrong, hasEssay, essayCount,
    passingScore: Math.round(((mcCount - maxWrong) / mcCount) * 100)
  });
});

app.get('/api/exam/questions/:topicId', authRequired('employee'), (req, res) => {
  const { topicId } = req.params;
  const tid = parseInt(topicId);
  const employees = loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === req.session.user_id);
  if (!emp) return res.json({ error: 'Employee not found' });

  const questionsDir = path.join(__dirname, 'questions');
  const mcFile = path.join(questionsDir, `topic_${tid}_mc.json`);
  if (!fs.existsSync(mcFile)) return res.json({ error: '題庫尚未準備好' });

  const mcQuestions = JSON.parse(fs.readFileSync(mcFile, 'utf-8'));

  let mcCount = 20, essayCount = 0;
  switch (emp.level) {
    case 'senior': mcCount = 20; break;
    case 'supervisor': mcCount = 20; essayCount = 3; break;
  }

  const group = emp.group_name || 'A';
  const groupIndex = ['A', 'B', 'C', 'D'].indexOf(group);

  // Deterministic shuffle based on topic + month + employee ID (每个人的题目都不同)
  const shuffledMC = [...mcQuestions];
  while (shuffledMC.length < mcCount * 4) shuffledMC.push(...mcQuestions);

  const now = new Date();
  const seedNum = tid * 10000 + emp.id * 100 + (now.getMonth() + 1);
  for (let i = shuffledMC.length - 1; i > 0; i--) {
    const j = (seedNum + i * 7 + 13) % (i + 1);
    [shuffledMC[i], shuffledMC[j]] = [shuffledMC[j], shuffledMC[i]];
  }
  const selectedMC = shuffledMC.slice(0, mcCount);

  let selectedEssay = [];
  if (essayCount > 0) {
    const essayFile = path.join(questionsDir, `topic_${tid}_essay.json`);
    if (fs.existsSync(essayFile)) {
      const essayQs = JSON.parse(fs.readFileSync(essayFile, 'utf-8'));
      const shuffledEssay = [...essayQs];
      for (let i = shuffledEssay.length - 1; i > 0; i--) {
        const j = (seedNum + i * 3 + 7) % (i + 1);
        [shuffledEssay[i], shuffledEssay[j]] = [shuffledEssay[j], shuffledEssay[i]];
      }
      selectedEssay = shuffledEssay.slice(0, essayCount);
    }
  }

  res.json({
    mc: selectedMC.map((q, i) => ({ id: `mc_${i}`, question: q.question, options: q.options, type: 'mc' })),
    essay: selectedEssay.map((q, i) => ({ id: `essay_${i}`, question: q.question, maxScore: q.maxScore || 5, type: 'essay' })),
    totalMC: mcCount, totalEssay: essayCount,
    timeLimit: essayCount > 0 ? 45 : 30,
    level: emp.level, group: group
  });
});

app.post('/api/exam/submit', authRequired('employee'), (req, res) => {
  const { topicId, mcAnswers, essayAnswers, timeUsed } = req.body;
  const tid = parseInt(topicId);
  const employees = loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === req.session.user_id);
  if (!emp) return res.json({ success: false, error: 'Employee not found' });

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // Check if already taken
  const results = loadJSON('exam_results.json', []);
  const existing = results.find(r =>
    r.employee_id === emp.id && r.topic_id === tid && r.month === currentMonth && r.year === currentYear
  );
  if (existing) return res.json({ success: false, error: '已提交過此考試' });

  // Load and score MC
  const mcFile = path.join(__dirname, 'questions', `topic_${tid}_mc.json`);
  if (!fs.existsSync(mcFile)) return res.json({ success: false, error: '題庫不存在' });
  const mcQuestions = JSON.parse(fs.readFileSync(mcFile, 'utf-8'));

  let mcCount = 20, maxWrong = 4, hasEssay = false;
  switch (emp.level) {
    case 'senior': mcCount = 20; maxWrong = 2; break;
    case 'supervisor': mcCount = 20; maxWrong = 2; hasEssay = true; break;
  }

  const group = emp.group_name || 'A';
  const groupIndex = ['A', 'B', 'C', 'D'].indexOf(group);
  const shuffledMC = [...mcQuestions];
  while (shuffledMC.length < mcCount * 4) shuffledMC.push(...mcQuestions);
  const seedNum = tid * 10000 + emp.id * 100 + currentMonth;
  for (let i = shuffledMC.length - 1; i > 0; i--) {
    const j = (seedNum + i * 7 + 13) % (i + 1);
    [shuffledMC[i], shuffledMC[j]] = [shuffledMC[j], shuffledMC[i]];
  }
  const selectedMC = shuffledMC.slice(0, mcCount);

  let mcCorrect = 0;
  const questionDetails = [];
  for (let i = 0; i < mcCount; i++) {
    const userAns = mcAnswers ? mcAnswers[`mc_${i}`] : null;
    const isCorrect = userAns === selectedMC[i].correct;
    if (isCorrect) mcCorrect++;
    
    questionDetails.push({
      questionNumber: i + 1,
      questionText: selectedMC[i].question,
      options: selectedMC[i].options,
      userAnswer: userAns,
      correctAnswer: selectedMC[i].correct,
      isCorrect: isCorrect
    });
  }
  const mcWrong = mcCount - mcCorrect;
  const mcPassed = mcWrong <= maxWrong;
  const mcScorePercent = Math.round((mcCorrect / mcCount) * 100);

  // Create result record
  const resultId = results.length > 0 ? Math.max(...results.map(r => r.id)) + 1 : 1;
  const newResult = {
    id: resultId,
    employee_id: emp.id,
    topic_id: tid,
    group_name: group,
    mc_score: mcScorePercent,
    mc_total: mcCount,
    mc_correct: mcCorrect,
    essay_score: 0,
    essay_total: hasEssay ? 15 : 0,
    total_score: mcScorePercent,
    passed: hasEssay ? 0 : (mcPassed ? 1 : 0),
    time_used: timeUsed || 0,
    submitted_at: nowStr(),
    essay_graded: hasEssay ? 0 : 1,
    graded_by: null,
    graded_at: null,
    month: currentMonth,
    year: currentYear
  };
  results.push(newResult);
  saveJSON('exam_results.json', results);

  // Save essay answers if supervisor
  if (hasEssay && essayAnswers) {
    const essayFile = path.join(__dirname, 'questions', `topic_${tid}_essay.json`);
    const allEssays = loadJSON('essay_answers.json', []);

    if (fs.existsSync(essayFile)) {
      const essayQs = JSON.parse(fs.readFileSync(essayFile, 'utf-8'));
      const shuffledEssay = [...essayQs];
      for (let i = shuffledEssay.length - 1; i > 0; i--) {
        const j = (seedNum + i * 3 + 7) % (i + 1);
        [shuffledEssay[i], shuffledEssay[j]] = [shuffledEssay[j], shuffledEssay[i]];
      }
      const selectedEssay = shuffledEssay.slice(0, 3);

      for (let i = 0; i < selectedEssay.length; i++) {
        allEssays.push({
          id: allEssays.length > 0 ? Math.max(...allEssays.map(e => e.id)) + 1 : 1,
          result_id: resultId,
          question_id: `essay_${i}`,
          question_text: selectedEssay[i].question,
          answer_text: essayAnswers[`essay_${i}`] || '',
          score: 0,
          max_score: selectedEssay[i].maxScore || 5,
          graded_by: null,
          graded_at: null
        });
      }
      saveJSON('essay_answers.json', allEssays);
    }
  }

  res.json({
    success: true,
    result: { mcCorrect, mcTotal: mcCount, mcWrong, mcScore: mcScorePercent, mcPassed, hasEssay, totalPassed: hasEssay ? false : mcPassed, maxWrong, questionDetails }
  });
});

app.get('/api/exam/my-results', authRequired('employee'), (req, res) => {
  const results = loadJSON('exam_results.json', []);
  const employees = loadJSON('employees.json', []);
  const topics = loadJSON('topics.json', []);

  const myResults = results.filter(r => r.employee_id === req.session.user_id)
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
    .map(r => {
      const t = topics.find(tp => tp.id === r.topic_id);
      const e = employees.find(em => em.id === r.employee_id);
      return { ...r, topic_name: t?.name || '', topic_name_en: t?.name_en || '', emp_name: e?.name || '', emp_number: e?.emp_number || '' };
    });

  res.json({ success: true, results: myResults });
});

// ===== ADMIN ROUTES =====

app.get('/api/admin/dashboard', authRequired('admin'), (req, res) => {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const employees = loadJSON('employees.json', []);
  const configs = loadJSON('exam_config.json', []);
  const results = loadJSON('exam_results.json', []);
  const topics = loadJSON('topics.json', []);

  const currentConfig = configs.find(c => c.month === currentMonth && c.year === currentYear);
  if (currentConfig) {
    const t = topics.find(tp => tp.id === currentConfig.topic_id);
    currentConfig.topic_name = t?.name || '';
    currentConfig.topic_name_en = t?.name_en || '';
  }

  const monthResults = results
    .filter(r => r.month === currentMonth && r.year === currentYear)
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  const passedCount = monthResults.filter(r => r.passed === 1).length;
  const totalTaken = monthResults.length;
  const passRate = totalTaken > 0 ? Math.round(passedCount / totalTaken * 100) : 0;
  const pendingEssays = monthResults.filter(r => r.essay_graded === 0).length;

  const levelStats = {};
  for (const level of ['junior', 'senior', 'supervisor']) {
    const lr = monthResults.filter(r => {
      const e = employees.find(em => em.id === r.employee_id);
      return e && e.level === level;
    });
    const lp = lr.filter(r => r.passed === 1).length;
    levelStats[level] = {
      total: lr.length, passed: lp,
      rate: lr.length > 0 ? Math.round(lp / lr.length * 100) : 0,
      avgScore: lr.length > 0 ? Math.round(lr.reduce((s, r) => s + r.mc_score, 0) / lr.length) : 0
    };
  }

  // Enrich results with employee/topic info
  const recentResults = monthResults.slice(0, 20).map(r => {
    const e = employees.find(em => em.id === r.employee_id);
    const t = topics.find(tp => tp.id === r.topic_id);
    return { ...r, emp_name: e?.name || '', emp_number: e?.emp_number || '', level: e?.level || '', group_name: e?.group_name || '', topic_name: t?.name || '' };
  });

  res.json({
    totalEmployees: employees.length,
    currentConfig,
    totalTaken, passedCount, passRate, pendingEssays,
    levelStats, recentResults
  });
});

app.get('/api/admin/employees', authRequired('admin'), (req, res) => {
  const employees = loadJSON('employees.json', []);
  employees.sort((a, b) => a.emp_number.localeCompare(b.emp_number));
  res.json({ success: true, employees });
});

app.post('/api/admin/employees', authRequired('admin'), (req, res) => {
  const { empNumber, name, level, group, password } = req.body;
  if (!empNumber || !name) return res.json({ success: false, error: '員工編號及姓名必填' });

  const employees = loadJSON('employees.json', []);
  if (employees.find(e => e.emp_number === empNumber)) return res.json({ success: false, error: '員工編號已存在' });

  const nextId = employees.length > 0 ? Math.max(...employees.map(e => e.id)) + 1 : 1;
  employees.push({
    id: nextId,
    emp_number: empNumber,
    name: name,
    password_hash: bcrypt.hashSync(password || '0000', 10),
    level: level || 'junior',
    group_name: group || null,
    created_at: nowStr()
  });
  saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.put('/api/admin/employees/:id', authRequired('admin'), (req, res) => {
  const { empNumber, name, level, group, password } = req.body;
  const eid = parseInt(req.params.id);
  const employees = loadJSON('employees.json', []);
  const idx = employees.findIndex(e => e.id === eid);
  if (idx < 0) return res.json({ success: false, error: '員工不存在' });

  const emp = employees[idx];
  if (password) emp.password_hash = bcrypt.hashSync(password, 10);
  if (empNumber !== undefined) emp.emp_number = empNumber;
  if (name !== undefined) emp.name = name;
  if (level !== undefined) emp.level = level;
  if (group !== undefined) emp.group_name = group;

  saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.delete('/api/admin/employees/:id', authRequired('admin'), (req, res) => {
  const eid = parseInt(req.params.id);
  let employees = loadJSON('employees.json', []);
  employees = employees.filter(e => e.id !== eid);
  saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.post('/api/admin/reset-password/:id', authRequired('admin'), (req, res) => {
  const { newPassword } = req.body;
  const eid = parseInt(req.params.id);
  const employees = loadJSON('employees.json', []);
  const idx = employees.findIndex(e => e.id === eid);
  if (idx >= 0) {
    employees[idx].password_hash = bcrypt.hashSync(newPassword || '0000', 10);
    saveJSON('employees.json', employees);
  }
  res.json({ success: true });
});

app.get('/api/admin/admins', authRequired('admin'), (req, res) => {
  const admins = loadJSON('admins.json', []);
  res.json({ success: true, admins: admins.map(({ password_hash: _, ...rest }) => rest) });
});

app.post('/api/admin/admins', authRequired('admin'), (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.json({ success: false, error: '用戶名及密碼必填' });

  const admins = loadJSON('admins.json', []);
  if (admins.find(a => a.username === username)) return res.json({ success: false, error: '用戶名已存在' });

  const nextId = admins.length > 0 ? Math.max(...admins.map(a => a.id)) + 1 : 1;
  admins.push({
    id: nextId, username, password_hash: bcrypt.hashSync(password, 10),
    display_name: displayName || username, is_super: 0, created_at: nowStr()
  });
  saveJSON('admins.json', admins);
  res.json({ success: true });
});

app.delete('/api/admin/admins/:id', authRequired('admin'), (req, res) => {
  const aid = parseInt(req.params.id);
  const admins = loadJSON('admins.json', []);
  const admin = admins.find(a => a.id === aid);
  if (admin && admin.is_super) return res.json({ success: false, error: '不能刪除超級管理員' });

  saveJSON('admins.json', admins.filter(a => a.id !== aid));
  res.json({ success: true });
});

app.get('/api/admin/exam-config', authRequired('admin'), (req, res) => {
  const configs = loadJSON('exam_config.json', []);
  const topics = loadJSON('topics.json', []);

  const enriched = configs.map(c => {
    const t = topics.find(tp => tp.id === c.topic_id);
    return { ...c, topic_name: t?.name || '', topic_name_en: t?.name_en || '' };
  }).sort((a, b) => b.year - a.year || b.month - a.month);

  res.json({ success: true, configs: enriched });
});

app.post('/api/admin/exam-config', authRequired('admin'), (req, res) => {
  const topicId = parseInt(req.body.topicId);
  const month = parseInt(req.body.month);
  const year = parseInt(req.body.year);
  const { startDate, endDate } = req.body;

  let configs = loadJSON('exam_config.json', []);
  // Deactivate same month/year
  configs = configs.map(c => (c.month === month && c.year === year ? { ...c, is_active: 0 } : c));

  const nextId = configs.length > 0 ? Math.max(...configs.map(c => c.id)) + 1 : 1;
  configs.push({
    id: nextId, topic_id: topicId, month, year,
    start_date: startDate, end_date: endDate, is_active: 1, created_at: nowStr()
  });
  saveJSON('exam_config.json', configs);
  res.json({ success: true });
});

app.put('/api/admin/exam-config/:id', authRequired('admin'), (req, res) => {
  const { isActive, startDate, endDate } = req.body;
  const cid = parseInt(req.params.id);
  const configs = loadJSON('exam_config.json', []);
  const idx = configs.findIndex(c => c.id === cid);
  if (idx >= 0) {
    if (isActive !== undefined) configs[idx].is_active = isActive ? 1 : 0;
    if (startDate) configs[idx].start_date = startDate;
    if (endDate) configs[idx].end_date = endDate;
    saveJSON('exam_config.json', configs);
  }
  res.json({ success: true });
});

app.get('/api/admin/results', authRequired('admin'), (req, res) => {
  const { month, year, level, topicId } = req.query;

  let results = loadJSON('exam_results.json', []);
  const employees = loadJSON('employees.json', []);
  const topics = loadJSON('topics.json', []);

  if (month) results = results.filter(r => r.month === parseInt(month));
  if (year) results = results.filter(r => r.year === parseInt(year));
  if (topicId) results = results.filter(r => r.topic_id === parseInt(topicId));

  // Enrich data
  results = results
    .map(r => {
      const e = employees.find(em => em.id === r.employee_id);
      const t = topics.find(tp => tp.id === r.topic_id);
      return { ...r, emp_name: e?.name || '', emp_number: e?.emp_number || '', level: e?.level || '', group_name: e?.group_name || '', topic_name: t?.name || '', topic_name_en: t?.name_en || '' };
    })
    .filter(r => !level || r.level === level)
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  res.json({ success: true, results });
});

app.get('/api/admin/essay-answers/:resultId', authRequired('admin'), (req, res) => {
  const rid = parseInt(req.params.resultId);
  const answers = loadJSON('essay_answers.json', []).filter(a => a.result_id === rid);
  const results = loadJSON('exam_results.json', []);
  const result = results.find(r => r.id === rid);
  const employees = loadJSON('employees.json', []);

  if (result) {
    const emp = employees.find(e => e.id === result.employee_id);
    Object.assign(result, { emp_name: emp?.name || '', emp_number: emp?.emp_number || '', level: emp?.level || '' });
  }

  res.json({ success: true, result, answers });
});

app.post('/api/admin/grade-essay/:resultId', authRequired('admin'), (req, res) => {
  const { scores } = req.body;
  const rid = parseInt(req.params.resultId);

  const admins = loadJSON('admins.json', []);
  const admin = admins.find(a => a.id === req.session.user_id);

  const results = loadJSON('exam_results.json', []);
  const ridx = results.findIndex(r => r.id === rid);
  if (ridx < 0) return res.json({ success: false, error: 'Result not found' });

  const result = results[ridx];

  let essayTotal = 0, essayMaxTotal = 0;
  let allEssays = loadJSON('essay_answers.json', []);

  for (const [questionId, score] of Object.entries(scores)) {
    const aidx = allEssays.findIndex(a => a.result_id === rid && a.question_id === questionId);
    if (aidx >= 0) {
      allEssays[aidx].score = score;
      allEssays[aidx].graded_by = admin?.username || '';
      allEssays[aidx].graded_at = nowStr();
      essayTotal += score;
      essayMaxTotal += allEssays[aidx].max_score;
    }
  }
  saveJSON('essay_answers.json', allEssays);

  const employees = loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === result.employee_id);
  const maxWrong = emp?.level === 'supervisor' ? 2 : 4;
  const mcPassed = result.mc_correct >= (result.mc_total - maxWrong);

  const essayPassPercent = essayMaxTotal > 0 ? (essayTotal / essayMaxTotal * 100) : 100;
  const totalPassed = mcPassed && essayPassPercent >= 60;
  const totalScore = Math.round(result.mc_score * 0.7 + essayPassPercent * 0.3);

  results[ridx] = {
    ...results[ridx],
    essay_score: Math.round(essayPassPercent),
    essay_total: essayMaxTotal,
    essay_graded: 1,
    total_score: totalScore,
    passed: totalPassed ? 1 : 0,
    graded_by: admin?.username || '',
    graded_at: nowStr()
  };
  saveJSON('exam_results.json', results);

  res.json({ success: true, totalPassed, totalScore, essayScore: Math.round(essayPassPercent), mcPassed });
});

app.get('/api/admin/export-csv', authRequired('admin'), (req, res) => {
  const { month, year } = req.query;
  const m = month ? parseInt(month) : new Date().getMonth() + 1;
  const y = year ? parseInt(year) : new Date().getFullYear();

  let results = loadJSON('exam_results.json', []).filter(r => r.month === m && r.year === y);
  const employees = loadJSON('employees.json', []);
  const topics = loadJSON('topics.json', []);

  const levelNames = { junior: '初級技術員', senior: '高級技術員', supervisor: '技術員主管' };

  results = results.map(r => {
    const e = employees.find(em => em.id === r.employee_id);
    const t = topics.find(tp => tp.id === r.topic_id);
    return { ...r, emp_name: e?.name || '', emp_number: e?.emp_number || '', level: e?.level || '', group_name: e?.group_name || '', topic_name: t?.name || '' };
  }).sort((a, b) => a.emp_number.localeCompare(b.emp_number));

  let csv = '\uFEFF'; // BOM for Excel UTF-8
  csv += '員工編號,姓名,職級,組別,主題,MC分數,MC正確,MC總題,問答分數,總分,合格,提交時間\n';
  for (const r of results) {
    csv += `${r.emp_number},${r.emp_name},${levelNames[r.level]||r.level},${r.group_name||''},${r.topic_name},${r.mc_score}%,${r.mc_correct},${r.mc_total},${r.essay_score}%,${r.total_score}%,${r.passed?'合格':'不合格'},${r.submitted_at}\n`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=exam_results_${y}_${m}.csv`);
  res.send(csv);
});

// ====== QUESTION BANK MANAGEMENT =====
const QUESTIONS_DIR = path.join(__dirname, 'questions');

// Get all questions for a topic
app.get('/api/admin/questions/:topicId', authRequired('admin'), (req, res) => {
  const tid = parseInt(req.params.topicId);
  if (tid < 1 || tid > 6) return res.status(400).json({ success: false, error: '無效主題 ID' });
  
  try {
    const mcFile = path.join(QUESTIONS_DIR, `topic_${tid}_mc.json`);
    const essayFile = path.join(QUESTIONS_DIR, `topic_${tid}_essay.json`);
    
    const mc = fs.existsSync(mcFile) ? JSON.parse(fs.readFileSync(mcFile, 'utf8')) : [];
    const essay = fs.existsSync(essayFile) ? JSON.parse(fs.readFileSync(essayFile, 'utf8')) : [];
    
    res.json({ success: true, mc, essay, mcCount: mc.length, essayCount: essay.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '讀取題庫失敗' });
  }
});

// Add MC question
app.post('/api/admin/questions/mc/:topicId', authRequired('admin'), (req, res) => {
  const tid = parseInt(req.params.topicId);
  const { question, options, answer } = req.body;
  
  if (!question || !options || options.length < 2 || answer === undefined) {
    return res.status(400).json({ success: false, error: '請填寫完整題目信息' });
  }
  if (answer < 0 || answer >= options.length) {
    return res.status(400).json({ success: false, error: '正確答案索引無效' });
  }
  
  try {
    const mcFile = path.join(QUESTIONS_DIR, `topic_${tid}_mc.json`);
    const mc = fs.existsSync(mcFile) ? JSON.parse(fs.readFileSync(mcFile, 'utf8')) : [];
    
    mc.push({ question, options, correct: answer });
    fs.writeFileSync(mcFile, JSON.stringify(mc, null, 2), 'utf8');
    
    res.json({ success: true, message: '選擇題添加成功', total: mc.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '添加題目失敗' });
  }
});

// Update MC question
app.put('/api/admin/questions/mc/:topicId/:qIndex', authRequired('admin'), (req, res) => {
  const tid = parseInt(req.params.topicId);
  const qIdx = parseInt(req.params.qIndex);
  const { question, options, answer } = req.body;
  
  try {
    const mcFile = path.join(QUESTIONS_DIR, `topic_${tid}_mc.json`);
    const mc = fs.existsSync(mcFile) ? JSON.parse(fs.readFileSync(mcFile, 'utf8')) : [];
    
    if (qIdx < 0 || qIdx >= mc.length) {
      return res.status(404).json({ success: false, error: '題目不存在' });
    }
    
    mc[qIdx] = { question, options, correct: answer };
    fs.writeFileSync(mcFile, JSON.stringify(mc, null, 2), 'utf8');
    
    res.json({ success: true, message: '題目更新成功' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '更新題目失敗' });
  }
});

// Delete MC question
app.delete('/api/admin/questions/mc/:topicId/:qIndex', authRequired('admin'), (req, res) => {
  const tid = parseInt(req.params.topicId);
  const qIdx = parseInt(req.params.qIndex);
  
  try {
    const mcFile = path.join(QUESTIONS_DIR, `topic_${tid}_mc.json`);
    const mc = fs.existsSync(mcFile) ? JSON.parse(fs.readFileSync(mcFile, 'utf8')) : [];
    
    if (qIdx < 0 || qIdx >= mc.length) {
      return res.status(404).json({ success: false, error: '題目不存在' });
    }
    
    mc.splice(qIdx, 1);
    fs.writeFileSync(mcFile, JSON.stringify(mc, null, 2), 'utf8');
    
    res.json({ success: true, message: '題目刪除成功', total: mc.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '刪除題目失敗' });
  }
});

// Add essay question
app.post('/api/admin/questions/essay/:topicId', authRequired('admin'), (req, res) => {
  const tid = parseInt(req.params.topicId);
  const { question, maxScore } = req.body;
  
  if (!question) {
    return res.status(400).json({ success: false, error: '請填寫題目內容' });
  }
  
  try {
    const essayFile = path.join(QUESTIONS_DIR, `topic_${tid}_essay.json`);
    const essay = fs.existsSync(essayFile) ? JSON.parse(fs.readFileSync(essayFile, 'utf8')) : [];
    
    essay.push({ question, maxScore: maxScore || 10 });
    fs.writeFileSync(essayFile, JSON.stringify(essay, null, 2), 'utf8');
    
    res.json({ success: true, message: '問答題添加成功', total: essay.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '添加題目失敗' });
  }
});

// Update essay question
app.put('/api/admin/questions/essay/:topicId/:qIndex', authRequired('admin'), (req, res) => {
  const tid = parseInt(req.params.topicId);
  const qIdx = parseInt(req.params.qIndex);
  const { question, maxScore } = req.body;
  
  try {
    const essayFile = path.join(QUESTIONS_DIR, `topic_${tid}_essay.json`);
    const essay = fs.existsSync(essayFile) ? JSON.parse(fs.readFileSync(essayFile, 'utf8')) : [];
    
    if (qIdx < 0 || qIdx >= essay.length) {
      return res.status(404).json({ success: false, error: '題目不存在' });
    }
    
    essay[qIdx] = { question, maxScore: maxScore || 10 };
    fs.writeFileSync(essayFile, JSON.stringify(essay, null, 2), 'utf8');
    
    res.json({ success: true, message: '題目更新成功' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '更新題目失敗' });
  }
});

// Delete essay question
app.delete('/api/admin/questions/essay/:topicId/:qIndex', authRequired('admin'), (req, res) => {
  const tid = parseInt(req.params.topicId);
  const qIdx = parseInt(req.params.qIndex);
  
  try {
    const essayFile = path.join(QUESTIONS_DIR, `topic_${tid}_essay.json`);
    const essay = fs.existsSync(essayFile) ? JSON.parse(fs.readFileSync(essayFile, 'utf8')) : [];
    
    if (qIdx < 0 || qIdx >= essay.length) {
      return res.status(404).json({ success: false, error: '題目不存在' });
    }
    
    essay.splice(qIdx, 1);
    fs.writeFileSync(essayFile, JSON.stringify(essay, null, 2), 'utf8');
    
    res.json({ success: true, message: '題目刪除成功', total: essay.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '刪除題目失敗' });
  }
});

app.get('/api/topics', (req, res) => {
  const topics = loadJSON('topics.json', []);
  topics.sort((a, b) => a.order_num - b.order_num);
  res.json({ success: true, topics });
});

// Serve frontend pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/exam', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Start server
app.listen(PORT, () => {
  console.log(`EPC Exam System running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Employee exam: http://localhost:${PORT}`);
});
