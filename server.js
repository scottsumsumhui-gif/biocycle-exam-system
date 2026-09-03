const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// Session lifetime: 24 hours for both the cookie and the server-side expiry.
// Long enough to survive a full exam (max 45 min) plus prep time, and rolling
// refresh via heartbeat keeps it alive while the exam page stays open.
const SESSION_TTL_MS = 24 * 3600000;
// Admin sessions last much longer (30 days) and are kept alive by a background
// heartbeat in admin.html, so an admin editing the warehouse won't be kicked out.
const ADMIN_SESSION_TTL_MS = 30 * 24 * 3600000;

// ====== UPSTASH REDIS (any platform) + DUAL-MODE DATA LAYER ======
const isVercel = !!process.env.VERCEL;
let redis = null;
let redisPing = 'unknown'; // unknown | ok | failed

// Admin RBAC permissions. Each key maps to a feature area. is_super admins automatically have all.
// When editing/adding admin features, just add a new key here and wrap endpoints with requirePermission().
const ADMIN_PERMISSIONS = {
  dashboard:   '看板 Dashboard',
  employees:   '員工管理 Employees',
  admin_mgmt:  '管理員權限 Admin Management',
  exam_config: '考試配置 Exam Config',
  results:     '成績查看 Results',
  grading:     '問答評分 Essay Grading',
  questions:   '題庫管理 Question Bank',
  warehouse:   '倉存管理 Warehouse',
  commission:  '渠網銷售佣金 Channel Commission',
  leads:       '服務銷售 Technician Leads'
};
const ALL_PERMISSION_KEYS = Object.keys(ADMIN_PERMISSIONS);

// Built-in defaults for job levels. Used as a fallback if data/job_levels.json is missing
// (e.g. on Vercel cold start). The file in data/ takes precedence once it exists.
const BUILTIN_JOB_LEVELS = [
  { key: 'junior',     label: '初級技術員', description: '考試：20題選擇題，最多錯4題（80%合格）', is_builtin: true, order: 1 },
  { key: 'senior',     label: '高級技術員', description: '考試：20題選擇題，最多錯2題（90%合格）', is_builtin: true, order: 2 },
  { key: 'supervisor', label: '技術員主管', description: '考試：20題選擇題+3題問答，最多錯2題（90%合格）', is_builtin: true, order: 3 }
];
const JOB_LEVEL_FILE = 'job_levels.json';

// Returns the list of job levels. Always returns an array (never null).
async function getJobLevels() {
  let list = await loadJSON(JOB_LEVEL_FILE, null);
  if (!Array.isArray(list) || list.length === 0) {
    list = BUILTIN_JOB_LEVELS.slice();
    // Persist so subsequent reads are consistent.
    try { await saveJSON(JOB_LEVEL_FILE, list); } catch (_) {}
  }
  return list.sort((a, b) => (a.order || 0) - (b.order || 0));
}

// Resolve a level key to its label. Falls back to the key itself if unknown.
async function getLevelLabel(levelKey) {
  if (!levelKey) return '';
  const list = await getJobLevels();
  const found = list.find(l => l.key === levelKey);
  return found ? found.label : levelKey;
}

// Synchronous variant for endpoints that already have the list loaded.
function levelLabelFromList(list, key) {
  const f = list.find(l => l.key === key);
  return f ? f.label : (key || '');
}

// Migration: when an existing non-super admin has no `permissions` field, grant them all (so they aren't locked out).
// 'admin_mgmt' is intentionally NOT included — only super admin manages permissions by default.
async function migrateAdminPermissions() {
  const admins = await loadJSON('admins.json', []);
  let dirty = false;
  for (const a of admins) {
    if (a.is_super) continue;
    if (!Array.isArray(a.permissions)) {
      a.permissions = ALL_PERMISSION_KEYS.filter(k => k !== 'admin_mgmt');
      dirty = true;
    } else if (a.permissions.includes('admin_mgmt')) {
      // Existing admins that somehow have admin_mgmt should not — strip it.
      a.permissions = a.permissions.filter(p => p !== 'admin_mgmt');
      dirty = true;
    }
  }
  if (dirty) await saveJSON('admins.json', admins);
}

// Check if the logged-in admin has the given permission. Super admin always returns true.
async function adminHasPermission(adminId, permKey) {
  const admins = await loadJSON('admins.json', []);
  const me = admins.find(a => a.id === adminId);
  if (!me) return false;
  if (me.is_super) return true;
  return Array.isArray(me.permissions) && me.permissions.includes(permKey);
}

// Compute the effective permission list for an admin (super = all).
function effectivePermissions(admin) {
  if (!admin) return [];
  if (admin.is_super) return ALL_PERMISSION_KEYS.slice();
  return Array.isArray(admin.permissions) ? admin.permissions : [];
}

// Try to connect to Upstash Redis if env vars are set (works on Vercel, Railway, etc.)
if (process.env.UPSTASH_REDIS_REST_URL) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('[REDIS] Upstash configured. URL=' + process.env.UPSTASH_REDIS_REST_URL);
    // Real connectivity test (the line above only creates the client, not a connection)
    redis.ping().then(() => {
      redisPing = 'ok';
      console.log('[REDIS] PING OK - persisted session/score enabled');
    }).catch(e => {
      redisPing = 'failed';
      console.error('[REDIS] PING FAILED:', e.message);
    });
  } catch(e) {
    redisPing = 'failed';
    console.error('[REDIS] init failed:', e.message);
  }
} else {
  console.log('[REDIS] No UPSTASH_REDIS_REST_URL set - using local file mode');
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
  if (!fs.existsSync(path.join(DATA_DIR, 'job_levels.json'))) saveJSONSync('job_levels.json', BUILTIN_JOB_LEVELS.slice());
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

// Helper: get expiry time (current local + ttl). Defaults to employee TTL.
function expiresAtStr(ttl = SESSION_TTL_MS) {
  const d = new Date(Date.now() + ttl);
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

// Permission gate: use after authRequired('admin'). 403 if missing.
function requirePermission(permKey) {
  return async (req, res, next) => {
    try {
      const admins = await loadJSON('admins.json', []);
      const me = admins.find(a => a.id === req.session.user_id);
      if (!me) return res.status(401).json({ success: false, error: 'Session invalid' });
      if (me.is_super) return next();
      const perms = Array.isArray(me.permissions) ? me.permissions : [];
      if (!perms.includes(permKey)) return res.status(403).json({ success: false, error: '權限不足: ' + (ADMIN_PERMISSIONS[permKey] || permKey) });
      next();
    } catch (e) {
      res.status(500).json({ success: false, error: '權限檢查失敗' });
    }
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
    expires_at: expiresAtStr(ADMIN_SESSION_TTL_MS)
  });
  await saveJSON('sessions.json', sessions);

  res.cookie('session_id', sessionId, { maxAge: ADMIN_SESSION_TTL_MS, httpOnly: true });
  res.json({
    success: true,
    admin: {
      id: admin.id,
      username: admin.username,
      displayName: admin.display_name,
      isSuper: admin.is_super,
      permissions: effectivePermissions(admin)
    }
  });
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
    if (adm) userInfo = { username: adm.username, displayName: adm.display_name, isSuper: adm.is_super, permissions: effectivePermissions(adm) };
  }

  res.json({ authenticated: true, userType: session.user_type, user: userInfo });
});

