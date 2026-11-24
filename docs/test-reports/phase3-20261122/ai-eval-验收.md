# T06196 AI 评测与质量检查 · 验收报告

- 任务：MTask `T06196`《[PRD] 构建AI评测与质量检查》
- 任务 ID：`5172c1da-ce6b-4529-8df4-99f9a0a38023`
- 优先级：high
- 验收日期：2026-11-24
- 结论：**通过（120 条标注集、离线 P/R 评测、混淆矩阵、重复/漏项自检、提交前留痕全部实测）**

## 1. 口径

- 关联需求 `REQ-019`，验收 `AC-20`。
- 标注集 120 条（>100），12 个票据业务组，ILF/EIF/EI/EO/EQ 各 24 条；每条含 `id/group/doc_title/system/name/desc/gold`。
- 评测完全离线：`ai_eval.evaluate` 只接收本地识别函数 `server.recognize_local`，不调用在线模型 API。
- 指标：Precision / Recall / F1 / Accuracy；质量门 `Precision ≥ 0.85 且 Recall ≥ 0.85`，同时要求数据集自检通过。
- 混淆矩阵：5×5，行=标注类型、列=预测类型；对角线为命中，非对角为误判。
- 自检覆盖：重复候选、漏项、多余、类型错误、非法类型、证据缺失；生成前另做重复/空字段/非法类型/无证据检查并留痕。
- 数据集故意保留 12 个真实歧义样本，不追求 100% 自证；本地规则在歧义处产生可解释误判。

## 2. 实现

- `data/eval_samples.json`（新增）
  - 12 组 × 10 条 = 120 条；五类均衡各 24 条；`sha256` 前 16 位 `c78353a356831e8e`。
  - `.gitignore` 增加源码级标注集放行，避免随 `data/*` 运行时数据被忽略。
- `scripts/ai_eval.py`（新增）
  - `load_dataset` / `dataset_check`：100+ 样本、重复 ID、组内重复名称、缺失字段、非法 gold、五类覆盖、组使用检查。
  - `evaluate`：按组生成临时 docx，调用注入的本地识别器；逐项按 `count_item` 对齐；输出 `tp/fp/fn`、P/R/F1/Accuracy、门限、5×5 混淆矩阵、重复/漏项/多余/类型错误/非法/证据缺失自检。
  - `save_run` / `latest_run`：写 `EVAL-*.json` 与 `latest.json`，保留最近 20 份。
  - `precheck_items` / `save_precheck` / `latest_precheck`：重复名称、空名称/空描述、非法类型、AI/LLM 无证据、可选 `expected_count` 数量不足；写 `PRECHECK-*.json` 与 `latest-precheck.json`。
  - CLI：`python scripts/ai_eval.py --out <dir> --json`，延迟导入 `server.recognize_local`。
- `scripts/server.py`
  - `EVAL_RUNS = APP_DATA / "eval_runs"`。
  - `GET /api/eval/latest`：最近评测、最近提交前自检、数据集摘要（版本、样本数、组数、sha、自检）。
  - `POST /api/eval/run`：真实运行 120 条 docx 回放，同步返回完整 run。
  - `POST /api/eval/precheck`：入参 `items/stage/title/job`，写留痕，返回 `run_id/created_at/precheck`。
  - `/api/generate`：规范化 items 后自动 `precheck_items` + `save_precheck(stage=generate)`，响应增加 `quality_precheck` 摘要；仅打印留痕失败，不阻断既有合法生成；硬证据门仍由 `evidence.validate_confirmable` 执行。
- `frontend/src/js/38_ai_eval.js`、`frontend/src/css/66_ai_eval.css`、`frontend/src/index.src.html`
  - 配置中心新增“AI 评测与质量门（AC-20）”面板：样本数/组数、数据集版本与指纹、P/R/F1、门限、最近 run、耗时、自检 chips、前 6 个误判、5×5 混淆矩阵、最近提交前自检。
  - `evalRun` 真实调用 `/api/eval/run`；`qualityPrecheck` 调用 `/api/eval/precheck`。
  - `localStorage.wl_eval_latest` 保存摘要，供审计页离线读取。
  - 1100/760 响应式：KPI 四列→两列；1024/768 矩阵与按钮均可见、无面板级横向溢出。
