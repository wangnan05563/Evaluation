## 根因

T06198 前，系统只有估算生成与审计导出，没有项目级生命周期：无法区分草稿、评审中、驳回、签收，也没有签收冻结、完整审计轨迹和带签收结论的签收页。项目交付只能靠人工线下确认，无法证明“谁在何时对哪个版本、基于什么意见完成签收”。

## 影响范围

- 数据：新增 `data/workflow.db` 与 `workflow_events` 审计事件表，不改动既有 `estimation.db` 表结构。
- 服务端：`C:\Users\hspcadmin\AppData\Local\Temp\eval_t171_clean\scripts\server.py` 新增部署模式、4 个 workflow 端点、生成后自动登记、审计包签收段注入。
- 状态机：新增 `...\scripts\project_workflow.py`，实现状态流转、意见校验、版本哈希、签收冻结、历史补登记。
- 审计包：`...\scripts\audit_package.py` 新增签收结论表、完整哈希、120 秒签收报告预算。
- 前端：新增 `...\frontend\src\js\39_project_workflow.js`、`...\frontend\src\css\67_project_workflow.css`，改造 `index.src.html`、`01_core.js`、`02...js`、`32_audit.js`、`guide.js`。
- i18n：`...\data\i18n\zh-CN.json`、`en-US.json` 各 1226 键。
- 测试：`...\tests\project_workflow.py`、`...\tests\project_workflow_api.py`、`...\tests\phase3\ui_project_workflow.mjs`，并登记 `run_phase3.mjs` 的 `project-workflow` 套件。
- 部署边界：单机版默认隐藏项目签收入口，工作组版启用；未实现服务端 RBAC，权限体系留给 T06199。

## 修复

- 状态机：`draft / review / rejected / signed`；提交、驳回、修订、撤回、签收均校验前置状态；签收后冻结，任何后续流转 409。
- 审计：每次变更写 `at/action/from_status/to_status/actor/role/opinion/object_ref/version_no/version_hash`；驳回/签收意见必填，操作人必填。
- 版本哈希：对标题、版本号、方法、参数、明细、汇总规范化 JSON 做 SHA-256，完整 64 位落库；修复创建事件与项目冻结哈希不一致。
- 签收：签收段返回签收人、时间、意见、完整哈希、短哈希、角色状态与评审意见；新版本自动回 draft 并清空当前签收字段，旧事件保留。
- API：`GET /api/workflow/projects`、`GET /api/workflow/project`、`POST /api/workflow/transition`、`POST /api/workflow/signoff-package`；生成接口返回 `version_group`、`version_no` 并自动登记。
- UI：项目列表/搜索、状态徽标、版本列表、64 位哈希、签收冻结卡、倒序审计轨迹、操作表单、报告按钮；单机版隐藏入口并拦截 `goPage('flow')`。
- 签收报告：签收页新增“签收结论”表，完整哈希换行显示；短哈希进入页眉/审计摘要；普通审计包保持 30 秒门，签收报告 120 秒预算。
- 可访问性：审计轨迹补 `tabindex=0 role=region aria-labelledby`；移除只读表单整体 `opacity:.62` 造成的对比度衰减，改为只读底色/虚线边框。
- 测试设施：签收页在干净 profile 写入角色与引导完成标记，避免引导遮罩污染截图/axe；phase3 checker 失败时返回非 0，避免失败套件被误报 PASS。

## 验证

- `python tests\project_workflow.py`：**24/24 PASS**，覆盖哈希、创建事件四要素、全状态流转、非法流转、意见必填、签收冻结、新版本回 draft、历史补登记、未知 action、空操作人。
- `python tests\project_workflow_api.py http://127.0.0.1:8033`：**25/25 PASS**；项目 `87d14ed879ae424ca7e8cf5e1e54e9ed`，哈希 `a2a9a0898a08c992a43f07b36ff53adf93890a4f10cc525dad7bd6b437dcd3da`，审计 6 条，签收报告 200/9 页/393,642 B，签收页人/时间/意见/短哈希均通过 PDF 文本抽取。
- `node tests\phase3\run_phase3.mjs --only project-workflow`：干净数据实例 **23/23 PASS**；项目 `3cd568cf7bb6442881af12b6cdfe9106`，哈希 `2586ea2fb0911d75e83abd2c6dd11d1977aba73d2b32a76c8f44b1c1231613d3`；UI 五步流转、6 条审计、签收四要素、报告 9 页、1440/1024/768 无溢出、axe 0、JS 异常 0。
- `python tests\i18n_check.py`：**17/17 PASS**，中英各 1226 键。
- `python -m py_compile ...`、`node --check ...`：PASS；`python scripts\build_frontend.py`：15 CSS + 28 JS → `frontend/index.html` 953,929 B。
- 产物：`docs/test-reports/phase3-20261122/project-workflow-验收.md`、`results/project-workflow.json`、`project-workflow-api.json`、`project-workflow-ui.json`、`project-workflow-signoff.pdf`、4 张 1440/1024/768 截图。
- 首次旧实例生成报告时与 Excel 后台重算并发失败一次；干净 phase3 实例复跑通过，已在验收文档记录。

## 已知边界

1. 单机版只做前端入口与页面守卫，未加服务端 RBAC；直接调用 workflow API 仍可用，权限/SSO 由 T06199 承接。
2. `workflow.db` 与 `estimation.db` 分库，历史版本首次访问补登记；直接改写历史库不会自动回灌。
3. 签收报告依赖 Chromium printToPDF + PyMuPDF，冷启动有波动，签收端点预算 120 秒。
4. UI 全流程只覆盖中文；英文只做字典与静态键校验。

---

通道：A（MCP 拉取，本地会话）
会话：workbuddy-20261124194500-t06198
完成时间：2026-11-24T19:50:00+08:00
