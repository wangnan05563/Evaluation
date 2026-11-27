# PDF 引擎选型 Spike（T06176 / AC-08）

- 日期：2026-11-22
- 样本：`sample-audit.html`（封面 + 目录 + 17 章，19 页）
- 结论：**采用 Chromium printToPDF 作为主引擎；WeasyPrint 仅作备选，不进入默认安装包。**

## 1. 实测结果（Chromium）

| 指标 | 结果 | 判定 |
|---|---|---|
| 页数 | 19 页（封面 + 目录 + 17 章） | 通过 |
| 文件大小 | 421,159 bytes | 通过 |
| 第二遍渲染耗时 | 3,593 ms（含目录页码回填后的正式版本） | ≤5s，通过 |
| 首遍渲染 | 2,896 ms | — |
| 中文字体 | `MicrosoftYaHei`、`MicrosoftYaHei-Bold`、`NSimSun`、`ArialMT` 均以子集嵌入 | 通过 |
| 目录页码 | 17/17 与正文实际页一致（3–19） | 通过 |
| PDF 书签 | 20 条（封面/目录 + 17 章 + 尾页） | 通过 |
| 水印 | 19/19 页均含「内部演示 · 勿外传」 | 通过 |
| 页脚页码 | 19/19 页均含 `n / 19` | 通过 |
| 确定性 | 两次渲染文本 SHA-256 一致；字节不同，仅 `creationDate/modDate` 时间戳差异 | 通过（可解释） |

复现命令：

```powershell
& 'F:\Program Files\Python3.14\python.exe' tests\phase3\pdf_spike.py
```

产物：
- `sample-audit-chromium.pdf`（正式样例）
- `sample-audit-final.html`（回填页码后的最终 HTML）
- `pdf-spike-result.json`（完整机读结果）

## 2. 两遍渲染目录方案

Chromium 不支持 CSS Paged Media 的 `target-counter()`，无法在 CSS 里直接写“第 N 章 → 第 X 页”。本 Spike 采用两遍渲染：

1. 第一遍渲染占位目录，生成 `pass1.pdf`；
2. 用 PyMuPDF 按章节标题定位实际页码；
3. 把 `{{PAGE_n}}` 替换为真实页码，生成最终 HTML；
4. 第二遍渲染正式 PDF，再用同一份页码表校验目录。

实测 17/17 页码一致，第二遍 3.6s，满足单包 ≤30s 预算。若拆成 17 个独立 PDF，每份都走两遍渲染，总耗时约 60s，会超预算；建议审计包保持“一个 PDF、17 章”的交付形态。

## 3. 与 WeasyPrint 对比

| 维度 | Chromium printToPDF | WeasyPrint |
|---|---|---|
| 运行时依赖 | Electron 已内置，无新增依赖 | Windows 需 GTK/Pango 等原生 DLL，安装包与故障面显著增加 |
| 目录页码 | 不支持 `target-counter()`，需两遍渲染 | 原生支持 `target-counter()`，目录页码最优雅 |
| 页眉页脚 | `headerTemplate/footerTemplate`，页码可用 | `@page` margin boxes，表达力更强 |
| 中文字体 | 子集嵌入稳定，实测 YaHei/SimSun 通过 | 依赖字体配置与 Pango，Windows 上需额外验证 |
| 书签 | `generateDocumentOutline` 可生成 | 支持 PDF bookmarks |
| 与现有 Electron 集成 | 直接 `webContents.printToPDF`，零桥接 | 需 sidecar/服务化，跨进程传递 HTML 与字体 |
| 本机可用性 | 已内置 Chrome 157，实测通过 | 未安装；`ModuleNotFoundError: No module named 'weasyprint'` |

**决策**：Chromium 主引擎。WeasyPrint 仅在“必须使用 CSS `target-counter()` 且能接受 GTK 依赖”的客户环境作为可选插件，不进入默认安装包。

## 4. 风险与后续

1. **字节级确定性**：Chromium 每次写入 `creationDate/modDate`，字节不同但文本哈希一致。若验收要求字节级快照，需要渲染后用 PyMuPDF 重写元数据，或对 PDF 做规范化后哈希。
2. **两遍渲染成本**：单包 3.6s 可接受；若未来拆分为多份 PDF，需要改为一次 HTML 多文档或并行渲染。
3. **字体授权**：当前使用系统 Microsoft YaHei/SimSun；分发审计包时需确认客户机器字体许可，建议后续内置开源 Noto Sans SC 子集。
4. **水印层级**：当前用 `position:fixed` + 低透明度，实测 19/19 页覆盖；若后续加入图表/图片，需要回归水印不被图片遮挡。

## 5. 验收对照（AC-08）

| AC-08 要求 | 证据 | 结果 |
|---|---|---|
| 字体嵌入 | PDF 字体列表含 YaHei/SimSun 子集 | 通过 |
| 页码 | 19/19 页页脚 `n / 19` | 通过 |
| 目录稳定 | 17/17 页码与正文一致，两次文本哈希一致 | 通过 |
| 确定性快照 | 文本哈希一致；字节差异仅时间戳，已记录 | 通过（需规范化可选） |
| 17 项文档 ≤30s | 单包 19 页第二遍 3.6s | 通过 |

> 注：原始 Spike 产物（样例 PDF/PNG/HTML/JSON）已随 docs 清理移除；复现脚本仍为 `tests/phase3/pdf_spike.py`。

