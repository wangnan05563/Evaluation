# T06189 增强项目自动分类 · 验收报告

- 任务：MTask `T06189`《[PRD] 开发增强项目自动分类》
- 任务 ID：`0743f9f5-a509-478b-8e4b-dfc38f3326d3`
- 优先级：urgent
- 验收日期：2026-11-24
- 结论：**通过（实现 / 单测 / API / UI / 响应式 / 无障碍 / 导出均已闭环）**

## 1. 口径与实现范围

按任务描述与 PRD `E5-S3` 实现增强项目分类，输出 IFPUG 增强功能点：

\[
EFP = ADD + CHGA + CFP + DEL
\]

\[
更新后 UFP = 基线 UFP + ADD + CHGA - CHGB - DEL
\]

其中 CFP（转换功能）计入 EFP，但不计入应用更新后 UFP。

> 口径差异已记录：任务 description 写 `AC-15`，关联验收项写 `AC-12`；PRD 正文未检索到 `REQ-011` 字面。实现以任务描述 + PRD E5-S3 的 EFP 公式为准，未擅自改写 AC 编号。

### 分类规则

| 场景 | 自动建议 | 匹配可信度 |
|---|---|---|
| `stable_id` 相同且字段变化 | CHG | 高 |
| 当前 `replaces_id` 指向基线旧 ID（类型变更） | CHG | 高 |
| 当前存在、基线无同 ID 项 | ADD | 高 |
| 基线存在、当前缺失 | DEL | 中/高 |
| 当前 `modify=删除` | DEL | 高 |
| 当前 `modify=修改` | CHG | 高 |
| 基线或当前 `conversion=true` | CFP | 高 |
| 仅按 `(desc, system)` 兼容匹配且无变化 | UNCHANGED | 低 |
| 完全相同 | UNCHANGED | 高 |

匹配优先级：`stable_id` > `replaces_id` > `(desc, system)` 兼容匹配。兼容匹配只作为低可信建议，不替代人工复核。

## 2. 交付内容

### 后端

- `scripts/enhancement.py`：纯函数分类器，不写库、不自动确认；返回每行 `auto / final / confidence / reason_codes / field_changes / reviewed`。
- `scripts/server.py`：新增 `POST /api/enhancement/classify`。
  - 请求：`{baseline, current, method, cx_mode}`
  - 响应：`rows / suggested_counts / totals / coverage / formula / rules_version`
  - 8MB 请求体上限；非法类型、非数组返回 400；不落库、不修改历史。
- `tests/enhancement.py`：20 项分类器单测。
- `tests/enhancement_api.py`：8 项 API 冒烟。

### 前端

- `frontend/src/js/36_enhancement.js`
  - 结果页导出菜单入口「增强项目分类（EFP）」；
  - 基线版本下拉 + 导入基线 JSON；
  - KPI：ADD / CHG / DEL / CFP / UNCHANGED / EFP；
  - 每行可改最终分类、勾选复核；改判行高亮 `mismatch`；
  - 「全部标记已复核」仅标记复核，不改变自动建议；
  - 导出前强制检查 12/12 行已复核；
  - CSV 输出稳定 ID、自动建议、最终分类、是否改判、复核状态、依据与公式合计；
  - JSON 输出 `rules_version / method / cx_mode / formula / totals / rows`；
  - Esc 关闭、Tab 焦点陷阱、i18n 动态文案。
- `frontend/src/css/64_enhancement.css`：1440 / 1024 / 768 响应式；1024 四列 KPI、768 三列 KPI 与表格容器横向滚动。
- `frontend/src/index.src.html`：导出菜单入口 + `#enhOverlay` 弹层骨架。
- `data/i18n/zh-CN.json`、`en-US.json`：新增 58 个键，共 1026 键；中英 key 对齐。

## 3. 测试证据

| 测试 | 结果 | 证据 |
|---|---|---|
| 分类器单测 | **20/20** | `results/enhancement-unit.json` |
| 分类 API | **8/8** | `results/enhancement-api.json` |
| 增强分类 UI | **23/23** | `results/ui-enhancement.json` |
| i18n 键校验 | **0 失败**，1026 键 | `tests/i18n_check.py` |
| 伪本地化回归 | **10/10** | `results/ui-i18n-pseudo.json` |

### 关键数值

- 合成基线 10 项 / 当前 10 项：ADD 2、CHG 3、DEL 3、CFP 1、UNCHANGED 3。
- 自动分类准确率：**100%（12/12 行与金标准一致）**。
- EFP = 55；更新后 UFP = 58；基线 UFP = 62 / 当前 UFP = 62；CHGB = 13、DEL = 18、CFP = 10。
- 人工改判 `F11 ADD → UNCHANGED` 后：EFP 51、更新后 UFP 54；CSV 中 F11 保留稳定 ID、自动建议 ADD、最终分类 UNCHANGED、是否改判=是。
- 默认 0 行已复核、导出按钮禁用；点击「全部标记已复核」后 12/12，导出解锁。
- 历史基线路径：历史库新组会重新发号，10 项历史基线与当前按 `(desc, system)` 兼容匹配 7 项，输出 13 行、ADD 3/CHG 2/DEL 4/CFP 1；该路径同样只给建议，需人工复核。
- 稳定 ID 导入路径：12 行、ADD 2/CHG 3/DEL 3/CFP 1，自动标签与金标准逐项一致。

### UI 验收

- 入口：结果页导出菜单显示「增强项目分类（EFP）」。
- 1440：完整表格、KPI、复核与导出；`enhancement_1440.png`。
- 1024：无页面级横向溢出，表格完整落入容器；`enhancement_1024.png`。
- 768：无页面级横向溢出，宽表在容器内横向滚动；`enhancement_768.png`。
- 英文态：标题、按钮、分类标签、动态状态/进度均本地化；`enhancement_en_1440.png`。
- WCAG A/AA：增强分类弹层严重/阻断 0（axe `color-contrast` 已通过）。

### 回归

改动涉及 `frontend/index.html`、全局 CSS 与 i18n；已复跑：

- `review-workbench`：18/18
- `a11y-wcag22`：17/17
- `review-efficiency`：13/13
- `role-onboarding`：16/16
- `single-machine`：通过
- `empty-error`：通过
- `i18n-pseudo`：10/10（修复 1024px 隐藏 tooltip 导致的横向溢出）

## 4. 已知边界

1. CFP 自动识别依赖数据中的 `conversion=true`；复核表未单独提供「转换功能」开关，但最终分类下拉可人工改为 CFP，满足人工兜底。
2. 历史库新版本组会重新分配稳定 ID；跨版本稳定匹配依赖同组修订或导入带 `stable_id` 的基线 JSON。`(desc, system)` 兼容匹配在 UI 中明确标为低可信。
3. `/api/enhancement/classify` 是无状态计算接口，不保存分类结果；结果通过前端 CSV/JSON 导出留档。
4. 任务 description 的 `AC-15` 与关联验收项 `AC-12` 编号不一致，已在实现与回写中保留差异说明。

## 5. 结论

T06189 已完成 ADD / CHG / DEL / CFP 自动分类、人工逐项复核、EFP / 更新后 UFP 计算与 CSV/JSON 导出；自动分类只建议不确认，导出强制全量复核。单测、API、UI、响应式、无障碍与相关回归均通过，可以提交并回写 MTask。
