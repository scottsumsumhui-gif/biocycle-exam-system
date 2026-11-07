"""#5 車隊明細快速切車 — 真 Chromium 回歸測試（mock 慢網絡，唔連 prod）。

修復前：慢回嘅 A 車會覆蓋畫面／表單，但 global 已係 B 車 → 出車／入油寫入錯車。
修復後：過期 fetch 回覆丟棄、載入未完唔准寫入、heartbeat 期間轉車即中止寫入。
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(r'C:\Users\Sum\WorkBuddy\2026-06-28-22-52-03\exam-system\public').resolve()

INIT = """
window.__posts = [];
window.__delay = {AAA: 800, BBB: 100};
window.__calls = 0;
window.fetch = async function(url, opts) {
  const u = String(url);
  const method = (opts && opts.method) ? opts.method.toUpperCase() : 'GET';
  if (method !== 'GET' && u.indexOf('/api/fleet/') >= 0) {
    window.__posts.push({url: u, body: (opts && opts.body) ? JSON.parse(opts.body) : null});
  }
  const m = u.match(/\\/api\\/fleet\\/vehicles\\/([^?/]+)/);
  if (m && method === 'GET') {
    const plate = decodeURIComponent(m[1]);
    window.__calls++;
    await new Promise(r => setTimeout(r, window.__delay[plate] === undefined ? 30 : window.__delay[plate]));
    const last = plate === 'AAA' ? 1000 : 2000;
    return { json: async () => ({
      success: true,
      vehicle: {plate: plate, alias: '', last_mileage: last, is_out: false, active_trip: null},
      stats: {total_km: 100, fuel_cost: 50, cost_per_km: 0.5},
      trips: [], fuels: [], maintenance: [], repairs: []
    })};
  }
  if (u.indexOf('/api/fleet/vehicles') >= 0 && method === 'GET')
    return { json: async () => ({success: true, vehicles: []}) };
  if (u.indexOf('/api/fleet/records') >= 0)
    return { json: async () => ({success: true, records: []}) };
  return { json: async () => ({success: true}) };
};
"""

SETUP = """
fleetDetailSeq = 0;
fleetDetailReady = false;
fleetCurrentPlate = null;
fleetVehicles = [{plate:'AAA', last_mileage:1000}, {plate:'BBB', last_mileage:2000}];
window.__posts = [];
window.__calls = 0;
window.pingHeartbeat = async function() { return {ok:true}; };
window.alert = function() {};
window.confirm = function() { return true; };
"""

# 1. A 慢、B 快：最終一定要係 B 車（畫面 + global + 表單值）
SCEN_A_SLOW = """
async () => {
  window.__delay = {AAA: 800, BBB: 100};
  const p1 = window.openFleetVehicle('AAA');
  await new Promise(r => setTimeout(r, 60));
  const p2 = window.openFleetVehicle('BBB');
  await Promise.all([p1, p2]);
  return {
    plate: fleetCurrentPlate,
    title: document.getElementById('fleetDetailTitle').textContent,
    mileage: document.getElementById('fleetDepartMileage').value,
    ready: fleetDetailReady,
    buttons: document.getElementById('fleetActionBar').innerHTML.indexOf('入油') >= 0
  };
}
"""

# 2. A 快、B 慢（反向）：一樣要係 B 車
SCEN_B_SLOW = """
async () => {
  window.__delay = {AAA: 60, BBB: 500};
  const p1 = window.openFleetVehicle('AAA');
  await new Promise(r => setTimeout(r, 40));
  const p2 = window.openFleetVehicle('BBB');
  await Promise.all([p1, p2]);
  return {
    plate: fleetCurrentPlate,
    title: document.getElementById('fleetDetailTitle').textContent,
    mileage: document.getElementById('fleetDepartMileage').value,
    ready: fleetDetailReady
  };
}
"""

# 3. 載入未完撳「出車」→ 唔可以發出任何 POST
SCEN_DURING_LOAD = """
async () => {
  window.__delay = {AAA: 700, BBB: 30};
  const p = window.openFleetVehicle('AAA');
  await new Promise(r => setTimeout(r, 100));
  document.getElementById('fleetDepartMileage').value = '1234';
  await window.submitFleetDepart();
  await p;
  return {posts: window.__posts.length, ready: fleetDetailReady,
          plate: fleetCurrentPlate};
}
"""

# 4. heartbeat await 期間轉車 → 唔可以發出任何 POST
SCEN_SWITCH_DURING_WRITE = """
async () => {
  window.__delay = {AAA: 30, BBB: 30};
  await window.openFleetVehicle('AAA');
  document.getElementById('fleetDepartMileage').value = '1100';
  window.pingHeartbeat = async function() {
    await new Promise(r => setTimeout(r, 300));
    return {ok:true};
  };
  const w = window.submitFleetDepart();
  await new Promise(r => setTimeout(r, 80));
  const s = window.openFleetVehicle('BBB');
  await Promise.all([w, s]);
  return {posts: window.__posts.length, plate: fleetCurrentPlate,
          ready: fleetDetailReady};
}
"""

# 5. 正常情況仍然寫入得，而且 plate 正確
SCEN_NORMAL = """
async () => {
  window.__delay = {AAA: 30, BBB: 30};
  await window.openFleetVehicle('AAA');
  document.getElementById('fleetDepartMileage').value = '1050';
  await window.submitFleetDepart();
  return {posts: window.__posts.length,
          plate: window.__posts.length ? window.__posts[0].body.plate : null,
          ready: fleetDetailReady};
}
"""


def main():
    results = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        cases = [
            ('A慢B快 → 最終 B 車', SCEN_A_SLOW,
             lambda o: o['plate'] == 'BBB' and 'BBB' in o['title'] and o['mileage'] == '2000'
                       and o['ready'] is True and o['buttons'] is True),
            ('A快B慢 → 最終 B 車', SCEN_B_SLOW,
             lambda o: o['plate'] == 'BBB' and 'BBB' in o['title']
                       and o['mileage'] == '2000' and o['ready'] is True),
            ('載入中寫入被擋', SCEN_DURING_LOAD,
             lambda o: o['posts'] == 0 and o['ready'] is True and o['plate'] == 'AAA'),
            ('寫入中途轉車被擋', SCEN_SWITCH_DURING_WRITE,
             lambda o: o['posts'] == 0 and o['plate'] == 'BBB'),
            ('正常寫入仍然得', SCEN_NORMAL,
             lambda o: o['posts'] == 1 and o['plate'] == 'AAA' and o['ready'] is True),
        ]
        for label, script, ok in cases:
            pg = b.new_page()
            pg.add_init_script(INIT)
            pg.goto((BASE / 'index.html').as_uri())
            pg.wait_for_timeout(200)
            pg.evaluate(SETUP)
            try:
                out = pg.evaluate(script)
                passed = ok(out)
                print(('PASS' if passed else 'FAIL'), '|', label, '|', json.dumps(out, ensure_ascii=False))
                results.append(passed)
            except Exception as e:
                print('FAIL |', label, '| ERROR', str(e)[:300])
                results.append(False)
            pg.close()
        b.close()
    print('=== %d/%d passed ===' % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
