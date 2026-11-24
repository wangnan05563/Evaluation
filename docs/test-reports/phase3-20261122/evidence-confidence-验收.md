# T06195 AI 证据与置信度 · 验收报告

- 任务：MTask `T06195`《[PRD] 实现AI证据与置信度》
- 任务 ID：`71fe1a61-93a2-4ed5-93c8-f691ad4830ae`
- 优先级：high
- 验收日期：2026-11-24
- 结论：**通过（规则/模型证据、置信度、无证据阻断、审计闭环全部实测）**

## 1. 口径

- 关联需求 `REQ-018`，验收 `AC-19`、`AC-22`。
- 证据只来自上传 docx 的真实段落与表格行；模型给出的 `evidence_quote` 必须在源文档逐字命中，命中不到则丢弃，不允许用编造引用确认。
- `origin` 取 `rule` / `llm` / `manual`；低置信阈值 `0.70`；AI 候选无证据时 `can_confirm=false`，前端禁用确认、全选跳过，服务端 `/api/generate` 返回 400。
- 审计包第 5 部分新增置信度列；第 6 部分新增 `AI 逐项审计（AC-22）`：稳定 ID、模型、提示词版本、识别时间、置信度、人工决策、决策时间。

## 2. 实现

- `scripts/evidence.py`（新增）
  - `source_units` 读取 docx 段落/表格行；`attach` 为候选绑定 `{kind, locator, quote, context, verified}`、`confidence`、`origin`、`can_confirm`、`ai`；`normalize_confidence` 支持 `0.82 / 82 / "82%"`；`validate_confirmable` 返回无证据 AI 候选；`summary` 输出覆盖率与低置信数；`audit_rows` 输出 AC-22 行。
  - 提示词版本 `identify-evidence-v1`、本地规则版本 `rules-evidence-v1`、本地模型名 `本地规则`。
- `scripts/server.py`
  - `recognize_local` 为本地规则候选绑定真实证据并默认置信度（表格 0.86 / 正文 0.64）。
  - `_llm_enhance` 对补充项与本地候选统一校验证据；`_llm_refine` 的 system prompt 要求逐字 `evidence_quote` 与 0~1 `confidence`，找不到原文不输出；meta 记录模型/提示词版本/时间/证据统计。
  - `/api/recognize`、长任务 `/api/recognize/job` 的 meta 增加 `evidence.summary`。
  - `_post_generate` 在规范化后调用 `validate_confirmable`，存在无证据 AI 候选时返回 400 `gen.evidence_required`，不进入成品表。
- `frontend/src/js/01_core.js`
  - `confidenceOf` / `confBadge` / `canConfirmItem` / `isAiOrigin`；识别结果保留 `origin/confidence/evidence/can_confirm/ai`；`visibleItems` 支持低置信优先排序；行复选框与全选确认按证据门禁，确认状态写 `human_decision/decision_at`。
- `frontend/src/js/30_review_workbench.js`
  - 证据卡显示 `locator + quote`；点击 `定位原文` 在原文上下文里用 `<mark>` 高亮逐字引用；无证据时显示阻断提示、禁用定位/确认、提供人工补录；低置信优先默认开启；0% / 42% / 86% / 90% 排序实测。
- `frontend/src/js/02...js`、`07...js`、`32_audit.js`、`35_review_efficiency.js`
  - 生成 payload 携带证据/置信度/来源/决策；批量确认只确认可确认项；粘贴导入标记 `origin=manual` 并附人工证据；结果页审计 payload 使用真实 `lastRecogMeta` 和逐项 AI 审计；低置信待办只统计可确认项。
- `frontend/src/css/50_review_workbench.css`
  - 置信徽标、证据卡、原文定位高亮、人工补录、无证据阻断态。
- `data/i18n/zh-CN.json`、`en-US.json`
  - 新增 `review.confidence.*`、`review.evidence.*`、`gen.evidence_required`、`common.on/off`；中英各 1112 键，集合一致。

## 3. 结果

### 3.1 单元 / 审计包

`python tests/evidence_confidence.py`：**21/21 PASS**，结果 `results/evidence-confidence.json`。

