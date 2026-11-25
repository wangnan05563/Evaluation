# T06203 全量 P0/P1 AC 验收测试 · 验收报告

- 任务：MTask `T06203`《[PRD] 执行全量AC验收测试》
- 任务 ID：`2270be42-6f0e-4b41-9e5c-a0ff39ef0720`
- 优先级：urgent
- 验收日期：2026-11-25
- 结论：**T06203 关联的 AC-01 / AC-05 / AC-11 / AC-14 全部本轮实测通过（76/76 检查）**；全量 P0/P1 尚余 AC-03，按 serial 计划由 T06204 承接。

## 1. 验收口径

任务 description 要求“运行所有 P0/P1 验收标准测试用例”，关联准则列出 `AC-14`、`AC-01`、`AC-05`、`AC-11`。本轮以关联准则为准执行这 4 项；AC-03（10k 行滚动性能）不在关联准则内，且其计划行 serial 后继 T06204 的任务描述明确覆盖 10k 行性能、视觉回归与 WCAG，因此不在 T06203 内重复执行。

MTask 矩阵 40 项 AC 中，P0/P1 共 32 项：本轮前 27 项 done、5 项 doing（AC-01/03/05/11/14）。本轮闭环其中 4 项后，P0/P1 剩余 1 项 AC-03。

验收环境：Windows 本机，`tests/phase3/run_phase3.mjs` 为每个套件启动隔离 API（8033）与独立 CDP 页面（9335），每个套件使用独立临时 DATA 目录，不触碰真实用户数据。

## 2. 结果总览

| AC | 验收项 | 套件 | 结果 | 证据 |
|---|---|---|---|---|
| AC-01 | 主题 JSON 零代码生效 | `theme-tokens` | **23/23 PASS** | `t06203-theme.log` |
| AC-05 | 复核效率提升 | `review-efficiency` | **13/13 PASS** | `t06203-review.log` |
| AC-11 | 稳定 ID 跨版本一致 | `stable-ids` | **20/20 PASS** | `t06203-ids.log` |
| AC-14 | 蒙特卡洛性能 | `montecarlo` | **20/20 PASS** | `t06203-mc.log` |

合计 **76/76 检查通过**，结构化结果见 `results/t06203-ac.json`。

## 3. 分项结果

### AC-01 主题 JSON 零代码生效（23/23 PASS）

- 内置 `base`、`lime` 两个主题均可导出 `raw / semantic / component / resolved / contrast` 完整三层 JSON。
- 非法 raw 引用被校验拦截，返回 2 条带定位的错误（`semantic.brand`、`component.button.primary.background`）。
- `lime` 主题应用后持久化，DOM `tokens=lime`，`component.button.primary.background=#84CC16`，实际按钮颜色 `rgb(132, 204, 22)`，现有按钮组件未改代码即生效。
- 图表调色板读取同一主题变量（brand、muted、grid、tipBg、tipInk、ink、card）。
- 刷新/重开后主题与配置面板恢复；JSON 文件导入 `custom-orange` 立即生效，按钮 `rgb(255, 102, 0)`；重置后恢复 `#2563EB`，服务端无自定义主题。
- 页面 JS 异常 0。

### AC-05 复核效率提升（13/13 PASS）

- 样本 100 条：80 条低风险、20 条高风险。
- 基线全部逐条确认：**29121.9 ms**，100 条全部确认。
- 优化路径：`A` 一键确认 80 条低风险，再用 `J/K` 切换、`C` 确认并自动下一条处理 20 条高风险，总耗时 **2040 ms**，100 条全部确认。
- 降幅 **93.0%**（为基线的 7.0%），远超 ≥30% 验收线。
- `ReviewPerf` 记录 21 个动作、100 项确认，`duration_ms=2039`。

### AC-11 稳定 ID 跨版本一致（20/20 PASS）

- 第 1 版生成 3 个稳定 ID：`F-C171867411`、`F-C093892790`、`F-539C560B7E`。
- 第 2、3 版 ID 完全不变，`version_no` 递增；描述改名不改 ID，diff 归为 `changed=1` 且含 `desc` 字段。
- 第 1 项类型由 ILF 改为 EI 后生成新 ID `F-9EBAC58BD5`，`replaces_id=F-C171867411`；旧版本仍保留旧 ID。
- 映射表校验 `rows=5 / items=15 / mapped=4 / issues=[]`。
- 另存新项目重新发号，不沿用旧组 ID；导出 zip 后历史与稳定 ID 仍可读。
- 复核页每行显示稳定功能 ID，无页面异常。

**首轮失败与修正**：首次执行 `stable-ids` 为 0/3 FAIL，`/api/generate` 首版返回 `ok=false`，随后 `GET /api/history/undefined` 触发 `TypeError: Cannot read properties of undefined (reading 'version_group')`。根因是测试夹具的 3 条 items 未声明 `origin`，被 AC-19 证据门视为 AI 候选；缺少 `evidence.quote` 时接口按设计返回 400。修正为在夹具显式标注 `origin='manual'`（人工录入，不属于 AI 候选），复跑 20/20 PASS。这是测试夹具随 AC-19 上线产生的漂移，不是产品缺陷。

### AC-14 蒙特卡洛性能（20/20 PASS）

- 200 任务 / 10000 次模拟，固定 seed `424242`：服务端计时 **1260 ms**，wall 1281 ms，满足 ≤2s。
- P50/P80/P95 = 2316.29 / 2354.74 / 2391.28 天，顺序正确；达标概率 36.3%。
- 敏感性 Top5 返回 5 项且按方差贡献降序；三情景（乐观/基准/保守）均返回 P50/P80/P95，基准与整体分位一致。
- 固定种子结果完全可复现，不同种子结果不同。
- 少于 1000 次模拟 400、负数目标 400、不存在项目 404。
- UI 显示 P50/P80/P95、达标概率、敏感性表 5 行、情景表 3 行、固定种子与耗时；UI 侧模拟耗时 438 ms，无页面异常。

## 4. P0/P1 缺口与缺陷口径

- 本轮没有发现新的 P0/P1 产品缺陷；MTask 任务表中无未关闭的 P0/P1 缺陷任务。
- P0/P1 AC 矩阵仍有 **AC-03** 未闭环（10k 行滚动性能），属于未执行验收项，不是已知缺陷；由 T06204 执行并收口视觉回归与 WCAG。
- 因此本报告只声明 **T06203 关联 4 项 AC 全部通过**，不声明“全项目 P0/P1 AC 已 100% 通过”。

## 5. 历史审计冲突

`results/ac-remaining-audit.json`（T06207）曾判定 AC-31、AC-32、AC-33、AC-35 `NOT_IMPLEMENTED`、AC-34 `PARTIAL`，而 MTask 矩阵中这 5 项均为 `done`。本轮未对这 5 项做新的实测，也不据此推翻审计结论；该编号/范围冲突保留，需在 T06204 或后续专项复核中处理，不能仅凭矩阵状态宣称全量 AC 已全部实现。

## 6. 结论

AC-01、AC-05、AC-11、AC-14 四项 P0 验收本轮均以真实 UI/API 链路跑通，76/76 检查通过，证据完整。T06203 可以提交并回写 MTask；项目级“全量 P0/P1 AC 通过”仍需 T06204 完成 AC-03 后才能成立。
