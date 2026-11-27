# SonarQube 扫描报告（修复前基线）

- 项目：`27_Evaluation`（源码根 `D:\code\otherProjects\Evaluation`）
- 扫描时间：2026-11-26 20:05:10 — 20:13:41
- SonarQube：Community Build 26.1.0.118079 @ `http://localhost:9000`
- 扫描器：`sonar-scanner 8.0.1.6346`
- CE Task：`57898f6e-c29a-49a2-b98a-9baf8b375926`（EXECUTION SUCCESS）
- 状态过滤：OPEN + CONFIRMED（`resolved=false`）
- 原始数据：`issues-20261126-201831.json` / `.csv`；日志 `scan-20261126-200510.log`

## 1. 总量与等级

| 指标 | 数量 |
|------|------|
| 问题总数 | **281** |
| BLOCKER | 0 |
| CRITICAL | 142 |
| MAJOR | 78 |
| MINOR | 61 |
| INFO | 0 |

## 2. 按类型

| 类型 | 数量 |
|------|------|
| CODE_SMELL | 270 |
| BUG | 11 |
| VULNERABILITY | 0 |

## 3. 按规则（39 条规则）

| 规则 | 数量 |
|------|------|
| `python:S1192` | 69 |
| `python:S3776` | 59 |
| `javascript:S2681` | 21 |
| `python:S1481` | 13 |
| `javascript:S3776` | 11 |
| `python:S1244` | 9 |
| `python:S1172` | 9 |
| `javascript:S7781` | 9 |
| `javascript:S7780` | 9 |
| `javascript:S6557` | 7 |
| `python:S5713` | 6 |
| `javascript:S4624` | 6 |
| `Web:S6845` | 5 |
| `javascript:S7748` | 5 |
| `javascript:S1128` | 5 |
| `python:S7519` | 4 |
| `python:S5869` | 3 |
| `python:S1186` | 3 |
| `javascript:S7755` | 2 |
| `python:S1110` | 2 |
| `javascript:S1788` | 2 |
| `Web:S6840` | 2 |
| `css:S7924` | 2 |
| `python:S7494` | 1 |
| `python:S6395` | 1 |
| `python:S7504` | 1 |
| `Web:S5255` | 1 |
| `Web:S5256` | 1 |
| `python:S7500` | 1 |
| `css:S4666` | 1 |
| `javascript:S7784` | 1 |
| `javascript:S7773` | 1 |
| `javascript:S7768` | 1 |
| `javascript:S6594` | 1 |
| `javascript:S6035` | 1 |
| `javascript:S4822` | 1 |
| `javascript:S4138` | 1 |
| `javascript:S1854` | 1 |
| `javascript:S1481` | 1 |
| `python:S5603` | 1 |
| `Web:S7927` | 1 |

> 表中列出的规则合计 281 条；`python:S1192`（重复字面量）与 `python:S3776`（认知复杂度）两项占 128 条，是首轮治理的主战场。

## 4. 问题最集中的文件（Top 15）

| 文件 | 数量 |
|------|------|
| `scripts/server.py` | 37 |
| `frontend/src/js/01_core.js` | 18 |
| `tests/rbac_api.py` | 11 |
| `scripts/rbac.py` | 11 |
| `frontend/src/index.src.html` | 10 |
| `scripts/audit_package.py` | 10 |
| `tests/load_concurrent.py` | 8 |
| `tests/integrations_api.py` | 7 |
| `tests/migration_drill.py` | 7 |
| `tests/ai_eval.py` | 7 |
| `tests/rbac.py` | 6 |
| `frontend/src/js/07_m3_fr_1_4_1_5_1_7_2_9_批量.js` | 6 |
| `scripts/brand_installer.py` | 5 |
| `tests/integrations.py` | 5 |
| `tests/ai_eval_api.py` | 5 |

## 5. 处置口径

- 按 **CRITICAL > MAJOR > MINOR > INFO** 顺序逐条修复；不新增 `NOSONAR`，不调低质量门。
- 修复后必须重新扫描并确认 `resolved=false` 为 0，才进入测试与构建。
- 每轮复扫清单保存在 `issues-20261126-round5.csv`（37 条）与 `issues-20261126-final.csv`（3 条），终态见 `sonar-report-20261126-final.md`。
