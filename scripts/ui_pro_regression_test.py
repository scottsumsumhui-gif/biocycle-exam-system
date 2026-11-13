# -*- coding: utf-8 -*-
"""
UI PRO 2026-11-13 回歸測試 — 本機靜態 server + 真 Chromium。
零 prod 風險：唔起 Node server、唔連 Upstash、唔寫任何 data；fetch 全部 stub。
验证：前台首頁／登入頁／節日主題、後台左側欄／權限／漢堡抽屜／print。
"""
import threading, functools, http.server, socketserver, pathlib, sys
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

def css(pg, sel, prop):
    return pg.eval_on_selector(sel, '(e,p)=>getComputedStyle(e)[p]', prop)

with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ===================== 前台 =====================
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_init_script(STUB)
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE + '/index.html', wait_until='domcontentloaded')
    pg.wait_for_timeout(350)

    print('\n[A] 前台 index.html')
    ck('A1 CSS 版本已 bump 且載入 200',
       'style.css?v=20261113' in pg.content() and
       pg.request.get(BASE + '/css/style.css?v=20261113').status == 200)
    ck('A2 登入頁專業卡片生效', css(pg, '#loginScreen .center-card', 'maxWidth') == '420px',
       css(pg, '#loginScreen .center-card', 'maxWidth'))
    ck('A3 首頁 8 張功能卡', pg.locator('#homeScreen .module-card').count() == 8)
    ck('A4 8 個單色線性 SVG icon（emoji 已清）',
       pg.locator('#homeScreen .module-icon svg').count() == 8 and
       pg.locator('#homeScreen .module-icon').first.inner_text().strip() == '')
    ck('A5 作者署名已搬去頁腳、頂欄減負',
       pg.locator('#homeScreen .brand-bar .bb-author').count() == 0 and
       pg.locator('#homeScreen .home-footer b').inner_text() == 'Hui Sum Sum')

    # showHome() 用返原本 JS，驗證 display:contents 無刪任何元素
    pg.evaluate("empData={name:'TESTER'}; showHome();")
    pg.wait_for_timeout(150)
    ck('A6 showHome() 後 h1 / quote-bar / bgMusicBtn 全部仍在',
       pg.locator('#homeHeader h1').count() == 1 and
       pg.locator('#homeHeader .quote-bar').count() == 1 and
       pg.locator('#bgMusicBtn').count() == 1)
    ck('A7 flex order：功能卡(2) 早過語錄(4)',
       css(pg, '#homeScreen .module-grid', 'order') == '2' and
       css(pg, '#homeHeader .quote-bar', 'order') == '4')
    ck('A8 頂欄深墨綠 / 卡片 grid 4 欄',
       css(pg, '#homeScreen .brand-bar', 'backgroundColor') == 'rgb(13, 51, 35)' and
       css(pg, '#homeScreen .module-grid', 'display') == 'grid' and
       len(css(pg, '#homeScreen .module-grid', 'gridTemplateColumns').split()) == 4,
       css(pg, '#homeScreen .module-grid', 'gridTemplateColumns'))
    ck('A9 hover 唔再飛起', css(pg, '#homeScreen .module-card', 'transform') in ('none', 'matrix(1, 0, 0, 1, 0, 0)'))

    pg.set_viewport_size({'width': 390, 'height': 800})
    pg.wait_for_timeout(120)
    ck('A10 手機 390 → 功能卡 2 欄',
       len(css(pg, '#homeScreen .module-grid', 'gridTemplateColumns').split()) == 2,
       css(pg, '#homeScreen .module-grid', 'gridTemplateColumns'))

    # 節日主題
    pg2 = ctx.new_page()
    pg2.on('pageerror', lambda e: errors.append(str(e)))
    pg2.goto(BASE + '/index.html?fest=halloween', wait_until='domcontentloaded')
    pg2.evaluate("empData={name:'TESTER'}; showHome();")
    pg2.wait_for_timeout(200)
    ck('A11 萬聖節 body class + 黑色首頁',
       'fest-halloween' in (pg2.locator('body').get_attribute('class') or '') and
       css(pg2, '#homeScreen', 'backgroundColor') == 'rgb(12, 12, 12)')
    # 註：萬聖節原本 inline CSS 嘅 `.center-card div{color:#e8e8e8!important}`
    # 特異性 (1,2,2) 高過 `.module-title{color:#ff9f1c!important}` (1,2,1)，
    # 所以標題一向係淺灰而唔係橙 —— 唔改節日既有行為，只確認黑底上仍可讀。
    _title = css(pg2, '#homeScreen .module-title', 'color')
    ck('A12 萬聖節 icon 底跟住轉深、標題保持淺色可讀',
       css(pg2, '#homeScreen .module-icon', 'backgroundColor') == 'rgb(44, 44, 44)' and
       _title in ('rgb(232, 232, 232)', 'rgb(255, 159, 28)'), _title)
    ck('A13 萬聖節 center-card 仍有 88px 頂位（燈籠唔壓內容）',
       css(pg2, '#homeScreen .center-card', 'paddingTop') == '88px',
       css(pg2, '#homeScreen .center-card', 'paddingTop'))
    ck('A14 萬聖節唔影響其他分頁（examInfoScreen 唔係黑底）',
       css(pg2, '#examInfoScreen', 'backgroundColor') != 'rgb(12, 12, 12)')
    pg2.close()

    pg3 = ctx.new_page()
    pg3.on('pageerror', lambda e: errors.append(str(e)))
    pg3.goto(BASE + '/index.html?fest=midautumn', wait_until='domcontentloaded')
    pg3.evaluate("empData={name:'TESTER'}; showHome();")
    pg3.wait_for_timeout(200)
    ck('A15 中秋 icon 底金黃 + 88px 頂位',
       css(pg3, '#homeScreen .module-icon', 'backgroundColor') == 'rgb(255, 243, 208)' and
       css(pg3, '#homeScreen .center-card', 'paddingTop') == '88px')
    pg3.close()
    ctx.close()

    # ===================== 後台 =====================
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_init_script(STUB)
    ap = ctx.new_page()
    ap.on('pageerror', lambda e: errors.append(str(e)))
    ap.goto(BASE + '/admin.html', wait_until='domcontentloaded')
    ap.wait_for_timeout(350)

    print('\n[B] 後台 admin.html')
    ck('B1 CSS 版本已 bump 且載入 200',
       'style.css?v=20261113' in ap.content() and
       ap.request.get(BASE + '/css/style.css?v=20261113').status == 200)
    ck('B2 19 個 nav-btn 一個都冇少／冇改 onclick',
       ap.locator('.nav-btn').count() == 19 and
       ap.locator('.nav-btn[onclick]').count() == 19)
    ck('B3 5 個分組標題 + 側欄底作者署名 + 遮罩 + 漢堡',
       ap.locator('.nav-group-label').count() == 5 and
       ap.locator('.admin-nav-author b').inner_text() == 'Hui Sum Sum' and
       ap.locator('#adminMask').count() == 1 and
       ap.locator('#adminBurger').count() == 1)
    ck('B4 管理員登入頁品牌一致',
       css(ap, '#adminLogin .center-card', 'maxWidth') == '420px' and
       css(ap, '#adminLogin', 'display') == 'flex')

    ap.evaluate("showScreen('adminPanel');")
    ap.wait_for_timeout(120)
    ck('B5 桌面：兩欄 grid、nav 喺左、body 喺右、漢堡收起',
       css(ap, '#adminPanel', 'display') == 'grid' and
       css(ap, '#adminNav', 'gridColumnStart') == '1' and
       css(ap, '#adminBody', 'gridColumnStart') == '2' and
       css(ap, '#adminBurger', 'display') == 'none',
       css(ap, '#adminPanel', 'display'))
    ck('B6 showScreen() 清 inline display，冇覆蓋 grid',
       ap.eval_on_selector('#adminPanel', 'e=>e.style.display') == '')

    ap.evaluate("adminData={isSuper:true,permissions:[]}; applyNavPermissions();")
    ap.wait_for_timeout(80)
    vis = ap.locator('#adminNav .nav-btn:visible').count()
    labels = ap.locator('#adminNav .nav-group-label:visible').count()
    ck('B7 超管：Dashboard／問答評分仍收埋、5 組標題全顯示',
       vis == 17 and labels == 5 and
       ap.locator('#tabDashboard').is_hidden() and ap.locator('#tabGrading').is_hidden(),
       'visible=%d labels=%d' % (vis, labels))

    ap.evaluate("adminData={isSuper:false,permissions:['worktime']}; applyNavPermissions();")
    ap.wait_for_timeout(80)
    vis2 = ap.locator('#adminNav .nav-btn:visible').count()
    hidden_groups = ap.evaluate("""[...document.querySelectorAll('#adminNav .nav-group-label')]
        .filter(e=>e.style.display==='none').length""")
    ck('B8 受限管理員：可見掣變少、空組標題自動收起',
       vis2 < vis and hidden_groups > 0 and ap.locator('#tabWorktime').is_visible(),
       'visible=%d hidden_groups=%d' % (vis2, hidden_groups))
    ck('B9 權限邏輯本身冇改：無權限掣 inline display=none',
       ap.eval_on_selector('#tabEmployees', 'e=>e.style.display') == 'none')

    ap.evaluate("window.showTab=function(){};")
    ap.locator('#tabHome').click()
    ap.wait_for_timeout(80)
    ck('B10 點選單項會收抽屜、showTab 仍可呼叫',
       'drawer-open' not in (ap.locator('#adminPanel').get_attribute('class') or ''))

    # 窄屏漢堡抽屜
    ap.set_viewport_size({'width': 390, 'height': 800})
    ap.evaluate("adminData={isSuper:true,permissions:[]}; applyNavPermissions();")
    ap.wait_for_timeout(150)
    _tx = float(css(ap, '#adminNav', 'transform').split(',')[-2]) if 'matrix' in css(ap, '#adminNav', 'transform') else 0
    ck('B11 手機：漢堡出現、側欄收埋喺左邊',
       ap.locator('#adminBurger').is_visible() and _tx < -200,
       css(ap, '#adminNav', 'transform'))
    ap.locator('#adminBurger').click()
    ap.wait_for_timeout(300)
    ck('B12 撳漢堡 → 抽屜彈出 + 遮罩出現 + 5 組標題可見',
       'drawer-open' in (ap.locator('#adminPanel').get_attribute('class') or '') and
       css(ap, '#adminMask', 'display') == 'block' and
       ap.locator('#adminNav .nav-group-label:visible').count() == 5)
    ap.locator('#adminMask').click(position={'x': 350, 'y': 200})
    ap.wait_for_timeout(280)
    ck('B13 撳右邊遮罩 → 收返',
       'drawer-open' not in (ap.locator('#adminPanel').get_attribute('class') or ''))
    ap.locator('#adminBurger').click()
    ap.locator('#adminNav .nav-btn:visible').nth(1).click()
    ap.wait_for_timeout(280)
    ck('B14 點選單項 → 自動收返',
       'drawer-open' not in (ap.locator('#adminPanel').get_attribute('class') or ''))

    ap.emulate_media(media='print')
    ap.wait_for_timeout(100)
    ck('B15 print：header / nav / 漢堡全部收起',
       css(ap, '#adminPanel > .admin-header', 'display') == 'none' and
       css(ap, '#adminNav', 'display') == 'none' and
       css(ap, '#adminBurger', 'display') == 'none')
    ap.emulate_media(media='screen')
    ctx.close()

    ck('C 全場 0 個 JS exception', len(errors) == 0, errors[:3])
    browser.close()

srv.shutdown()
print('\n===== %d PASS / %d FAIL =====' % (len(PASS), len(FAIL)))
if FAIL:
    print('FAILED:', FAIL)
    sys.exit(1)
