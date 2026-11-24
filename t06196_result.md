## 根因

T06196 前，系统没有可复现的 100+ 标注集，也没有离线 Precision/Recall 评测、混淆矩阵和提交前重复/漏项自检；AI 识别质量只能靠人工抽查，无法在版本迭代或生成前形成可解释的质量门。审计包也没有质量评测与自检留痕。

## 影响范围

- 数据：新增 `data/eval_samples.json` 120 条标注集；`.gitignore` 放行该源码级文件。
- 评测：`scripts/ai_eval.py`（加载/自检/回放/指标/混淆矩阵/run 留痕/precheck 留痕）。
- 服务端：`GET /api/eval/latest`、`POST /api/eval/run`、`POST /api/eval/precheck`；`/api/generate` 自动 precheck 并返回 `quality_precheck`。
- 配置中心：`38_ai_eval.js` + `66_ai_eval.css` + `index.src.html` 评测面板；`01_core.js` 初始化；`02...js` 生成前自检与 payload；`32_audit.js` 审计 payload。
- 审计包：`audit_package.py` 第 6 部分新增质量评测、质量自检、提交前自检行。
- i18n：中英 `config.eval.*` 与 `eval.srv_run_fail`。
- 不影响既有识别/生成硬证据门：`evidence.validate_confirmable` 仍是无证据 AI 候选的最终阻断。

## 修复

- 标注集：12 组（签发/承兑/贴现/背书/质押/到期/保证金/授信/客户名单/清算/票交所/统计查询）×10 条；五类各 24；保留 12 个真实歧义样本。
- `ai_eval.py`：`count_item` 精确对齐；本地 docx 回放；`tp/fp/fn`、P/R/F1/Accuracy；5×5 矩阵；重复/漏项/多余/类型错误/非法/证据缺失自检；`EVAL-*` 与 `latest.json`、`PRECHECK-*` 与 `latest-precheck.json`。
- 门禁：`Precision ≥ 0.85 && Recall ≥ 0.85 && dataset self_check.ok`；未过门禁 UI 显示 FAIL。
- 提交前自检：重复名称、空名称/空描述、非法类型、AI/LLM 无证据、可选 `expected_count` 不足；生成前告警不阻断合法生成，服务端留痕 `stage=generate`。
- UI：配置中心 KPI/自检 chips/误判前 6/混淆矩阵/最近自检；运行按钮真实 HTTP；结果写 `window.lastEvalRun` 与 `localStorage.wl_eval_latest`。
- 审计：第 6 部分展示质量评测 P/R/F1、门禁、run id、自检计数、precheck run id；兼容 summary 与 full list。
- 测试：`tests/ai_eval.py` 23 项、`tests/ai_eval_api.py` 10 项、`tests/phase3/ui_ai_eval.mjs` 14 项；`run_phase3.mjs` 登记 `ai-eval`。

## 验证

- `python tests\ai_eval.py`：**23/23 PASS**；120/120 回放，TP/FP/FN=108/12/12，P/R/F1/Accuracy=90%，门禁 PASS，矩阵对角 108 / 非对角 12，证据 120/120，审计 PDF 8 页且含 `P 90.0%` 与 `提交前自检 漏项 2`。
- `python tests\ai_eval_api.py http://127.0.0.1:8033`：**10/10 PASS**；`/api/eval/run` 返回 90%，`/api/eval/precheck` 检出重复 1/非法 1/无证据 2，`/api/generate` 返回 `quality_precheck.ok=true, checked=6` 且 `stage=generate` 留痕。
- `node tests\phase3\ui_ai_eval.mjs`：**14/14 PASS**；KPI 90.0%，门禁 PASS，矩阵 5×5，自检 6 chips，1024/768 无横向溢出，axe critical/serious=0，JS 异常 0。
- `python tests\evidence_confidence.py`：**21/21 PASS**；`node tests\phase3\ui_evidence_confidence.mjs`：**25/25 PASS**。
- `python tests\audit_package.py`：**13/13 PASS**，AC-08 29,147 ms（首次冷启动 86,673 ms 超时，复跑通过）。
- `python tests\i18n_check.py`：**17/17 PASS**，中英各 1154 键。
- `python scripts\build_frontend.py`：14 CSS + 27 JS → `frontend/index.html` 925,882 B。
- `python -m py_compile scripts\ai_eval.py scripts\server.py scripts\audit_package.py`：PASS。
- 提交：本次 `feat(ai-eval): 离线质量评测与提交前自检闭环 (T06196)`；最终 hash 以 MTask 关联与交付消息为准。

## 已知边界

1. 120 条标注集为票据业务构造集，不是真实项目独立双盲标注；保留 12 个歧义样本，P/R=90% 不是 100% 自证。
2. 评测只走本地规则识别器，不评估远程 LLM；符合“离线本地运行，不依赖在线 API”。
3. 生成前自检是告警，不阻断既有合法生成；无证据 AI 候选仍由 T06195 硬证据门 400 阻断。
4. 审计包质量行仅在 payload 携带 `quality` / `quality_precheck` 时出现；旧客户端不携带时保持原 6 行表。
5. 审计 30 秒墙钟受 Chromium 冷启动波动，首次可能 80–131 秒；复跑 29 秒通过，属既有 T06181 门。

---

通道：A（MCP 拉取，本地会话）
会话：doubao-T06196-20261124143000
完成时间：2026-11-24T15:10:00+08:00
