# T06181 七部分审计包生成 — 验收报告

- 任务：REQ-007 / AC-08、AC-09
- 日期：2026-11-24
- 结论：**验收通过**（真实 17 项样本生成 10 页 PDF，10.4 秒；30 秒门通过；7/7 目录、10/10 水印、10/10 页脚、字体嵌入、51 条内部追溯链接）

## 1. 交付内容

| 能力 | 实现 |
|---|---|
| 七部分固定结构 | 封面 / 执行摘要 / 方法与口径 / 估算明细 / 追溯矩阵 / 变更与 AI 审计 / 签收页 |
| PDF 渲染 | `scripts/pdf_render.mjs`，Chrome `Page.printToPDF`，A4、背景、页脚 `n / N`、书签 |
| 业务生成 | `scripts/audit_package.py`，校验输入、逐项复算 UFP/US、两遍渲染回填目录页码 |
| 追溯 | 明细每行 UFP、US 与「追溯」共 3 个可点击内部链接；链接定位到追溯页对应行 |
| 服务端 | `POST /api/audit/package`、`GET /api/audit/download`；文件名白名单、AUDIT_DIR 沙箱 |
| 前端 | 结果页导出菜单「七部分审计包（PDF）」；生成中禁用/恢复、成功 toast、浏览器下载 |
| 自动化 | `tests/audit_package.py`、`tests/phase3/ui_audit_package.mjs` |

## 2. 30 秒门根因与修复

**现象**：首版两遍渲染总耗时 128.5 秒；`Page.printToPDF` 自身仅 405–455 ms，时间全部耗在 Node/Chrome 退出等待（每次 `subprocess.run` 约 62.8 秒）。

**定位**：分阶段测量 `render1` 返回 `render_ms=413`，函数实际 62.86 秒；`render2` 返回 455 ms，实际 62.71 秒。耗时不在 PDF 生成，也不在 PyMuPDF 目录/链接阶段（0.06–0.08 秒）。

**修复**：
1. 正式渲染完成后写入指标，`Browser.close` 尽力关闭，再 `process.exit(0)` 强制结束 Node，避免 Chrome/CDP 关闭阶段拖住 60 秒。
2. `finally` 中用 detached `taskkill /PID <chrome> /T /F` 清理浏览器进程并 `unref()`，不阻塞 Node 退出。
3. 不再同步 `rmSync` Chrome 临时 profile（Windows 占用时会等待释放）；旧 profile 由下次生成前按 1 小时 TTL 惰性清理。

**效果**：单次 Node 渲染 64.19 秒 → **4.1 秒**；17 项两遍生成 10.4 秒；API 端到端 7.5–12.1 秒；UI 端到端 12.2 秒。

## 3. AC-08 实测（17 项）

样本来自内置母版前 17 行真实明细，`--sample` 直连生成：

- 页数：**10**
- 文件大小：**433,842 B**
- 生成耗时：**10,442 ms**（`budget_ok=true`，30,000 ms 门）
- 两遍 `printToPDF`：各 **405 ms**
- 目录：**7/7** 正确，页码 1 / 3 / 4 / 5 / 7 / 9 / 10
- 水印：**10/10** 页含「内部 · 勿外传」
- 页脚页码：**10/10** 页
- 字体嵌入：Microsoft YaHei / Microsoft YaHei-Bold / ArialMT 子集
- 明细行：**17**；追溯行：**17**
- 追溯内部链接：**51**（17 行 × UFP/US/追溯）
- 版本哈希：`8f12b9a4597b7c41`
- PDF SHA-256：`379928698ec9a4aed622d107a45624994478f67e7e8b507a302740d1a5d4c206`

## 4. AC-09 追溯实测

- 明细页每行 UFP、US 数值均为独立内部链接，不是只有「追溯」文字可点。
- 点击后定位到第 5 部分追溯矩阵对应行的纵向位置（按 `FP-` 行锚点，跨页连续）。
- 追溯行包含：ID、原文段落、原文摘录、识别规则、复算公式、规则版本、需求关联、验收关联。
- 摘要页修正了首版把「调整后规模 51.63 FP」误标为「未调整 UFP」的问题：现在 UFP=80、US=42.67、调整后=51.63，三项分开。

## 5. 自动化结果

| 套件 | 结果 | 证据 |
|---|---|---|
| `python tests/audit_package.py http://127.0.0.1:8092` | 18/18 PASS（直连 + API + 下载） | `results/audit-package-test.json` |
| `node tests/phase3/run_phase3.mjs --only audit-package` | **9/9 PASS** | `results/ui-audit-package.json` |
| `python tests/i18n_check.py` | 0 失败（921 键对齐） | 控制台 |
| `python tests/unit_engine.py` | 0 失败 | 控制台 |
| `python tests/api_smoke.py 8092` | **17/17 PASS**（种子化隔离实例） | 控制台 |
| `python tests/phase3/run_phase3.mjs --only a11y-wcag22` | **17/17 PASS** | 控制台 |

UI 实测记录：17 项结果快照 → 点击「七部分审计包（PDF）」→ 生成中状态 → toast「审计包已生成：10 页 · 11.8 秒」→ 按钮恢复 → 服务端落盘 404,663 B PDF；全程 12.2 秒。下载接口路径穿越探测 `f=..%2Fconfig.json` 返回 404。

## 6. 边界与后续

- 本次 17 项来自内置母版真实明细，用作结构/性能/追溯验收；真实 PRD 的 17 份独立原始文档尚未接入。T06195 接入 AI 证据/置信度后，追溯矩阵的「原文段落」可替换为精确原文坐标。
- 生成是单进程串行（`AUDIT_LOCK`），避免多个 Chrome 抢 profile；并发请求会排队，不引入独立后台服务。
- 企业母版口径下 DET/RET/FTR 不参与计分，明细显示 `N/A` 并在表下注明；标准 IFPUG 模式需在输入中提供三项。
- 审计包 PDF 不写入 LLM key；服务端仅接受 300 项以内、请求体 ≤3 MB 的 payload。
- Windows 下 Chrome 退出仍依赖 `taskkill` 清理；已用 detached 方式避免阻塞，旧临时 profile 按 TTL 清理。

## 7. 复现

```powershell
# 直连生成 17 项样本
python scripts/audit_package.py --sample docs/test-reports/phase3-20261122/audit audit_t06181

# 直连 + API + 下载
python tests/audit_package.py http://127.0.0.1:8092

# UI 入口
node tests/phase3/run_phase3.mjs --only audit-package
```

## 8. 文件

- `scripts/audit_package.py`
- `scripts/pdf_render.mjs`
- `scripts/server.py`
- `frontend/src/js/32_audit.js`
- `frontend/src/index.src.html`
- `frontend/index.html`
- `data/i18n/zh-CN.json`
- `data/i18n/en-US.json`
- `tests/audit_package.py`
- `tests/phase3/ui_audit_package.mjs`
- `tests/phase3/run_phase3.mjs`
- `docs/test-reports/phase3-20261122/audit/audit_t06181.pdf`
- `docs/test-reports/phase3-20261122/audit/audit_t06181.html`
- `docs/test-reports/phase3-20261122/results/audit-direct.json`
- `docs/test-reports/phase3-20261122/results/audit-package-test.json`
- `docs/test-reports/phase3-20261122/results/ui-audit-package.json`
- `docs/test-reports/phase3-20261122/screenshots/audit_package_p1.png` / `p3.png` / `p5.png` / `p7.png` / `p10.png`
- `docs/test-reports/phase3-20261122/screenshots/audit_package_menu_1440.png`
