# -*- coding: utf-8 -*-
"""
前台其他功能頁 手機排版回歸 — 本機靜態 server + 真 Chromium（零 prod 連線、零寫檔）。
驗證 FRONT MOBILE 2026-11-13：倉存／車隊／佣金 hub／考試頂欄 <=700px grid 對齊；
桌面 >=701px 維持原本排版；無橫向溢出、無 JS exception。
每個 screen 分開顯示再量（一次只顯示一個 screen，寬度先會 > 0）。
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

def eq(vals, tol=1.5):
    return len(vals) >= 2 and all(v > 0 for v in vals) and max(vals) - min(vals) <= tol


def newpage(browser, width, errors):
    ctx = browser.new_context(viewport={'width': width, 'height': 900})
    ctx.add_init_script(STUB)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE + '/index.html', wait_until='domcontentloaded')
    pg.evaluate("""() => {
      document.getElementById('whAddNewBox').style.display = 'block';
      for (const id of ['fleetDepartBox','fleetReturnBox','fleetFuelBox','fleetMaintBox','fleetRepairBox']) {
        const el = document.getElementById(id); if (el) el.style.display = 'block';
      }
      const dv = document.getElementById('fleetDetailView'); if (dv) dv.style.display = 'block';
    }""")
    pg.wait_for_timeout(150)
    return ctx, pg


def show(pg, body):
    # body 係箭頭函數字串（例 "()=>showScreen('x')"）→ 還原成函數再調用
    pg.evaluate("(b)=>{ try { (new Function(b))(); } catch (e) {} }", body)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []

    for width in (360, 390, 700, 1440):
        tag = 'W%d' % width
        ctx, pg = newpage(browser, width, errors)
        mobile = width <= 700

        # ---------- 倉存 ----------
        show(pg, "showScreen('warehouseScreen')")
        pg.wait_for_timeout(120)
        m = pg.evaluate("""() => {
          const w=(e)=>e?Math.round(e.getBoundingClientRect().width*10)/10:-1;
          const cs=(e,p)=>e?getComputedStyle(e)[p]:'';
          const row=document.querySelector('#warehouseScreen h3.mt-18 + div');
          return { iw:innerWidth, scrollW:document.documentElement.scrollWidth,
            display:cs(row,'display'), cols:cs(row,'gridTemplateColumns'),
            selects:['#whCatSelect','#whItemSelect'].map(s=>w(document.querySelector(s))),
            btnW:w(row.querySelector(':scope > .btn')), rowW:w(row),
            add:cs(document.getElementById('whAddNewBox'),'display') };
        }""")
        print('\n[%s WH] scrollW=%d/%d' % (tag, m['scrollW'], m['iw']))
        ck(tag + ' 倉存 無橫向溢出', m['scrollW'] <= m['iw'] + 1, '%d/%d' % (m['scrollW'], m['iw']))
        if mobile:
            ck(tag + ' 倉存行 grid 2 欄 + 分類/物資等闊',
               m['display'] == 'grid' and len(m['cols'].split()) == 2 and eq(m['selects']),
               '%s %s' % (m['display'], m['selects']))
            ck(tag + ' 倉存提交掣全闊', m['btnW'] > m['rowW'] * 0.85, 'btn=%s row=%s' % (m['btnW'], m['rowW']))
            ck(tag + ' 新增物資盒 grid 直排', m['add'] == 'grid', m['add'])
        else:
            ck(tag + ' 倉存桌面維持 flex', m['display'] == 'flex', m['display'])

        # ---------- 車隊 ----------
        show(pg, "showScreen('fleetScreen')")
        pg.wait_for_timeout(120)
        m = pg.evaluate("""() => {
          const w=(e)=>e?Math.round(e.getBoundingClientRect().width*10)/10:-1;
          const cs=(e,p)=>e?getComputedStyle(e)[p]:'';
          const row=document.querySelector('#fleetScreen .field-row');
          const fuel=Array.from(document.querySelectorAll('#fleetFuelBox input')).map(w);
          return { iw:innerWidth, scrollW:document.documentElement.scrollWidth,
            display:cs(row,'display'), cols:cs(row,'gridTemplateColumns'),
            monthW:w(row.children[2]), rowW:w(row),
            fuel, fuelBtn:w(document.querySelector('#fleetFuelBox .btn')),
            dep:Array.from(document.querySelectorAll('#fleetDepartBox input')).map(w) };
        }""")
        print('[%s FLEET] scrollW=%d/%d' % (tag, m['scrollW'], m['iw']))
        ck(tag + ' 車隊 無橫向溢出', m['scrollW'] <= m['iw'] + 1, '%d/%d' % (m['scrollW'], m['iw']))
        if mobile:
            ck(tag + ' 車隊篩選 grid 2 欄 + 月份全闊',
               m['display'] == 'grid' and len(m['cols'].split()) == 2 and m['monthW'] > m['rowW'] * 0.85,
               '%s %s' % (m['display'], m['cols']))
            ck(tag + ' 車隊入油 4 格等闊 + 確認掣全闊',
               eq(m['fuel']) and m['fuelBtn'] > m['fuel'][0] * 1.8, '%s btn=%s' % (m['fuel'], m['fuelBtn']))
            ck(tag + ' 車隊出車 2 格等闊', eq(m['dep']), m['dep'])
        else:
            ck(tag + ' 車隊桌面維持 flex', m['display'] == 'flex', m['display'])

        # ---------- 佣金 hub：渠網 ----------
        show(pg, "{showScreen('commissionHubScreen'); switchCommHubTab('channel'); addCommMemberRow();}")
        pg.wait_for_timeout(120)
        m = pg.evaluate("""() => {
          const w=(e)=>e?Math.round(e.getBoundingClientRect().width*10)/10:-1;
          const cs=(e,p)=>e?getComputedStyle(e)[p]:'';
          const panel=document.querySelector('#commChannelSub .panel');
          const mrow=document.querySelector('#commChannelSub .comm-member-row');
          return { iw:innerWidth, scrollW:document.documentElement.scrollWidth,
            dir:cs(panel.querySelector(':scope > .inline-row'),'flexDirection'),
            dateW:w(document.getElementById('commDate')), panelW:w(panel),
            mDisplay:cs(mrow,'display'), mEmpW:w(mrow.querySelector('.comm-emp')),
            mBtnW:w(mrow.querySelector(':scope > .btn')) };
        }""")
        print('[%s COMM-CH] scrollW=%d/%d' % (tag, m['scrollW'], m['iw']))
        ck(tag + ' 渠網 無橫向溢出', m['scrollW'] <= m['iw'] + 1, '%d/%d' % (m['scrollW'], m['iw']))
        if mobile:
            ck(tag + ' 渠網行直排 + 日期全闊',
               m['dir'] == 'column' and m['dateW'] > m['panelW'] * 0.85,
               '%s %s/%s' % (m['dir'], m['dateW'], m['panelW']))
            ck(tag + ' 渠網隊員行 grid + select/移除掣全闊',
               m['mDisplay'] == 'grid' and m['mEmpW'] > m['panelW'] * 0.85 and m['mBtnW'] > m['panelW'] * 0.85,
               '%s emp=%s btn=%s' % (m['mDisplay'], m['mEmpW'], m['mBtnW']))
        else:
            ck(tag + ' 渠網桌面維持 row', m['dir'] != 'column', m['dir'])

        # ---------- 佣金 hub：服務 ----------
        show(pg, "switchCommHubTab('tech'); addLeadMemberRow();")
        pg.wait_for_timeout(120)
        m = pg.evaluate("""() => {
          const w=(e)=>e?Math.round(e.getBoundingClientRect().width*10)/10:-1;
          const cs=(e,p)=>e?getComputedStyle(e)[p]:'';
          const three=document.querySelector('#commTechSub .panel > div[style*="1fr 1fr 1fr"]');
          const lrow=document.querySelector('#commTechSub .lead-member-row');
          return { iw:innerWidth, scrollW:document.documentElement.scrollWidth,
            threeCols:cs(three,'gridTemplateColumns'), leadCode:w(document.getElementById('leadCustomerCode')),
            panelW:w(document.querySelector('#commTechSub .panel')),
            lDisplay:cs(lrow,'display'), lEmpW:w(lrow.querySelector('.lead-emp')), lRowW:w(lrow),
            submitW:w(document.querySelector('#commTechSub .panel > .inline-row .btn')) };
        }""")
        print('[%s COMM-TECH] scrollW=%d/%d' % (tag, m['scrollW'], m['iw']))
        ck(tag + ' 服務佣金 無橫向溢出', m['scrollW'] <= m['iw'] + 1, '%d/%d' % (m['scrollW'], m['iw']))
        if mobile:
            ck(tag + ' 服務佣金 3 欄變 1 欄 + 客戶編號全闊',
               len(m['threeCols'].split()) == 1 and m['leadCode'] > m['panelW'] * 0.85,
               '%s %s' % (m['threeCols'], m['leadCode']))
            ck(tag + ' 服務佣金隊員行 grid + select 全闊',
               m['lDisplay'] == 'grid' and m['lEmpW'] >= m['lRowW'] * 0.7,
               '%s emp=%s' % (m['lDisplay'], m['lEmpW']))
            ck(tag + ' 服務佣金提交掣全闊', m['submitW'] > m['panelW'] * 0.85, m['submitW'])
        else:
            ck(tag + ' 服務佣金桌面維持 3 欄', len(m['threeCols'].split()) == 3, m['threeCols'])
        ctx.close()

    # 考試頂欄
    ctx, pg = newpage(browser, 390, errors)
    show(pg, "showScreen('examScreen')")
    pg.wait_for_timeout(150)
    m = pg.evaluate("""() => ({
      scrollW: document.documentElement.scrollWidth, iw: window.innerWidth,
      wrap: getComputedStyle(document.querySelector('#examScreen .exam-header')).flexWrap })""")
    ck('考試頁頂欄無溢出 + 可換行', m['scrollW'] <= m['iw'] + 1 and m['wrap'] == 'wrap', m)
    ctx.close()

    ck('全場 0 個 JS exception', len(errors) == 0, errors[:2])
    browser.close()

print('\n===== %d PASS / %d FAIL =====' % (len(PASS), len(FAIL)))
if FAIL:
    print('FAILED: ' + ', '.join(FAIL))
    raise SystemExit(1)
