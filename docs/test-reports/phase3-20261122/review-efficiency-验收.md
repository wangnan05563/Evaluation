# T06186 复核效率 30% 降幅 — 验收报告

## 结论

复核页新增「确认低风险」一键批量、批量取消确认（驳回）、J/K/C/A 键盘路径；风险评分不变，只改变交互路径。100 条样本（80 低风险 + 20 高风险）实测：

- 基线（旧路径逐条打开证据抽屉 + 勾选确认）：**8,917.5 ms**
- 优化（80 条低风险一键 + 20 条高风险逐条）：**1,177.4 ms**
- 降幅 **86.8%**，远超 30% 验收线；100 条全部确认。

> 计时为浏览器 DOM 交互耗时（自动化、无人工阅读/决策停留），用于可重复的交互成本对比，不代表真实人工总工时；多轮实测降幅 53.8%–86.8%，均 ≥30%。

## 实现

- `frontend/src/js/35_review_efficiency.js`
  - `RWB.smartConfirm()`：只确认 `RWB.level() === 'low'` 的待复核项；中/高风险不动；一次 `render`、一次 undo 快照。
  - `RWB.nextPending(dir)`：按当前筛选/风险排序找下一条未确认；`RWB.confirmAndNext()` 确认当前并自动下一条。
  - 键盘：`J/K` 切换、`C` 确认并下一条、`A` 低风险批量；输入框/命令面板/角色弹窗/演示层内不触发。
  - `ReviewPerf`：本地记录 `wl_review_perf_v1`（开始/结束、items/confirmed、actions、操作序列，最多 10 条），匿名、不上传。
- `frontend/src/js/07_..._批量.js`
  - `batchUnconfirm()`：对筛选可见行批量取消确认（需 confirm 防误触）。
  - `batchConfirm()` 增加 `ReviewPerf.action("batch_confirm")`。
- `frontend/src/js/30_review_workbench.js`
  - `toggleConfirm` 增加 `ReviewPerf.action("toggle_confirm")`。
- `frontend/src/js/01_core.js`
  - 行 checkbox 变更增加 `ReviewPerf.action("row_toggle")`（此前直接点 checkbox 未计入操作日志）。
- `frontend/src/index.src.html`
  - 批量条新增「确认低风险（n）」「取消确认（批量驳回）」；dock 增 J/K/Enter/C/A 提示。
- `frontend/src/css/63_review_efficiency.css`
  - 批量按钮与快捷键提示样式；760px 以下隐藏提示，避免挤压批量按钮。
- `tests/phase3/ui_review_efficiency.mjs`、`run_phase3.mjs`
  - 13 项：数据构成、按钮、快捷键 A/J/C、批量往返、基线/优化计时、30% 门、ReviewPerf、截图。

## 实测证据

- 基线操作：100 行 ×（打开证据抽屉 + 勾选确认）= 200 次交互；`base.ms=8917.5`，100/100 确认。
- 优化操作：1 次低风险批量 + 20 次高风险逐条；`opt.ms=1177.4`，`low=80/high=20/ok=100`。
- 降幅：`(8917.5-1177.4)/8917.5 = 86.8%`。
- `ReviewPerf`：`actions=21`（1 次 smart + 20 次 row_toggle），`duration_ms=1177`，`confirmed=100`。
- 快捷键：`A` 后 80 项已确认、低风险 0；`J` 选中 81；`C` 后 81 已确认、自动选中 82。
- 批量往返：`batchUnconfirm` 后 0 确认，`batchConfirm` 后 100 确认。
- 风险评分/复核字段未被修改；智能批量只写 `ok=true`，不改变类型/复杂度/重用/修改等复核逻辑。

## 验收命令与结果

- `node tests/phase3/run_phase3.mjs --only review-efficiency`：**13/13 PASS**（基线/优化计时、30% 门、快捷键、批量往返、ReviewPerf）。
- `node tests/phase3/run_phase3.mjs --only review-workbench`：**18/18 PASS**。
- `node tests/phase3/run_phase3.mjs --only a11y-wcag22`：**17/17 PASS**（新增批量控件后复核页 axe 0 serious/critical）。
- `python tests/i18n_check.py`：968 键 0 失败。
- `python tests/unit_engine.py`：0 失败。

## 证据位置

- 截图：`docs/test-reports/phase3-20261122/screenshots/review_efficiency_1440.png`
- 结果：`docs/test-reports/phase3-20261122/results/ui-review-efficiency.json`
- 本地操作记录键：`wl_review_perf_v1`（仅本机，封顶 10 条）

## 边界

- 低风险自动确认只针对 `RWB.level()==='low'`；中/高风险仍需逐条打开证据复核，不能用 A 跳过。
- 批量取消确认会弹系统确认框，防止误触；删除仍走原确认逻辑。
- 30% 为交互耗时口径，不计人工阅读/判断；真实人工复核时长受文档质量、风险分布影响。
- 未改变 IFPUG/NESMA 计算、风险评分、类型/复杂度/重用/修改判定。
