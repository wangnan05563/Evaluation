# T06171 三层 Token 设计系统 验收

- 任务：Evaluation三期 T06171（urgent，REQ-001 / AC-01）
- 结论：**通过**（23/23 自动化检查）
- 证据：`results/theme-tokens.json`、`screenshots/theme_tokens_lime_config_1440.png`

## 交付

1. 三层 Token 模型 `scripts/theme_tokens.py`
   - `raw`：原始设计值（色板、字体、间距、圆角、阴影、动效）；
   - `semantic`：语义变量，引用 raw，落为 `--brand/--bg/--ink/--r-lg/--shadow/...`；
   - `component`：组件绑定，引用 semantic/raw，落为 `--c-button-primary-background` 等。
2. 内置主题 `data/themes/base.json`、`data/themes/lime.json`，覆盖颜色/字体/间距/圆角/阴影/动效六类。
3. 主题 API：`GET /api/theme`、`GET /api/theme/export?name=`、`POST /api/theme/validate|apply|reset`。导入前逐引用解析，缺失引用直接拒绝；单文件上限 50KB；主题名白名单防路径穿越。
4. 配置中心「主题 Token」面板：选择/应用内置主题、导出 JSON、导入 JSON 文件并即时生效；刷新/重开自动恢复已应用主题。
5. 现有组件不改代码：按钮、卡片、徽章等继续消费原 CSS 变量；图表调色板 `chartTheme()` 读取 `--brand`，应用主题后同步刷新。

## 自动化验证（23/23）

- 主题列表、三层导出、缺失引用拦截、合法主题解析值；
- lime 应用后 `--brand=#84CC16`、`--r-lg=18px`、`--fs-md=14px`、`--shadow` 生效；
- `--c-button-primary-background=#84CC16`，现有 `.btn-primary` 背景变为 `rgb(132,204,22)`；
- 图表调色板 `chartTheme().brand=#84CC16`；
- 刷新后主题与面板自动恢复；
- 导入 `custom-orange` 后 `--brand=#FF6600`、按钮背景 `rgb(255,102,0)`、服务端 active 与导出均为该主题；
- 重置后内联 Token 清除，`--brand` 回落默认 `#2563EB`，服务端 active 为空；
- 全程无页面异常。

## 边界与说明

- 自定义主题是全量皮肤：应用后会覆盖亮色/暗色/高对比的底色与组件变量；重置后恢复原主题模式。若后续要求「主题内同时声明 light/dark 两套」，需要把 semantic 层扩展为按模式分组，当前任务未要求。
- 组件 token 已产出并应用为 `--c-*`，当前核心按钮仍通过 semantic `--brand` 消费；两者同源，新增组件可直接消费 `--c-*`，不需要改旧组件。
