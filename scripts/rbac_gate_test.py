"""#4 三條 admin API 權限閘 — 本機真 server 整合測試（file mode）。
測試前備份 data/*.json，測試後完整還原；唔連 prod、唔寫 prod。

Case:
  超管 (is_super=1)        → dashboard / announcement / mail-test 全部唔係 403
  受限管理員 (只得 worktime) → 三條全部 403
  已有權限閘嘅 exam-config → 兩者行為維持不變（超管 200 / 受限 403）
  mail/test 唔接受 body.to  → source 靜態斷言
"""
import subprocess, time, os, json, shutil, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\exam-system')
OUT = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\outputs')
DATA = ROOT / 'data'
BAK = OUT / '_data_bak_rbac'
BASE = 'http://127.0.0.1:3998'

files = sorted(DATA.glob('*.json'))
if BAK.exists():
    shutil.rmtree(BAK)
BAK.mkdir(parents=True)
for f in files:
    shutil.copy2(f, BAK / f.name)
print('backed up', len(files), 'data files')

exp = (datetime.now(timezone(timedelta(hours=8))) + timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S')
(DATA / 'admins.json').write_text(json.dumps([
    {'id': 901, 'username': 'TESTSUPER', 'display_name': 'Test Super',
     'password_hash': '$2b$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
     'is_super': 1, 'permissions': [], 'email': 'super@test.local'},
    {'id': 902, 'username': 'TESTLIMITED', 'display_name': 'Test Limited',
     'password_hash': '$2b$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
     'is_super': 0, 'permissions': ['worktime'], 'email': 'limited@test.local'}
], ensure_ascii=False), encoding='utf-8')
(DATA / 'sessions.json').write_text(json.dumps([
    {'id': 'RBACS', 'user_type': 'admin', 'user_id': 901, 'expires_at': exp},
    {'id': 'RBACL', 'user_type': 'admin', 'user_id': 902, 'expires_at': exp}
], ensure_ascii=False), encoding='utf-8')

env = os.environ.copy()
env['PORT'] = '3998'
env.pop('UPSTASH_REDIS_REST_URL', None)
env.pop('UPSTASH_REDIS_REST_TOKEN', None)
proc = subprocess.Popen(['node', 'server.js'], cwd=str(ROOT), env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def req(path, cookie, payload=None, method='GET'):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={'Content-Type': 'application/json', 'Cookie': 'admin_session_id=' + cookie})
    try:
        resp = urllib.request.urlopen(r, timeout=6)
        return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


results = []
try:
    up = False
    for _ in range(60):
        try:
            hr = urllib.request.urlopen(BASE + '/api/health', timeout=1)
            if hr.status == 200:
                up = True
                break
        except Exception:
            time.sleep(0.25)
    if not up:
        print('SERVER FAILED TO START')
        print(proc.stdout.read() if proc.poll() is not None else '')
        raise SystemExit(1)
    print('server up')

    cases = [
        ('dashboard',   '/api/admin/dashboard',       'GET',  None),
        ('announcement','/api/admin/announcement',    'POST', {'text': ''}),
        ('mail/test',   '/api/admin/mail/test',       'POST', {'to': 'attacker@evil.example'}),
    ]
    for name, path, method, payload in cases:
        s_super, b_super = req(path, 'RBACS', payload, method)
        s_limited, b_limited = req(path, 'RBACL', payload, method)
        ok = (s_super != 403) and (s_limited == 403)
        print('%-13s super=%s limited=%s  %s' % (name, s_super, s_limited, 'PASS' if ok else 'FAIL'))
        if not ok:
            print('   super body:', b_super[:180])
            print('   limited body:', b_limited[:180])
        results.append((name + ' gate', ok))

    # 已有閘嘅 route 保持不變（證明改動無破壞 requirePermission 本身）
    s1, _ = req('/api/admin/exam-config', 'RBACS')
    s2, _ = req('/api/admin/exam-config', 'RBACL')
    ok = (s1 == 200 and s2 == 403)
    print('%-13s super=%s limited=%s  %s' % ('exam-config', s1, s2, 'PASS' if ok else 'FAIL'))
    results.append(('existing gate unchanged', ok))

    # mail/test 唔可以再經 body.to 指定收件人
    src = (ROOT / 'server.js').read_text(encoding='utf-8')
    ok = ('req.body && req.body.to' not in src) and ('const target = String(me.email || \'\').trim();' in src)
    print('%-13s %s' % ('no body.to', 'PASS' if ok else 'FAIL'))
    results.append(('mail/test ignores body.to', ok))

finally:
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except Exception:
        proc.kill()
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