- `frontend/src/js/01_core.js`、`02_t00927_确认无误_生成进度条_后台真实阶段.js`、`32_audit.js`
  - `goPage('config')` 调 `evalInit`。
  - 生成 payload 增补 `quality` / `quality_precheck`；点击“确认无误 · 生成结果”先做提交前自检，告警不阻断；生成响应回写 recent precheck。
  - 审计 payload 的 `ai.quality` / `ai.quality_precheck` 从 `window.lastEvalRun`、`localStorage`、`window.lastEvalPrecheck` 读取。
- `scripts/audit_package.py`
  - 第 6 部分新增 `质量评测（AC-20）`：P/R/F1、样本数、门禁、run id。
  - 新增 `质量自检`：重复/漏项/多余/类型错误/证据缺失。
  - 新增 `提交前自检`：重复/漏项/非法/证据缺失/precheck run id；兼容 summary 计数与 full list 两种形状。
- `data/i18n/zh-CN.json`、`en-US.json`：新增 `config.eval.*` 与 `eval.srv_run_fail`；中英各 1154 键，集合一致。
- 测试：`tests/ai_eval.py`、`tests/ai_eval_api.py`、`tests/phase3/ui_ai_eval.mjs`；`run_phase3.mjs` 已登记 `ai-eval` 套件。

## 3. 结果

### 3.1 标注集与单元 / 审计

`python tests/ai_eval.py`：**23/23 PASS**，结果 `results/ai-eval.json`。

| 检查 | 结果 |
|---|---|
| 样本 / 组 | PASS：120 条 / 12 组 |
| 五类覆盖 | PASS：ILF/EIF/EI/EO/EQ 各 24 |
| 数据集自检 | PASS：0 错误、ID/组内名称无重复 |
| 真实 docx 回放 | PASS：预测 120，漏项 0，多余 0，重复 0 |
| TP/FP/FN | PASS：108 / 12 / 12 |
| Precision / Recall / F1 / Accuracy | PASS：90.0% / 90.0% / 90.0% / 90.0% |
| 质量门 | PASS：阈值 0.85，`passed=true` |
| 混淆矩阵 | PASS：5×5，对角 108，非对角 12，合计 120 |
| 类型误判清单 | PASS：12 项可逐项列出 |
| 证据覆盖 | PASS：120/120，缺失 0 |
| 真实样例提交前自检 | PASS：6 项，重复/漏项/非法/无证据均 0 |
| 构造异常自检 | PASS：重复 1 组、漏字段 2、非法 1、无证据 2 |
| 自检留痕 | PASS：`PRECHECK-*.json` + `latest-precheck.json` |
| 审计包 PDF | PASS：8 页、七部分/目录/字体/追溯/水印/页脚；含 `P 90.0%` 与“提交前自检 漏项 2” |

混淆矩阵（行=gold，列=预测）：

| gold\pred | ILF | EIF | EI | EO | EQ |
|---|---:|---:|---:|---:|---:|
| ILF | 21 | 0 | 2 | 0 | 1 |
| EIF | 0 | 21 | 1 | 0 | 2 |
| EI | 0 | 1 | 23 | 0 | 0 |
| EO | 0 | 0 | 3 | 21 | 0 |
| EQ | 0 | 0 | 2 | 0 | 22 |

12 个歧义误判示例：`客户信息维护表` ILF→EI、`第三方征信查询接口` EIF→EQ、`批量校验汇总报表` EO→EI、`票据登记簿` ILF→EI、`票据信息查询表` ILF→EQ、`票交所信息返回接口` EIF→EQ、`监管报送接口` EIF→EI、`票交所外部报文报送` EI→EIF、`票据校验统计报表` EO→EI、`票据批量校验` EO→EI、`票据信息视图` EQ→EI、`票据信息清单` EQ→EI。

### 3.2 UI 验收

`node tests/phase3/ui_ai_eval.mjs`：**14/14 PASS**，结果 `results/ai-eval-ui.json`。

