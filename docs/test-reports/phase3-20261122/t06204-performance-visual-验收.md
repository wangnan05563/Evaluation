# T06204 性能与视觉回归扫描 · 验收报告

- 任务：MTask `T06204`《[PRD] 性能与视觉回归扫描》
- 任务 ID：`8024965d-0f72-439b-b6af-25bb59f3ff9e`
- 优先级：urgent
- 验收日期：2026-11-25
- 结论：**通过**。AC-03 实测 60.0fps / 60 秒 / 无白屏；交互 p95 64.7ms 与 60.9ms（≤150ms）；视觉 6/6 基线一致；WCAG serious/critical 0 阻断。

## 1. 验收口径

任务 description 要求自动化扫描 10k 行性能、视觉回归、无障碍阻断，完成定义为 `p95≤150ms`、`视觉无破版`、`WCAG 0 阻断`；关联准则为 AC-03：10000 行 8 列连续滚动 60 秒，帧率 ≥60fps 且无白屏。

本轮使用真实前端、隔离 API（8033）与 Chrome headless（GPU 合成，1440×900），三个套件各自使用独立临时 DATA 目录，不触碰真实用户数据。

- 性能/视觉门槛：`tests/phase3/regression_baseline.mjs`
- 10k 帧率：`tests/phase3/ui_10k_grid.mjs`
- 无障碍：`tests/phase3/ui_a11y_wcag22.mjs`

## 2. 结果总览

| 套件 | 检查 | 结果 | 证据 |
|---|---|---|---|
| `regression-baseline` | 12/12 | **PASS** | `t06204-baseline.log` |
| `ui-a11y-wcag22` | 17/17 | **PASS** | `t06204-a11y.log` |
| `ui-10k-grid` | 9/9 | **PASS** | `t06204-10k.log` |

合计 **38/38 检查通过**，结构化结果见 `results/t06204-regression.json`。

## 3. AC-03 10k 行滚动性能

- 数据：10000 行 × 8 列（seq / system / desc / count_item / type / cx / reuse / modify）。
- 连续滚动 60 秒：**60.007fps / 3601 帧 / 60009.5ms**，达到 AC-03 的 ≥60fps。
- 白屏采样 **0**；DOM 虚拟窗口始终 7 行（≤120）；滚动容器 `clientHeight=300`、`scrollHeight=440000`，可滚到末尾 `439700/439700`，末尾窗口包含第 10000 行。
- 长帧（>20ms）**2 帧 / 0.06%**，远低于 10% 门槛。
- 隔离诊断：关闭 `refreshTotals` 后 60.2fps；同时关闭 `refreshTotals + lucide` 后 60.0fps、平均 render 5.8ms、599 次调用；`table-layout:fixed` 59.9fps。说明 60fps 不是靠单一取巧路径达标。

截图：`screenshots/10k_start_1440.png`、`screenshots/10k_end_1440.png`。

## 4. 交互 p95 性能

| 指标 | 实测 | 门槛 | 结果 |
|---|---|---|---|
| 10k 复核页 render p95 | 64.7ms（n=30） | ≤150ms | PASS |
| 10k 复核页搜索输入 p95 | 60.9ms（n=30） | ≤150ms | PASS |
| 首屏 FCP | 532ms | ≤2s | PASS |
| DCL | 611.1ms | ≤2s | PASS |
| 导航到可交互 | 784ms | ≤3s | PASS |

首轮基线扫描曾测得 render p95 26.8ms、input p95 22.8ms；复跑为 64.7/60.9ms，仍显著低于 150ms。差异来自 Windows 主机调度波动，不影响门槛结论。

## 5. 视觉回归

本轮 3 主题（light / dark / contrast）× 中英 = 6 张 1440×900 截图，按 SHA-256 与基线比对。

首轮结果 4/6 不一致：

- 不一致：`light_zh`、`light_en`、`contrast_zh`、`contrast_en`
- 一致：`dark_zh`、`dark_en`

定位后确认不是破版：

1. 基线建立于 2026-11-24 04:32；T06199 提交 `b5a218b` 在 22:56 将导航项 `.m-item` 的颜色从 `var(--muted)` 改为 `var(--ink-2)`。Light 主题由 `#5B6472` 变为 `#374151`，Contrast 由 `#E0E0E0` 变为 `#FFFFFF`；Dark 主题的 `ink-2` 未变，所以两张 dark 图哈希完全一致。
2. 像素差只落在顶部导航文字区域 `x=760–1248 / y=50–67`，占比 **0.186%–0.207%**，最大通道差 **31–36/255**；页面其余区域逐像素一致，无位移、无遮挡、无布局破版。
3. 执行 `regression_baseline.mjs --update-baseline` 刷新 6 张基线，再跑 `run_phase3 --only regression-baseline`，**6/6 哈希精确一致、12/12 检查通过**。

像素对比证据：`visual-diff/baseline-vs-current.json`、`visual-diff/upload_light_zh_crop_compare.png`、`visual-diff/upload_light_zh_diff8x.png`。

**测试基础设施修正**：原 `regression_baseline.mjs` 即使在非 `--update-baseline` 模式下也会把候选截图写回 `visual-baseline/`，失败时会覆盖旧基线、丢失定位依据。已改为非更新运行写入 `visual-current/`，只有显式 `--update-baseline` 才改写基线；`visual-current/` 已加入 `.gitignore`。这是测试脚本修正，不涉及产品代码。

## 6. WCAG 2.2 AA

- axe-core 4.10.2 注入成功。
- `work-upload` / `work-review-20` / `config` / `help` 四页 **serious/critical 阻断均为 0**；各页 passes 24 / 27 / 26 / 21。
- 200% 缩放（1440 物理 / 720 CSS）四页均无横向滚动：`vw=720 / doc=705 / body=705`；可见控件裁切 0。
- Accessibility 全树检查 1473 个节点，可交互控件（button/switch/link/textbox/combobox/checkbox）无空名称。
- 六步步骤条、上传拖放区、大模型开关的 `role / tabindex / aria` 键盘语义齐备。

截图：`screenshots/a11y_200pct_help_720.png`（200% 缩放全页长图）。

## 7. 缺陷与结论

- 本轮未发现新的 P0/P1 产品缺陷。
- AC-03 的 ≥60fps 与无白屏已实测满足；p95 与 WCAG 门槛均通过；视觉差异已确认是过期基线对 T06199 语义色变更的滞后，刷新后 6/6 完全一致，无破版。
- T06204 可以提交并回写 MTask。至此 MTask 矩阵 P0/P1 的 5 项 doing（AC-01/03/05/11/14）均已具备本轮通过证据。
