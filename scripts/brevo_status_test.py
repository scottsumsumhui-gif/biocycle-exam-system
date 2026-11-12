"""Brevo 切換 — 本機真 server 整合測試（file mode，唯讀診斷 endpoint）。
測試前備份 data/*.json，測試後完整還原；唔連 prod、唔寫 prod、唔寄任何信。

Case:
  1. BREVO_API_KEY + MAIL_PROVIDER=brevo → /api/admin/mail/status 顯示 provider=brevo、configured=true
  2. 零寄信 env → provider=smtp、configured=false（行為同改動前一致）
  3. 超管可讀 status；只得 worktime 權限嘅 admin 仍然 403（權限閘無壞）
"""
import subprocess, time, os, json, shutil, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\exam-system')
OUT = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\outputs')
DATA = ROOT / 'data'
BAK = OUT / '_data_bak_brevo'
BASE = 'http://127.0.0.1:3999'

files = sorted(DATA.glob('*.json'))
if BAK.exists():
    shutil.rmtree(BAK)
BAK.mkdir(parents=True)
for f in files:
    shutil.copy2(f, BAK / f.name)

exp = (datetime.now(timezone(timedelta(hours=8))) + timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S')
(DATA / 'admins.json').write_text(json.dumps([
    {'id': 901, 'username': 'TESTSUPER', 'display_name': 'Test Super', 'password_hash': 'x',
     'is_super': 1, 'permissions': [], 'email': 'super@test.local'},
    {'id': 902, 'username': 'TESTLIMITED', 'display_name': 'Test Limited', 'password_hash': 'x',
     'is_super': 0, 'permissions': ['worktime'], 'email': 'limited@test.local'}
], ensure_ascii=False), encoding='utf-8')
(DATA / 'sessions.json').write_text(json.dumps([
    {'id': 'BREVS', 'user_type': 'admin', 'user_id': 901, 'expires_at': exp},
    {'id': 'BREVL', 'user_type': 'admin', 'user_id': 902, 'expires_at': exp}
], ensure_ascii=False), encoding='utf-8')


def req(cookie):
    r = urllib.request.Request(BASE + '/api/admin/mail/status',
                               headers={'Cookie': 'admin_session_id=' + cookie})
    try:
        resp = urllib.request.urlopen(r, timeout=6)
        return resp.status, json.loads(resp.read().decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        return e.code, {}


def boot(extra):
    env = os.environ.copy()
    env['PORT'] = '3999'
    for k in ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'BREVO_API_KEY',
              'SENDGRID_API_KEY', 'MAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
              'SMTP_PASS', 'SMTP_FROM']:
        env.pop(k, None)
    env.update(extra)
    proc = subprocess.Popen(['node', 'server.js'], cwd=str(ROOT), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(60):
        try:
            if urllib.request.urlopen(BASE + '/api/health', timeout=1).status == 200:
                return proc
        except Exception:
            time.sleep(0.25)
    print('SERVER FAILED TO START')
    raise SystemExit(1)


results = []
procs = []
try:
    p = boot({'BREVO_API_KEY': 'xkeysib-fake', 'MAIL_PROVIDER': 'brevo',
              'SMTP_FROM': 'BIOCYCLE OPERATION SYSTEM <sum@biokill.hk>'})
    procs.append(p)
    s, d = req('BREVS')
    ok = s == 200 and d.get('provider') == 'brevo' and d.get('brevoApi') is True and d.get('configured') is True
    print('brevo status  provider=%s brevoApi=%s configured=%s  %s' %
          (d.get('provider'), d.get('brevoApi'), d.get('configured'), 'PASS' if ok else 'FAIL'))
    results.append(('brevo status fields', ok))
    s2, _ = req('BREVL')
    ok = s2 == 403
    print('limited admin  status=%s  %s' % (s2, 'PASS' if ok else 'FAIL'))
    results.append(('admin_mgmt gate unchanged', ok))
    p.terminate(); p.wait(timeout=8); procs.remove(p)

    p = boot({})
    procs.append(p)
    s, d = req('BREVS')
    ok = s == 200 and d.get('provider') == 'smtp' and d.get('configured') is False and d.get('brevoApi') is False
    print('no-env status  provider=%s configured=%s brevoApi=%s  %s' %
          (d.get('provider'), d.get('configured'), d.get('brevoApi'), 'PASS' if ok else 'FAIL'))
    results.append(('zero-config behavior unchanged', ok))
    p.terminate(); p.wait(timeout=8); procs.remove(p)
finally:
    for p in procs:
        try:
            p.terminate(); p.wait(timeout=8)
        except Exception:
            p.kill()
    for f in DATA.glob('*.json'):
        if not (BAK / f.name).exists():
            f.unlink()
    for f in BAK.glob('*.json'):
        shutil.copy2(f, DATA / f.name)
    shutil.rmtree(BAK)
    print('data/ restored')

print('\nRESULT %d/%d PASS' % (sum(1 for _, ok in results if ok), len(results)))
for name, ok in results:
    print(' ', 'PASS' if ok else 'FAIL', name)
if not all(ok for _, ok in results):
    raise SystemExit(1)
