# -*- coding: utf-8 -*-
"""
工時記錄手機排版回歸 — 本機靜態 server + 真 Chromium（零 prod 連線、零寫檔）。
驗證 WT MOBILE 2026-11-13 段：
  1) 手機寬度下日期/狀態、三個時間框、單號/開始/完結、類型 chip、按鈕全部等闊對齊
  2) 無橫向溢出、無 JS exception
  3) 桌面 >=701px 唔受影響（維持原本 flex 排版）
"""
import threading, functools, http.server, socketserver, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent / 'public'
PASS, FAIL = [], []


def ck(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  PASS  ' if cond else '  FAIL  ') + name + (('  | ' + str(extra)) if extra else ''))


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

MEASURE = """() => {
  const r = (e) => e ? e.getBoundingClientRect() : null;
  const w = (e) => e ? Math.round(e.getBoundingClientRect().width * 10) / 10 : -1;
  const cs = (e, p) => e ? getComputedStyle(e)[p] : '';
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const row = q('#worktimeScreen .field-row-lg');
  const times = q('#wtTimesBox > .wt-inline');
  const job = q('#wtJobs .wt-job');
  const jobRow = job ? job.querySelector('.wt-inline') : null;
  const spans = jobRow ? Array.from(jobRow.children) : [];
  const types = job ? job.querySelector('.wt-types') : null;
  const chips = types ? Array.from(types.children) : [];
  const btns = job && job.lastElementChild ? Array.from(job.lastElementChild.querySelectorAll('.btn')) : [];
  const save = q('#worktimeScreen .center-card > .mt-16 > .btn-primary');
  return {
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    rowDisplay: cs(row, 'display'),
    rowCols: cs(row, 'gridTemplateColumns'),
    rowInputs: row ? Array.from(row.querySelectorAll('input,select')).slice(0,2).map(w) : [],
    timesDisplay: cs(times, 'display'),
    timesW: Array.from(qa('#wtTimesBox > .wt-inline .wt-time')).map(w),
    jobRowDisplay: cs(jobRow, 'display'),
    spanW: spans.map(w),
    typesDisplay: cs(types, 'display'),
    chipW: chips.slice(0, 6).map(w),
    btnW: btns.map(w),
    saveW: w(save),
    cardW: w(q('#worktimeScreen .center-card')),
    jobCount: qa('#wtJobs .wt-job').length
  };
}"""


def eq(vals, tol=1.5):
    return len(vals) >= 2 and all(v > 0 for v in vals) and max(vals) - min(vals) <= tol


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []

    for width in (360, 390, 430, 600, 700, 768, 1440):
        ctx = browser.new_context(viewport={'width': width, 'height': 900})
        ctx.add_init_script(STUB)
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(BASE + '/index.html', wait_until='domcontentloaded')
        pg.evaluate("""() => {
          if (typeof showScreen === 'function') showScreen('worktimeScreen');
          else {
            document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
            document.getElementById('worktimeScreen').style.display = 'block';
          }
          if (typeof wtAddJob === 'function' && !document.querySelector('#wtJobs .wt-job')) wtAddJob();
        }""")
        pg.wait_for_timeout(180)
        m = pg.evaluate(MEASURE)
        tag = 'W%d' % width
        print('\n[%s] card=%s job=%d scrollW=%d/%d' % (tag, m['cardW'], m['jobCount'], m['scrollW'], m['innerW']))

        ck(tag + ' 有生成到工作單卡（DOM 真實）', m['jobCount'] >= 1)
        ck(tag + ' 無橫向溢出', m['scrollW'] <= m['innerW'] + 1,
           '%d/%d' % (m['scrollW'], m['innerW']))

        if width <= 700:
            ck(tag + ' 日期/狀態 = 2 欄 grid + 等闊',
               m['rowDisplay'] == 'grid' and len(m['rowCols'].split()) == 2 and eq(m['rowInputs']),
               '%s %s' % (m['rowDisplay'], m['rowInputs']))
            ck(tag + ' 三個時間框等闊 + 儲存掣全闊',
               m['timesDisplay'] == 'grid' and eq(m['timesW']), m['timesW'])
            ck(tag + ' 單號全闊、開始/完結等闊',
               m['jobRowDisplay'] == 'grid' and len(m['spanW']) == 3 and
               m['spanW'][0] > m['spanW'][1] * 1.8 and eq(m['spanW'][1:]), m['spanW'])
            ck(tag + ' 工作類型 chip 等闊 grid',
               m['typesDisplay'] == 'grid' and eq(m['chipW'][:4]), m['chipW'][:4])
            ck(tag + ' 卡底兩粒掣等闊 + 主儲存掣全闊',
               eq(m['btnW']) and m['saveW'] > m['cardW'] * 0.8, m['btnW'])
        else:
            ck(tag + ' 桌面維持原本 flex（新 CSS 唔影響）',
               m['rowDisplay'] != 'grid' and m['timesDisplay'] != 'grid' and m['typesDisplay'] != 'grid',
               '%s/%s/%s' % (m['rowDisplay'], m['timesDisplay'], m['typesDisplay']))
        ctx.close()

    ck('全場 0 個 JS exception', len(errors) == 0, errors[:2])
    browser.close()

print('\n===== %d PASS / %d FAIL =====' % (len(PASS), len(FAIL)))
if FAIL:
    print('FAILED: ' + ', '.join(FAIL))
    raise SystemExit(1)
