"""工時「叠單」回歸測試：真 Chromium 跑 public/index.html，mock 慢網絡 + 並行載入。

修復前：A1=12、B=12（6 張單被複製成 12 張）
修復後：A1=6（保留用戶填咗資料嗰 6 張）、B=6、A2=12（兩批唔同單號都要留，唔可以誤刪）、C=0 新增、D=保留用戶輸入

跑法：python exam-system/scripts/wt_race_repro.py
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\exam-system\public').resolve()

# 模擬舊記錄：6 張「得單號」嘅單（排單 PDF 導入後存低）
REC = {
    'id': 1, 'date': '2026-11-06', 'emp_id': 1, 'emp_number': 'ST001', 'emp_name': 'TEST',
    'day_status': '正常上班', 'schedule_in': '09:00', 'actual_in': '09:00', 'off_time': '18:00',
    'jobs': [{'client_no': 'A%d' % i, 'start': '', 'end': '', 'types': [],
              'remarks': '', 'no_sync': False, 'night_allowance': False} for i in range(1, 7)],
    'members': [], 'total_duty_hours': 9, 'standard_hours': 10,
    'ot_hours': 0, 'ot_evening_hours': 0, 'ot_night_hours': 0
}

INIT = """
window.__mockRecs = __REC_PLACEHOLDER__;
window.__mockDelay = 700;
window.fetch = async function(url, opts) {
  const u = String(url);
  const method = (opts && opts.method) ? opts.method.toUpperCase() : 'GET';
  if (u.indexOf('/api/worktime/meta') >= 0)
    return { json: async () => ({success:true, types:['PC','TC','RC'], holidays:{}}) };
  if (u.indexOf('/api/worktime/employees') >= 0)
    return { json: async () => ({success:true, employees:[{id:1,name:'TEST',emp_number:'ST001'}]}) };
  if (u.indexOf('/api/worktime/import-schedule') >= 0)
    return { json: async () => ({success:true, clientNos:['A1','A2','A3','A4','A5','A6'], matchedTeam:true}) };
  if (u.indexOf('/api/worktime/records') >= 0 && method === 'GET') {
    await new Promise(r => setTimeout(r, window.__mockDelay));
    return { json: async () => ({success:true, records:window.__mockRecs}) };
  }
  return { json: async () => ({success:true}) };
};
window.pingHeartbeat = async function() { return {ok:true}; };
""".replace('__REC_PLACEHOLDER__', json.dumps([REC], ensure_ascii=False))

SETUP = """
empData = {id:1, name:'TEST', emp_number:'ST001', level:'senior'};
wtTypes = ['PC','TC','RC'];
wtHolidays = {};
document.getElementById('wtDate').value = '2026-11-06';
"""

# A1: 慢網絡，用戶喺 fetch 未返之前入咗「同一批單號」嘅完整資料 → 應該淨係 6 張完整單
SCEN_A1 = """
async () => {
  const box = document.getElementById('wtJobs');
  const rows = () => Array.from(box.querySelectorAll('.wt-job'));
  box.innerHTML = '';
  const p = window.showWorktime();
  await new Promise(r => setTimeout(r, 150));
  for (let i = 1; i <= 6; i++)
    window.wtAddJob({client_no:'A'+i, start:'09:00', end:'10:00', types:['PC'], remarks:'done'});
  await p;
  return {final: rows().length,
          nos: rows().map(r => r.querySelector('.wt-client').value),
          filled: rows().filter(r => r.querySelector('.wt-start').value === '09:00').length};
}
"""

# A2: 用戶入咗「另一批」單號 → 兩批都要保留（證明修復唔會誤刪用戶資料）
SCEN_A2 = """
async () => {
  const box = document.getElementById('wtJobs');
  box.innerHTML = '';
  const p = window.showWorktime();
  await new Promise(r => setTimeout(r, 150));
  for (let i = 1; i <= 6; i++)
    window.wtAddJob({client_no:'U'+i, start:'09:00', end:'10:00', types:['PC']});
  await p;
  return {final: box.querySelectorAll('.wt-job').length,
          nos: Array.from(box.querySelectorAll('.wt-client')).map(i => i.value)};
}
"""

# B: 兩次 wtDateChange 並行（快速改日期／撳兩下工時頁）
SCEN_B = """
async () => {
  const box = document.getElementById('wtJobs');
  box.innerHTML = '';
  const p1 = window.wtDateChange(), p2 = window.wtDateChange();
  await Promise.all([p1, p2]);
  return {final: box.querySelectorAll('.wt-job').length,
          nos: Array.from(box.querySelectorAll('.wt-client')).map(i => i.value)};
}
"""

# C: 對照 — 導入排單嘅防重複仍然有效
SCEN_C = """
async () => {
  const box = document.getElementById('wtJobs');
  box.innerHTML = '';
  for (let i = 1; i <= 6; i++) window.wtAddJob({client_no:'A'+i, start:'09:00', end:'10:00', types:['PC']});
  const before = box.querySelectorAll('.wt-job').length;
  await window.wtImportSchedule({files:[{}], value:''});
  return {before, after: box.querySelectorAll('.wt-job').length};
}
"""

# D: 當日無記錄，但用戶喺載入期間入咗單 → 唔可以被空白單顶走
SCEN_D = """
async () => {
  window.__mockRecs = [];
  const box = document.getElementById('wtJobs');
  box.innerHTML = '';
  const p = window.wtDateChange();
  await new Promise(r => setTimeout(r, 150));
  for (let i = 1; i <= 3; i++) window.wtAddJob({client_no:'N'+i, start:'09:00', end:'10:00', types:['PC']});
  await p;
  return {final: box.querySelectorAll('.wt-job').length,
          nos: Array.from(box.querySelectorAll('.wt-client')).map(i => i.value)};
}
"""


def main():
    results = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        cases = [
            ('A1 慢網絡+同號完整單', SCEN_A1,
             lambda o: o['final'] == 6 and o['filled'] == 6 and o['nos'] == ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']),
            ('A2 慢網絡+另一批單(唔誤刪)', SCEN_A2,
             lambda o: o['final'] == 12 and len(o['nos']) == 12),
            ('B 兩次載入並行', SCEN_B, lambda o: o['final'] == 6),
            ('C 導入防重對照', SCEN_C, lambda o: o['after'] == o['before']),
            ('D 無記錄+用戶已入單', SCEN_D,
             lambda o: o['final'] == 3 and o['nos'] == ['N1', 'N2', 'N3']),
        ]
        for label, script, ok in cases:
            pg = b.new_page()
            pg.add_init_script(INIT)
            pg.goto((BASE / 'index.html').as_uri())
            pg.wait_for_timeout(250)
            pg.evaluate(SETUP)
            try:
                out = pg.evaluate(script)
                passed = ok(out)
                print(('PASS' if passed else 'FAIL'), '|', label, '|', json.dumps(out, ensure_ascii=False))
                results.append(passed)
            except Exception as e:
                print('FAIL |', label, '| ERROR', str(e)[:200])
                results.append(False)
            pg.close()
        b.close()
    print('=== %d/%d passed ===' % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
