// 本地單元測試：mailer.js 三條 transport（Brevo / SendGrid / SMTP）切換 + payload 格式
// 全部用 mock fetch，唔會真係寄信、唔需要網絡。跑法：node scripts/brevo_mailer_test.js
const assert = require('assert');

const MAILER = require.resolve('../mailer');
const KEYS = [
  'MAIL_PROVIDER', 'BREVO_API_KEY', 'SENDGRID_API_KEY',
  'SMTP_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE'
];

let calls = [];
function fresh(env) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env || {});
  delete require.cache[MAILER];
  return require(MAILER);
}
function mockFetch(handler) {
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body || '{}') });
    return handler(url, opts);
  };
}
const jsonRes = (status, body) => ({ status, async json() { return body; } });

const BASE = {
  MAIL_PROVIDER: 'brevo',
  BREVO_API_KEY: 'xkeysib-test-key',
  SMTP_FROM: 'BIOCYCLE OPERATION SYSTEM <sum@biokill.hk>'
};

async function run() {
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };

  // 1. Brevo 成功：URL / header / sender / 多收件人 / 只落 htmlContent
  {
    const m = fresh(BASE);
    mockFetch(() => jsonRes(201, { messageId: 'abc@relay' }));
    const r = await m.sendMail({
      to: ['sum@biocycle.com.hk', 'ryan@biocycle.hk'],
      subject: '【佣金申請】測試', html: '<p>Hello</p>', text: 'Hello'
    });
    check('Brevo 成功回 success + via + messageId', () => {
      assert.strictEqual(r.success, true);
      assert.strictEqual(r.via, 'brevo-api');
      assert.strictEqual(r.messageId, 'abc@relay');
      assert.deepStrictEqual(r.to, ['sum@biocycle.com.hk', 'ryan@biocycle.hk']);
      assert.strictEqual(calls.length, 1);
    });
    check('Brevo URL / api-key header 正確', () => {
      assert.strictEqual(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
      assert.strictEqual(calls[0].opts.method, 'POST');
      assert.strictEqual(calls[0].opts.headers['api-key'], 'xkeysib-test-key');
      assert.strictEqual(calls[0].opts.headers['Content-Type'], 'application/json');
    });
    check('Brevo payload：sender 拆名＋電郵、to 陣列、只用 htmlContent', () => {
      const b = calls[0].body;
      assert.deepStrictEqual(b.sender, { email: 'sum@biokill.hk', name: 'BIOCYCLE OPERATION SYSTEM' });
      assert.deepStrictEqual(b.to, [{ email: 'sum@biocycle.com.hk' }, { email: 'ryan@biocycle.hk' }]);
      assert.strictEqual(b.subject, '【佣金申請】測試');
      assert.strictEqual(b.htmlContent, '<p>Hello</p>');
      assert.strictEqual('textContent' in b, false);
    });
  }

  // 2. 得純文字 → textContent
  {
    const m = fresh(BASE);
    mockFetch(() => jsonRes(201, { messageId: 'x' }));
    await m.sendMail({ to: 'a@b.com', subject: 's', text: 'plain text' });
    check('純文字信用 textContent，唔送 htmlContent', () => {
      assert.strictEqual(calls[0].body.textContent, 'plain text');
      assert.strictEqual('htmlContent' in calls[0].body, false);
    });
  }

  // 3. 寄件人無效 → 略過，唔好打 API
  {
    const m = fresh(Object.assign({}, BASE, { SMTP_FROM: 'apikey' }));
    mockFetch(() => jsonRes(201, { messageId: 'x' }));
    const r = await m.sendMail({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    check('SMTP_FROM 無效 → skipped invalid-from，0 次 API', () => {
      assert.strictEqual(r.skipped, true);
      assert.strictEqual(r.reason, 'invalid-from');
      assert.strictEqual(calls.length, 0);
    });
  }

  // 4. API 401 → 回 success:false + 清楚 error，唔 throw
  {
    const m = fresh(BASE);
    mockFetch(() => jsonRes(401, { code: 'unauthorized', message: 'Key not found' }));
    const r = await m.sendMail({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    check('Brevo 401 → success:false + error 有 code/message', () => {
      assert.strictEqual(r.success, false);
      assert.ok(/Brevo API 401/.test(r.error));
      assert.ok(/Key not found/.test(r.error));
    });
  }

  // 5. fetch 本身 throw → 都唔好 throw 出主流程
  {
    const m = fresh(BASE);
    mockFetch(() => { throw new Error('network boom'); });
    const r = await m.sendMail({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    check('network throw → 只回 success:false，唔炸 server', () => {
      assert.strictEqual(r.success, false);
      assert.ok(/network boom/.test(r.error));
    });
  }

  // 6. 無有效收件人 → skipped
  {
    const m = fresh(BASE);
    mockFetch(() => jsonRes(201, { messageId: 'x' }));
    const r = await m.sendMail({ to: ['not-an-email'], subject: 's', html: '<p>x</p>' });
    check('無有效收件人 → skipped no-recipient，0 次 API', () => {
      assert.strictEqual(r.skipped, true);
      assert.strictEqual(r.reason, 'no-recipient');
      assert.strictEqual(calls.length, 0);
    });
  }

  // 7. provider 路由
  {
    const m = fresh({ MAIL_PROVIDER: 'auto', BREVO_API_KEY: 'k1', SENDGRID_API_KEY: 'k2', SMTP_FROM: 'sys@x.com' });
    mockFetch(() => jsonRes(201, { messageId: 'x' }));
    check('auto + 兩個 key → 揀 Brevo', () => assert.strictEqual(m.activeProvider(), 'brevo'));
    const r = await m.sendMail({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    check('auto 實際寄信都行 Brevo', () => {
      assert.strictEqual(r.via, 'brevo-api');
      assert.ok(/api\.brevo\.com/.test(calls[0].url));
    });
  }
  {
    const m = fresh({ MAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'SG.test', SMTP_FROM: 'sys@x.com' });
    mockFetch(() => jsonRes(202, {}));
    const r = await m.sendMail({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    check('MAIL_PROVIDER=sendgrid → 仍然行 SendGrid，行為不變', () => {
      assert.strictEqual(r.via, 'sendgrid-api');
      assert.ok(/api\.sendgrid\.com/.test(calls[0].url));
      assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer SG.test');
    });
  }
  {
    const m = fresh({ MAIL_PROVIDER: 'brevo', SMTP_FROM: 'sys@x.com' });
    mockFetch(() => jsonRes(201, { messageId: 'x' }));
    const r = await m.sendMail({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    check('強制 brevo 但無 key → skipped brevo-not-configured', () => {
      assert.strictEqual(r.skipped, true);
      assert.strictEqual(r.reason, 'brevo-not-configured');
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(m.isConfigured(), false);
    });
  }
  {
    const m = fresh({});
    mockFetch(() => jsonRes(201, { messageId: 'x' }));
    const r = await m.sendMail({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    check('零設定 → auto=smtp，靜默略過，唔寄信', () => {
      assert.strictEqual(m.activeProvider(), 'smtp');
      assert.strictEqual(m.isConfigured(), false);
      assert.strictEqual(r.skipped, true);
      assert.strictEqual(calls.length, 0);
    });
  }

  console.log('\n' + passed + '/' + passed + ' PASS');
}

run().catch(e => { console.error('FAIL', e); process.exitCode = 1; });
