# 職級改名 + 考試規則改動 — 執行計劃 (未動手)

> 狀態：**只出計劃，未執行**。所有改動待你拍板才做。

## 一、最終 job_levels 表（12 個 key）

| 新 key | label | 考試 | 合格線 (20MC) | 派津貼 |
|---|---|---|---|---|
| junior | 初級技術員 | ✅ | 16 題 | ✅ |
| P.junior | 見習技術員 | ✅ | 16 題 | ✅ |
| senior | 高級技術員 | ✅ | 18 題 | ✅ |
| D.supervisor | 技術員副主管 | ✅ | 18 題 | ✅ |
| P.senior | 見習高級技術員 | ✅ | 18 題 | ✅ |
| PD.supervisor | 見習技術員副主管 | ✅ | 18 題 | ✅ |
| P.supervisor | 見習技術員主管 | ❌ 免考 | — | ❌ |
| supervisor | 技術員主管 | ❌ 免考 | — | ❌ |
| AAM | Assistant Accounting Manager | ❌ 免考 | — | ❌ |
| DGM | DGM | ❌ 免考 | — | ❌ |
| GM | GM | ❌ 免考 | — | ❌ |
| OPM | 技術員經理 | ❌ 免考 | — | ❌ |

**改名對照（舊 key → 新 key）：**
`a→AAM` / `c→DGM` / `g→GM` / `d→D.supervisor` / `b→OPM` / `e→P.senior` / `h→PD.supervisor` / `i→P.supervisor` / `f→（併入 P.senior 後刪除）` / `junior,supervisor,senior→不變`

## 二、受影響員工（9 位，level 值要搬；其餘 21 位不變）

| 員工 | 姓名 | 舊 level | 新 level |
|---|---|---|---|
| GH | — | a | AAM |
| Helen Lai | — | c | DGM |
| Jackson | — | g | GM |
| ST065 | Lee Kwok Keung | b | OPM |
| ST140 | Hui Sum Sum | b | OPM |
| ST340 | Eddie Mo | b | OPM |
| ST082 | Lee Kin Fai | d | D.supervisor |
| ST105 | Mok Chung Ming | d | D.supervisor |
| ST130 | Pang Kwok Ho | d | D.supervisor |

> 註：ST021 (supervisor)、13 位 junior、7 位 senior 完全不變。e/f/h/i 目前無員工用，只係 dropdown 定義改。

## 三、server.js 兩處 code 改動（要 commit + push Railway）

### 3.1 `getExamCriteria()`（現約 server.js:514）— 改為新 key + 過渡 alias
```js
function getExamCriteria(level) {
  // 16 題合格 (max 4 wrong)：初級 / 見習技術員
  // —— 建議最終寫法 ——
  if (level === 'junior' || level === 'P.junior')
    return { mcCount: 20, maxWrong: 4, hasEssay: false, essayCount: 0, exempt: false, criteriaLabel: '初級技術員' };
  if (level === 'senior' || level === 'D.supervisor' || level === 'P.senior' || level === 'PD.supervisor')
    return { mcCount: 20, maxWrong: 2, hasEssay: false, essayCount: 0, exempt: false, criteriaLabel: '高級技術員' };
  // 其他（supervisor / P.supervisor / AAM / DGM / GM / OPM）免考
  return { mcCount: 0, maxWrong: 0, hasEssay: false, essayCount: 0, exempt: true, criteriaLabel: '不用考試' };
}
```
> 過渡安全網：deploy 同搬數據之間有空窗，建議同時保留舊 key alias（`a/b/c/g→exempt`、`d/e/h→senior`），等數據搬完後舊 key 已從 job_levels 刪走，alias 留喺 code 無害。

### 3.2 `ALLOWANCE_EXEMPT`（現 server.js:3144）
```js
// 舊：new Set(['i','supervisor','a','b','c','g'])
// 新：免考職級 = 主管 + 見習主管 + 管理層
const ALLOWANCE_EXEMPT = new Set(['supervisor','P.supervisor','AAM','DGM','GM','OPM']);
```
> 改名後 GH/Helen/Jackson/ST065/ST140/ST340 嘅 level 變 AAM/DGM/GM/OPM，必須喺 exempt 名單，否則會錯誤開始攞津貼。

### 3.3 唔使改嘅位
- 作文：code 現狀已 `hasEssay:false / essayCount:0` 全 level，「全面取消問答題」已經係咁。
- Dashboard levelStats：靠 `criteriaLabel` 自動歸類（P.junior→初級、P.senior/PD.supervisor/D.supervisor→高級），無需改。
- guaranteed_pay：只用 supervisor/d/senior/junior（呢啲 key 唔改名），不受影響。
- 執行前需 grep 確認無其他地方 hardcode `a/b/c/d/e/f/g/h` 作 level（目前已知只 getExamCriteria + ALLOWANCE_EXEMPT）。

## 四、prod 數據改動順序（經 API，超管 ST140）

1. **先做備份**：`GET /api/admin/backup/export` 存底，萬一要 rollback。
2. **push code**（步驟三）→ Railway 自動 deploy。等 `/api/health` 顯示新 code（或 poll）。
3. **加新 key**（超管 `POST /api/admin/job-levels`，9 個）：AAM / DGM / GM / OPM / D.supervisor / P.senior / PD.supervisor / P.supervisor / P.junior（各帶 label）。
4. **搬 9 位員工**（`PUT /api/admin/employees/:id`，body `{level:'新key'}`）：按第二節表格。
5. **刪舊 key**（超管 `DELETE /api/admin/job-levels/:key`，9 個）：`a b c d e g h i f`。DELETE 會 block 有員工引用嘅 key，搬完 9 位後舊 key 零引用，可刪。
6. **verify**：`GET /api/admin/employees` 確認 30 人 level 正確；抽查 GH(exempt 免考)、ST082(18題)、P.junior 新員工(16題)；津貼板確認 GH/Helen 等唔再出津貼。

## 五、風險 & rollback
- **空窗風險**：deploy 後、搬數據前，員工仍在舊 key。靠 3.1 嘅舊 key alias 頂住（舊 key 行為不變），空窗內唔會派錯考試/津貼。
- **f 刪除**：f 目前無員工用，安全。
- **i→P.supervisor**：見習技術員主管改名，DELETE 一併刪 i 舊 key；目前 i 無員工用，零遷移風險。
- **rollback**：`git revert` 該 commit + 必要時 `/api/admin/backup/import` 還原 job_levels/employees。

## 六、執行確認清單（做嘅時候逐項剔）
- [ ] 備份 export 存底
- [ ] server.js getExamCriteria 改新 key + alias
- [ ] server.js ALLOWANCE_EXEMPT 改新名單
- [ ] commit + push + Railway deploy 確認
- [ ] POST 9 個新 key
- [ ] PUT 9 位員工 level
- [ ] DELETE 9 個舊 key (a b c d e g h i f)
- [ ] verify 30 人 + 抽查考試/津貼
