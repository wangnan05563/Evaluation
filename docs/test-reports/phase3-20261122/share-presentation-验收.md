# T06182 演示模式与离线脱敏分享 — 验收报告

- 任务：REQ-008 / AC-10
- 日期：2026-11-24
- 结论：**验收通过**（大字号 6 页投屏演示；单文件离线分享包 17 项/11,532 B；0 外部链接、0 远程字体；UI 20/20、直连 15/15）

## 1. 背景与目标

此前结果页只有 Excel/CSV/Markdown/审计包导出，没有适合投屏的大字号演示模式，也没有可对外发送的脱敏单文件。T06182 需要同时解决两个场景：评审会投屏（分页、大字号、隐藏内部备注与未确认数据）和离线分享（内容完整、无外部链接、无字体缺失）。

## 2. 实现

### 2.1 投屏演示模式

- 结果页新增「演示模式」入口（`#presentBtn`）；全屏 `#presenter` 覆盖层，6 页：
  1. 封面与项目边界；
  2. 规模/工作量/费用 KPI；
  3. 分系统与类型/重用分布；
  4. US Top 8 已确认功能项；
  5. 方法与口径；
  6. 分享边界与脱敏说明。
- 只读取 `items.filter(x => x.ok === true)`；演示页不渲染 `note`、`evidence`、`basis`、`trace` 等字段。
- 若存在未确认项，摘要按已确认项用 `ufp/us` 重新计算，不沿用全量 `gSummary`；测试中 15/17 确认，投屏 KPI 与页面逐项复算一致（UFP 90）。
- 分页：`上一页/下一页`、`←/→`、`PageUp/PageDown`、空格；`Esc` 退出；退出焦点回到「演示模式」按钮。
- 1440×900 下封面 `h1` 实测 66.24px；投屏页不暴露未确认描述与内部备注 sentinel。

### 2.2 离线脱敏分享包

- 结果页导出菜单新增「脱敏分享包（HTML）」；前端只提交已确认项，服务端再做一次白名单化：
  - 只保留 `stable_id/system/m1/desc/count_item/type/reuse/modify/det/ret/ftr/seq`；
  - 丢弃 `note/remark/comment/evidence/trace/basis/ai/confidence/raw/path`；
  - 只接受 `ok === true`，未确认项不进入 HTML；
  - 摘要按分享项重新复算，不携带全量 KPI。
- 单文件 HTML：内联 CSS；`font-family` 只用 Microsoft YaHei / PingFang SC / Noto Sans SC / Segoe UI / Arial 系统栈；无 `@font-face`、无 `<link>`、无 `<script src>`、无 `src=`、无 `href=`、无 `url()`、无 `http(s)://`。
- 服务端 `POST /api/share/package` 生成到独立 `SHARE_DIR`，`GET /api/share/download?f=` 白名单下载；路径穿越返回 404。
- 分享页面按 A4 打印流式排版，离线 Chrome 打开/打印为 7 页；包含封面、执行摘要、方法与口径、规模构成、已确认功能项清单。

## 3. AC-10 实测

### 3.1 演示模式

- 入口：结果页顶部「演示模式」。
- 页数：6；首屏 `1 / 6`，翻页后 `2 / 6`。
- 字号：封面 h1 66.24px；KPI 数字 30px+（1440×900）。
- 隐藏：`SECRET_NOTE_INTERNAL_ONLY`、未确认项 16/17 的 `desc` 均未出现在投屏 DOM。
- 键盘：ArrowRight/按钮翻页、Esc 退出、焦点回 presentBtn；ole=dialog、ria-modal=true、打开焦点进 presenterExit。
- 截图：`screenshots/presenter_1440.png`、`screenshots/presenter_summary_1440.png`。

### 3.2 离线分享包

