const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Session lifetime: 24 hours for both the cookie and the server-side expiry.
// Long enough to survive a full exam (max 45 min) plus prep time, and rolling
// refresh via heartbeat keeps it alive while the exam page stays open.
const SESSION_TTL_MS = 24 * 3600000;

// ====== UPSTASH REDIS (any platform) + DUAL-MODE DATA LAYER ======
const isVercel = !!process.env.VERCEL;
let redis = null;

// Try to connect to Upstash Redis if env vars are set (works on Vercel, Railway, etc.)
if (process.env.UPSTASH_REDIS_REST_URL) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('Upstash Redis connected');
  } catch(e) {
    console.log('Upstash Redis not available:', e.message);
  }
}

const DATA_DIR = path.join(__dirname, 'data');
if (!isVercel && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Sync versions for local dev
function loadJSONSync(file, defaultVal) {
  const fp = path.join(DATA_DIR, file);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch(e) {}
  return defaultVal ? JSON.parse(JSON.stringify(defaultVal)) : [];
}
function saveJSONSync(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
}

// Async dual-mode: Upstash Redis on cloud, JSON files locally
async function loadJSON(file, defaultVal) {
  if (redis) {
    const data = await redis.get(file);
    if (data !== null && data !== undefined) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    // Seed from bundled data file
    const seedFile = path.join(__dirname, 'data', file);
    if (fs.existsSync(seedFile)) {
      const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
      await redis.set(file, JSON.stringify(seedData));
      return seedData;
    }
    if (defaultVal) {
      const seed = JSON.parse(JSON.stringify(defaultVal));
      await redis.set(file, JSON.stringify(seed));
      return seed;
    }
    return [];
  }
  // Local: use sync file operations
  const fp = path.join(DATA_DIR, file);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch(e) {}
  return defaultVal ? JSON.parse(JSON.stringify(defaultVal)) : [];
}

async function saveJSON(file, data) {
  if (redis) {
    await redis.set(file, JSON.stringify(data));
    return;
  }
  saveJSONSync(file, data);
}

// Async question loading (dual-mode)
async function loadQuestions(type, topicId) {
  const key = `questions_topic_${topicId}_${type}`;
  if (redis) {
    const data = await redis.get(key);
    if (data !== null && data !== undefined) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    const seedFile = path.join(__dirname, 'questions', `topic_${topicId}_${type}.json`);
    if (fs.existsSync(seedFile)) {
      const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
      await redis.set(key, JSON.stringify(seedData));
      return seedData;
    }
    return [];
  }
  const file = path.join(__dirname, 'questions', `topic_${topicId}_${type}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

async function saveQuestions(type, topicId, data) {
  const key = `questions_topic_${topicId}_${type}`;
  if (redis) {
    await redis.set(key, JSON.stringify(data));
    return;
  }
  const file = path.join(__dirname, 'questions', `topic_${topicId}_${type}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// Initialize data locally only (Vercel seeds on first request via loadJSON)
if (!isVercel) {
  if (!fs.existsSync(path.join(DATA_DIR, 'admins.json'))) {
    const hash = bcrypt.hashSync('61583398', 10);
    saveJSONSync('admins.json', [{ id: 1, username: 'ST140', password_hash: hash, display_name: 'Super Admin', is_super: 1, created_at: new Date().toISOString() }]);
  }
  if (!fs.existsSync(path.join(DATA_DIR, 'topics.json'))) {
    saveJSONSync('topics.json', [
      { id: 1, name: 'IPM 綜合害蟲管理', name_en: 'IPM Integrated Pest Management', order_num: 1 },
      { id: 2, name: 'BIOKILL', name_en: 'BioKill Products & Methods', order_num: 2 },
      { id: 3, name: '白蟻治理', name_en: 'Termite Treatment', order_num: 3 },
      { id: 4, name: '職業安全', name_en: 'Occupational Safety', order_num: 4 },
      { id: 5, name: '技術員手冊', name_en: 'Technician Manual', order_num: 5 },
      { id: 6, name: '害蟲、蒼蠅及鼠患', name_en: 'Insect Pests, Flies & Rodent Control', order_num: 6 }
    ]);
  }
  for (const f of ['employees.json', 'sessions.json', 'exam_results.json', 'essay_answers.json', 'exam_config.json']) {
    if (!fs.existsSync(path.join(DATA_DIR, f))) saveJSONSync(f, []);
  }
  console.log('JSON database initialized in: ' + DATA_DIR);
}

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: get current LOCAL time string (GMT+8 Hong Kong)
function nowStr() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// Helper: get expiry time (current local + 24 hours)
function expiresAtStr() {
  const d = new Date(Date.now() + SESSION_TTL_MS);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// Auth middleware
function authRequired(userType) {
  return async (req, res, next) => {
    const sessionId = req.cookies.session_id;
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const sessions = await loadJSON('sessions.json', []);
    const session = sessions.find(s => s.id === sessionId && s.user_type === userType && s.expires_at > nowStr());
    if (!session) return res.status(401).json({ error: 'Session expired or invalid' });

    req.session = session;
    next();
  };
}

// ===== AUTH ROUTES =====

app.post('/api/auth/employee-login', async (req, res) => {
  const { empNumber, password } = req.body;
  if (!empNumber || !password) return res.json({ success: false, error: '請輸入員工編號及密碼' });

  const employees = await loadJSON('employees.json', []);
  const emp = employees.find(e => e.emp_number === empNumber);
  if (!emp) return res.json({ success: false, error: '員工編號不存在' });
  if (!bcrypt.compareSync(password, emp.password_hash))
    return res.json({ success: false, error: '密碼不正確' });

  const sessionId = uuidv4();
  const sessions = await loadJSON('sessions.json', []);
  sessions.push({
    id: sessionId, user_type: 'employee', user_id: emp.id,
    username: emp.emp_number, created_at: nowStr(),
    expires_at: expiresAtStr()
  });
  await saveJSON('sessions.json', sessions);

  res.cookie('session_id', sessionId, { maxAge: SESSION_TTL_MS, httpOnly: true });
  res.json({
    success: true,
    employee: { id: emp.id, empNumber: emp.emp_number, name: emp.name, level: emp.level, group: emp.group_name }
  });
});

app.post('/api/auth/admin-login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: '請輸入用戶名及密碼' });

  const admins = await loadJSON('admins.json', []);
  const admin = admins.find(a => a.username === username);
  if (!admin) return res.json({ success: false, error: '用戶名不存在' });
  if (!bcrypt.compareSync(password, admin.password_hash))
    return res.json({ success: false, error: '密碼不正確' });

  const sessionId = uuidv4();
  const sessions = await loadJSON('sessions.json', []);
  sessions.push({
    id: sessionId, user_type: 'admin', user_id: admin.id,
    username: admin.username, created_at: nowStr(),
    expires_at: expiresAtStr()
  });
  await saveJSON('sessions.json', sessions);

  res.cookie('session_id', sessionId, { maxAge: SESSION_TTL_MS, httpOnly: true });
  res.json({ success: true, admin: { id: admin.id, username: admin.username, displayName: admin.display_name, isSuper: admin.is_super } });
});

app.post('/api/auth/change-password', authRequired('employee'), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const employees = await loadJSON('employees.json', []);
  const idx = employees.findIndex(e => e.id === req.session.user_id);
  const emp = employees[idx];
  if (!emp || !bcrypt.compareSync(currentPassword, emp.password_hash))
    return res.json({ success: false, error: '當前密碼不正確' });
  if (newPassword.length < 4)
    return res.json({ success: false, error: '新密碼至少4位' });

  emp.password_hash = bcrypt.hashSync(newPassword, 10);
  await saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.post('/api/auth/admin-change-password', authRequired('admin'), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admins = await loadJSON('admins.json', []);
  const idx = admins.findIndex(a => a.id === req.session.user_id);
  const admin = admins[idx];
  if (!admin || !bcrypt.compareSync(currentPassword, admin.password_hash))
    return res.json({ success: false, error: '當前密碼不正確' });

  admin.password_hash = bcrypt.hashSync(newPassword, 10);
  await saveJSON('admins.json', admins);
  res.json({ success: true });
});

app.post('/api/auth/logout', async (req, res) => {
  const sessionId = req.cookies.session_id;
  if (sessionId) {
    let sessions = await loadJSON('sessions.json', []);
    sessions = sessions.filter(s => s.id !== sessionId);
    await saveJSON('sessions.json', sessions);
  }
  res.clearCookie('session_id');
  res.json({ success: true });
});

app.get('/api/auth/check', async (req, res) => {
  const sessionId = req.cookies.session_id;
  if (!sessionId) return res.json({ authenticated: false });

  const sessions = await loadJSON('sessions.json', []);
  const session = sessions.find(s => s.id === sessionId && s.expires_at > nowStr());
  if (!session) return res.json({ authenticated: false });

  let userInfo = {};
  if (session.user_type === 'employee') {
    const employees = await loadJSON('employees.json', []);
    const emp = employees.find(e => e.id === session.user_id);
    if (emp) userInfo = { empNumber: emp.emp_number, name: emp.name, level: emp.level, group: emp.group_name };
  } else {
    const admins = await loadJSON('admins.json', []);
    const adm = admins.find(a => a.id === session.user_id);
    if (adm) userInfo = { username: adm.username, displayName: adm.display_name, isSuper: adm.is_super };
  }

  res.json({ authenticated: true, userType: session.user_type, user: userInfo });
});

// Heartbeat: keep the session alive while the exam/tab is open.
// Works for both employee and admin sessions, extends expiry and cookie.
app.post('/api/auth/heartbeat', async (req, res) => {
  const sessionId = req.cookies.session_id;
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const sessions = await loadJSON('sessions.json', []);
    const idx = sessions.findIndex(s => s.id === sessionId && s.expires_at > nowStr());
    if (idx < 0) return res.status(401).json({ error: 'Session expired or invalid' });
    sessions[idx].expires_at = expiresAtStr();
    await saveJSON('sessions.json', sessions);
    res.cookie('session_id', sessionId, { maxAge: SESSION_TTL_MS, httpOnly: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Heartbeat failed' });
  }
});

// ===== EMPLOYEE EXAM ROUTES =====

// Deterministically select the MC and essay questions for an employee's exam.
// CRITICAL: this is used by BOTH /api/exam/questions (what the user sees) and
// /api/exam/submit (how answers are graded), so the question order MUST be
// identical. Any difference here causes the user to be graded on a different
// question than the one they answered.
function selectExamQuestions(mcQuestions, essayQs, emp, tid, monthVal, mcCount, essayCount) {
  // MC: deduplicate by first line of question text, then a deterministic
  // Fisher-Yates shuffle, then take the first mcCount questions.
  const seen = new Set();
  const uniqueMC = [];
  for (const q of mcQuestions) {
    if (!q || !q.question) continue;
    const key = q.question.split('\n')[0].trim();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueMC.push(q);
  }

  const seedNum = tid * 10000 + emp.id * 100 + monthVal;
  for (let i = uniqueMC.length - 1; i > 0; i--) {
    const j = (seedNum + i * 7 + 13) % (i + 1);
    [uniqueMC[i], uniqueMC[j]] = [uniqueMC[j], uniqueMC[i]];
  }
  const selectedMC = uniqueMC.slice(0, mcCount);

  let selectedEssay = [];
  if (essayCount > 0 && essayQs && essayQs.length > 0) {
    const shuffledEssay = [...essayQs];
    for (let i = shuffledEssay.length - 1; i > 0; i--) {
      const j = (seedNum + i * 3 + 7) % (i + 1);
      [shuffledEssay[i], shuffledEssay[j]] = [shuffledEssay[j], shuffledEssay[i]];
    }
    selectedEssay = shuffledEssay.slice(0, essayCount);
  }

  return { selectedMC, selectedEssay };
}

app.get('/api/exam/current', authRequired('employee'), async (req, res) => {
  const employees = await loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === req.session.user_id);
  if (!emp) return res.json({ available: false, error: 'Employee not found' });

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const configs = await loadJSON('exam_config.json', []);
  const config = configs.find(c =>
    c.month === currentMonth && c.year === currentYear &&
    c.is_active === 1 &&
    c.start_date <= nowStr() && c.end_date >= nowStr()
  );

  if (!config) return res.json({ available: false, reason: '當月沒有開放的考試' });

  // Check if employee's group is allowed for this exam config
  // Backward compatible: if config has no 'groups' field, all groups are allowed
  if (config.groups) {
    const allowedGroups = config.groups.split(',').map(g => g.trim());
    const empGroup = emp.group_name || 'A';
    if (!allowedGroups.includes(empGroup)) {
      return res.json({ available: false, reason: `此考試批次為 ${config.groups} 組，您所在的是 ${empGroup} 組` });
    }
  }

  const results = await loadJSON('exam_results.json', []);
  const existingResult = results.find(r =>
    r.employee_id === emp.id && r.topic_id === config.topic_id && r.month === currentMonth && r.year === currentYear
  );

  let mcCount = 20, maxWrong = 4, hasEssay = false, essayCount = 0;
  switch (emp.level) {
    case 'senior': mcCount = 20; maxWrong = 2; break;
    case 'supervisor': mcCount = 20; maxWrong = 2; hasEssay = true; essayCount = 3; break;
  }

  const topics = await loadJSON('topics.json', []);
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

app.get('/api/exam/questions/:topicId', authRequired('employee'), async (req, res) => {
  const { topicId } = req.params;
  const tid = parseInt(topicId);
  const employees = await loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === req.session.user_id);
  if (!emp) return res.json({ error: 'Employee not found' });

  const mcQuestions = await loadQuestions('mc', tid);
  if (!mcQuestions || mcQuestions.length === 0) return res.json({ error: '題庫尚未準備好' });

  let mcCount = 20, essayCount = 0;
  switch (emp.level) {
    case 'senior': mcCount = 20; break;
    case 'supervisor': mcCount = 20; essayCount = 3; break;
  }

  const group = emp.group_name || 'A';
  const now = new Date();
  const monthVal = now.getMonth() + 1;
  const essayQs = essayCount > 0 ? await loadQuestions('essay', tid) : [];
  const { selectedMC, selectedEssay } = selectExamQuestions(mcQuestions, essayQs, emp, tid, monthVal, mcCount, essayCount);

  if (selectedMC.length < mcCount) {
    console.warn(`[exam] Only ${selectedMC.length} unique MC questions for topic ${tid} (need ${mcCount})`);
  }

  res.json({
    mc: selectedMC.map((q, i) => ({ id: `mc_${i}`, question: q.question, options: q.options, type: 'mc' })),
    essay: selectedEssay.map((q, i) => ({ id: `essay_${i}`, question: q.question, maxScore: q.maxScore || 5, type: 'essay' })),
    totalMC: mcCount, totalEssay: essayCount,
    timeLimit: essayCount > 0 ? 45 : 30,
    level: emp.level, group: group
  });
});

app.post('/api/exam/submit', authRequired('employee'), async (req, res) => {
  const { topicId, mcAnswers, essayAnswers, timeUsed } = req.body;
  const tid = parseInt(topicId);
  const employees = await loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === req.session.user_id);
  if (!emp) return res.json({ success: false, error: 'Employee not found' });

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const results = await loadJSON('exam_results.json', []);
  const existing = results.find(r =>
    r.employee_id === emp.id && r.topic_id === tid && r.month === currentMonth && r.year === currentYear
  );
  if (existing) return res.json({ success: false, error: '已提交過此考試' });

  const mcQuestions = await loadQuestions('mc', tid);
  if (!mcQuestions || mcQuestions.length === 0) return res.json({ success: false, error: '題庫不存在' });

  let mcCount = 20, maxWrong = 4, hasEssay = false;
  switch (emp.level) {
    case 'senior': mcCount = 20; maxWrong = 2; break;
    case 'supervisor': mcCount = 20; maxWrong = 2; hasEssay = true; break;
  }

  const group = emp.group_name || 'A';

  const essayQs = hasEssay ? await loadQuestions('essay', tid) : [];
  // Use the SAME selection as /api/exam/questions so the question the user
  // answered (mc_i / essay_i) is graded against the identical question.
  const { selectedMC, selectedEssay } = selectExamQuestions(mcQuestions, essayQs, emp, tid, currentMonth, mcCount, hasEssay ? 3 : 0);

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
  await saveJSON('exam_results.json', results);

  if (hasEssay && essayAnswers) {
    const allEssays = await loadJSON('essay_answers.json', []);

    // selectedEssay comes from the shared selectExamQuestions() helper, so it
    // matches exactly what the employee saw during the exam.
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
    await saveJSON('essay_answers.json', allEssays);
  }

  res.json({
    success: true,
    result: { mcCorrect, mcTotal: mcCount, mcWrong, mcScore: mcScorePercent, mcPassed, hasEssay, totalPassed: hasEssay ? false : mcPassed, maxWrong, questionDetails }
  });
});

app.get('/api/exam/my-results', authRequired('employee'), async (req, res) => {
  const results = await loadJSON('exam_results.json', []);
  const employees = await loadJSON('employees.json', []);
  const topics = await loadJSON('topics.json', []);

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

app.get('/api/admin/dashboard', authRequired('admin'), async (req, res) => {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const employees = await loadJSON('employees.json', []);
  const configs = await loadJSON('exam_config.json', []);
  const results = await loadJSON('exam_results.json', []);
  const topics = await loadJSON('topics.json', []);

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

app.get('/api/admin/employees', authRequired('admin'), async (req, res) => {
  const employees = await loadJSON('employees.json', []);
  employees.sort((a, b) => a.emp_number.localeCompare(b.emp_number));
  res.json({ success: true, employees });
});

app.post('/api/admin/employees', authRequired('admin'), async (req, res) => {
  const { empNumber, name, level, group, password } = req.body;
  if (!empNumber || !name) return res.json({ success: false, error: '員工編號及姓名必填' });

  const employees = await loadJSON('employees.json', []);
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
  await saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.put('/api/admin/employees/:id', authRequired('admin'), async (req, res) => {
  const { empNumber, name, level, group, password } = req.body;
  const eid = parseInt(req.params.id);
  const employees = await loadJSON('employees.json', []);
  const idx = employees.findIndex(e => e.id === eid);
  if (idx < 0) return res.json({ success: false, error: '員工不存在' });

  const emp = employees[idx];
  if (password) emp.password_hash = bcrypt.hashSync(password, 10);
  if (empNumber !== undefined) emp.emp_number = empNumber;
  if (name !== undefined) emp.name = name;
  if (level !== undefined) emp.level = level;
  if (group !== undefined) emp.group_name = group;

  await saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.delete('/api/admin/employees/:id', authRequired('admin'), async (req, res) => {
  const eid = parseInt(req.params.id);
  let employees = await loadJSON('employees.json', []);
  employees = employees.filter(e => e.id !== eid);
  await saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.post('/api/admin/reset-password/:id', authRequired('admin'), async (req, res) => {
  const { newPassword } = req.body;
  const eid = parseInt(req.params.id);
  const employees = await loadJSON('employees.json', []);
  const idx = employees.findIndex(e => e.id === eid);
  if (idx >= 0) {
    employees[idx].password_hash = bcrypt.hashSync(newPassword || '0000', 10);
    await saveJSON('employees.json', employees);
  }
  res.json({ success: true });
});

app.get('/api/admin/admins', authRequired('admin'), async (req, res) => {
  const admins = await loadJSON('admins.json', []);
  res.json({ success: true, admins: admins.map(({ password_hash: _, ...rest }) => rest) });
});

app.post('/api/admin/admins', authRequired('admin'), async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.json({ success: false, error: '用戶名及密碼必填' });

  const admins = await loadJSON('admins.json', []);
  if (admins.find(a => a.username === username)) return res.json({ success: false, error: '用戶名已存在' });

  const nextId = admins.length > 0 ? Math.max(...admins.map(a => a.id)) + 1 : 1;
  admins.push({
    id: nextId, username, password_hash: bcrypt.hashSync(password, 10),
    display_name: displayName || username, is_super: 0, created_at: nowStr()
  });
  await saveJSON('admins.json', admins);
  res.json({ success: true });
});

app.delete('/api/admin/admins/:id', authRequired('admin'), async (req, res) => {
  const aid = parseInt(req.params.id);
  const admins = await loadJSON('admins.json', []);
  const admin = admins.find(a => a.id === aid);
  if (admin && admin.is_super) return res.json({ success: false, error: '不能刪除超級管理員' });

  await saveJSON('admins.json', admins.filter(a => a.id !== aid));
  res.json({ success: true });
});

app.get('/api/admin/exam-config', authRequired('admin'), async (req, res) => {
  const configs = await loadJSON('exam_config.json', []);
  const topics = await loadJSON('topics.json', []);

  const enriched = configs.map(c => {
    const t = topics.find(tp => tp.id === c.topic_id);
    return { ...c, topic_name: t?.name || '', topic_name_en: t?.name_en || '' };
  }).sort((a, b) => b.year - a.year || b.month - a.month);

  res.json({ success: true, configs: enriched });
});

app.post('/api/admin/exam-config', authRequired('admin'), async (req, res) => {
  const topicId = parseInt(req.body.topicId);
  const month = parseInt(req.body.month);
  const year = parseInt(req.body.year);
  const { startDate, endDate, groups } = req.body;

  let configs = await loadJSON('exam_config.json', []);
  configs = configs.map(c => (c.month === month && c.year === year ? { ...c, is_active: 0 } : c));

  const nextId = configs.length > 0 ? Math.max(...configs.map(c => c.id)) + 1 : 1;
  configs.push({
    id: nextId, topic_id: topicId, month, year,
    start_date: startDate, end_date: endDate, is_active: 1,
    groups: groups || null, created_at: nowStr()
  });
  await saveJSON('exam_config.json', configs);
  res.json({ success: true });
});

app.put('/api/admin/exam-config/:id', authRequired('admin'), async (req, res) => {
  const { isActive, startDate, endDate, groups } = req.body;
  const cid = parseInt(req.params.id);
  const configs = await loadJSON('exam_config.json', []);
  const idx = configs.findIndex(c => c.id === cid);
  if (idx >= 0) {
    if (isActive !== undefined) configs[idx].is_active = isActive ? 1 : 0;
    if (startDate) configs[idx].start_date = startDate;
    if (endDate) configs[idx].end_date = endDate;
    if (groups !== undefined) configs[idx].groups = groups || null;
    await saveJSON('exam_config.json', configs);
  }
  res.json({ success: true });
});

app.delete('/api/admin/exam-config/:id', authRequired('admin'), async (req, res) => {
  const cid = parseInt(req.params.id);
  if (isNaN(cid)) return res.status(400).json({ success: false, error: '無效的配置ID' });

  const configs = await loadJSON('exam_config.json', []);
  const idx = configs.findIndex(c => c.id === cid);
  if (idx === -1) return res.status(404).json({ success: false, error: '找不到該配置' });

  const target = configs[idx];

  // Check if any exam results reference this (topic_id, month, year) combination
  const results = await loadJSON('exam_results.json', []);
  const relatedResults = results.filter(r =>
    r.topic_id === target.topic_id && r.month === target.month && r.year === target.year
  );

  configs.splice(idx, 1);
  await saveJSON('exam_config.json', configs);

  res.json({
    success: true,
    message: `配置已刪除${relatedResults.length > 0 ? `（提示：尚有 ${relatedResults.length} 條相關成績記錄）` : ''}`,
    relatedResultCount: relatedResults.length
  });
});

app.get('/api/admin/results', authRequired('admin'), async (req, res) => {
  const { month, year, level, topicId } = req.query;

  let results = await loadJSON('exam_results.json', []);
  const employees = await loadJSON('employees.json', []);
  const topics = await loadJSON('topics.json', []);

  if (month) results = results.filter(r => r.month === parseInt(month));
  if (year) results = results.filter(r => r.year === parseInt(year));
  if (topicId) results = results.filter(r => r.topic_id === parseInt(topicId));

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

app.get('/api/admin/essay-answers/:resultId', authRequired('admin'), async (req, res) => {
  const rid = parseInt(req.params.resultId);
  const answers = (await loadJSON('essay_answers.json', [])).filter(a => a.result_id === rid);
  const results = await loadJSON('exam_results.json', []);
  const result = results.find(r => r.id === rid);
  const employees = await loadJSON('employees.json', []);

  if (result) {
    const emp = employees.find(e => e.id === result.employee_id);
    Object.assign(result, { emp_name: emp?.name || '', emp_number: emp?.emp_number || '', level: emp?.level || '' });
  }

  res.json({ success: true, result, answers });
});

app.post('/api/admin/grade-essay/:resultId', authRequired('admin'), async (req, res) => {
  const { scores } = req.body;
  const rid = parseInt(req.params.resultId);

  const admins = await loadJSON('admins.json', []);
  const admin = admins.find(a => a.id === req.session.user_id);

  const results = await loadJSON('exam_results.json', []);
  const ridx = results.findIndex(r => r.id === rid);
  if (ridx < 0) return res.json({ success: false, error: 'Result not found' });

  const result = results[ridx];

  let essayTotal = 0, essayMaxTotal = 0;
  let allEssays = await loadJSON('essay_answers.json', []);

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
  await saveJSON('essay_answers.json', allEssays);

  const employees = await loadJSON('employees.json', []);
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
  await saveJSON('exam_results.json', results);

  res.json({ success: true, totalPassed, totalScore, essayScore: Math.round(essayPassPercent), mcPassed });
});

app.delete('/api/admin/results/:id', authRequired('admin'), async (req, res) => {
  const rid = parseInt(req.params.id);
  if (isNaN(rid)) return res.status(400).json({ success:false, error:'無效的記錄ID' });

  const results = await loadJSON('exam_results.json', []);
  const idx = results.findIndex(r => r.id === rid);
  if (idx === -1) return res.status(404).json({ success:false, error:'找不到該記錄' });

  const target = results[idx];
  const employees = await loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === target.employee_id);
  const empLabel = emp ? `${emp.emp_number} ${emp.name}` : `ID ${target.employee_id}`;

  // 同步刪除相關問答答案
  let answers = await loadJSON('essay_answers.json', []);
  const beforeAns = answers.length;
  answers = answers.filter(a => a.result_id !== rid);
  if (answers.length !== beforeAns) {
    await saveJSON('essay_answers.json', answers);
  }

  results.splice(idx, 1);
  await saveJSON('exam_results.json', results);

  console.log(`[Admin ${req.session.username}] 刪除成績記錄 ID=${rid}, 員工=${empLabel}, Topic=${target.topic_id}, 時間=${target.submitted_at}`);

  res.json({ success:true, message:`已刪除 ${empLabel} 嘅成績記錄`, deletedAnswers: beforeAns - answers.length });
});

app.get('/api/admin/export-csv', authRequired('admin'), async (req, res) => {
  const { month, year } = req.query;
  const m = month ? parseInt(month) : new Date().getMonth() + 1;
  const y = year ? parseInt(year) : new Date().getFullYear();
  let results = (await loadJSON('exam_results.json', [])).filter(r => r.month === m && r.year === y);
  const employees = await loadJSON('employees.json', []);
  const topics = await loadJSON('topics.json', []);

  const levelNames = { junior: '初級技術員', senior: '高級技術員', supervisor: '技術員主管' };

  results = results.map(r => {
    const e = employees.find(em => em.id === r.employee_id);
    const t = topics.find(tp => tp.id === r.topic_id);
    return { ...r, emp_name: e?.name || '', emp_number: e?.emp_number || '', level: e?.level || '', group_name: e?.group_name || '', topic_name: t?.name || '' };
  }).sort((a, b) => a.emp_number.localeCompare(b.emp_number));

  let csv = '\uFEFF';
  csv += '員工編號,姓名,職級,組別,主題,MC分數,MC正確,MC總題,問答分數,總分,合格,提交時間\n';
  for (const r of results) {
    csv += `${r.emp_number},${r.emp_name},${levelNames[r.level]||r.level},${r.group_name||''},${r.topic_name},${r.mc_score}%,${r.mc_correct},${r.mc_total},${r.essay_score}%,${r.total_score}%,${r.passed?'合格':'不合格'},${r.submitted_at}\n`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=exam_results_${y}_${m}.csv`);
  res.send(csv);
});

// ====== QUESTION BANK MANAGEMENT ======

app.get('/api/admin/questions/:topicId', authRequired('admin'), async (req, res) => {
  const tid = parseInt(req.params.topicId);
  if (isNaN(tid) || tid < 1) return res.status(400).json({ success: false, error: '無效主題 ID' });

  try {
    const mc = await loadQuestions('mc', tid);
    const essay = await loadQuestions('essay', tid);

    res.json({ success: true, mc: mc || [], essay: essay || [], mcCount: (mc || []).length, essayCount: (essay || []).length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '讀取題庫失敗' });
  }
});

// Re-seed question bank from local files into Redis (or overwrite file storage)
app.post('/api/admin/questions/reseed', authRequired('admin'), async (req, res) => {
  try {
    const results = [];
    for (const tid of [1, 2, 3, 4, 5, 7, 8]) {
      for (const type of ['mc', 'essay']) {
        const file = path.join(__dirname, 'questions', `topic_${tid}_${type}.json`);
        if (!fs.existsSync(file)) continue;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        await saveQuestions(type, tid, data);
        results.push({ topicId: tid, type, count: data.length });
      }
    }
    res.json({ success: true, message: 'Re-seeded from local files', results });
  } catch (e) {
    console.error('Reseed failed:', e);
    res.status(500).json({ success: false, error: 'Re-seed failed: ' + e.message });
  }
});

app.post('/api/admin/questions/mc/:topicId', authRequired('admin'), async (req, res) => {
  const tid = parseInt(req.params.topicId);
  const { question, options, answer } = req.body;
  
  if (!question || !options || options.length < 2 || answer === undefined) {
    return res.status(400).json({ success: false, error: '請填寫完整題目信息' });
  }
  if (answer < 0 || answer >= options.length) {
    return res.status(400).json({ success: false, error: '正確答案索引無效' });
  }
  
  try {
    const mc = await loadQuestions('mc', tid) || [];
    mc.push({ question, options, correct: answer });
    await saveQuestions('mc', tid, mc);
    res.json({ success: true, message: '選擇題添加成功', total: mc.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '添加題目失敗' });
  }
});

app.put('/api/admin/questions/mc/:topicId/:qIndex', authRequired('admin'), async (req, res) => {
  const tid = parseInt(req.params.topicId);
  const qIdx = parseInt(req.params.qIndex);
  const { question, options, answer } = req.body;
  
  try {
    const mc = await loadQuestions('mc', tid) || [];
    if (qIdx < 0 || qIdx >= mc.length) {
      return res.status(404).json({ success: false, error: '題目不存在' });
    }
    mc[qIdx] = { question, options, correct: answer };
    await saveQuestions('mc', tid, mc);
    res.json({ success: true, message: '題目更新成功' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '更新題目失敗' });
  }
});

app.delete('/api/admin/questions/mc/:topicId/:qIndex', authRequired('admin'), async (req, res) => {
  const tid = parseInt(req.params.topicId);
  const qIdx = parseInt(req.params.qIndex);
  
  try {
    const mc = await loadQuestions('mc', tid) || [];
    if (qIdx < 0 || qIdx >= mc.length) {
      return res.status(404).json({ success: false, error: '題目不存在' });
    }
    mc.splice(qIdx, 1);
    await saveQuestions('mc', tid, mc);
    res.json({ success: true, message: '題目刪除成功', total: mc.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '刪除題目失敗' });
  }
});

app.post('/api/admin/questions/essay/:topicId', authRequired('admin'), async (req, res) => {
  const tid = parseInt(req.params.topicId);
  const { question, maxScore } = req.body;
  
  if (!question) {
    return res.status(400).json({ success: false, error: '請填寫題目內容' });
  }
  
  try {
    const essay = await loadQuestions('essay', tid) || [];
    essay.push({ question, maxScore: maxScore || 10 });
    await saveQuestions('essay', tid, essay);
    res.json({ success: true, message: '問答題添加成功', total: essay.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '添加題目失敗' });
  }
});

app.put('/api/admin/questions/essay/:topicId/:qIndex', authRequired('admin'), async (req, res) => {
  const tid = parseInt(req.params.topicId);
  const qIdx = parseInt(req.params.qIndex);
  const { question, maxScore } = req.body;
  
  try {
    const essay = await loadQuestions('essay', tid) || [];
    if (qIdx < 0 || qIdx >= essay.length) {
      return res.status(404).json({ success: false, error: '題目不存在' });
    }
    essay[qIdx] = { question, maxScore: maxScore || 10 };
    await saveQuestions('essay', tid, essay);
    res.json({ success: true, message: '題目更新成功' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '更新題目失敗' });
  }
});

app.delete('/api/admin/questions/essay/:topicId/:qIndex', authRequired('admin'), async (req, res) => {
  const tid = parseInt(req.params.topicId);
  const qIdx = parseInt(req.params.qIndex);
  
  try {
    const essay = await loadQuestions('essay', tid) || [];
    if (qIdx < 0 || qIdx >= essay.length) {
      return res.status(404).json({ success: false, error: '題目不存在' });
    }
    essay.splice(qIdx, 1);
    await saveQuestions('essay', tid, essay);
    res.json({ success: true, message: '題目刪除成功', total: essay.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: '刪除題目失敗' });
  }
});

app.get('/api/topics', async (req, res) => {
  const topics = await loadJSON('topics.json', []);
  topics.sort((a, b) => a.order_num - b.order_num);
  res.json({ success: true, topics });
});

// Serve frontend pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/exam', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Export for Vercel serverless
module.exports = app;

// Start server locally only (not on Vercel)
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`BIOYCLE Exam System running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Employee exam: http://localhost:${PORT}`);
  });
}
