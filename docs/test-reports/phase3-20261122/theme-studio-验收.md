# T06193 主题工作室实时预览 · 验收报告

- 任务：MTask `T06193`《[PRD] 构建主题工作室实时预览》
- 任务 ID：`684092bc-d6ee-457f-9971-17704267c241`
- 优先级：high
- 验收日期：2026-11-24
- 结论：**通过（实现 / 单测 / API / UI / 响应式 / 无障碍 / 导出均已闭环）**

## 1. 口径与实现范围

按任务描述实现视觉主题的实时预览、WCAG 对比度检查和 JSON 导出；不包含功能配置。

- 任务验收项写 `AC-36`、`AC-37`，关联准则列 `REQ-017`、`AC-31`、`AC-32`，编号存在口径差异；实现以任务描述中的行为定义为准，未擅自改写编号。
- `REQ-017` 提到白标品牌包贯穿 UI / 报告 / 安装器；T06193 的完成定义只要求 **UI / 报告一致**，安装器不在本任务边界内。导出的三层主题 JSON 可作为后续安装器品牌包的输入。
- “品牌包 1 天内完成”是流程承诺，不是可自动断言的时间指标；本次实测从模板加载、改色、保存到导出均为秒级。

### 对比度检查口径

采用 WCAG 2.2 相对亮度公式，检查 6 组实际被组件消费的前景 / 背景组合：

| key | 组合 | 默认蓝 |
|---|---|---|
| `ink_bg` | 正文 / 页面背景 | 14.68:1 |
| `ink2_bg` | 次级正文 / 页面背景 | 10.31:1 |
| `muted_bg` | 弱化文字 / 页面背景 | 5.98:1 |
| `ink_card` | 正文 / 卡片背景 | 14.68:1 |
| `button` | 主按钮文字 / 主按钮背景 | 5.17:1 |
| `badge` | 品牌徽标文字 / 品牌徽标背景 | 6.08:1 |

低于 `4.5:1` 的项写入校验错误，前端禁用保存，服务端 `/api/theme/apply` 返回 400，不能只靠前端拦截。

## 2. 交付内容

### 后端

- `scripts/theme_tokens.py`
  - 新增 `MIN_CONTRAST = 4.5`、`CONTRAST_PAIRS`、`_hex_rgb`、`_luminance`、`contrast_ratio`、`contrast_checks`；
  - `validate()` 解析 raw / semantic / component 后执行 6 组对比度检查，并输出 `contrast` 列表；
  - 任一检查失败即写入 errors，`save_active()` 与 `/api/theme/apply` 均拒绝落盘；
  - 继续保持 50KB、主题名、token 引用层级等原有校验。
- `data/themes/lime.json`
  - 主按钮前景从 `raw.white` 调整为 `raw.slate900`，青柠主按钮对比度由 1.98:1 提升到 7.40:1；
  - 默认蓝主按钮保持 5.17:1。
- `tests/theme_studio.py`：15 项对比度 / 保存单测。

### 前端

- `frontend/src/js/37_theme_studio.js`
  - 配置中心「主题工作室」入口；
  - 内置主题模板加载、品牌令牌编辑；
  - 实时预览：UI 卡片、按钮、报告头部、品牌徽标同步刷新；
  - 6 组对比度表实时计算，不足时禁用保存并提示；
  - 保存调用 `/api/theme/apply`，服务端二次校验；
  - 导出 `raw / semantic / component` 三层 JSON，可再次导入；
  - Esc 关闭、Tab 焦点陷阱、关闭后焦点归还入口；
  - `setLang()` 时重绘动态标签与对比度表。
- `frontend/src/css/65_theme_studio.css`
  - 双栏工作室、实时 UI / 报告预览、对比度表、底部操作；
  - 1024 / 768 响应式，单栏预览优先，无页面级横向溢出；
  - 品牌文字统一使用 `--brand-ink`，避免亮色品牌直接作为正文颜色。
- `frontend/src/js/24_theme_tokens.js`
  - 主题面板新增工作室入口；
  - component 层 `button.primary.foreground` 映射到 `--on-brand`；
  - 保存后同步 `wl_brand`，重置时清理。
