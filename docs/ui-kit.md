# 核心 UI 组件库（T06172 / REQ-002）

位置：
- 实现：`frontend/src/js/29_ui_kit.js`（全局 `UIKIT`，无第三方依赖）
- 样式：`frontend/src/css/40_ui_kit.css`
- 构建：`npm run build:frontend` 会自动按文件名排序拼进 `frontend/index.html`

组件统一使用现有主题变量（`--brand`、`--ink`、`--line`、`--r-md`、`--shadow-lg` 等），因此亮色 / 暗色 / 高对比三套主题无需额外适配。所有组件均带键盘焦点样式与 ARIA 属性。

## 快速开始

```js
// 按钮
document.body.appendChild(UIKIT.button({
  label: "生成审计包",
  variant: "primary",          // primary | secondary | ghost | danger
  size: "md",                  // sm | md | lg
  icon: "play",
  onClick: () => generate()
}));

// 输入（返回 { el, input, value(), setError() }）
const name = UIKIT.field({
  label: "项目名称", required: true, placeholder: "如：票据系统三期",
  hint: "最多 80 字"
});
document.body.appendChild(name.el);
name.setError("项目名称不能为空");

// 表格
document.body.appendChild(UIKIT.table({
  caption: "功能点明细",
  columns: [
    { key: "desc", label: "功能描述" },
    { key: "ufp", label: "UFP", align: "right" }
  ],
  rows: [{ desc: "内部文件", ufp: 10 }],
  empty: "暂无功能点",
  onRowClick: row => openEvidence(row)
}));

// 图表（纯 CSS 条形图，无 Canvas/外链）
document.body.appendChild(UIKIT.chart({
  title: "各类型 UFP 分布", unit: "UFP",
  data: [{ label: "ILF", value: 40 }, { label: "EI", value: 24 }]
}));

// 弹窗 / 抽屉（返回 { el, panel, body, close(), setContent() }）
const modal = UIKIT.modal({
  title: "确认生成",
  content: "<p>将生成 PDF 审计包。</p>",
  actions: [
    { label: "取消", variant: "ghost" },
    { label: "开始", variant: "primary", onClick: () => go() }
  ],
  onClose: reason => console.log(reason)  // close | escape | backdrop
});
const drawer = UIKIT.drawer({ title: "证据", content: node, side: "right" });
```

## 组件 API

| 组件 | 入口 | 关键参数 | 行为 |
|---|---|---|---|
| 按钮 | `UIKIT.button(o)` | `label/variant/size/icon/disabled/block/onClick` | 原生 `<button>`，`disabled` 置灰；焦点环 2px |
| 输入 | `UIKIT.field(o)` | `label/type/value/placeholder/hint/error/required/disabled/options` | `type=select` 渲染下拉，`type=textarea` 渲染多行；错误态 `aria-invalid` + `aria-describedby` |
| 表格 | `UIKIT.table(o)` | `columns/rows/caption/empty/onRowClick/footer` | 空态整行提示；可点击行 `tabIndex=0`，Enter/Space 触发 |
| 图表 | `UIKIT.chart(o)` | `title/unit/data/max/note` | 高度按最大值归一化，`role=img` + 完整 `aria-label` |
| 弹窗 | `UIKIT.modal(o)` | `title/content/actions/onClose` | `role=dialog`、`aria-modal`、Esc 关闭、Tab 焦点循环、关闭后焦点归还 |
| 抽屉 | `UIKIT.drawer(o)` | 同弹窗 + `side`（right/left） | 右侧滑入，移动端全宽 |
| 进度 | `UIKIT.progress(o)` | `label/value` | `role=progressbar`，0–100 钳制 |
| 徽标 | `UIKIT.badge(text, tone)` | `ok/warn/danger/info` | 状态标签 |
| 组件预览 | `UIKIT.gallery(host?)` | 容器，默认 `body` | 一次性渲染全部组件，用于本地验收/截图 |

## 主题与响应式

- 亮 / 暗 / 高对比：组件只引用语义变量，不写死颜色；切换 `data-theme` 后自动变化。
- 断点：≤768px 表单单列、弹窗/抽屉全屏、图表高度 130px；≥769px 双列表单。
- 动效：`prefers-reduced-motion: reduce` 时关闭入场/条形过渡。
- 打印：`@media print` 隐藏弹窗与组件预览，避免污染审计报告。

## 本地验收

```powershell
$env:PYTHON='F:\Program Files\Python3.14\python.exe'; npm run build:frontend
node tests/phase3/run_phase3.mjs --only ui-kit
```

验收脚本会在真实页面调用 `UIKIT.gallery()`，检查：
1. 按钮 4 种变体 / 3 种尺寸 / 禁用态渲染；
2. 输入、下拉、错误态与 ARIA 关联；
3. 表格 3 行、点击行详情、空态；
4. 图表格数、数值、`role=img`；
5. 弹窗打开/Esc 关闭/焦点归还；抽屉打开/Esc 关闭；
6. 1440 / 1024 / 768 无横向溢出；
7. 亮 / 暗 / 高对比三主题下文本与背景对比度 ≥ 4.5:1（抽样按钮与正文）。

## 边界

- 不含业务逻辑、数据请求、虚拟滚动（大数据表格继续用 `21_component_table.js` 的行池）。
- 图表为轻量条形图，不替代结果页的复杂图表；需要折线/饼图时在业务层扩展。
- 弹窗/抽屉同一时刻可叠加，但调用方应避免超过 2 层。