- 配置中心面板、运行按钮、样本 120、12 组、初始徽标结构正确。
- 点击运行真实回放 120 条：P/R/F1 均 90.0%；门禁徽标 PASS；run meta 含 `EVAL-2026...` 与耗时；`window.lastEvalRun` 与 `localStorage.wl_eval_latest` 均已写入。
- 混淆矩阵 6 行（表头+5 类）、25 个数据格、对角 5 格 108、非对角 7 格合计 12。
- 自检 chips 6 个；误判清单前 6 条；真实样例自检 6 项通过。
- 提交前自检告警：重复 1、非法 1、证据缺失 2，面板显示 warn 并写 `window.lastEvalPrecheck`。
- 1024 / 768 无面板级横向溢出，矩阵与运行按钮可见；KPI 分别两列。
- axe A/AA critical/serious = 0；运行期 JS 异常 0。
- 截图：`screenshots/ai_eval_1440.png`、`ai_eval_1024.png`、`ai_eval_768.png`。

### 3.3 HTTP 真实调用

`python tests/ai_eval_api.py http://127.0.0.1:8033`：**10/10 PASS**，结果 `results/ai-eval-api.json`。

- `GET /api/eval/latest`：200，数据集 120/12，sha `c78353a356831e8e`。
- `POST /api/eval/run`：200，`counts={expected:120,predicted:120,missing:0,extra:0}`，P/R/F1=90%，门禁 PASS，混淆矩阵合计 120。
- `GET /api/eval/latest` 回显最近 run `EVAL-20261124-145540-c78353a3`。
- `POST /api/eval/precheck`：重复 1、非法 1、无证据 2，留痕可由 latest 读取。
- `POST /api/recognize`（内置样例）：6 项且全部带证据。
- `POST /api/generate`：200，`quality_precheck={ok:true, checked:6, duplicate_count:0, missing_count:0, invalid_count:0, evidence_missing_count:0}`；生成前自检 `stage=generate` 已留痕。

### 3.4 既有回归与构建

- `python tests/evidence_confidence.py`：**21/21 PASS**；该次审计 PDF 受 Chromium 冷启动耗时 131,325 ms（结构/文案断言通过），不改变 21/21 结论；独立审计包复跑 29,147 ms 通过。
- `node tests/phase3/ui_evidence_confidence.mjs`：**25/25 PASS**，证据抽屉、无证据阻断、payload、英文态、axe 无回归。
- `python tests/audit_package.py`：**13/13 PASS**，AC-08 29,147 ms（首次冷启动 86,673 ms 超时，复跑通过，属既有 Chromium 冷启动波动）。
- `python tests/i18n_check.py`：**17/17 PASS**，中英各 1154 键，集合一致，服务端 msgKey 无缺失。
- `python scripts/build_frontend.py`：14 CSS + 27 JS → `frontend/index.html` **925,882 B**。
- `python -m py_compile scripts/ai_eval.py scripts/server.py scripts/audit_package.py`：PASS。

## 4. 已知边界

1. 120 条标注集是按票据业务构造的离线标注集，不是真实项目历史标注的独立双盲集；它保留 12 个歧义样本，避免自证 100%。若后续要求“真实业务标注样本”，需用户提供脱敏样本或确认按构造集口径验收。
2. 评测只调用本地规则识别器，不覆盖远程 LLM 的识别质量；离线可用性正是 AC-20 的边界。
3. 生成前自检是告警，不阻断既有合法生成；无证据 AI 候选仍由 T06195 的 `evidence.validate_confirmable` 硬门拦截。这是两级门禁，不互相替代。
4. 审计包第 6 部分的质量行只在 payload 携带 `quality` / `quality_precheck` 时出现；旧客户端未携带时保持原有 6 行表，不报错。
5. 审计包 30 秒墙钟受本机 Chromium 冷启动影响，首次可能 80–131 秒；复跑 29 秒通过，属 T06181 既有门，不是本任务功能回归。
6. 120 条评测 CLI 在 Python 3.14 首次导入较慢；UI 运行实测 5.5–16.5 秒（含服务端进程冷/热差异），均同步返回，不占用生成链路。

## 5. 结论

AC-20 的 100+ 标注样本、Precision/Recall ≥85%、5×5 混淆矩阵、重复/漏项/异常自检、提交前留痕均已实现并在真实 docx 回放、真实 HTTP 接口、真实配置中心 UI、真实审计 PDF 上闭环。T06196 可以提交并回写 MTask。
