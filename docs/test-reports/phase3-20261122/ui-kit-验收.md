# T06172 核心 UI 组件库 验收

- 任务：Evaluation三期 T06172（urgent，REQ-002）
- 结论：**通过**（套件 26/26；按钮/输入/弹窗/抽屉/表格/图表 全部实测）
- 证据：`results/ui-kit.json`、`screenshots/ui_kit_1440.png`、`ui_kit_dark_1440.png`、`ui_kit_1024.png`、`ui_kit_768.png`

## 实现

- 新增 `frontend/src/js/29_ui_kit.js`：全局 `UIKIT`（IIFE，零依赖），提供
  - `UIKIT.button()`：primary/secondary/ghost/danger，sm/md/lg，icon/disabled/block；
  - `UIKIT.field()`：label/hint/error/required，text/select/textarea，`aria-invalid` + `aria-describedby`；
  - `UIKIT.table()`：列定义/空态/可点击行（Enter/Space）/列对齐/页脚；
  - `UIKIT.chart()`：纯 CSS 条形图，`role=img` 全量 aria 文本；
  - `UIKIT.modal()` / `drawer()`：`role=dialog`、`aria-modal`、Esc、Tab 焦点循环、关闭归还焦点；
  - `UIKIT.progress()` / `badge()` / `gallery()`。
- 新增 `frontend/src/css/40_ui_kit.css`：全部使用 `var(--brand/--ink/--line/--r-md/--shadow-lg)`，主题切换自动跟随；≤768px 表单单列、抽屉全宽、弹窗全屏；`prefers-reduced-motion` 关闭动效；打印隐藏。
- 新增 `docs/ui-kit.md`：API、参数、可访问性、主题/断点、验收命令、边界。
- `tests/phase3/run_phase3.mjs` 注册 `ui-kit` 套件。
- `frontend/index.html` 重建为 741,126 字节（18 JS + 6 CSS）。

## 验证（26/26 PASS）

- API：`UIKIT` 加载、版本 1.0.0、6 个核心入口齐全。
- 按钮：11 个实例（4 变体 + 禁用 + 图标 + 3 尺寸 + 弹窗/抽屉入口），禁用态 1。
- 输入：4 个字段、下拉 2 选项、错误态 `aria-invalid=true` 且 `aria-describedby` 指向错误文案；label `for` 与控件 `id` 一致。
- 表格：3 行、点击行回调返回 `{desc:'内部文件',ufp:10}`；空表显示「暂无功能点」。
- 图表：5 柱，`role=img`，aria 文本含「ILF 40UFP…EQ 12UFP」。
- 弹窗：dialog/aria-modal 语义、2 个动作、打开后焦点在弹窗内；Esc 关闭后焦点归还「打开弹窗」按钮。
- 抽屉：打开含原文/规则/AI 建议，宽 480/1440，焦点在抽屉内；Esc 关闭。
- 对比度（WCAG AA ≥4.5:1）：亮色按钮 5.17、正文 5.53；暗色按钮 7.02、正文 6.96；高对比按钮 19.56、正文 15.91。
- 响应式：1440/1024/768 均无横向溢出；768 表单单列，表格内部滚动（693/768）。
- 运行期 0 JS 异常。

## 边界

- 组件库不含业务请求与虚拟滚动；大数据复核表继续使用 `21_component_table.js` 的行池。
- 图表为轻量 CSS 条形图，不替代结果页已有复杂图表。
- 现有页面暂未整体迁移到 `UIKIT`（避免一次性改面）；后续新页面/新弹窗优先使用该 API。

## 本次回写

- 提交：见 MTask T06172 的 git 关联。
- MTask：running → progress start → git link → result → progress done → done + verified。
