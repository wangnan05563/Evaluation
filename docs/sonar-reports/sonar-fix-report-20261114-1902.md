# SonarQube 代码质量治理报告（Evaluation / 27_Evaluation）

- 治理日期：2026-11-14
- 项目根：`D:\code\otherProjects\Evaluation`
- SonarQube：Community Build 26.1.0.118079 @ `http://localhost:9000`（内嵌 ES 9001）
- 扫描器：`sonar-scanner 8.0.1.6346`（Windows x64）
- 项目 Key：`27_Evaluation`（配置见仓库 `sonar-project.properties`）

## 1. 结论摘要

| 项目 | 结果 |
|------|------|
| 扫描（修复前） | 78 个 OPEN（BLOCKER 2 / CRITICAL 35 / MAJOR 24 / MINOR 17） |
| 扫描（修复后） | **0 个 OPEN**（含新增问题在内全部清零，连续复扫稳定为 0） |
| 行为一致性 | 13 项接口快照与 HEAD 基线**完全相符**（`GUARD_EXIT=0`） |
| 全套测试 | **19/19 套件全绿**（`npm test`，含 S3 API 全链路、S4~S12/S15/S16 UI 实跑、S17 Electron 实机烟测） |
| 生产构建 | **成功**（`BUILD_EXIT=0`），产物版本 `0.1.20261114-001`，金标准 US=105.07 通过 |

> 结论：代码质量问题已按 Blocker > Critical > Major > Minor > Info 的优先级全部修复并复扫清零，测试与生产构建均通过。

## 2. 扫描与清零过程（四轮）

| 轮次 | 触发 | 日志 | CE Task | OPEN 数 |
|------|------|------|---------|---------|
| 基线 | 首次全量扫描 | `docs/sonar-reports/scan-baseline.log` | `e95ef80a-5c8c-41f8-9d55-14fcabac6652` | 78 |
| R1 | 第一轮修复后复扫 | `docs/sonar-reports/scan-fixed-20261114-175406.log` | `935426c5-bc56-4a02-9657-22d2648fb84f` | 37 |
| R2 | 收尾修复后复扫 | `docs/sonar-reports/scan-fixed2-20261114-180537.log` | `cf090021-7094-4f03-a6c7-1a7dbb8a541a` | 2 |
| R3（终态） | 最终确认扫描 | `docs/sonar-reports/scan-final-20261114-181046.log` | `4fb5804c-e2da-473b-9996-06395de638dc` | **0** |

说明：
- 四轮扫描均 `ANALYSIS SUCCESSFUL` + `EXECUTION SUCCESS`。
- R1 的 37 条中有 26 条是**本轮重构新引入**的 `python:S1172`（`do_POST` 拆分为统一签名 `(path, raw)` 的处理器方法，部分参数未被使用），已在 R2 前全部清零——治理目标不只清基线，也包括治理过程自身不新增问题。
- 每轮复扫的完整问题清单（JSON/CSV/Markdown）均已落盘，见第 6 节产物索引。

## 3. 修复内容

### 3.1 基线规则分布与处置

| 规则 | 数量 | 处置方式 |
|------|------|----------|
| `javascript:S4624` | 20 | 嵌套模板字符串拆为具名中间变量（摘要/文件名/日志文案），保持输出逐字符一致 |
| `python:S3776` | 15 | 认知复杂度拆分：`server.py`（do_POST/recognize/context/generate）、`generate_xlsx.py`、`pert.py`、`validators.py`、`replay_recognize.py` |
| `python:S1192` | 12 | 重复字面量提常量（`API_CONFIG`/`MIME_JSON`/`EP_CONFIG`/`EP_UPDATE_CHECK`/`EP_UPDATE_CONFIG`/`CUSTOM_LATEST`/`METHOD`/`TPL_NAME`/`SHEET_XML`/`CONTENT_TYPES`/`RELS_END`/`SHEET_END`） |
| `javascript:S7781` | 9 | `replace(...)` 改 `replaceAll(...)` |
| `javascript:S3776` | 5 | `prod_smoke.mjs` / `native_dialog_probe.mjs` / `tmp_janitor.mjs` / `01_core.js` 拆分场景与渲染函数 |
| `javascript:S7755` | 3 | 末元素索引改 `.at(-1)` / `.findLast(...)` |
| `javascript:S2871` | 2 | 单字符替换改 `replaceAll` |
| `python:S1186` | 1 | `unit_update_source.py` 的 `log_message` 补 docstring + `WE_TEST_VERBOSE` 门控实现 |
| `javascript:S7780` | 1 | `String.raw` 模板 / 正则字面量替代 `\\` 转义字符串 |
| `javascript:S7747` | 1 | 去掉多余的数组转换，直接 `for…of` |
| `javascript:S6653` | 1 | 改 `Object.hasOwn()` |
| `javascript:S6397` | 1 | 单字符字符类改为字符本身 |
| `javascript:S4140` | 1 | 去掉数组中间的多余逗号（空槽位） |
| `javascript:S4043` | 1 | `sort` 移出表达式、单独语句（或 `toSorted`） |
| `javascript:S3516` | 1 | 统一返回新对象字面量，消除「恒返回同值」 |
| `javascript:S2681` | 1 | 条件语句补花括号，避免后续语句被无条件执行 |
| `javascript:S2189` | 1 | 循环条件变量不可变，改为受控 `break` |
| `javascript:S6594` | 1 | 改 `RegExp.exec()` |
| `javascript:S1128` | 1 | 删除未使用导入 |

