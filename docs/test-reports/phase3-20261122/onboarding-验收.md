# T06183 首次启动角色化引导 — 验收报告

## 结论

首次启动新增角色选择：默认「评估师」，点击「用样例 5 分钟跑通」后，服务端内存生成内置样例 docx，走正常识别 → 全部确认 → 生成结果链路；实测 **3.5 秒**到达结果页，满足 ≤5 分钟验收。项目经理/PMO、财务/商务角色不进入样例，按角色提示进入对应工作区；不展示高级功能引导。

## 实现

- `frontend/src/index.src.html`：新增 `#roleWelcome` 覆盖层，`role=dialog` / `aria-modal`、3 个角色单选、评估师样例 CTA、进度/状态、稍后入口。
- `frontend/src/js/34_role_onboard.js`：首次启动判定、角色持久化、焦点陷阱/Esc、样例流程、本地匿名耗时记录；`?welcome=0` 跳过，`?welcome=1` 强制（供回归/验收）。
- `frontend/src/css/62_role_onboard.css`：全屏遮罩 + 角色卡 + 进度条；1440/768/375 响应式。
- `scripts/server.py`：`GET /api/onboarding/sample` 内存生成 `评估师样例-票据业务系统.docx`（36,152 B），覆盖 EI/EQ/EO/EIF/ILF 五类；不落盘、不含客户数据。
- `frontend/guide.js`：角色弹窗打开时或已选角色时，不再自动叠加旧菜单引导，避免首启双浮层；未选角色的既有用户行为不变。
- `tests/phase3/cdp.mjs`：既有 UI 套件默认 `?welcome=0`，不污染回归；角色套件显式 `?welcome=1`。
- `tests/onboarding_flow.py`、`tests/phase3/ui_role_onboard.mjs`、`tests/phase3/run_phase3.mjs`：直连/API/UI 验收与 suite 注册。

## 实测

- 首次启动：弹窗可见，3 个角色，评估师默认选中；`role=dialog`、`aria-modal=true`、背景滚动锁定。
- 切换项目经理：`aria-checked=true`，CTA 变「查看历史估算」；切回评估师恢复样例 CTA。
- 样例：**3.5 秒**到达结果页；6 项全部确认；UFP **34**、调整后 **27.43 FP**、US **22.67**、工作量 **29 人天**、费用 **3.42 万元**。
- 本地匿名记录：`success=true`、`elapsed_ms=1157`、`items=6`、`source=builtin_sample`；无 token/上传字段。
- 旧菜单引导：角色弹窗打开/已选角色时不再自动弹出；结果页截图无旧引导叠加。
- 响应式：768px、375px 弹窗无内部横向溢出，角色卡单列；axe 0 serious/critical（violations=0, passes=24）。
- 直连/API：`tests/onboarding_flow.py` **15/15 PASS**，命令层 705 ms；API 识别 6 项、生成摘要 UFP 34。
- UI：`node tests/phase3/run_phase3.mjs --only role-onboarding` **16/16 PASS**。
- i18n：955 键双字典一致，0 失败；既有 a11y 17/17、present-share 20/20 回归通过。

## 证据

- 截图：`docs/test-reports/phase3-20261122/screenshots/onboarding_1440.png`、`onboarding_768.png`、`onboarding_375.png`、`onboarding_sample_result_1440.png`。
- 结果：`docs/test-reports/phase3-20261122/results/onboarding-test.json`（15/15）、`ui-role-onboarding.json`（16/16）。
- 样例接口：`GET http://127.0.0.1:8092/api/onboarding/sample`；样例文件为内存生成，不入库、不落盘。

## 边界

- 角色选择只覆盖首次上手路径，不替代既有帮助/操作引导；已选角色的用户仍可通过帮助页手动重温引导。
- 样例为内置演示文档，不代表客户项目；生成结果写入本机历史（用于后续演示），不包含外部数据。
- “5 分钟”为交互时长验收口径，不代表真实项目估算耗时；真实文档仍取决于文档质量与识别确认量。
- 未实现角色权限隔离/多用户协作；本任务只做首次启动引导与角色化路径。
