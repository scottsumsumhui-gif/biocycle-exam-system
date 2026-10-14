# 員工職級 LIST (線上版 prod)

**可用職級選項 (job_levels)：junior (初級技術員) / senior (高級技術員) / supervisor (技術員主管) / a (Assistant Accounting Manager) / b (技術員經理) / c (DGM) / d (技術員副主管) / g (GM) / e (見習技術員) / f (見習高級技術員) / h (見習技術員副主管) / i (見習技術員主管)**

| 員工編號 | 姓名 | 現職級 key | 現職級 label | 組別 | 新職級 key (填返) |
|---|---|---|---|---|---|
| GH | GH | a | Assistant Accounting Manager |  |  |
| Helen | Helen Lai | c | DGM |  |  |
| Jackson | Jackson | g | GM | A |  |
| ST021 | Wong Tak Wai | supervisor | 技術員主管 | A |  |
| ST065 | Lee Kwok Keung | b | 技術員經理 |  |  |
| ST082 | Lee Kin Fai | d | 技術員副主管 | E |  |
| ST105 | Mok Chung Ming | d | 技術員副主管 | E |  |
| ST130 | Pang Kwok Ho | d | 技術員副主管 | E |  |
| ST140 | Hui Sum Sum | b | 技術員經理 |  |  |
| ST188 | Ho Chun Hin | senior | 高級技術員 | D |  |
| ST199 | Chan Chu Ming | senior | 高級技術員 | C |  |
| ST273 | Chan Wing Hong | junior | 初級技術員 | C |  |
| ST320 | Leung Chin Nam | senior | 高級技術員 | B |  |
| ST334 | Lau Chun Wai Oscar | senior | 高級技術員 | E |  |
| ST340 | Eddie Mo | b | 技術員經理 |  |  |
| ST348 | Cheng Man Chun | senior | 高級技術員 | B |  |
| ST360 | Ma Chun Man | junior | 初級技術員 | A |  |
| ST388 | Kwok Chun Hong | senior | 高級技術員 | D |  |
| ST396 | Ling Wai Tak | junior | 初級技術員 | C |  |
| ST403 | Wong Ho Yin | junior | 初級技術員 | D |  |
| ST405 | Wong Ping Fuk | junior | 初級技術員 | B |  |
| ST410 | Yu Hon Leung | junior | 初級技術員 | D |  |
| ST411 | Alvin Baluyut | senior | 高級技術員 | A |  |
| ST418 | Lo Chun Wai | junior | 初級技術員 | C |  |
| ST419 | Wong King Pang | junior | 初級技術員 | A |  |
| ST433 | WONG CHEUK YIN | junior | 初級技術員 | B |  |
| ST435 | Cheuk Chun Cheung | junior | 初級技術員 | C |  |
| ST439 | Li CHI HUNG | junior | 初級技術員 | A |  |
| ST443 | CHEN SIQI | junior | 初級技術員 | A |  |
| ST444 | NG KIT YING | junior | 初級技術員 | A |  |


共 30 人。

## 用法
- 編輯 `employees_levels_edit.csv` 嘅 `new_level_key` 欄（填 junior/senior/supervisor/d 等），save 後交返俾我，我幫你批量 `PUT /api/admin/employees/:id` 更新。
- 注意：改 `level` 會影響該員嘅考試題型（junior=20MC / senior=20MC / d=20MC / supervisor=20MC+3作文）。