> 全程**未新增任何 `NOSONAR` 抑制**；`sonar-project.properties` 中既有的 16 条 issue-ignore 规则保持不变，未借抑制规避修复。

### 3.2 关键结构重构

**Python**
- `scripts/server.py`：`do_POST`（原 555 行、认知复杂度 278）→ 类级 `POST_ROUTES` 路由表 + `_dispatch_post`/`_call_post` 分发；25 个端点拆为独立 `_post_xxx` 方法；`POST_ARITY` 声明最小入参形态（`(path, raw)` / `(raw)` / `()`），避免重构引入未使用参数；`_get_history_*`、`_detect_stack_from_manifest` 等再拆分；generate/pert_import/pert_generate 的辅助步骤下沉为静态方法。
- `scripts/generate_xlsx.py`：`schedule_excel_recalc`、`run_from_json`、`_try_excel_recalc` 拆出计时/异步回写/Excel 释放等职责单一的小函数。
- `scripts/pert.py`：打印资产恢复（头尾合并、关系/内容类型注册）拆为 `_read_print_parts`/`_add_print_relationships`/`_merge_header_footer`/`_merge_content_types`/`_write_zip_parts` 等；`generate` 拆 `_require_template`/`_fill_pert_sheet`/`_write_pert_rows`。
- `scripts/validators.py`：`check_generate` 拆 `_check_item`/`_check_brand_color`/`_check_gb_state`。
- `scripts/replay_recognize.py`：`main` 拆 `_judge_row`/`_basis_for`/`_print_stats`。

**JavaScript / 前端**
- `tests/prod_smoke.mjs`：`runScenarios`（原复杂度 80）拆 `scenarioPA`/`scenarioPA2`/`scenarioPA3`/`scenarioPB`/`scenarioPC`，并再抽出 `clickUntilGone`/`dialogMismatches`/`readWindowPrefs`，使 P-A/P-A2 场景复杂度落到阈值内。
- `tests/tools/native_dialog_probe.mjs`：`runMode`（原 86）拆轮次执行/弹框未出现/点击未发出/点击已发出/救援点击/守护死亡/重启实例/汇总输出，闭包状态改挂 `ctx` 对象。
- `tests/tmp_janitor.mjs`：`reclaimStaleTmp` 拆 `_reclaimFromStuck`/`_reclaimHolderScript`/`_reclaimHours`，`keepRequested()` 改为返回新字面量。
- `frontend/src/js/01_core.js`：`bindConfig`（16）拆 `renderConfigFields`/`bindContextSection`/`renderUpdateSection`/`renderRecalcSection`；改动后已用 `python scripts/build_frontend.py` 重建 `frontend/index.html`（640909 字节）。

**测试**
- `tests/unit_engine.py`、`tests/unit_update_source.py` 的重复字面量提常量；`unit_update_source.py` 空方法补实现。

## 4. 行为一致性守门（不改变可观测行为）

本项目为「Electron 壳 + Python sidecar」，重构前先建立了接口级行为基线：

1. 首轮比对发现 `tests/refactor_guard.py` 的 `LLM_OFF = {"llm_enabled": False}` 放在 payload 顶层，而 `/api/recognize` 实际读 `payload["params"]["llm_enabled"]`，导致基线快照一直在调用外部大模型、条数随接口波动 → 修正为 `{"params": {"llm_enabled": False}}`（另设 generate 用的扁平变体）。
2. 用 `git stash` 以 HEAD 代码重打基线 `logs/_t1501_base.json`（旧被污染基线备份为 `logs/_t1501_base.llm-on.bak.json`），再恢复改动。
3. 每轮重构后执行 `run-guard.ps1 -Mode compare`，结果均为：

```
行为一致：13 项快照与基线完全相符（D:\code\otherProjects\Evaluation\logs\_t1501_base.json）
GUARD_EXIT=0
```

覆盖快照含 recognize/generate/config/history/pert 等 13 条主链路（LLM 显式关闭，保证确定性）。

## 5. 测试与构建

### 5.1 全套测试（19/19 通过）

- 命令：`npm test`（`tests/run.mjs` 编排）
- 解释器：`F:\Program Files\Python3.14\python.exe`（openpyxl 3.1.5 / python-docx 已装）
- 结果：`通过 19/19（skip 0）`，`TEST_EXIT=0`
- 日志：`docs/test-reports/npm-test-20261114-183239.log`

