# T06191 实际人天与 MAPE 校准 验收

- 任务：Evaluation三期 T06191（urgent，REQ-013 / AC-15）
- 结论：**通过**（17/17 自动化检查）
- 证据：`results/calibration.json`、`screenshots/calibration_pert_1440.png`

## 交付

1. 数据层 `scripts/pert.py`
   - `projects` 新增 `actual_days REAL`、`actual_note TEXT`，旧库通过 `ALTER TABLE` 幂等补列。
   - 新增 `calibration(con, min_samples=5)`：只读汇总同时具备有效三点估算与实际人天的项目，计算：
     - 单项目偏差 = 实际 - 估算，偏差率 =（实际-估算）/估算；
     - `MAPE` = 平均绝对偏差率；
     - `bias_pct` =（Σ实际/Σ估算 - 1）×100，方向 `underestimated` / `overestimated` / `balanced`；
     - `suggested_factor` = Σ实际/Σ估算，限定 0.7–1.3；不足 5 个样本返回 `ready=false`、不给系数。
2. 接口 `scripts/server.py`
   - `POST /api/pert/actual`：录入/清空实际人天与偏差原因；拒绝负数、非法数字、不存在项目；只更新 `projects`，不触碰 `pert_items`。
   - `POST /api/pert/calibration`：返回样本量、MAPE、偏差、方向、系数与逐项目明细；无写操作。
   - `POST /api/pert/projects` / `pert/list` 返回项目实际值，供 UI 回显。
3. 前端 `frontend/src/js/26_calibration.js`
   - PERT 结果页新增「实际值校准（MAPE）」卡片：当前项目实际人天/原因录入、保存、生成校准建议。
   - 建议区展示样本量、MAPE、偏差方向、建议系数与逐项目差异表，并明确「不修改历史估算」。
   - 在 `pertStep('gen')`/`pertRefresh` 时挂载与刷新，不影响既有 PERT 流程。
4. `frontend/index.html` 由干净 worktree 重建（697,284 bytes）。

## 验证

测试：`node tests/phase3/run_phase3.mjs --only calibration`，隔离 `WE_DATA` + 8033/9335，**17/17 PASS**。

关键实测：
- 4 个样本：`ready=false`、`sample_count=4`、`suggested_factor=null`；
- 第 5 个样本（5 个项目估算均 10 人天，实际 12/11/10/14/13）：`mape=20.0`、`bias_pct=20.0`、`direction=underestimated`、`factor=1.2`、`suggested_factor=1.2`；
- 文案含「样本 5 个」「MAPE 20.0%」「×1.20」「不修改历史估算」；
- 写入实际人天前后，`pert_items` 的 O/M/P 三元组完全一致；
- 负数实际人天返回 400，不存在项目返回 404；
- UI 回显实际值/原因，保存成功，生成建议表格 5 行，MAPE/方向/系数均显示；
- 无页面异常。

## 本次回写

- 提交见 MTask T06191 的 git 关联（提交后回写完整 SHA）。
- MTask：`T06191` running → progress start → git link → 本结果 → progress done → done verified。

## 下一步建议

- 可在 PERT 项目列表增加「结项」状态与批量导入实际值，当前任务未要求（仅观察不建单）。
- 校准系数目前只展示，不自动应用到新估算；若后续要「一键采用系数」，需产品确认后另立任务（仅观察不建单）。

