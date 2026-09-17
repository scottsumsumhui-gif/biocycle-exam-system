const https = require('https');
const BASE = 'https://biocycle-exam-system-production.up.railway.app';
function req(m, p, b, c) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const h = { 'Content-Type': 'application/json' };
    if (c) h['Cookie'] = c;
    const r = https.request(BASE + p, { method: m, headers: h }, x => {
      let s = ''; x.on('data', y => s += y); x.on('end', () => res({ code: x.statusCode, cookie: x.headers['set-cookie'], body: s }));
    });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const sleep = ms => new Promise(r => { const t = Date.now(); while (Date.now() - t < ms) {} });

(async () => {
  // wait for deploy
  console.log('--- waiting for deploy (75s) ---');
  sleep(75000);
  console.log('HEALTH', (await req('GET', '/api/health')).body.slice(0, 80));

  // admin login
  const l = await req('POST', '/api/auth/admin-login', { username: 'ST140', password: '61583398' });
  const c = l.cookie && l.cookie[0].split(';')[0];
  console.log('ADMIN LOGIN', l.code, c ? 'cookie ok' : 'NO COOKIE');
  if (!c) { console.log(l.body); return; }

  // seed check
  const qa = j((await req('GET', '/api/admin/quiz/questions', null, c)).body);
  console.log('ADMIN questions count =', qa.questions.length, '| has answer field?', qa.questions[0] && !!qa.questions[0].answer);
  const ra = j((await req('GET', '/api/admin/quiz/records', null, c)).body);
  console.log('ADMIN records count (before) =', ra.total);

  // employee login ST411
  const el = await req('POST', '/api/auth/employee-login', { empNumber: 'ST411', password: '0000' });
  const ec = el.cookie && el.cookie[0].split(';')[0];
  console.log('EMP LOGIN ST411', el.code, ec ? 'ok' : 'NO');
  if (!ec) { console.log(el.body); return; }

  const eq = j((await req('GET', '/api/quiz/questions', null, ec)).body);
  console.log('EMP questions: taken=', eq.taken, 'total=', eq.total, '| answer leaked?', eq.questions[0] && 'answer' in eq.questions[0]);

  // submit all 'A'
  const ans = {}; eq.questions.forEach(q => ans[q.id] = 'A');
  const sub = j((await req('POST', '/api/quiz/submit', { answers: ans }, ec)).body);
  console.log('EMP submit (all A):', JSON.stringify(sub));

  // taken now true
  const eq2 = j((await req('GET', '/api/quiz/questions', null, ec)).body);
  console.log('EMP questions after submit: taken=', eq2.taken);
  const rec = j((await req('GET', '/api/quiz/record', null, ec)).body);
  console.log('EMP record: correct=', rec.record.correct, '/', rec.record.total, '| details=', rec.details.length, '| first detail correct?', rec.details[0] && rec.details[0].correctAnswer);

  // resubmit should 403
  const sub2 = await req('POST', '/api/quiz/submit', { answers: ans }, ec);
  console.log('EMP resubmit status =', sub2.code, '(expect 403)');

  // admin sees record
  const ra2 = j((await req('GET', '/api/admin/quiz/records', null, c)).body);
  console.log('ADMIN records count (after) =', ra2.total, '| first =', ra2.records[0] && (ra2.records[0].emp_number + ' ' + ra2.records[0].correct + '/' + ra2.records[0].total));

  // question CRUD: add, update, delete
  const addR = j((await req('POST', '/api/admin/quiz/questions', { category: '邏輯推理', question: '測試題：1+1=?', options: [{ key: 'A', text: '2' }, { key: 'B', text: '3' }, { key: 'C', text: '4' }, { key: 'D', text: '5' }], answer: 'A', explanation: 'x' }, c)).body);
  console.log('ADD question success=', addR.success, 'id=', addR.question && addR.question.id);
  const newId = addR.question && addR.question.id;
  const updR = j((await req('PUT', '/api/admin/quiz/questions/' + newId, { category: '數字推理', question: '測試題改：2+2=?', options: [{ key: 'A', text: '2' }, { key: 'B', text: '4' }, { key: 'C', text: '4' }, { key: 'D', text: '5' }], answer: 'B' }, c)).body);
  console.log('UPDATE question success=', updR.success, '| cat=', updR.question && updR.question.category, '| ans=', updR.question && updR.question.answer);
  const delR = j((await req('DELETE', '/api/admin/quiz/questions/' + newId, null, c)).body);
  console.log('DELETE question success=', delR.success);
  const qa2 = j((await req('GET', '/api/admin/quiz/questions', null, c)).body);
  console.log('ADMIN questions count after CRUD =', qa2.questions.length, '(expect 20)');

  // export csv
  const exp = await req('GET', '/api/admin/quiz/export', null, c);
  console.log('EXPORT csv status=', exp.code, '| type=', exp.headers ? 'csv' : '', '| bytes=', exp.body.length);

  console.log('=== E2E DONE ===');
})();