| 套件 | 内容 | 结果 |
|------|------|------|
| S1 | 识别规则表驱动单测 | 全绿 |
| S2 | 引擎口径单测 | 全绿 |
| S3 | API 冒烟（隔离实例全链路） | 全绿 |
| S4 | UI 冒烟（四图+导出管线） | 全绿 |
| S5 | UI 表格增强+规则沉淀 | 全绿 |
| S6 | UI 进度/失败/超时 | 全绿 |
| S7 | UI 版本 diff 对比 | 全绿 |
| S8 | UI 主题色定制 | 全绿 |
| S9 | UI 键盘主链路 | 全绿 |
| S10 | 命令行/无人值守模式 | 全绿 |
| S11 | UI 动效/骨架屏/空态插画 | 全绿 |
| S12 | UI 界面多语言（82 项断言） | 全绿 |
| S13 | 桌面壳窗口偏好存储单测 | 全绿 |
| S14 | 桌面壳文案双语单测 | 全绿 |
| S15 | UI 配置中心「窗口行为」卡片 | 全绿 |
| S16 | UI 配置中心降级态 | 全绿 |
| S17 | Electron 关闭行为实机烟测 | 全绿 |
| S18 | 免安装产物冒烟 | 全绿（实机场景按设计跳过：本次构建产物为安装包，未生成 `release/win-unpacked`） |
| S19 | 内置 GitHub 更新源单测 | 全绿 |

排障记录（保留以备复核）：首次跑测时并行安装了 PyInstaller，导致 S8「API 实例未就绪」与 S12 两条动态语言断言假红（Python 站点包重写期间实例启动/字典加载超时）；安装结束后**无并发干扰重跑，19/19 全绿**，两次日志均保留。

### 5.2 生产构建

- 命令：`_env WE_PYTHON=F:\Program Files\Python3.14\python.exe` 后执行 `scripts\构建打包.bat`
- 日志：`docs/test-reports/build-20261114-184552.log`，`BUILD_EXIT=0`
- 版本：`0.1.20261112-001` → **`0.1.20261114-001`**
- 金标准：`[verify] 引擎 US 合计 = 105.07；母版金标准 = 105.07；校验结论：通过 ✓`
- 产物：

| 产物 | 路径 | 大小 | 备注 |
|------|------|------|------|
| 安装包（NSIS） | `release\WorkloadEstimate-0.1.20261114-1-setup.exe` | 121,708,457 B | SHA256 `341D5CE6824F3A871F1E306FCE4DC5BE75ACA068665888586DDDDAE8CB39185F` |
| 后端可执行 | `release\exe\工作量评估工具.exe` | 43,811,903 B | PyInstaller 单文件 |
| 源码/脚本包 | `release\workload-estimate.zip` | 983,850 B | 85 个文件 |

## 6. 产物索引

**扫描**
- `docs/sonar-reports/baseline-issues-20261114-171838.json` / `.csv` / `baseline-summary-20261114-171838.md`（78 条基线）
- `docs/sonar-reports/fixed-issues-20261114-180010.csv`（R1：37 条）
- `docs/sonar-reports/final-issues-20261114-180931.csv`（R2：2 条）
- `docs/sonar-reports/final2-issues-20261114-181641.csv`（R3：0 条）
- 扫描日志：`scan-baseline.log`、`scan-fixed-20261114-175406.log`、`scan-fixed2-20261114-180537.log`、`scan-final-20261114-181046.log`

**行为守门**
- `logs/_t1501_base.json`（13 项基线）、`logs/_t1501_base.llm-on.bak.json`（旧基线备份）

**测试**
- `docs/test-reports/npm-test-20261114-183239.log`（19/19 全绿）
- `docs/test-reports/npm-test-20261114-181656.log`（含首次环境干扰的排障记录）

**构建**
- `docs/test-reports/build-20261114-184552.log`
- `release\WorkloadEstimate-0.1.20261114-1-setup.exe`、`release\exe\工作量评估工具.exe`、`release\workload-estimate.zip`

## 7. 边界与遗留

1. **SCM blame 缺失**：扫描日志中的 `Missing blame information ...` 属未提交工作树导致的 warn-only（技能定义不阻塞），不影响问题判定。
2. **S18 实机场景跳过**：构建脚本输出安装包与单文件 exe，不生成 `release/win-unpacked`，故 S18 的实机场景按设计跳过；如需覆盖，可额外执行 `npm run dist:dir` 后重跑 S18。
3. **未提交**：本次改动共 26 个文件（`+2062 / -1514`），仍未提交 git（HEAD `4fbcb85`），可随时 `git diff` 复核或回滚。
4. **构建会清理 `release/`**：`scripts\构建打包.bat` 默认重建 release 目录，旧版本安装包（`WorkloadEstimate-0.1.20261112-1-setup.exe` 等）已按脚本设计被清理。
