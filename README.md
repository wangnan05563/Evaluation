# 工作量评估助手

> 需求文档 → IFPUG 功能点 → 成品造价表（引擎直连）

![social preview](assets/github-social-preview.png)

![platform](assets/badges/platform.svg) ![python](assets/badges/python.svg) ![electron](assets/badges/electron.svg) ![tests](assets/badges/tests.svg) ![i18n](assets/badges/i18n.svg)

本地运行的软件项目工作量评估工具：上传需求说明书，自动识别 IFPUG 功能点并生成符合企业造价模板的成品评估表；同时提供 NESMA 快速估算与 PERT 三点估算，支持大模型（LLM）辅助识别与拆分。全部计算在本地完成，需求文档不出本机。

> 上文徽章是仓库内本地 SVG（`assets/badges/`，由 `python scripts/make_badges.py` 生成），不引用 shields.io 等外部图床 —— 离线 / 内网环境同样正常渲染。

## 特性

- **IFPUG 估算**：上传 `.docx` 需求文档 → 本地引擎解析候选功能点 → 逐条审核（类别/复杂度/重用/修改）→ 一键生成《规模估算》《费用估算》成品 xlsx（公式与样式保真，Excel 打开即重算）
- **NESMA 快速估算**：数 ILF/EIF 即出规模与费用，支持预估法 / 估算法两种口径，适合需求早期拿量级
- **PERT 三点估算**：新建/选择项目 → 需求导入（AI 拆分或人工录入）→ 乐观/最可能/悲观三值 → 预期 = (O + 4M + P) ÷ 6、σ = (P − O) ÷ 6 → 生成 PERT 成品表
- **大模型识别增强**：配置中心可接入任意 OpenAI 兼容接口（OpenAI / Claude / 通义 / 火山 / Agnes / 自定义），支持连接测试、模型列表自动拉取；启用后对候选做复核补全，并可注入项目上下文目录扫描出的技术栈/规模信息
- **估算历史与版本对比**：估算历史持久化、重开复用，两次估算可逐项 diff（新增/删除/变更高亮）
- **多语言与主题**：界面中/英双语切换（813 组文案 key 全量对齐）；浅色 / 深色 / 高对比三套主题，品牌主色可自定义
- **可访问性**：全链路键盘可完成主流程，语义化 role/aria，焦点环与对比度按 WCAG 口径校验
- **项目库与参数持久化**：PERT 项目、估算项、费率、母版模板、识别规则统一落库 SQLite，支持多项目管理与在线编辑
- **桌面应用**：Electron 壳 + PyInstaller sidecar，安装即用；前端图标库本地内联，离线/内网环境正常渲染；关窗前自动检测仍在运行的估算任务并二次确认
- **数据与运维**：配置中心可一键导出/导入全量数据（含 schema 版本），提供诊断包导出与更新源检查入口
- **命令行模式**：`scripts/we_cli.py` 无人值守出表，退出码可信（0 成功 / 2 输入非法 / 3 生成失败），可挂进调度脚本
- **本地目录选择**：配置中心浏览目录走系统原生对话框，返回绝对路径自动填入

## 页面导览

| 页面 | 用途 |
|---|---|
| IFPUG 估算 | 上传需求 → 审核功能点 → 生成成品造价表 |
| 快速估算 | NESMA 预估/估算法，数 ILF/EIF 即出规模与费用 |
| PERT 估算 | 三点估算与项目库管理 |
| 配置中心 | 大模型识别增强、连接测试与模型管理、主题/母版/费率 |
| 帮助文档 | 评估方法论与计算算法说明、更新检查 |

## 计算口径（与母版 Excel 公式对齐）

| 项 | 口径 |
|---|---|
| UFP | 估算功能点法：ILF=10 / EIF=7 / EI=4 / EO=5 / EQ=4（预估功能点法 ILF=35 / EIF=15，事务类回退估算权重） |
| US | UFP × 重用系数（低 1 / 中 2/3 / 高 1/3） × 修改系数（新增 1 / 修改 0.8 / 删除 0.2） |
| 调整后规模 | US × 规模变更调整因子（估算早期 1.39 / 中期 1.21 / 晚期 1.10 / 交付后及运维 1.00） |
| 工作量 | 调整后规模 × 中值生产率 10.67 人时/FP ÷ 8 × 调整因子 0.8（低/中/高 ±20%） |
| 费用 | 工作量 ÷ 22 人/月 × 2.57 万元/人月 |

