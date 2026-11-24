# T06194 稳定 ID 跨版本一致性 · 验收报告

- 任务：MTask `T06194`《[PRD] 验证稳定ID跨版本一致性》
- 任务 ID：`c82c47d5-b65b-4f8f-99f0-061b1d16e4cd`
- 优先级：urgent
- 验收日期：2026-11-24
- 结论：**通过（3 版本迭代 / 导出 / 导入全新目录 / 重开 / 类型变更链全部闭环）**

## 1. 口径

- 任务 description 写“验收项：AC-14”，关联准则写 `AC-11`。本次按关联准则与行为定义执行 AC-11：同一项目 3 个版本，导出 / 导入 / 重开后功能 ID 不变、映射表校验通过、无数据丢失。
- T06194 是验证任务，不新增产品功能；测试使用真实 `HistStore` 与 `datakeeper.export_zip/import_zip`，在临时目录隔离运行，不触碰真实用户数据。

## 2. 测试方法

1. 在临时数据目录创建 `pert.db`、`schema_ver` 和 `estimation.db`。
2. 同一项目写入 3 个版本：v1 基线 3 项；v2 原样重开；v3 改名但携带 `stable_id`。
3. 校验 3 个版本的 `version_no`、`stable_id` 和 `item_id_map`。
4. `datakeeper.export_zip` 生成真实数据包，检查 `pert.db + estimation.db + schema_ver`。
5. `datakeeper.import_zip` 导入全新目录，重新打开 v1/v2/v3，逐字段比对。
6. 导入后重开 v4，再对第 1 项做类型变更生成 v5，校验 `replaces_id` 替换链。

## 3. 结果

| 检查 | 结果 |
|---|---|
| 第 1 版生成 3 个稳定 ID | PASS：`F-F53B2C01B3` / `F-2AE58F250E` / `F-E4FC4C1CD4` |
| 第 2 版稳定 ID 不变 | PASS |
| 第 3 版改名但 ID 不变 | PASS |
| 3 个版本 version_no | PASS：1 / 2 / 3 |
| 导出前映射表 | PASS：rows=3、items=9、mapped=3、issues=[] |
| 导出包 | PASS：`pert.db`、`estimation.db`、`schema_ver`，zip 可读，1850 B |
| 导入全新目录 | PASS：3 个文件全部导入 |
| 导入后 v1/v2/v3 稳定 ID | PASS：三版 ID 均与导出前一致 |
| 导入后明细字段 | PASS：desc / type / system / count_item 与导出前一致 |
| 导入后映射表 | PASS：rows=3、items=9、mapped=3、issues=[] |
| 导入后重开 v4 | PASS：ID 不变，version_no=4，diff 仅 1 条改名 |
| 导入后类型变更 v5 | PASS：新 ID `F-44A1A17B5E`，`replaces_id=F-F53B2C01B3` |
| 最终替换链 | PASS：rows=5、items=15、mapped=4、issues=[] |

- 新测试：`tests/phase3/stable_ids_versions.py` **19/19**，结果 `results/stable-ids-versions.json`。
- 既有 API/UI 回归：`tests/phase3/ui_stable_ids.mjs` **20/20**，覆盖 5 个版本、diff、映射表、数据导出、复核页稳定 ID 展示。
- 截图：`screenshots/stable_ids_review_1440.png`（复核页每行显示稳定 ID）。

## 4. 已知边界

1. 本测试覆盖存储层真实导出/导入代码路径；浏览器“上传 zip → 导入”交互未单独点击验证，但 `/api/data/import` 调用的就是同一个 `datakeeper.import_zip`。
2. 测试使用最小 `pert.db` 占位，不校验 PERT 业务数据；本次只验证估算历史库与稳定 ID 映射，不涉及 PERT 数据迁移。
3. 3 个版本指同一项目版本组内的 v1–v3；另存新项目重新发号由 T06187 单测与 `ui_stable_ids` 覆盖。

## 5. 结论

AC-11 要求的 3 版本导出、导入、重开、ID 不变、映射表通过、无数据丢失均已实测通过；导入后继续重开和类型变更也能保持替换链完整。T06194 可以提交并回写 MTask。
