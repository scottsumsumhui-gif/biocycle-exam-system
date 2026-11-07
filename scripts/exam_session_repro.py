"""真 Chromium 跑 exam-system 前台：重現「交卷彈登入過期」。
模擬 heartbeat 短暫 503 / 真正 401，睇 submitExam() 有冇照樣提交。
唯讀本地測試，唔連 prod。
"""
from playwright.sync_api import sync_playwright
from pathlib import Path
import json

BASE = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\exam-system\public').resolve()
URL = (BASE / 'index.html').as_uri()

INIT = r"""
window.__alerts = [];
window.__calls = [];
window.alert = (m) => { window.__alerts.push(String(m)); };
window.__hbStatus = 503;
window.__submitStatus = 200;
window.__backup = null;
const _realFetch = window.fetch;
window.fetch = async (url, opts) => {
  const u = String(url);
  window.__calls.push(u);
  if (u.includes('/api/auth/heartbeat')) {
    return { ok: window.__hbStatus >= 200 && window.__hbStatus < 300,
             status: window.__hbStatus,
             json: async () => ({ success: false }) };
  }
  if (u.includes('/api/exam/submit')) {
    return { ok: window.__submitStatus >= 200 && window.__submitStatus < 300,
             status: window.__submitStatus,
             json: async () => ({ success: false, error: '__SUBMIT_REACHED__' }) };
  }
  return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
};
"""


def run(case, hb_status, submit_status):
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.add_init_script(INIT)
        pg.goto(URL)
        pg.wait_for_timeout(250)
        pg.evaluate("""([st, sst]) => {
          window.__hbStatus = st;
          window.__submitStatus = sst;
          currentTopicId = 4;
          answers = { mc_1: 0 };
          startTime = Date.now() - 60000;
          timerInterval = null;
          window.showResult = () => { window.__showResultCalled = true; };
          try { localStorage.clear(); } catch(e) {}
        }""", [hb_status, submit_status])
        pg.evaluate("window.__alerts = []; window.__calls = [];")
        pg.evaluate("submitExam()")
        pg.wait_for_timeout(500)
        calls = pg.evaluate("window.__calls")
        alerts = pg.evaluate("window.__alerts")
        backup = pg.evaluate("() => { try { return localStorage.getItem('exam_backup_4'); } catch(e) { return null; } }")
        submitted = any('/api/exam/submit' in c for c in calls)
        b.close()
        return case, hb_status, submit_status, calls, alerts, submitted, bool(backup), errors


CASES = [
    ('A heartbeat 503（短暫抖動，session 其實有效）', 503, 200, True,  False),
    ('B 真正過期（heartbeat 401 + submit 401）',      401, 401, True,  True),
    ('C 完全正常',                                    200, 200, True,  False),
    ('D heartbeat 503 但 submit 都 401',              503, 401, True,  True),
]
ok = 0
for case, hb, sub, want_submit, want_backup in CASES:
    c, h, s, calls, alerts, submitted, backup, errs = run(case, hb, sub)
    passed = (submitted == want_submit and backup == want_backup and not errs)
    ok += passed
    print('===', c, '| hb=%s submit=%s' % (h, s))
    print('  calls:', [x.split('/api/')[-1] for x in calls])
    print('  submitted=%s (expect %s) | backup=%s (expect %s)' % (submitted, want_submit, backup, want_backup))
    print('  alerts:', [a[:48] for a in alerts])
    print('  pageerrors:', errs[:2])
    print('  =>', 'PASS' if passed else 'FAIL')
print('\nRESULT %d/%d PASS' % (ok, len(CASES)))
