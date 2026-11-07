"""本機真 server 整合測試：login / heartbeat / logout scope。
用 file mode（唔連 prod），測試前後完整還原 data/*.json。純 stdlib。
"""
import subprocess, time, os, json, shutil, urllib.request, urllib.error, http.cookiejar
from pathlib import Path

ROOT = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\exam-system')
OUT = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\outputs')
DATA = ROOT / 'data'
BAK = OUT / '_data_bak_integration'
BASE = 'http://127.0.0.1:3999'

files = sorted(DATA.glob('*.json'))
if BAK.exists():
    shutil.rmtree(BAK)
BAK.mkdir(parents=True)
for f in files:
    shutil.copy2(f, BAK / f.name)
print('backed up', len(files), 'data files')

env = os.environ.copy()
env['PORT'] = '3999'
env.pop('UPSTASH_REDIS_REST_URL', None)
env.pop('UPSTASH_REDIS_REST_TOKEN', None)
proc = subprocess.Popen(['node', 'server.js'], cwd=str(ROOT), env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def req(path, payload=None, method='POST'):
    data = json.dumps(payload).encode('utf-8') if payload is not None else (b'' if method == 'POST' else None)
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={'Content-Type': 'application/json'})
    try:
        return opener.open(r, timeout=6)
    except urllib.error.HTTPError as e:
        return e


def body(resp):
    try:
        return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return {}


def setcookies(resp):
    return resp.headers.get_all('Set-Cookie') or []


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
        raise SystemExit(1)
    print('server up:', body(hr))

    e = body(req('/api/auth/employee-login', {'empNumber': 'ST82', 'password': '0000'}))
    names = [c.name for c in jar]
    print('employee login:', e.get('success'), '| cookies:', names)
    results.append(('employee login', bool(e.get('success')) and 'session_id' in names))

    a = body(req('/api/auth/admin-login', {'username': 'ST140', 'password': '61583398'}))
    names = [c.name for c in jar]
    print('admin login   :', a.get('success'), '| cookies:', names)
    results.append(('admin login both cookies',
                    bool(a.get('success')) and 'session_id' in names and 'admin_session_id' in names))

    hb = req('/api/auth/heartbeat')
    sc = setcookies(hb)
    refreshed = [c.split('=')[0] for c in sc]
    print('heartbeat:', hb.status, '| refreshed:', refreshed)
    results.append(('heartbeat refreshes both cookies',
                    hb.status == 200 and 'session_id' in refreshed and 'admin_session_id' in refreshed))

    out = req('/api/auth/logout', {'scope': 'admin'})
    sc = setcookies(out)
    cleared_adm = any(c.startswith('admin_session_id=') for c in sc)
    cleared_emp = any(c.startswith('session_id=') for c in sc)
    names = [c.name for c in jar]
    chk = body(req('/api/auth/check', method='GET'))
    print('admin logout: cleared admin=%s employee=%s | cookies left=%s | check=%s'
          % (cleared_adm, cleared_emp, names, chk.get('authenticated')))
    results.append(('admin logout keeps employee session',
                    cleared_adm and not cleared_emp and chk.get('authenticated') is True))

    req('/api/auth/logout', {'scope': 'employee'})
    chk2 = body(req('/api/auth/check', method='GET'))
    print('employee logout: check =', chk2.get('authenticated'))
    results.append(('employee logout clears own session', chk2.get('authenticated') is False))

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