内置金标准校验：引擎复算母版 US 合计必须等于 `105.07`（`python scripts/generate_xlsx.py --verify`）。

## 安装

### 桌面版（推荐）

从 `release/` 获取安装包 `WorkloadEstimate-<版本>-setup.exe`（版本号为日期序列，如 `WorkloadEstimate-0.1.20261012-1-setup.exe`，与 `package.json` 的 `version` 一致），双击安装后启动桌面应用（自动拉起本地引擎并打开界面）。

### 开发运行

依赖：Python 3.10+（需 `python-docx`、`openpyxl`）

```bash
# 方式一：启动脚本（引擎 8020 端口 + 自动打开前端）
scripts\启动服务.bat

# 方式二：手动启动
python scripts/server.py 8020
# 浏览器访问 http://127.0.0.1:8020
```

## 快速开始

1. 打开 **IFPUG 估算** 页，拖入需求说明书（`.docx`）
2. 在 **审核功能点** 步骤确认/调整每条候选的类别、复杂度、重用与修改类型
3. 点击 **生成成品造价表**，下载成品 xlsx（含规模估算、费用估算与汇总）
4. 如需 AI 识别增强，先到 **配置中心** 填写 API 地址与 Key 并启用
5. 只需量级时切到 **快速估算**，填 ILF/EIF 数量直接出表

无人值守出表：

```bash
python scripts/we_cli.py --docx 需求说明书.docx --out 评估表.xlsx --method 估算功能点
```

## 构建

```bat
rem 一条命令跑完全流程（0 清空 release -> 1 停占用 -> 2 依赖校验 -> 3 金标准
rem -> 4 源码 zip -> 5 sidecar exe -> 6 桌面安装包）
scripts\构建打包.bat

rem 只清空发布目录（产物均可重建，可随时清理）
scripts\清理发布目录.bat

rem 保留现有产物、跳过清理再构建
set SKIP_CLEAN=1 && scripts\构建打包.bat
```

产物固定落在 `release/`：`workload-estimate.zip`、`exe\工作量评估工具.exe`、`WorkloadEstimate-<版本>-setup.exe`。
electron-builder 的中间产物（`win-unpacked\resources\app.asar`）输出到系统临时目录 `%TEMP%\we-eb-out`，
构建完成后只把 `setup.exe` 移回 `release` —— 避免 asar 落进工作区后被 IDE/索引进程独占打开，
导致 `release` 整个目录删不掉、改不了名。

前端源码在 `frontend/src/`（`index.src.html` + `js/*` + `css/*`），由 `python scripts/build_frontend.py`
打包成单文件 `frontend/index.html`；改完 `src` 必须重新构建，`tests/refactor_guard.py` 会校验产物与源码同步。

> 清理失败时的排查：脚本会自动列出删不掉的文件与占用进程
> （`python scripts\_rm_locks.py release`）。历史遗留的 `release\*\win-unpacked\resources\app.asar`
> 若被 WorkBuddy.exe 索引句柄占住（err=32），需要**重启 WorkBuddy 后**再跑一次清理脚本。

## 目录结构

```
├── frontend/
│   ├── src/                   # 前端源码（index.src.html + js/ 12 模块 + css/）
│   └── index.html             # 构建产物：单文件前端（含本地内联图标库，无 CDN 依赖）
├── scripts/
│   ├── server.py              # 本地引擎：stdlib http.server，REST API + 前端托管
│   ├── engine.py              # IFPUG 规则引擎（US/汇总口径）
│   ├── gb_engine.py           # 国标费率与基准（多版本存取）
│   ├── generate_xlsx.py       # 母版保真生成器（写明细、保公式、Excel 重算）
│   ├── pert.py                # PERT 库与成品表生成
│   ├── history.py             # 估算历史与版本 diff
│   ├── replay_recognize.py    # 功能点类型/修改类型识别规则
│   ├── we_cli.py              # 命令行 / 无人值守模式
│   ├── build_frontend.py      # 前端源码 → 单文件 index.html
│   └── make_badges.py         # README 本地徽章生成（离线可用，替代外链图床）
├── data/
│   ├── i18n/                  # 界面文案字典 zh-CN.json / en-US.json（813 key 对齐）
│   ├── config.json            # 运行配置（LLM 预设、上下文目录、主题）
│   └── pert.db / estimation.db# 项目库与估算历史
├── tpl/template.xlsx          # 成品母版（公式/样式保真基座）
├── tests/                     # 回归套件（S1–S12：Python 单测 + API 冒烟 + UI 冒烟）
├── docs/                      # 设计与方法论文档（见下方「设计文档」）
├── dev-shell/                 # Electron 壳（main.js 拉起 sidecar 并托管窗口）
├── assets/                    # 应用图标、README 徽章与社交预览图
├── scripts\构建打包.bat        # 一键构建（先清 release，再 zip / exe / 安装包）
├── scripts\清理发布目录.bat    # 清空 release（可随时执行，产物可重建）
└── release/                   # 构建产物（zip、sidecar exe、安装包），可随时清理
```