- `frontend/src/css/20_components.css`
  - `.btn-primary` 消费 `--c-button-primary-foreground` / `--c-button-primary-background`，component token 真正生效。
- `frontend/src/js/07_m3_fr_1_4_1_5_1_7_2_9_批量.js`
  - 外观模式与语言选中态文字改用 `--brand-ink`；自定义黄色品牌下不再出现品牌色文字低对比。
- `frontend/src/index.src.html`
  - 新增 `#themeStudioOverlay` 静态弹层：品牌令牌、实时预览、对比度检查、底部操作。
- `data/i18n/zh-CN.json`、`en-US.json`
  - 新增 67 个主题工作室键，各 1095 键；中英 key 对齐。

## 3. 测试证据

| 测试 | 结果 | 证据 |
|---|---|---|
| 主题对比度单测 | **15/15** | `results/theme-studio-unit.json` |
| 主题工作室 UI | **22/22** | `results/ui-theme-studio.json` |
| 主题 Token 回归 | **23/23** | `results/theme-tokens.json` |
| i18n 键校验 | **0 失败**，1095 键 | `tests/i18n_check.py` |
| axe WCAG A/AA | **0 serious** | `ui-theme-studio` 内置 axe |
| 前端构建 | 13 CSS + 26 JS，893200 B | `frontend/index.html` |

### 关键数值

- 默认蓝 6 组：14.68 / 10.31 / 5.98 / 14.68 / 5.17 / 6.08。
- 青柠 6 组：14.36 / 8.58 / 7.43 / 14.61 / 7.40 / 4.82。
- 低对比模拟：黄色主色 + 白色按钮文字 = **1.07:1**，保存禁用，服务端返回 400 并返回错误项。
- 改为黑色按钮文字：**19.56:1**，保存恢复。
- 保存后根 `--brand`、`localStorage.wl_brand`、`buildGeneratePayload().brand_color` 三处同为 `#ffff00`。
- 导出 JSON 保留 `semantic.brand=#ffff00`、`component.button.primary.foreground=#000000`，重新导入后生效。
- 自定义黄色品牌 + 黑色按钮文字状态下，axe `color-contrast` 严重阻断为 0。

### UI 验收

- 入口：配置中心「主题 Token」面板显示「主题工作室」。
- 实时预览：改主色后预览按钮、报告装饰线、对比度表同步变化。
- 保存阻断：白字黄底 1.07:1 时保存按钮禁用，提示「对比度不足：保存已阻断（需 ≥ 4.5:1）」。
- 服务端阻断：绕过前端直接 `POST /api/theme/apply` 仍返回 400。
- 保存生效：保存后全局按钮、`wl_brand` 与报告生成参数同源。
- 导出/导入：JSON 三层结构完整，重新导入后品牌色生效。
- 英文态：标题、字段标签、对比度行、摘要均本地化。
- 响应式：1024 / 768 无页面级横向溢出，预览可见。
- 无障碍：Esc 关闭并归还焦点；自定义黄色品牌下 axe 0 serious。
- 截图：
  - `screenshots/theme_studio_1440.png`
  - `screenshots/theme_studio_1024.png`
  - `screenshots/theme_studio_768.png`

## 4. 已知边界

1. 对比度表只覆盖 6 组核心文字 / 背景组合，不等价于全站所有自定义 token 的完整审计；当前 UI 的品牌文字统一走 `brand-ink`，新增品牌文字消费点需继续使用该 token 或扩展检查表。
2. 安装器品牌包不在 T06193 边界内；导出的三层 JSON 已为安装器复用保留结构，但安装器侧消费未在本任务实测。
3. 主题 JSON 当前 `version: 1`，没有版本迁移机制；导入只校验结构、引用和对比度，不做历史主题自动升级。
4. 主题工作室只处理视觉主题，不包含功能开关、角色权限或业务流程配置。

## 5. 结论

T06193 已完成主题模板加载、品牌令牌编辑、UI / 报告实时预览、6 组 WCAG 对比度阻断、服务端二次校验、主题保存与三层 JSON 导出 / 导入；自定义品牌下 UI 与报告主色同源，1024 / 768 响应式与 axe A/AA 均通过。单测 15/15、UI 22/22、主题 Token 回归 23/23，可以提交并回写 MTask。