- 样本：内置母版 17 项全部确认，`share_t06182.html`；
- 文件：**11,532 B**；4 个正文 section（执行摘要/方法与口径/规模构成/功能项清单）+ 封面；
- 数据：17 项，UFP 80、US 42.67、调整后 51.63 FP、工作量中值 55.09 人天、费用中值 6.44 万元；
- 离线自检：`external_links=0`，`font_stack=true`，`sections=4`；
- 离线打开：Chrome `file://` 打开并打印为 **7 页 PDF**（`share_t06182_offline_check.pdf`），字体/排版完整；
- SHA-256：`8a1cec15a20a17402e46927b0a39710cf55fd50ba2439b01e38856b048e38cbe`；
- 截图：`share_t06182_p1.png`（封面）、`share_t06182_p2.png`（执行摘要）。

### 3.3 隔离与脱敏样本

`tests/share_package.py` 用 15 项确认 + 2 项未确认 + 内部备注 sentinel 生成：

- `items=15`、`excluded=2`；
- `SECRET_NOTE` / `SECRET_EVIDENCE` / `UNCONFIRMED_ITEM` 均未进入 HTML；
- 摘要按 15 项复算（UFP 72、US 38.67、调整后 46.79 FP、工作量 49.92 人天、费用 5.83 万元）；
- 分享包生成 3 ms；API 生成 17 项 11,449 B；下载 `text/html`；路径穿越 404。

## 4. 自动化结果

| 套件 | 结果 | 证据 |
|---|---|---|
| `python tests/share_package.py http://127.0.0.1:8092` | **15/15 PASS** | `results/share-package-test.json` |
| `node tests/phase3/run_phase3.mjs --only present-share` | **20/20 PASS**，1/1 suite | `results/ui-present-share.json` |
| `python tests/i18n_check.py` | 0 失败（930 键，双字典一致） | 控制台 |
| `python tests/unit_engine.py` | 0 失败 | 控制台 |
| `python tests/api_smoke.py 8092` | **17/17 PASS** | 控制台 |
| `node tests/phase3/run_phase3.mjs --only a11y-wcag22` | 17/17 PASS（T06181 回归） | 控制台 |

UI 实测：生成 17 项结果 → 演示打开 → 6 页翻页 → Esc 退出 → 导出菜单 → 分享生成（15 项 · 9 KB）→ 按钮恢复；分享生成 272 ms，全程无页面异常。

## 5. 文件

- `scripts/share_package.py` — 白名单化/单文件 HTML/离线自检/摘要复算
- `scripts/server.py` — `SHARE_DIR`、`POST /api/share/package`、`GET /api/share/download`
- `frontend/src/js/33_present_share.js` — 6 页投屏、键盘分页、分享 payload/下载
- `frontend/src/css/61_present_share.css` — 全屏大字号演示样式
- `frontend/src/index.src.html` — `#presentBtn`、`#shareBtn`、`#presenter`
- `frontend/index.html` — 重建（802,638 B）
- `data/i18n/zh-CN.json` / `en-US.json` — 新增 presentation/share 词条
- `tests/share_package.py`
- `tests/phase3/ui_present_share.mjs`
- `tests/phase3/run_phase3.mjs` — 新增 `present-share` suite
- `docs/test-reports/phase3-20261122/share/share_t06182.html`
- `docs/test-reports/phase3-20261122/share/share_t06182.json`
- `docs/test-reports/phase3-20261122/share/share_t06182_offline_check.pdf`
- `docs/test-reports/phase3-20261122/share/share_t06182_p1.png` / `p2.png`
- `docs/test-reports/phase3-20261122/screenshots/presenter_1440.png` / `presenter_summary_1440.png` / `share_menu_1440.png`
- `docs/test-reports/phase3-20261122/results/share-package-test.json` / `ui-present-share.json`

## 6. 边界

- 投屏是浏览器内全屏覆盖层，不调用系统全屏 API；投屏分辨率按当前窗口，1440×900 验收通过。
- 分享包是 HTML（非 PDF/压缩包）；单文件便于离线打开和转发，内容完整但无在线预览/检索。
- 分享包不含用户身份、上传原文件、原文证据、AI 置信度、内部备注与未确认项；只展示报告摘要和已确认功能项。
- 服务端对 `ok === true` 做硬过滤，缺少确认态的数据不会进入分享包。
- 分享包由服务端同步生成（无 Chrome 依赖），UI 实测 272 ms；不引入后台任务。
- 页数随功能项数量增加；本次 17 项离线打印 7 页，未做分页压缩。

