// =====================================================================
//  mailer.js — 系統內部電郵通知（SendGrid Web API / SMTP）
//
//  ⚠️ 設計原則：env-gated + 永不阻住主流程
//   - 未設定任何寄信環境變數 → sendMail() 直接略過（回 {skipped:true}）
//   - nodemailer 未安裝 → 一樣略過，唔會令 server 開唔到
//   - 發送失敗只 log，唔 throw（佣金提交等主流程唔可以因為電郵踼親而失敗）
//
//  寄信方式（揀一種）：
//  【A. SendGrid Web API（推薦，HTTPS 443，Railway 一定通）】
//   SENDGRID_API_KEY   SG.xxxxx（Restricted Access, Mail Send Full Access）
//   SMTP_FROM          顯示嘅寄件人，e.g. "BIOCYCLE 系統 <noreply@biocycle.hk>"（必須已驗證）
//  【B. SMTP（某些 host 對外 587/465 會 timeout，例如 Railway→SendGrid）】
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
// =====================================================================

// 懶加载：模組唔喺度都唔會拖垮 server
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isConfigured() {
  return !!(process.env.SENDGRID_API_KEY || (nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));
}

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: String(process.env.SMTP_SECURE || '') === 'true' || port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Railway 有時 DNS/IPv6 會慢，設個合理 timeout 避免 request 吊住
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  return _transporter;
}

function parseFrom() {
  const rawFrom = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  const angle = /<([^>]+)>/.exec(rawFrom); // 支援 "BIOCYCLE 系統 <noreply@biocycle.hk>" 格式
  const fromAddr = angle ? angle[1].trim() : rawFrom;
  return { rawFrom, fromAddr, valid: EMAIL_RE.test(fromAddr) };
}

// SendGrid v3 Web API（HTTPS 443）— Railway 對外 443 一定通，避開 SMTP timeout
async function sendViaSendGridApi(toList, subject, html, text) {
  const { rawFrom, fromAddr, valid } = parseFrom();
  if (!valid) {
    console.error('[mailer] SENDGRID_API_KEY 已設但 SMTP_FROM 唔係有效電郵（現時係 "' + rawFrom + '"）。已略過發送。');
    return { skipped: true, reason: 'invalid-from' };
  }
  const nameMatch = /^(.*?)\s*<[^>]+>\s*$/.exec(rawFrom);
  const from = { email: fromAddr };
  if (nameMatch && nameMatch[1].trim()) from.name = nameMatch[1].trim();
  const content = [];
  if (html) content.push({ type: 'text/html', value: html });
  if (text) content.push({ type: 'text/plain', value: text });
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: toList.map(e => ({ email: e })) }],
      from,
      subject: subject || '(無主題)',
      content
    })
  });
  if (res.status >= 200 && res.status < 300) {
    console.log('[mailer] 已發送（SendGrid Web API）：' + (subject || '') + ' → ' + toList.join(', '));
    return { success: true, via: 'sendgrid-api', to: toList };
  }
  let detail = '';
  try {
    const j = await res.json();
    detail = (j.errors || []).map(e => e.message + (e.field ? ' (' + e.field + ')' : '')).join('; ');
  } catch (e) { /* ignore */ }
  const msg = 'SendGrid API ' + res.status + (detail ? ': ' + detail : '');
  console.error('[mailer] 發送失敗：' + msg);
  return { success: false, error: msg };
}

/**
 * 發送電郵。
 * @param {Object} opts { to: string|string[], subject: string, html: string, text?: string }
 * @returns {Promise<{success?:boolean, skipped?:boolean, reason?:string, error?:string}>}
 */
async function sendMail(opts) {
  const o = opts || {};
  const rawTo = Array.isArray(o.to) ? o.to : [o.to];
  const toList = [...new Set(rawTo.map(x => String(x || '').trim()).filter(x => EMAIL_RE.test(x)))];
  if (toList.length === 0) return { skipped: true, reason: 'no-recipient' };

  // A. SendGrid Web API（優先）
  if (process.env.SENDGRID_API_KEY) {
    try { return await sendViaSendGridApi(toList, o.subject, o.html, o.text); }
    catch (e) {
      console.error('[mailer] 發送失敗：' + (e && e.message ? e.message : e));
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  }

  // B. SMTP
  if (!nodemailer) return { skipped: true, reason: 'nodemailer-not-installed' };
  if (!isConfigured()) {
    console.log('[mailer] SMTP 未設定，略過發送：' + (o.subject || ''));
    return { skipped: true, reason: 'smtp-not-configured' };
  }

  // 寄件人防呆：SendGrid 嘅 SMTP user 係字面 'apikey'，唔係電郵，
  // 所以 SMTP_FROM 一定要係一個已驗證嘅真實電郵，否則 SendGrid 會 550 拒收。
  const { rawFrom, valid } = parseFrom();
  if (!valid) {
    console.error('[mailer] SMTP_FROM 唔係有效電郵（現時係 "' + rawFrom + '"）—— SendGrid 用戶名係 "apikey"，'
      + '必須另外設定 SMTP_FROM 為你喺 SendGrid 驗證過嘅寄件人電郵，否則會被拒收。已略過發送。');
    return { skipped: true, reason: 'invalid-from' };
  }

  try {
    const info = await getTransporter().sendMail({
      from: rawFrom,
      to: toList.join(', '),
      subject: o.subject || '(無主題)',
      html: o.html || undefined,
      text: o.text || undefined
    });
    console.log('[mailer] 已發送：' + (o.subject || '') + ' → ' + toList.join(', '));
    return { success: true, messageId: info && info.messageId, to: toList };
  } catch (e) {
    console.error('[mailer] 發送失敗：' + (e && e.message ? e.message : e));
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { sendMail, isConfigured };