| 检查 | 结果 |
|---|---|
| 6 个规则候选全部有证据 | PASS：6/6，定位 `表格 1 · 第 2..7 行` |
| 规则候选置信度 | PASS：86% |
| 模型补充项 | PASS：追加 2 项，共 8 项 |
| 模型逐字引用 | PASS：`校验出票人、收款人与金额` 保留 |
| 模型低置信度 | PASS：42% |
| 编造引用 | PASS：丢弃，`can_confirm=false` |
| meta 模型/提示词/时间 | PASS：`fake-evidence-model` / `identify-evidence-v1` / `2026-11-24T12:32:30+0800` |
| 生成前无证据拦截 | PASS：仅拦截 1 项编造候选 |
| 证据覆盖 | PASS：7/8，未证实 1，低置信 2 |
| AC-22 审计行 | PASS：8 行，含模型、提示词、时间、置信度、决策 |
| 审计包 PDF | PASS：8 页、目录正确、七部分齐全、字体嵌入、追溯 2 行、页脚/水印 8/8 |
| AC-08 30 秒门 | PASS：24,962 ms |
| PDF 文案 | PASS：模型、提示词、42%、人工决策、`无原文证据`（跨行时按去空白文本匹配） |

### 3.2 UI 验收

`node tests/phase3/ui_evidence_confidence.mjs`：**25/25 PASS**，结果 `results/evidence-confidence-ui.json`。

- 真实 `/api/recognize` 上传内置样例：6 项全部 `origin=rule`、置信度 86%、定位 `表格 1 · 第 2 行`、引用 `票据签发申请`，`matched=6 / unverified=0`。
- 1440 三栏布局；低置信优先默认开启并按 0%→42%→86%→90% 排序；表格显示真实置信徽标；无证据项在行内禁用确认。
- 点击低置信行走 `13–16ms` 打开证据抽屉；证据卡显示 `表格 1 · 第 2 行` 与逐字引用；点击证据卡打开原文并高亮 `校验出票人、收款人与金额`；定位与确认动作可用。
- 确认后写 `human_decision=confirmed`、`decision_at`；无证据项显示“无证据”、禁用定位/确认/复选框；绕过按钮直接调用 `RWB.toggleConfirm(3)` 仍被拦截；批量确认跳过无证据项。
- `buildGeneratePayload()` 与 `AUDIT.buildPayload().ai.items` 均携带真实证据、置信度、模型、提示词版本、时间、决策。
- 1024 两栏、抽屉覆盖式打开；768 单栏、无横向溢出；英文态 `Low confidence first On`、`Source evidence`、`No source evidence`、`No evidence`；axe A/AA critical/serious=0；运行期无 JS 异常。
- 截图：`screenshots/evidence_confidence_1440.png`、`evidence_confidence_1024.png`、`evidence_confidence_768.png`。

### 3.3 既有回归

- `node tests/phase3/ui_review_workbench.mjs`：**18/18 PASS**；旧夹具无 `origin/evidence/confidence` 时仍保留 3 段占位路径，无回归。
- `python tests/audit_package.py`：**0 失败 / 13/13 PASS**，AC-08 21,647 ms。
- `python tests/i18n_check.py`：**0 失败**，中英各 1112 键，集合一致，占位符无缺失。
- `python scripts/build_frontend.py`：13 CSS + 26 JS → `frontend/index.html` 910,438 B。

### 3.4 HTTP 真实调用

- `POST /api/recognize`（内置样例）：HTTP 200，6 项，`meta.evidence={total:6, matched:6, unverified:0}`。
- `POST /api/recognize/jobs` → `GET /api/recognize/job`：`done`，6 项，`matched=6`，`low_confidence=0`。
- `POST /api/generate`（1 项 `origin=ai`、`evidence=[]`）：HTTP 400，`msgKey=gen.evidence_required`，`items` 返回违规项；未生成成品表。
- `python tests/api_smoke.py 8033`：生成链路 `fp=36` 通过，携带证据的识别结果可直接生成；该实例规则种子为空导致两项旧断言失败，与 T06195 无关。

## 4. 已知边界

1. 证据只扫描 docx 段落与表格行；PDF 上传不提供原文定位，按无证据处理。
2. 人工补录只写 `人工补录` / `粘贴导入` 的 locator，不再校验来源原文；属于人工担保。
3. 模型只用于补漏，本地候选不做逐条模型复核；本地候选置信度为规则默认值（表格 86% / 正文 64%）。
4. 审计包 30 秒墙钟受本机 Chromium 冷启动影响曾出现 31–71 秒；最终复跑 24,962 ms 通过。此指标属 T06181 既有门，不是 T06195 功能本身。
5. 浏览器上传 zip 导入的交互未单独点击；`/api/data/import` 复用同一 `import_zip`，T06194 已覆盖存储层。

## 5. 结论

AC-19 的无证据不可确认、不可出表，以及 AC-22 的逐项模型/提示词/时间/置信度/人工决策审计，均已在真实识别接口、真实 UI 抽屉、真实生成接口与真实审计 PDF 上闭环。T06195 可以回写 MTask。