// Health check: shows whether Upstash Redis is actually connected (ping verified)
app.get('/api/health', (req, res) => {
  res.json({
    redis: redisPing,
    mode: redis ? 'upstash' : 'file',
    url: redis ? process.env.UPSTASH_REDIS_REST_URL : null
  });
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
    const ttl = sessions[idx].user_type === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
    const newExpiry = expiresAtStr(ttl);
    sessions[idx].expires_at = newExpiry;
    await saveJSON('sessions.json', sessions);
    res.cookie('session_id', sessionId, { maxAge: ttl, httpOnly: true });
    res.json({ success: true, expiresAt: newExpiry });
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
    // 'd' = 技術員副主管：合格邏輯同 senior 一樣 (20 MC, 最多錯 2, 冇問答)
    case 'senior':
    case 'd': mcCount = 20; maxWrong = 2; break;
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
    // 'd' = 技術員副主管：同 senior 一樣 (20 MC, 冇問答)
    case 'senior':
    case 'd': mcCount = 20; break;
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
    // 'd' = 技術員副主管：同 senior 一樣 (20 MC, 最多錯 2, 冇問答)
    case 'senior':
    case 'd': mcCount = 20; maxWrong = 2; break;
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

// ===== JOB LEVELS (職級管理) ROUTES =====
app.get('/api/admin/job-levels', authRequired('admin'), requirePermission('employees'), async (req, res) => {
  const list = await getJobLevels();
  res.json({ success: true, jobLevels: list });
});

// Add a new job level. Only super admin can create new levels — this affects
// the employee dropdown and the exam logic, so it must be tightly controlled.
app.post('/api/admin/job-levels', authRequired('admin'), requirePermission('employees'), async (req, res) => {
  const admins = await loadJSON('admins.json', []);
  const me = admins.find(a => a.id === req.session.user_id);
  if (!me || !me.is_super) return res.status(403).json({ success: false, error: '只有超級管理員可新增職級' });

  const { key, label, description, order } = req.body || {};
  if (!key || !label) return res.json({ success: false, error: 'key 及 label 必填' });
  // Restrict key to lowercase letters / digits / underscore so it is safe in URLs and SQL-ish contexts.
  if (!/^[a-z][a-z0-9_]{0,29}$/.test(key)) return res.json({ success: false, error: 'key 必須係小寫英文字母開頭，只可包含字母、數字、底線' });

  const list = await getJobLevels();
  if (list.find(l => l.key === key)) return res.json({ success: false, error: '此 key 已存在' });
  list.push({
    key, label, description: description || '',
    is_builtin: false,
    order: Number.isFinite(Number(order)) ? Number(order) : (list.length + 1)
  });
  await saveJSON(JOB_LEVEL_FILE, list);
  res.json({ success: true });
});

// Update an existing job level's label / description / order. The key is immutable
// because changing it would break employees that already reference it.
app.put('/api/admin/job-levels/:key', authRequired('admin'), requirePermission('employees'), async (req, res) => {
  const admins = await loadJSON('admins.json', []);
  const me = admins.find(a => a.id === req.session.user_id);
  if (!me || !me.is_super) return res.status(403).json({ success: false, error: '只有超級管理員可修改職級' });

  const targetKey = req.params.key;
  const { label, description, order } = req.body || {};
  const list = await getJobLevels();
  const idx = list.findIndex(l => l.key === targetKey);
  if (idx < 0) return res.json({ success: false, error: '職級不存在' });
  if (label !== undefined) list[idx].label = String(label).trim();
  if (description !== undefined) list[idx].description = String(description);
  if (order !== undefined && Number.isFinite(Number(order))) list[idx].order = Number(order);
  await saveJSON(JOB_LEVEL_FILE, list);
  res.json({ success: true });
});

// Delete a job level. Blocked if any employee still references it — that prevents
// orphaned levels and silently broken exam logic.
app.delete('/api/admin/job-levels/:key', authRequired('admin'), requirePermission('employees'), async (req, res) => {
  const admins = await loadJSON('admins.json', []);
  const me = admins.find(a => a.id === req.session.user_id);
  if (!me || !me.is_super) return res.status(403).json({ success: false, error: '只有超級管理員可刪除職級' });

  const targetKey = req.params.key;
  const list = await getJobLevels();
  const idx = list.findIndex(l => l.key === targetKey);
  if (idx < 0) return res.json({ success: false, error: '職級不存在' });

  const employees = await loadJSON('employees.json', []);
  const inUse = employees.filter(e => e.level === targetKey).length;
  if (inUse > 0) {
    return res.json({ success: false, error: `仍有 ${inUse} 名員工使用此職級，請先改員工職級先刪除` });
  }
  list.splice(idx, 1);
  await saveJSON(JOB_LEVEL_FILE, list);
  res.json({ success: true });
});

app.get('/api/admin/employees', authRequired('admin'), requirePermission('employees'), async (req, res) => {
  const employees = await loadJSON('employees.json', []);
  const jobLevels = await getJobLevels();
  employees.sort((a, b) => a.emp_number.localeCompare(b.emp_number));
  const enriched = employees.map(e => ({ ...e, level_label: levelLabelFromList(jobLevels, e.level) }));
  res.json({ success: true, employees: enriched, jobLevels });
});

app.post('/api/admin/employees', authRequired('admin'), requirePermission('employees'), async (req, res) => {
  const { empNumber, name, level, group, password } = req.body;
  if (!empNumber || !name) return res.json({ success: false, error: '員工編號及姓名必填' });

  const employees = await loadJSON('employees.json', []);
  if (employees.find(e => e.emp_number === empNumber)) return res.json({ success: false, error: '員工編號已存在' });

  // Validate that the requested level exists in the configured list (defaults to 'junior').
  const finalLevel = level || 'junior';
  const jobLevels = await getJobLevels();
  if (!jobLevels.find(l => l.key === finalLevel)) return res.json({ success: false, error: '職級無效: ' + finalLevel });

  const nextId = employees.length > 0 ? Math.max(...employees.map(e => e.id)) + 1 : 1;
  employees.push({
    id: nextId,
    emp_number: empNumber,
    name: name,
    password_hash: bcrypt.hashSync(password || '0000', 10),
    level: finalLevel,
    group_name: group || null,
    created_at: nowStr()
  });
  await saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.put('/api/admin/employees/:id', authRequired('admin'), requirePermission('employees'), async (req, res) => {
  const { empNumber, name, level, group, password } = req.body;
  const eid = parseInt(req.params.id);
  const employees = await loadJSON('employees.json', []);
  const idx = employees.findIndex(e => e.id === eid);
  if (idx < 0) return res.json({ success: false, error: '員工不存在' });

  const emp = employees[idx];
  if (password) emp.password_hash = bcrypt.hashSync(password, 10);
  if (empNumber !== undefined) emp.emp_number = empNumber;
  if (name !== undefined) emp.name = name;
  if (level !== undefined) {
    const jobLevels = await getJobLevels();
    if (!jobLevels.find(l => l.key === level)) return res.json({ success: false, error: '職級無效: ' + level });
    emp.level = level;
  }
  if (group !== undefined) emp.group_name = group;

  await saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.delete('/api/admin/employees/:id', authRequired('admin'), requirePermission('employees'), async (req, res) => {
  const eid = parseInt(req.params.id);
  let employees = await loadJSON('employees.json', []);
  employees = employees.filter(e => e.id !== eid);
  await saveJSON('employees.json', employees);
  res.json({ success: true });
});

app.post('/api/admin/reset-password/:id', authRequired('admin'), requirePermission('employees'), async (req, res) => {
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

app.get('/api/admin/admins', authRequired('admin'), requirePermission('admin_mgmt'), async (req, res) => {
  const admins = await loadJSON('admins.json', []);
  const list = admins.map(a => ({
    id: a.id, username: a.username, display_name: a.display_name,
    is_super: a.is_super, created_at: a.created_at,
    permissions: effectivePermissions(a)
  }));
  res.json({ success: true, admins: list, allPermissions: ADMIN_PERMISSIONS });
});

app.post('/api/admin/admins', authRequired('admin'), requirePermission('admin_mgmt'), async (req, res) => {
  const { username, password, displayName, permissions } = req.body;
  if (!username || !password) return res.json({ success: false, error: '用戶名及密碼必填' });

  const admins = await loadJSON('admins.json', []);
  if (admins.find(a => a.username === username)) return res.json({ success: false, error: '用戶名已存在' });

  const nextId = admins.length > 0 ? Math.max(...admins.map(a => a.id)) + 1 : 1;
  // Filter out admin_mgmt — only super admin manages permissions by default.
  const grantedPerms = Array.isArray(permissions)
    ? permissions.filter(p => ALL_PERMISSION_KEYS.includes(p) && p !== 'admin_mgmt')
    : [];
  admins.push({
    id: nextId, username, password_hash: bcrypt.hashSync(password, 10),
    display_name: displayName || username, is_super: 0,
    permissions: grantedPerms,
    created_at: nowStr()
  });
  await saveJSON('admins.json', admins);
  res.json({ success: true, id: nextId, admin: { id: nextId, username, displayName: displayName || username, is_super: 0, permissions: grantedPerms } });
});

app.delete('/api/admin/admins/:id', authRequired('admin'), requirePermission('admin_mgmt'), async (req, res) => {
  const aid = parseInt(req.params.id);
  const admins = await loadJSON('admins.json', []);
  const admin = admins.find(a => a.id === aid);
  if (admin && admin.is_super) return res.json({ success: false, error: '不能刪除超級管理員' });

  await saveJSON('admins.json', admins.filter(a => a.id !== aid));
  res.json({ success: true });
});

app.put('/api/admin/admins/:id/permissions', authRequired('admin'), requirePermission('admin_mgmt'), async (req, res) => {
  try {
    const aid = parseInt(req.params.id);
    const { permissions } = req.body || {};
    if (!Array.isArray(permissions)) return res.json({ success: false, error: 'permissions 必須為陣列' });
    const admins = await loadJSON('admins.json', []);
    const idx = admins.findIndex(a => a.id === aid);
    if (idx < 0) return res.json({ success: false, error: '管理員不存在' });
    if (admins[idx].is_super) return res.json({ success: false, error: '超級管理員權限不可修改' });
    admins[idx].permissions = permissions.filter(p => ALL_PERMISSION_KEYS.includes(p) && p !== 'admin_mgmt');
    await saveJSON('admins.json', admins);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '修改失敗' });
  }
});

app.put('/api/admin/admins/:id/password', authRequired('admin'), async (req, res) => {
  try {
    const aid = parseInt(req.params.id);
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.json({ success: false, error: '新密碼至少 4 位' });
    const current = req.session.user_id;
    const admins = await loadJSON('admins.json', []);
    const me = admins.find(a => a.id === current);
    if (!me) return res.status(401).json({ success: false, error: 'Session invalid' });
    if (aid !== current) {
      // Need admin_mgmt permission to change others' passwords (super bypasses via is_super)
      if (!me.is_super) {
        const perms = Array.isArray(me.permissions) ? me.permissions : [];
        if (!perms.includes('admin_mgmt')) return res.json({ success: false, error: '權限不足: 管理員權限' });
      }
    }
    const idx = admins.findIndex(a => a.id === aid);
    if (idx < 0) return res.json({ success: false, error: '管理員不存在' });
    admins[idx].password_hash = bcrypt.hashSync(newPassword, 10);
    await saveJSON('admins.json', admins);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '修改失敗' });
  }
});

app.get('/api/admin/exam-config', authRequired('admin'), requirePermission('exam_config'), async (req, res) => {
  const configs = await loadJSON('exam_config.json', []);
  const topics = await loadJSON('topics.json', []);

  const enriched = configs.map(c => {
    const t = topics.find(tp => tp.id === c.topic_id);
    return { ...c, topic_name: t?.name || '', topic_name_en: t?.name_en || '' };
  }).sort((a, b) => b.year - a.year || b.month - a.month);

  res.json({ success: true, configs: enriched });
});

app.post('/api/admin/exam-config', authRequired('admin'), requirePermission('exam_config'), async (req, res) => {
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

app.put('/api/admin/exam-config/:id', authRequired('admin'), requirePermission('exam_config'), async (req, res) => {
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

app.delete('/api/admin/exam-config/:id', authRequired('admin'), requirePermission('exam_config'), async (req, res) => {
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

app.get('/api/admin/results', authRequired('admin'), requirePermission('results'), async (req, res) => {
  const { month, year, level, topicId } = req.query;

  let results = await loadJSON('exam_results.json', []);
  const employees = await loadJSON('employees.json', []);
  const topics = await loadJSON('topics.json', []);
  const jobLevels = await getJobLevels();

  if (month) results = results.filter(r => r.month === parseInt(month));
  if (year) results = results.filter(r => r.year === parseInt(year));
  if (topicId) results = results.filter(r => r.topic_id === parseInt(topicId));

  results = results
    .map(r => {
      const e = employees.find(em => em.id === r.employee_id);
      const t = topics.find(tp => tp.id === r.topic_id);
      const empLevel = e?.level || '';
      return { ...r, emp_name: e?.name || '', emp_number: e?.emp_number || '', level: empLevel, level_label: levelLabelFromList(jobLevels, empLevel), group_name: e?.group_name || '', topic_name: t?.name || '', topic_name_en: t?.name_en || '' };
    })
    .filter(r => !level || r.level === level)
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  res.json({ success: true, results });
});

app.get('/api/admin/essay-answers/:resultId', authRequired('admin'), requirePermission('grading'), async (req, res) => {
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

app.post('/api/admin/grade-essay/:resultId', authRequired('admin'), requirePermission('grading'), async (req, res) => {
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
  // maxWrong 對齊：supervisor/senior/副主管(d) 都係 2，其餘（junior、自訂）係 4
  const maxWrong = (emp?.level === 'supervisor' || emp?.level === 'senior' || emp?.level === 'd') ? 2 : 4;
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

app.delete('/api/admin/results/:id', authRequired('admin'), requirePermission('results'), async (req, res) => {
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

app.get('/api/admin/export-csv', authRequired('admin'), requirePermission('results'), async (req, res) => {
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

app.get('/api/admin/questions/:topicId', authRequired('admin'), requirePermission('questions'), async (req, res) => {
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
app.post('/api/admin/questions/reseed', authRequired('admin'), requirePermission('questions'), async (req, res) => {
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

app.post('/api/admin/questions/mc/:topicId', authRequired('admin'), requirePermission('questions'), async (req, res) => {
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

app.put('/api/admin/questions/mc/:topicId/:qIndex', authRequired('admin'), requirePermission('questions'), async (req, res) => {
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

app.delete('/api/admin/questions/mc/:topicId/:qIndex', authRequired('admin'), requirePermission('questions'), async (req, res) => {
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

app.post('/api/admin/questions/essay/:topicId', authRequired('admin'), requirePermission('questions'), async (req, res) => {
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

app.put('/api/admin/questions/essay/:topicId/:qIndex', authRequired('admin'), requirePermission('questions'), async (req, res) => {
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

app.delete('/api/admin/questions/essay/:topicId/:qIndex', authRequired('admin'), requirePermission('questions'), async (req, res) => {
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

// ===== WAREHOUSE ROUTES (employee + admin) =====
const WH_ITEMS = 'warehouse_items.json';
const WH_TX = 'warehouse_transactions.json';
const WH_VEHICLES = 'warehouse_vehicles.json';

// Seed default vehicle list (CAR 1-12) on first run if file missing/empty
async function ensureDefaultVehicles() {
  let vehicles = await loadJSON(WH_VEHICLES, null);
  if (!Array.isArray(vehicles) || !vehicles.length) {
    vehicles = [];
    for (let i = 1; i <= 12; i++) vehicles.push({ id: i, code: `CAR ${i}` });
    await saveJSON(WH_VEHICLES, vehicles);
  }
  return vehicles;
}

// Compute current stock balance per item (in - out)
async function computeStock() {
  const items = await loadJSON(WH_ITEMS, []);
  const tx = await loadJSON(WH_TX, []);
  return items.map(it => {
    let bal = 0;
    for (const t of tx) {
      if (t.item_id !== it.id) continue;
      bal += (t.type === 'in' ? 1 : -1) * t.qty;
    }
    return { ...it, balance: bal };
  });
}

// Employee: list catalog
app.get('/api/warehouse/items', authRequired('employee'), async (req, res) => {
  res.json(await loadJSON(WH_ITEMS, []));
});

// Employee: add new item (fixed catalog + can add new)
app.post('/api/warehouse/items', authRequired('employee'), async (req, res) => {
  try {
    const { name, unit, category } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '請填寫物資名稱' });
    const cleanName = name.trim();
    const items = await loadJSON(WH_ITEMS, []);
    const dup = items.find(i => i.name === cleanName);
    if (dup) return res.status(400).json({ error: '物資已存在', item: dup });
    const employees = await loadJSON('employees.json', []);
    const emp = employees.find(e => e.id === req.session.user_id);
    const nextId = items.length ? Math.max(...items.map(i => i.id)) + 1 : 1;
    const item = {
      id: nextId,
      name: cleanName,
      unit: (unit || '').trim() || '個',
      category: (category || '').trim() || '其他',
      created_by: emp ? emp.name : 'unknown',
      created_at: nowStr()
    };
    items.push(item);
    await saveJSON(WH_ITEMS, items);
    res.json({ success: true, item });
  } catch (e) {
    res.status(500).json({ success: false, error: '新增物資失敗' });
  }
});

// Employee: list own transactions
app.get('/api/warehouse/transactions', authRequired('employee'), async (req, res) => {
  const tx = await loadJSON(WH_TX, []);
  const employees = await loadJSON('employees.json', []);
  const emp = employees.find(e => e.id === req.session.user_id);
  const mine = tx.filter(t => t.emp_id === emp.id).sort((a, b) => b.id - a.id);
  res.json(mine);
});

// Employee: current stock
app.get('/api/warehouse/stock', authRequired('employee'), async (req, res) => {
  res.json(await computeStock());
});

// Employee: record in/out transaction
app.post('/api/warehouse/transactions', authRequired('employee'), async (req, res) => {
  try {
    const { item_id, type, qty, remark, car_no } = req.body || {};
    if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'type 必須為 in 或 out' });
    const q = Number(qty);
    if (!q || q <= 0) return res.status(400).json({ error: '數量必須大於 0' });
    const items = await loadJSON(WH_ITEMS, []);
    const item = items.find(i => i.id === Number(item_id));
    if (!item) return res.status(400).json({ error: '物資不存在，請先新增或選擇正確物資' });
    const employees = await loadJSON('employees.json', []);
    const emp = employees.find(e => e.id === req.session.user_id);
    if (!emp) return res.status(401).json({ error: '員工資料不存在' });
    if (type === 'out') {
      const stock = await computeStock();
      const cur = stock.find(s => s.id === item.id);
      if (cur && cur.balance < q) {
        return res.status(400).json({ error: `庫存不足：現有 ${cur.balance} ${item.unit}，不足 ${q}` });
      }
    }
    const tx = await loadJSON(WH_TX, []);
    const nextId = tx.length ? Math.max(...tx.map(t => t.id)) + 1 : 1;
    const record = {
      id: nextId,
      item_id: item.id,
      item_name: item.name,
      category: item.category,
      type,
      qty: q,
      emp_id: emp.id,
      emp_name: emp.name,
      car_no: type === 'out' ? (car_no || '').trim() : '',
      remark: (remark || '').trim(),
      created_at: nowStr()
    };
    tx.push(record);
    await saveJSON(WH_TX, tx);
    res.json({ success: true, record });
  } catch (e) {
    res.status(500).json({ success: false, error: '記錄失敗' });
  }
});

// Employee: delete own transaction (e.g. typo on out record)
app.delete('/api/warehouse/transactions/:id', authRequired('employee'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const employees = await loadJSON('employees.json', []);
    const emp = employees.find(e => e.id === req.session.user_id);
    if (!emp) return res.status(401).json({ error: '員工資料不存在' });

    const tx = await loadJSON(WH_TX, []);
    const idx = tx.findIndex(t => t.id === id);
    if (idx < 0) return res.status(404).json({ success: false, error: '交易不存在' });
    if (tx[idx].emp_id !== emp.id) return res.status(403).json({ success: false, error: '只可以刪除自己的記錄' });

    tx.splice(idx, 1);
    await saveJSON(WH_TX, tx);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '刪除失敗' });
  }
});

// ===== ADMIN WAREHOUSE ROUTES =====
app.get('/api/admin/warehouse/items', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  res.json(await loadJSON(WH_ITEMS, []));
});

// Admin: add item with optional initial stock (auto in-transaction)
app.post('/api/admin/warehouse/items', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const { name, unit, category, initial_qty } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '請填寫物資名稱' });
    const cleanName = name.trim();
    const items = await loadJSON(WH_ITEMS, []);
    const dup = items.find(i => i.name === cleanName);
    if (dup) return res.status(400).json({ error: '物資已存在', item: dup });
    const admins = await loadJSON('admins.json', []);
    const admin = admins.find(a => a.id === req.session.user_id);
    const nextId = items.length ? Math.max(...items.map(i => i.id)) + 1 : 1;
    const item = {
      id: nextId,
      name: cleanName,
      unit: (unit || '').trim() || '個',
      category: (category || '').trim() || '其他',
      created_by: admin ? admin.username : 'admin',
      created_at: nowStr()
    };
    items.push(item);
    await saveJSON(WH_ITEMS, items);

    // optional initial stock
    const init = Number(initial_qty);
    if (init && init > 0) {
      const tx = await loadJSON(WH_TX, []);
      const nextTxId = tx.length ? Math.max(...tx.map(t => t.id)) + 1 : 1;
      const record = {
        id: nextTxId,
        item_id: item.id,
        item_name: item.name,
        category: item.category,
        type: 'in',
        qty: init,
        emp_id: req.session.user_id,
        emp_name: admin ? admin.username : 'admin',
        car_no: '',
        remark: '初始庫存',
        created_at: nowStr()
      };
      tx.push(record);
      await saveJSON(WH_TX, tx);
    }
    res.json({ success: true, item });
  } catch (e) {
    res.status(500).json({ success: false, error: '新增物資失敗' });
  }
});

// Admin: edit item (name/unit/category), sync existing transactions
app.put('/api/admin/warehouse/items/:id', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, unit, category } = req.body || {};
    const items = await loadJSON(WH_ITEMS, []);
    const item = items.find(i => i.id === id);
    if (!item) return res.status(404).json({ error: '物資不存在' });
    if (name && name.trim()) item.name = name.trim();
    if (unit !== undefined) item.unit = (unit || '').trim() || '個';
    if (category !== undefined) item.category = (category || '').trim() || '其他';
    await saveJSON(WH_ITEMS, items);

    // sync item_name & category in transactions
    const tx = await loadJSON(WH_TX, []);
    let changed = false;
    for (const t of tx) {
      if (t.item_id === id) {
        t.item_name = item.name;
        t.category = item.category;
        changed = true;
      }
    }
    if (changed) await saveJSON(WH_TX, tx);
    res.json({ success: true, item });
  } catch (e) {
    res.status(500).json({ success: false, error: '修改失敗' });
  }
});

app.delete('/api/admin/warehouse/items/:id', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const items = await loadJSON(WH_ITEMS, []);
    await saveJSON(WH_ITEMS, items.filter(i => i.id !== id));
    // also drop related transactions
    const tx = await loadJSON(WH_TX, []);
    await saveJSON(WH_TX, tx.filter(t => t.item_id !== id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '刪除失敗' });
  }
});

// Admin: reindex item IDs to be continuous (1,2,3...) and remap related transactions
app.post('/api/admin/warehouse/reindex', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const items = await loadJSON(WH_ITEMS, []);
    const sorted = items.slice().sort((a, b) => a.id - b.id);
    const idMap = {};
    const remapped = sorted.map((it, idx) => {
      const newId = idx + 1;
      idMap[it.id] = newId;
      return { ...it, id: newId };
    });
    await saveJSON(WH_ITEMS, remapped);

    const tx = await loadJSON(WH_TX, []);
    let txChanged = false;
    for (const t of tx) {
      if (idMap[t.item_id] != null && idMap[t.item_id] !== t.item_id) {
        t.item_id = idMap[t.item_id];
        txChanged = true;
      }
    }
    if (txChanged) await saveJSON(WH_TX, tx);
    res.json({ success: true, remapped: remapped.length, tx_remapped: txChanged });
  } catch (e) {
    res.status(500).json({ success: false, error: '重整編號失敗' });
  }
});

// Admin: directly set stock -> auto in/out adjust transaction
app.post('/api/admin/warehouse/adjust', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const { item_id, new_balance } = req.body || {};
    const item = (await loadJSON(WH_ITEMS, [])).find(i => i.id === Number(item_id));
    if (!item) return res.status(404).json({ error: '物資不存在' });
    const nb = Number(new_balance);
    if (!Number.isFinite(nb) || nb < 0) return res.status(400).json({ error: '目標庫存必須為非負數' });
    const stock = await computeStock();
    const cur = stock.find(s => s.id === item.id);
    const current = cur ? cur.balance : 0;
    const diff = nb - current;
    if (diff === 0) return res.json({ success: true, adjusted: false, record: null });

    const admins = await loadJSON('admins.json', []);
    const admin = admins.find(a => a.id === req.session.user_id);
    const tx = await loadJSON(WH_TX, []);
    const nextTxId = tx.length ? Math.max(...tx.map(t => t.id)) + 1 : 1;
    const type = diff > 0 ? 'in' : 'out';
    const record = {
      id: nextTxId,
      item_id: item.id,
      item_name: item.name,
      category: item.category,
      type,
      qty: Math.abs(diff),
      emp_id: req.session.user_id,
      emp_name: admin ? admin.username : 'admin',
      car_no: '',
      remark: `庫存調整：由 ${current} → ${nb}`,
      created_at: nowStr()
    };
    tx.push(record);
    await saveJSON(WH_TX, tx);
    res.json({ success: true, adjusted: true, record });
  } catch (e) {
    res.status(500).json({ success: false, error: '調整失敗' });
  }
});

// Admin: delete a single transaction (stock recomputes automatically)
app.delete('/api/admin/warehouse/transactions/:id', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tx = await loadJSON(WH_TX, []);
    const filtered = tx.filter(t => t.id !== id);
    if (filtered.length === tx.length) return res.status(404).json({ error: '交易不存在' });
    await saveJSON(WH_TX, filtered);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '刪除失敗' });
  }
});

app.get('/api/admin/warehouse/transactions', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  res.json((await loadJSON(WH_TX, [])).sort((a, b) => b.id - a.id));
});

app.get('/api/admin/warehouse/stock', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  res.json(await computeStock());
});

app.get('/api/admin/warehouse/export', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const tx = await loadJSON(WH_TX, []);
    const items = await loadJSON(WH_ITEMS, []);
    const itemMap = {}; items.forEach(i => itemMap[i.id] = i);
    const stock = await computeStock();
    const balMap = {}; stock.forEach(s => balMap[s.id] = s.balance);
    const header = ['交易編號','物資名稱','分類','類型','數量','單位','技術員','車號','備註','現有存量','日期'];
    const buildRows = (data) => data.slice().sort((a, b) => b.id - a.id).map(t => {
      const it = itemMap[t.item_id] || {};
      const type = t.type === 'in' ? '入倉' : '出倉';
      const bal = balMap[t.item_id] != null ? balMap[t.item_id] + ' ' + (it.unit || '') : '';
      return [t.id, t.item_name, t.category || '', type, t.qty, it.unit || '', t.emp_name, t.car_no || '', t.remark, bal, t.created_at];
    });

    const wb = XLSX.utils.book_new();

    // All transactions
    const allRows = buildRows(tx);
    const allWs = XLSX.utils.aoa_to_sheet([header, ...allRows]);
    XLSX.utils.book_append_sheet(wb, allWs, '全部');

    // One sheet per category
    const cats = [...new Set(tx.map(t => t.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    for (const cat of cats) {
      const catRows = buildRows(tx.filter(t => t.category === cat));
      const ws = XLSX.utils.aoa_to_sheet([header, ...catRows]);
      const safeName = cat.replace(/[\\/*?:[\]]/g, '_').substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, safeName);
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="warehouse_transactions.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ success: false, error: '匯出失敗' });
  }
});

// ===== COMMISSION (銷售佣金) ROUTES =====
const COMM_FILE = 'commission_records.json';
const COMM_SALE_RATE = 25;      // 銷售一件 $25
const COMM_INSTALL_RATE = 20;   // 安裝一件額外 $20
const COMM_PCT = 0.30;          // 佣金 = 全隊總額 30%

// ===== TECH LEAD (服務銷售佣金) ROUTES =====
const LEAD_FILE = 'tech_leads.json';
// Fixed service types the technician can pick. `蚊燈` and `Others` are special:
// 蚊燈 carries an embedded quantity (`蚊燈×3`), Others allows free text (`Others: text`).
const LEAD_SERVICE_KEYS = ['Aircon Cleaning', 'Bedbug', 'Disinfection', 'In2care', 'Pest control', 'Rodent', 'Sentricon', 'Termite control', '蚊燈', 'Others'];

// Accepts:
//   1) exact service key (e.g. 'Pest control', 'Termite control')
//   2) '蚊燈×<positive int>' (quantity is required when 蚊燈 is chosen)
//   3) 'Others: <text>' (free text after the colon)
// Anything else is rejected by the validator.
function isValidLeadService(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (LEAD_SERVICE_KEYS.includes(t)) return true;
  if (/^蚊燈×[1-9]\d*$/.test(t)) return true;
  if (/^Others:\s*\S+/.test(t)) return true;
  return false;
}

// Employee: create a tech-lead record (sales referral by technician)
app.post('/api/tech-leads/records', authRequired('employee'), async (req, res) => {
  try {
    const { record_date, customer_name, customer_phone, customer_address, services, notes, members, customer_code } = req.body || {};
    if (!record_date || !/^\d{4}-\d{2}-\d{2}$/.test(record_date)) return res.status(400).json({ error: '請選擇有效日期' });
    const custName = (customer_name == null ? '' : String(customer_name)).trim();
    if (!custName) return res.status(400).json({ error: '請填寫客戶姓名' });
    // 客戶編號 optional：trim + strip leading '#'
    const custCode = (customer_code == null ? '' : String(customer_code)).trim().replace(/^#+/, '').slice(0, 20);
    // 服務 chip 至少 1 個，必須係 10 個固定選項 + 蚊燈×N + Others: text
    const svcArr = Array.isArray(services) ? services.filter(isValidLeadService) : [];
    if (svcArr.length === 0) return res.status(400).json({ error: '請選擇至少一項服務' });
    // 隊員 1-3 名，去重複，必須有效 emp_id
    const employees = await loadJSON('employees.json', []);
    const empIdSet = new Set(employees.map(e => e.id));
    let memArr = Array.isArray(members) ? members : [];
    if (memArr.length < 1 || memArr.length > 3) return res.status(400).json({ error: '隊員數量需為 1-3 名' });
    const cleanedMembers = [];
    const seen = new Set();
    for (const m of memArr) {
      const id = parseInt(m && m.emp_id);
      if (!id || !empIdSet.has(id)) return res.status(400).json({ error: '隊員必須為有效員工' });
      if (seen.has(id)) return res.status(400).json({ error: '隊員不可重複' });
      seen.add(id);
      const emp = employees.find(e => e.id === id);
      cleanedMembers.push({ emp_id: id, emp_name: emp ? emp.name : '' });
    }
    const me = employees.find(e => e.id === req.session.user_id);
    const records = await loadJSON(LEAD_FILE, []);
    const nextId = records.length ? Math.max(...records.map(r => r.id)) + 1 : 1;
    const record = {
      id: nextId,
      record_date,
      customer_code: custCode,
      customer_name: custName,
      customer_phone: (customer_phone == null ? '' : String(customer_phone)).trim(),
      customer_address: (customer_address == null ? '' : String(customer_address)).trim(),
      services: svcArr,
      members: cleanedMembers,
      notes: (notes == null ? '' : String(notes)).trim(),
      created_by_emp_id: me ? me.id : null,
      created_by_emp_name: me ? me.name : 'unknown',
      created_at: nowStr()
    };
    records.push(record);
    await saveJSON(LEAD_FILE, records);
    res.json({ success: true, record });
  } catch (e) {
    res.status(500).json({ success: false, error: '記錄失敗' });
  }
});

// Employee: list own lead records
app.get('/api/tech-leads/records', authRequired('employee'), async (req, res) => {
  const records = await loadJSON(LEAD_FILE, []);
  const myId = req.session.user_id;
  const mine = records.filter(r => r.created_by_emp_id === myId).sort((a, b) => b.id - a.id);
  res.json(mine);
});

// Employee: delete own lead within 24h
app.delete('/api/tech-leads/records/:id', authRequired('employee'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const employees = await loadJSON('employees.json', []);
    const emp = employees.find(e => e.id === req.session.user_id);
    if (!emp) return res.status(401).json({ error: '員工資料不存在' });
    const records = await loadJSON(LEAD_FILE, []);
    const idx = records.findIndex(r => r.id === id);
    if (idx < 0) return res.status(404).json({ success: false, error: '記錄不存在' });
    if (records[idx].created_by_emp_id !== emp.id) return res.status(403).json({ success: false, error: '只可以刪除自己記錄的單' });
    const created = new Date((records[idx].created_at || '').replace(' ', 'T') + '+08:00');
    if (isNaN(created.getTime()) || Date.now() - created.getTime() > 24 * 3600 * 1000) {
      return res.status(403).json({ success: false, error: '超過 24 小時，不可刪除，請聯絡管理員' });
    }
    records.splice(idx, 1);
    await saveJSON(LEAD_FILE, records);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '刪除失敗' });
  }
});

// Admin: list all lead records (with year/month filter)
app.get('/api/admin/tech-leads/records', authRequired('admin'), requirePermission('leads'), async (req, res) => {
  const { month, year } = req.query;
  let records = await loadJSON(LEAD_FILE, []);
  if (month) records = records.filter(r => (r.record_date || '').startsWith(`${year || new Date().getFullYear()}-${String(month).padStart(2, '0')}`));
  else if (year) records = records.filter(r => (r.record_date || '').startsWith(String(year)));
  res.json(records.sort((a, b) => b.id - a.id));
});

// Admin: delete any lead record
app.delete('/api/admin/tech-leads/records/:id', authRequired('admin'), requirePermission('leads'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const records = await loadJSON(LEAD_FILE, []);
    const idx = records.findIndex(r => r.id === id);
    if (idx < 0) return res.status(404).json({ success: false, error: '記錄不存在' });
    records.splice(idx, 1);
    await saveJSON(LEAD_FILE, records);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '刪除失敗' });
  }
});

// Admin: export leads to Excel (single sheet)
app.get('/api/admin/tech-leads/export', authRequired('admin'), requirePermission('leads'), async (req, res) => {
  try {
    const { month, year } = req.query;
    const y = year ? parseInt(year) : new Date().getFullYear();
    const m = month ? String(month).padStart(2, '0') : null;
    let records = await loadJSON(LEAD_FILE, []);
    if (m) records = records.filter(r => (r.record_date || '').startsWith(`${y}-${m}`));
    else records = records.filter(r => (r.record_date || '').startsWith(String(y)));
    records.sort((a, b) => b.id - a.id);
    const wb = XLSX.utils.book_new();
    const header = ['記錄編號', '日期', '客戶編號', '隊員', '客戶姓名', '客戶電話', '客戶地址', '服務類型', '備註'];
    const rows = records.map(r => {
      const svc = (r.services || []).join('、');
      const svcAll = r.custom_service ? (svc ? svc + '、' + r.custom_service : r.custom_service) : (svc || '—');
      const mem = (r.members || []).map(m => m.emp_name).join('、') || '—';
      const custCode = r.customer_code ? '#' + r.customer_code : '';
      return [r.id, r.record_date, custCode, mem, r.customer_name, r.customer_phone, r.customer_address, svcAll, r.notes];
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), '服務銷售記錄');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tech_leads_${y}${m ? ('_' + m) : ''}.xlsx"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ success: false, error: '匯出失敗' });
  }
});

// Employee: list all employees (for team-member picker)
app.get('/api/commission/employees', authRequired('employee'), async (req, res) => {
  const employees = await loadJSON('employees.json', []);
  const list = employees
    .map(e => ({ id: e.id, name: e.name, emp_number: e.emp_number, group_name: e.group_name || '' }))
    .sort((a, b) => String(a.emp_number).localeCompare(String(b.emp_number)));
  res.json(list);
});

// Compute commission breakdown on the server (never trust client totals)
function computeCommission(members) {
  const subtotals = members.map(m => {
    const sales = Math.max(0, parseInt(m.sales) || 0);
    const installs = Math.max(0, parseInt(m.installs) || 0);
    return {
      emp_id: m.emp_id,
      emp_name: m.emp_name,
      sales,
      installs,
      subtotal: sales * COMM_SALE_RATE + installs * COMM_INSTALL_RATE
    };
  });
  const total_amount = subtotals.reduce((s, x) => s + x.subtotal, 0);
  const total_commission = Math.round(total_amount * COMM_PCT * 100) / 100;
  const per_person = subtotals.length ? Math.round((total_commission / subtotals.length) * 100) / 100 : 0;
  return { subtotals, total_amount, total_commission, per_person };
}

// Employee: create a team sales record
app.post('/api/commission/records', authRequired('employee'), async (req, res) => {
  try {
    const { record_date, customer_code, members } = req.body || {};
    if (!record_date || !/^\d{4}-\d{2}-\d{2}$/.test(record_date)) return res.status(400).json({ error: '請選擇有效日期' });
    if (!Array.isArray(members) || members.length < 2 || members.length > 3) return res.status(400).json({ error: '隊員必須 2 至 3 人' });
    // 客戶編號可選,自動 trim 及去掉開頭 # / 空白
    const custCode = (customer_code == null ? '' : String(customer_code)).trim().replace(/^#+/, '').trim();
    const employees = await loadJSON('employees.json', []);
    const seen = new Set();
    const resolved = [];
    for (const m of members) {
      const emp = employees.find(e => e.id === Number(m.emp_id));
      if (!emp) return res.status(400).json({ error: '隊員不存在' });
      if (seen.has(emp.id)) return res.status(400).json({ error: '隊員不可重複' });
      seen.add(emp.id);
      resolved.push({ emp_id: emp.id, emp_name: emp.name, sales: Math.max(0, parseInt(m.sales) || 0), installs: Math.max(0, parseInt(m.installs) || 0) });
    }
    const me = employees.find(e => e.id === req.session.user_id);
    const calc = computeCommission(resolved);
    const records = await loadJSON(COMM_FILE, []);
    const nextId = records.length ? Math.max(...records.map(r => r.id)) + 1 : 1;
    const record = {
      id: nextId,
      record_date,
      customer_code: custCode,
      created_by_emp_id: me ? me.id : null,
      created_by_emp_name: me ? me.name : 'unknown',
      rate_sale: COMM_SALE_RATE,
      rate_install: COMM_INSTALL_RATE,
      commission_pct: COMM_PCT,
      members: calc.subtotals,
      total_amount: calc.total_amount,
      total_commission: calc.total_commission,
      per_person_commission: calc.per_person,
      created_at: nowStr()
    };
    records.push(record);
    await saveJSON(COMM_FILE, records);
    res.json({ success: true, record });
  } catch (e) {
    res.status(500).json({ success: false, error: '記錄失敗' });
  }
});

// Employee: list own records (where I am a member)
app.get('/api/commission/records', authRequired('employee'), async (req, res) => {
  const records = await loadJSON(COMM_FILE, []);
  const myId = req.session.user_id;
  const mine = records.filter(r => (r.members || []).some(m => m.emp_id === myId)).sort((a, b) => b.id - a.id);
  res.json(mine);
});

// Employee: delete own record within 24h
app.delete('/api/commission/records/:id', authRequired('employee'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const employees = await loadJSON('employees.json', []);
    const emp = employees.find(e => e.id === req.session.user_id);
    if (!emp) return res.status(401).json({ error: '員工資料不存在' });
    const records = await loadJSON(COMM_FILE, []);
    const idx = records.findIndex(r => r.id === id);
    if (idx < 0) return res.status(404).json({ success: false, error: '記錄不存在' });
    if (records[idx].created_by_emp_id !== emp.id) return res.status(403).json({ success: false, error: '只可以刪除自己記錄的單' });
    const created = new Date((records[idx].created_at || '').replace(' ', 'T') + '+08:00');
    if (isNaN(created.getTime()) || Date.now() - created.getTime() > 24 * 3600 * 1000) {
      return res.status(403).json({ success: false, error: '超過 24 小時，不可刪除，請聯絡管理員' });
    }
    records.splice(idx, 1);
    await saveJSON(COMM_FILE, records);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '刪除失敗' });
  }
});

// ===== ADMIN COMMISSION ROUTES =====
app.get('/api/admin/commission/records', authRequired('admin'), requirePermission('commission'), async (req, res) => {
  const { month, year } = req.query;
  let records = await loadJSON(COMM_FILE, []);
  if (month) records = records.filter(r => (r.record_date || '').startsWith(`${year || new Date().getFullYear()}-${String(month).padStart(2, '0')}`));
  else if (year) records = records.filter(r => (r.record_date || '').startsWith(String(year)));
  res.json(records.sort((a, b) => b.id - a.id));
});

app.delete('/api/admin/commission/records/:id', authRequired('admin'), requirePermission('commission'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const records = await loadJSON(COMM_FILE, []);
    const idx = records.findIndex(r => r.id === id);
    if (idx < 0) return res.status(404).json({ success: false, error: '記錄不存在' });
    records.splice(idx, 1);
    await saveJSON(COMM_FILE, records);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '刪除失敗' });
  }
});

// Monthly report: per-employee accumulated commission
app.get('/api/admin/commission/report', authRequired('admin'), requirePermission('commission'), async (req, res) => {
  const { month, year } = req.query;
  const y = year ? parseInt(year) : new Date().getFullYear();
  const m = month ? String(month).padStart(2, '0') : null;
  let records = await loadJSON(COMM_FILE, []);
  if (m) records = records.filter(r => (r.record_date || '').startsWith(`${y}-${m}`));
  else records = records.filter(r => (r.record_date || '').startsWith(String(y)));

  const perEmp = {};
  let teamSales = 0, teamInstalls = 0, teamSubtotal = 0, teamCommission = 0;
  for (const r of records) {
    teamSales += r.members.reduce((s, x) => s + x.sales, 0);
    teamInstalls += r.members.reduce((s, x) => s + x.installs, 0);
    teamSubtotal += r.total_amount;
    teamCommission += r.total_commission;
    for (const mem of r.members) {
      if (!perEmp[mem.emp_id]) perEmp[mem.emp_id] = { emp_id: mem.emp_id, emp_name: mem.emp_name, sales: 0, installs: 0, subtotal: 0, commission: 0 };
      perEmp[mem.emp_id].sales += mem.sales;
      perEmp[mem.emp_id].installs += mem.installs;
      perEmp[mem.emp_id].subtotal += mem.subtotal;
      perEmp[mem.emp_id].commission += r.per_person_commission;
    }
  }
  const rows = Object.values(perEmp).map(e => ({ ...e, commission: Math.round(e.commission * 100) / 100 }))
    .sort((a, b) => b.commission - a.commission);
  res.json({ rows, team: { sales: teamSales, installs: teamInstalls, subtotal: Math.round(teamSubtotal * 100) / 100, commission: Math.round(teamCommission * 100) / 100 } });
});

// Export to Excel
app.get('/api/admin/commission/export', authRequired('admin'), requirePermission('commission'), async (req, res) => {
  try {
    const { month, year } = req.query;
    const y = year ? parseInt(year) : new Date().getFullYear();
    const m = month ? String(month).padStart(2, '0') : null;
    let records = await loadJSON(COMM_FILE, []);
    if (m) records = records.filter(r => (r.record_date || '').startsWith(`${y}-${m}`));
    else records = records.filter(r => (r.record_date || '').startsWith(String(y)));
    records.sort((a, b) => b.id - a.id);

    const wb = XLSX.utils.book_new();
    const header = ['記錄編號', '日期', '客戶編號', '入數人', '隊員', '銷售件數', '安裝件數', '小計', '每人應得佣金', '全隊總額', '全隊總佣金'];
    const rows = [];
    for (const r of records) {
      for (const mem of r.members) {
        rows.push([r.id, r.record_date, r.customer_code ? '#' + r.customer_code : '', r.created_by_emp_name, mem.emp_name, mem.sales, mem.installs, mem.subtotal, r.per_person_commission, r.total_amount, r.total_commission]);
      }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), '所有記錄');

    const perEmp = {};
    for (const r of records) for (const mem of r.members) {
      if (!perEmp[mem.emp_id]) perEmp[mem.emp_id] = { emp_name: mem.emp_name, sales: 0, installs: 0, subtotal: 0, commission: 0 };
      perEmp[mem.emp_id].sales += mem.sales;
      perEmp[mem.emp_id].installs += mem.installs;
      perEmp[mem.emp_id].subtotal += mem.subtotal;
      perEmp[mem.emp_id].commission += r.per_person_commission;
    }
    const sumRows = Object.values(perEmp).map(e => ({ ...e, commission: Math.round(e.commission * 100) / 100 })).sort((a, b) => b.commission - a.commission)
      .map(e => [e.emp_name, e.sales, e.installs, e.subtotal, e.commission]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['隊員', '總銷售件數', '總安裝件數', '總小計', '累計應得佣金'], ...sumRows]), '每人匯總');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="commission_report_${y}${m ? ('_' + m) : ''}.xlsx"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ success: false, error: '匯出失敗' });
  }
});

// ===== VEHICLE (車號) ROUTES =====
// Employee: read vehicle list for out-transaction picker
app.get('/api/warehouse/vehicles', authRequired('employee'), async (req, res) => {
  res.json(await ensureDefaultVehicles());
});

// Admin: list vehicles
app.get('/api/admin/warehouse/vehicles', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  res.json(await ensureDefaultVehicles());
});

// Admin: add vehicle
app.post('/api/admin/warehouse/vehicles', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || !code.trim()) return res.status(400).json({ error: '請填寫車號' });
    const clean = code.trim();
    const vehicles = await ensureDefaultVehicles();
    if (vehicles.find(v => v.code === clean)) return res.status(400).json({ error: '車號已存在' });
    const nextId = vehicles.length ? Math.max(...vehicles.map(v => v.id)) + 1 : 1;
    vehicles.push({ id: nextId, code: clean });
    await saveJSON(WH_VEHICLES, vehicles);
    res.json({ success: true, vehicle: { id: nextId, code: clean } });
  } catch (e) {
    res.status(500).json({ success: false, error: '新增車號失敗' });
  }
});

// Admin: rename vehicle
app.put('/api/admin/warehouse/vehicles/:id', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { code } = req.body || {};
    if (!code || !code.trim()) return res.status(400).json({ error: '請填寫車號' });
    const clean = code.trim();
    const vehicles = await ensureDefaultVehicles();
    const v = vehicles.find(x => x.id === id);
    if (!v) return res.status(404).json({ error: '車號不存在' });
    if (vehicles.find(x => x.code === clean && x.id !== id)) return res.status(400).json({ error: '車號已存在' });
    v.code = clean;
    await saveJSON(WH_VEHICLES, vehicles);
    res.json({ success: true, vehicle: v });
  } catch (e) {
    res.status(500).json({ success: false, error: '修改失敗' });
  }
});

// Admin: delete vehicle
app.delete('/api/admin/warehouse/vehicles/:id', authRequired('admin'), requirePermission('warehouse'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const vehicles = await ensureDefaultVehicles();
    await saveJSON(WH_VEHICLES, vehicles.filter(v => v.id !== id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '刪除失敗' });
  }
});

// Serve frontend pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/exam', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Export for Vercel serverless
module.exports = app;

// Migration: grant all permissions to existing non-super admins that lack the field.
(async () => {
  try { await migrateAdminPermissions(); } catch (e) { console.error('migrateAdminPermissions error:', e.message); }
})();

// Start server locally only (not on Vercel)
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`BIOCYCLE Exam System running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Employee exam: http://localhost:${PORT}`);
  });
}
