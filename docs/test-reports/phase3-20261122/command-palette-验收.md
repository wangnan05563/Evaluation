# T06184 命令面板与全局搜索验收（AC-17）

日期：2026-11-23
任务：T06184「开发命令面板与全局搜索」，验收项 AC-17
结论：**PASS（24/24）**

## 验收口径

AC-17：Given 任意页面，When 按 Ctrl/Cmd+K，Then 两次按键内打开面板，搜索响应 ≤200ms。

任务完成定义另要求：支持项目/功能项搜索、本地索引、最近与收藏。本轮逐条实测：

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| Ctrl+K 一次组合键打开 | PASS | CDP 真实键盘事件，`keydown` 捕获 `ctrlKey=true`、`key=k` |
| 打开后输入框自动聚焦 | PASS | `document.activeElement.id=cmdkInput` |
| 页面导航可检索/可执行 | PASS | 搜索「帮助」→ Enter → `body.dataset.page=help` |
| 最近使用 | PASS | `we_cmd_recent` 写入 `page:help`，空查询显示「最近」组 |
| 收藏 | PASS | Ctrl+Enter 将 `page:config` 写入 `we_cmd_fav`，星标为 ★，空查询显示「收藏」组 |
| 10k 功能项索引 | PASS | 注入 10,000 条功能项，搜索「功能项9999」命中 |
| 搜索响应 ≤200ms | PASS | 页面检索 **15ms**；10k 功能项检索 **48ms**（面板内实测） |
| 功能项定位 | PASS | Enter 后回到审核页，虚拟表滚动至第 9999 行并高亮 `cur` |
| PERT 项目检索/切换 | PASS | 新建「CMDK 验收项目」→ 搜索 → Enter → `pertCur` 显示项目名、`pertPid=1` |
| Esc/遮罩关闭 | PASS | 两种关闭路径均生效 |
| 无障碍 | PASS | axe WCAG 2.2 A/AA：0 violations（critical/serious=0） |
| 页面异常 | PASS | `Runtime.exceptionThrown` 0 条 |

## 实现

- `frontend/src/index.src.html`：新增 `#cmdk` 覆盖层；列表改为 `role=listbox`，每组 `role=group`、行 `role=option`，避免 `option` 内嵌按钮的 ARIA 违规；打开时对 `.wrap` 设 `inert` + `aria-hidden`，关闭时恢复。
- `frontend/src/js/23_command_palette.js`
  - 本地索引：5 个页面 + 当前 IFPUG 功能项 + PERT 项目（POST `/api/pert/projects` 后台预取一次，失败静默降级）+ 估算历史操作；
  - 搜索：单次内存过滤，25/50/100 前缀/包含加权排序，最多 60 条；
  - 最近/收藏：`localStorage` 的 `we_cmd_recent`（最多 30，展示 8）与 `we_cmd_fav`（展示 10）；
  - 执行：功能项设置 `curSeq` 并按 `CT.rowH` 预滚动，再 `render()` 让虚拟窗口包含目标行；PERT 项目等待下拉重建后回填再 `pertPickProj()`，带 12 次重试避免异步覆盖；
  - 中英双语文案内置，随 `__I18N_LANG`/`wl_lang` 切换，不新增 i18n 字典键，避免与帮助页未提交改动混在一起。
- `frontend/src/css/23_command_palette.css`：全部主题令牌，暗色/高对比自动跟随；行高 40px、focus-visible 走全局品牌环；`prefers-reduced-motion` 下取消定位动画；窄屏隐藏键帽提示。

## 证据

- 自动化：`tests/phase3/ui_command_palette.mjs`（隔离实例 8033 + 无头 Chrome 9335；真实 CDP 键盘事件，不直接调 JS）
- 结果：`docs/test-reports/phase3-20261122/results/cmdk-ac17.json`（24/24）
- 截图：`docs/test-reports/phase3-20261122/screenshots/cmdk_search_1440.png`

## 备注

- 10k 场景下索引构建与首次过滤合并计入面板计时，仍为 48ms，低于 200ms 门禁。
- 命令面板为单机版本地功能，无网络搜索；项目预取仅访问本机 `/api/pert/projects`。
- 本次仅改命令面板相关文件；帮助页未提交改动未纳入提交。