## 测试

```bash
npm test                  # 全量 12 套件
npm test -- --only=S3,S4  # 只跑指定套件
```

编排器（`tests/run.mjs`）跑 S1–S12 共 12 个套件，默认全部纳入（S6 的偶发卡死已在 T01079 根因修复，夹具改绝对路径后转为 default-on）：

| 套件 | 内容 |
|---|---|
| S1 / S2 / S10 | Python 单测：识别规则表驱动对拍、引擎口径、CLI 无人值守 |
| S3 | API 冒烟（隔离实例全链路） |
| S4 / S5 / S7 / S8 / S9 / S11 / S12 | UI 冒烟（无头 Chrome + CDP）：上传→识别→审核→生成→导出、表格增强与规则沉淀、版本 diff、主题定制、键盘可达、动效空态、界面多语言 |
| S6 | UI 进度/失败/超时 |

辅助校验：`python tests/i18n_check.py`（双语 key 对齐、服务端 msgKey 覆盖）、`python tests/refactor_guard.py`（前端产物与源码同步）、`python scripts/generate_xlsx.py --verify`（金标准）。**12/12 全绿为交付线。**

## 主要接口

引擎是 stdlib `http.server`，无框架依赖；前端与桌面壳共用同一套接口。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 引擎就绪探针（含金标准口径回显） |
| POST | `/api/recognize` | 上传需求 docx(base64) → 候选功能点清单 |
| POST | `/api/generate` | 候选清单 + 参数 → 成品 xlsx（返回下载句柄） |
| GET | `/api/generate/progress` | 生成分阶段进度轮询 |
| GET | `/api/jobs/running` | 仍在运行的估算任务（桌面端关窗前确认） |
| GET | `/api/download?s=` | 下载生成的成品表 |
| GET/POST | `/api/config` | 配置中心读写；`/api/config/test` 连接测试、`/api/config/models` 拉取模型列表 |
| GET | `/api/i18n` | 按语言取界面文案字典（运行时下发，语言白名单 + 路径穿越防护） |
| GET/POST | `/api/context` | 项目上下文目录扫描结果与技术栈分析 |
| GET/POST | `/api/history` | 估算历史持久化与重开复用；`/api/history/diff` 两次估算逐项对比 |
| GET/POST | `/api/rules` | 功能点识别规则读写 |
| GET/POST | `/api/rates` | 费率与基准（国标口径）多版本读写 |
| GET/POST | `/api/templates` | 成品母版模板目录与口径说明 |
| POST | `/api/pert/*` | PERT 项目/估算项/导入/生成（`project`、`item`、`import`、`import/confirm`、`generate`、`list`、`delete`） |
| POST | `/api/pickdir` | 系统原生目录选择，返回绝对路径 |
| POST | `/api/data/export` `/api/data/import` | 全量数据导出/导入（zip，含 schema 版本） |
| GET | `/api/diag` | 诊断包导出（日志 + 数据快照） |
| GET/POST | `/api/update/*` | 更新源检查、下载与安装进度 |

## 设计文档

- `docs/概要设计说明.md` — 总体架构、模块划分、接口定义、计算口径
- `docs/设计-国标造价引擎.md` — 费率与基准口径
- `docs/设计-估算历史与版本管理.md` — 历史持久化与 diff
- `docs/设计-前端拆分与生态扩展.md` — `frontend/src` 模块化与构建链
- `docs/设计-多语言边界-交付物恒为中文.md` — 界面双语与交付物语言边界
- `docs/设计-核心链路自动化测试.md` — S1–S12 套件设计
- `docs/设计-结果可视化与导出管线.md` / `docs/设计-结果页信息架构与可访问性.md` — 结果页与导出
- `docs/设计-设计令牌与主题系统.md` — 主题与品牌色令牌
- `docs/设计-复核表格增强与规则沉淀.md` — 审核表格交互与规则沉淀
- `docs/设计-运维健壮性与数据安全.md` — 数据备份、诊断与健壮性

## 许可证

内部工具，未随附开源许可证。
