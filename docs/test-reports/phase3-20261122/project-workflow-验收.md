# T06198 项目状态机与签收验收

- 任务：`[PRD] 实现项目状态机与签收`（REQ-020 / AC-23 / AC-24）
- 结论：**PASS**
- 验收日期：2026-11-24
- 运行方式：本地 Windows、隔离数据目录、无头 Chrome；UI 通过 `tests/phase3/run_phase3.mjs --only project-workflow` 在干净实例执行。

## 实现范围

### 状态机与审计

- `scripts/project_workflow.py` 新增独立 `WorkflowStore`，使用 `data/workflow.db`，不侵入估算主库。
- 状态：`draft`（草稿）、`review`（评审中）、`rejected`（已驳回）、`signed`（已签收）。
- 流转：
  - 生成/新增版本 → `draft`
  - `submit_review`：`draft/rejected` → `review`
  - `reject`：`review` → `rejected`
  - `revise`：`rejected/review` → `draft`
  - `withdraw`：`review` → `draft`
  - `sign`：`review` → `signed`
- `signed` 后所有流转返回 `409 invalid_transition`；驳回与签收必须填写意见；操作人必填。
- 每次变更写入 `workflow_events`，字段包含 `at`、`action`、`from_status`、`to_status`、`actor`、`role`、`opinion`、`object_ref`、`version_no`、`version_hash`，满足 AC-23 人/时间/对象/意见四要素。
- 版本哈希对标题、版本号、方法、参数、明细、汇总的规范化 JSON 做 SHA-256，保存完整 64 位；签收后冻结，新版本自动回到 `draft` 并清空当前签收人/时间/意见，旧签收事件保留。
- `sync_from_history()` 首次访问时把 `estimation.db` 已有版本组补登记为草稿项目。

### 服务端

- `GET /api/workflow/projects`：返回部署模式、项目列表、四状态计数。
- `GET /api/workflow/project?project_id=...`：返回项目、状态、事件链、版本列表、签收段。
- `POST /api/workflow/transition`：合法流转 200；非法流转 409；字段缺失 400；项目不存在 404。
- `POST /api/workflow/signoff-package`：组装审计包并生成 PDF；签收页使用冻结版本哈希。
- `/api/generate` 响应新增 `version_group`、`version_no`，落库后自动调用 `WORKFLOW.ensure()` 登记状态。
- 部署配置新增 `deployment.mode`，仅接受 `standalone` / `workgroup`；默认单机版。

### 前端

- `frontend/src/js/39_project_workflow.js` + `67_project_workflow.css`：项目列表/搜索、状态徽标、版本列表、完整哈希、签收冻结卡、倒序审计轨迹、状态操作表单、按钮可用性、报告下载。
- `index.src.html` 新增导航 `#mi-flow`、页面 `#pg-flow`、配置中心部署模式卡；`body` 增加 `data-deploy-mode`。
- 单机版隐藏导航、直接 `goPage('flow')` 拦截并提示；工作组版进入签收页。
- 审计轨迹容器补 `tabindex="0" role="region" aria-labelledby`，修复 `scrollable-region-focusable`。
- 中英字典各 1226 键，新增 `flow.*`、`config.deploy.*`、`nav.flow`、`workflow.srv_*`。

### 签收报告

- `scripts/audit_package.py` 签收页新增“签收结论”表：签收人、签收时间、签收意见、完整版本哈希；短哈希同步进入页眉/审计摘要。
- `version_hash` 覆盖仅接受 16 位十六进制；普通审计包仍保持 30 秒预算，签收报告使用 120 秒预算并记录实际耗时。
- `_insert_generation_history()` 改为插入后取完整历史快照计算哈希，修复“创建事件哈希与项目冻结哈希不一致”。

## 验收证据

| 验收层 | 结果 | 证据 |
|---|---|---|
| 单元测试 | **24/24 PASS** | `docs/test-reports/phase3-20261122/results/project-workflow.json` |
| HTTP 验收 | **25/25 PASS** | `results/project-workflow-api.json`；项目 `87d14ed879ae424ca7e8cf5e1e54e9ed`；哈希 `a2a9a0898a08c992a43f07b36ff53adf93890a4f10cc525dad7bd6b437dcd3da` |
| UI 验收 | **23/23 PASS** | `results/project-workflow-ui.json`；项目 `3cd568cf7bb6442881af12b6cdfe9106`；哈希 `2586ea2fb0911d75e83abd2c6dd11d1977aba73d2b32a76c8f44b1c1231613d3` |
| 签收 PDF | **9 页 / 393,642 B** | `results/project-workflow-signoff.pdf`；签名/时间/意见/短哈希均通过文本抽取校验 |
| 可访问性 | axe critical/serious **0** | 签收页 1440px，`color-contrast` 0 节点 |
| i18n | **17/17 PASS** | 中英各 1226 键，术语与服务端 `msgKey` 全量覆盖 |
| 编译/构建 | PASS | `py_compile`、`node --check`、`build_frontend.py` → `frontend/index.html` 953,929 B |

关键 UI 实测：

- 工作组版入口可见，部署徽标“工作组版”；单机版入口 `display:none` 且 `goPage('flow')` 被拦截。
- 真实生成草稿项目，显示 64 位哈希与 1 条创建事件；草稿仅“提交评审”可用。
- 依次点击：提交评审 → 驳回 → 修订 → 再提交 → 签收，状态、意见、审计轨迹 6 条全部正确。
- 签收卡显示签收人“王签收”、时间、意见“UI 同意签收”、完整哈希；表单只读，仅报告按钮可用。
- UI 生成签收报告提示“签收报告已生成：9 页”。
- 1440/1024/768 页面横向溢出均为 0，列表/详情/报告按钮均可见。
- 页面 JS 异常 0。

截图：

- `screenshots/project_workflow_1440.png`
- `screenshots/project_workflow_report_1440.png`
- `screenshots/project_workflow_1024.png`
- `screenshots/project_workflow_768.png`

## 复现命令

```powershell
cd C:\Users\hspcadmin\AppData\Local\Temp\eval_t171_clean
F:\Program Files\Python3.14\python.exe tests\project_workflow.py
F:\Program Files\Python3.14\python.exe scripts\server.py 8033 --serve-frontend --no-open
F:\Program Files\Python3.14\python.exe tests\project_workflow_api.py http://127.0.0.1:8033
D:\code\nodejs24\node.exe tests\phase3\run_phase3.mjs --only project-workflow
F:\Program Files\Python3.14\python.exe tests\i18n_check.py
```

## 边界与已知限制

1. 部署模式只控制前端入口与页面流程，未在服务端做 RBAC；单机版直接调用 workflow API 仍可读取/流转。角色权限与 SSO 由 T06199 承接。
2. `workflow.db` 与 `estimation.db` 分库；首次访问补登记历史版本，之后新生成实时登记。直接改写历史库不会自动回灌，需重新触发同步。
3. 签收报告依赖 Chromium printToPDF + PyMuPDF；冷启动耗时波动，签收端点给 120 秒预算，普通审计包仍为 30 秒门。
4. UI 验收覆盖中文、工作组版全流程；英文界面仅做字典一致性与静态键校验，未做英文签收全流程点击。
5. 首轮 UI 报告生成在旧实例与 Excel 后台重算并发时失败一次；切换干净 phase3 实例后 9 页报告通过。该并发场景已记录，不视为功能通过证据。
