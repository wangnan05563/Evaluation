# T06179 三栏证据复核工作台 验收

- 任务：Evaluation三期 T06179（urgent，REQ-005 / AC-06）
- 结论：**通过**（工作台套件 18/18；1440 三栏、1024 两栏+覆盖抽屉、768 单栏均实测）
- 证据：`results/review-workbench.json`、`screenshots/review_workbench_1440.png`、`review_workbench_1024.png`、`review_workbench_768.png`

## 实现

- `frontend/src/index.src.html`：复核页增加左侧 `#riskOutline` 风险大纲、中栏 `rwb-center`、右侧 `#evidenceDrawer` 证据抽屉与 `#evidenceScrim` 遮罩；抽屉带关闭按钮与 `aria-live`。
- 新增 `frontend/src/js/30_review_workbench.js`：全局 `RWB`。
  - 风险评分：缺描述 28、缺计数项 18、缺模块 10、缺分类 20、缺重用/修改各 5、未确认 8、缺依据 8、描述超长 5、重复描述 15；标准 IFPUG 下再校验 DET/RET/FTR。
  - 高风险 ≥50、中风险 25–49、低风险 <25；按风险分组、Top 风险、风险筛选、风险排序。
  - 点击行或 Enter/Space 同步渲染证据：原文、规则（类型/复杂度/UFP/US/DET/RET/FTR/依据）、AI 建议（本地规则占位、置信度、来源、T06195 替换说明）。
  - 抽屉动作复用 `UIKIT.button`：定位原文、标记确认/取消确认；确认走 `pushUndo` + `render()`，同步复核状态。
  - 窄屏抽屉为覆盖式，关闭时设置 `inert` 防误聚焦；Esc/遮罩/关闭按钮均可退出。
- `frontend/src/js/01_core.js`：`visibleItems()` 接入 `RWB.filter` 与 `RWB.riskSort`；非 light 渲染后异步 `RWB.onRender()`，保证风险大纲/行绑定与证据同步。
- 新增 `frontend/src/css/50_review_workbench.css`：≥1360 三栏 `200px / 1fr / 290px`；≤1359 两栏 + 420px 覆盖抽屉；≤900 单栏、风险列表两列；≤600 抽屉全宽；≥901 中栏 550px 九列表格，≤900 沿用原 4 列只读布局。
- `tests/phase3/run_phase3.mjs` 注册 `review-workbench` 套件；`frontend/index.html` 重建为 764,265 字节（19 JS + 7 CSS）。

## 验证（18/18 PASS）

- 1440 三栏：`200px / 606px / 290px`，左中右三块均存在。
- 风险大纲：高风险 1 / 中风险 2 / 待复核 3；样本风险分 59/34/31/0/0。
- 高风险筛选只保留 1 行；风险排序 `[1,3,2,4,5]`，最高风险置顶。
- 点击行同步打开抽屉，实测点击到可见 **8ms**（≤300ms）；三段证据齐全；AI 置信度 73%，来源「本地规则（占位）」并明确 T06195 接入模型。
- 抽屉含「定位原文」「标记确认」；标记确认后状态「已确认」、按钮变「取消确认」。
- 键盘 Enter 打开行证据，选中行与焦点均保持。
- 1024：两栏；抽屉默认隐藏，点击行后覆盖式抽屉宽 420、遮罩显示、body 锁定；关闭后恢复滚动。
- 768：单栏；风险列表两列；`scrollWidth=753/768` 无横向溢出；表格在面板内横向滚动（683/768）。
- 运行期 0 JS 异常。
- 相关回归：`a11y-wcag22 17/17`（200% 缩放下 review 可见控件裁切 0）；`10k-grid 9/9`（滚动容器 clientHeight=300、连续 60 秒 60.0fps）；`regression-baseline 12/12`（6 张上传页视觉基线已按 T06188 后的「复杂度口径」布局刷新）。

## 边界

- AI 建议当前是本地规则占位，不是模型输出；真实模型证据与置信度由 T06195 接入后替换。
- 风险分是本地启发式，不等同模型风险概率；分数用于排序与筛选，不替代人工确认。
- ≤900px 继续使用既有 4 列只读紧凑表，编辑走批量操作；这与 T06173/T06174 的 200%/10k 约束一致。
- 全批次运行受共享 Chrome 恢复态影响（前序套件把 `data-page` 恢复为 config），本套件已加入清空 `we_form_state_v1`、显式 `goPage('work')/goStep('review')` 与 page/step 断言；本轮以单套件证据验收，完整批次留待 T06203 统一收口。

## 本次回写

- 提交：见 MTask T06179 的 git 关联。
- MTask：running → progress start → git link → result → progress done → done + verified。
