# -*- coding: utf-8 -*-
"""
前台全部功能頁 手機排版掃描 — 本機靜態 server + 真 Chromium（零 prod 連線）。
逐個 screen 逐個寬度量：橫向溢出 + 越界元素清單（right > viewport 或 left < 0）。
只報告，唔改嘢。
"""
import threading, functools, http.server, socketserver, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent / 'public'
SCREENS = ['homeScreen', 'examInfoScreen', 'examScreen', 'resultScreen', 'changePwScreen',
           'quizScreen', 'gamesScreen', 'feedbackScreen', 'commissionHubScreen',
           'myResultsScreen', 'myRecordsScreen', 'warehouseScreen', 'fleetScreen', 'worktimeScreen']

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

handler = functools.partial(Quiet, directory=str(ROOT))
srv = socketserver.TCPServer(('127.0.0.1', 0), handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % port

STUB = """
window.fetch = function () {
  return Promise.resolve(new Response(JSON.stringify({authenticated:false, ok:true}),
    {status:200, headers:{'Content-Type':'application/json'}}));
};
"""

SHOW = """(id) => {
  try {
    if (id === 'homeScreen') { if (typeof showHome === 'function') { window.empData = window.empData || {name:'TESTER'}; showHome(); return; } }
    if (typeof showScreen === 'function') { showScreen(id); return; }
  } catch (e) {}
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  const el = document.getElementById(id);
  if (el) { el.style.display = 'block'; el.style.visibility = 'visible'; }
}"""

MEASURE = """() => {
  const iw = window.innerWidth;
  const doc = document.documentElement;
  const offenders = [];
  for (const e of document.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const st = getComputedStyle(e);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    if (r.right > iw + 1.5 || r.left < -1.5) {
      // 只報「真正突出 viewport」嘅最深層元素：跳過佢自己 overflow hidden 已裁走嘅
      offenders.push({
        tag: e.tagName.toLowerCase(),
        id: e.id || '',
        cls: (e.className && typeof e.className === 'string') ? e.className.slice(0, 60) : '',
        w: Math.round(r.width), l: Math.round(r.left), rgt: Math.round(r.right),
        txt: (e.textContent || '').trim().slice(0, 24)
      });
    }
  }
  // 淨返最外層嘅（父母都越界嘅就只報一層代表性）：保留全部但限制數量
  return { iw, scrollW: doc.scrollWidth, n: offenders.length, off: offenders.slice(0, 8) };
}"""

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    problems = {}
    for width in (360, 390, 430, 768):
        ctx = browser.new_context(viewport={'width': width, 'height': 900})
        ctx.add_init_script(STUB)
        pg = ctx.new_page()
        pg.goto(BASE + '/index.html', wait_until='domcontentloaded')
        pg.wait_for_timeout(250)
        for sid in SCREENS:
            pg.evaluate(SHOW, sid)
            pg.wait_for_timeout(120)
            m = pg.evaluate(MEASURE)
            bad = m['scrollW'] > m['iw'] + 1
            if bad or m['n'] > 0:
                key = sid
                problems.setdefault(key, []).append({'w': width, 'scrollW': m['scrollW'], 'iw': m['iw'], 'off': m['off']})
        ctx.close()

    if not problems:
        print('ALL CLEAN — 全部 screen 全部寬度零橫向溢出')
    else:
        for sid, rows in problems.items():
            print('\n### %s' % sid)
            for row in rows:
                print('  W%d scrollW=%d iw=%d offenders=%d' % (row['w'], row['scrollW'], row['iw'], len(row['off'])))
                for o in row['off']:
                    print('    <%s id=%s class=%s> w=%d l=%d r=%d | %s' % (o['tag'], o['id'], o['cls'], o['w'], o['l'], o['rgt'], o['txt']))
    browser.close()
