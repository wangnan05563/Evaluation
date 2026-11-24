# T06200 外部系统同步验收

- 任务：`[PRD] 开发外部系统同步`（REQ-022 / AC-30）
- 结论：**PASS**
- 验收日期：2026-11-24
- 运行方式：本地 Windows、隔离数据目录、无头 Chrome；外部系统使用本地 HTTP Mock，不访问真实云租户。

## 实现范围

### 连接器与凭据

- `scripts/integrations.py` 新增独立 `IntegrationStore`，使用 `data/integrations.db`，不混入估算库或 RBAC 库。
- 首次启动种子 3 个连接器：`github`（GitHub Issues）、`jira`、`gitlab`（GitLab Issues），`kind` 唯一。
- 连接器字段：启用状态、服务地址、仓库/项目、账号、最近测试时间与结果、字段映射；配置整体以 JSON 落库。
- `token` / `api_token` 由服务端注入的 `secret_store.protect` 加密后落库（Windows DPAPI，密文前缀 `dpapi:`），公开视图仅返回 `token_set` / `api_token_set` 布尔值，不回明文、不回密文。
- 保存时空密钥不覆盖旧密文；界面占位提示“已保存，留空不修改”。

### 三个适配器

| 集成 | 测试连接 | 创建需求/任务 | 认证 |
|---|---|---|---|
| GitHub Issues | `GET /repos/{repo}` | `POST /repos/{repo}/issues` | `Bearer token` |
| Jira | `GET /rest/api/2/myself` | `POST /rest/api/2/issue` | `Basic email:api_token` |
| GitLab Issues | `GET /api/v4/projects/{encoded}` | `POST /api/v4/projects/{encoded}/issues` | `PRIVATE-TOKEN` |

- GitHub 载荷写 `title/body/labels`；Jira 写 `fields.summary/description/labels/priority`，项目与问题类型取连接器配置；GitLab 写 `title/description/labels`（标签按逗号连接）。
- 单次最多 50 条，单请求超时 12 秒。

### 字段映射

- 固定四个槽位：`title`、`body`、`priority`、`labels`。
- 每个槽位可映射到本地字段：`title`、`body`、`priority`、`labels`、`acceptance`、`component`；非法值回退默认映射。
- 映射随连接器持久化，可单独“仅保存字段映射”；适配器按映射取本地值后写入远端固定槽位。例如 `title -> component` 时，远端标题取 `component`。
- `priority` 仅在 Jira 适配器实际使用；GitHub Issues 与 GitLab Issues 无优先级字段，映射值保留但不发送。

### 同步任务、错误与重试

- `jobs` 表记录 `status/total/succeeded/failed/attempts/error/errors_json/payload_json/retry_of`。
- 状态：`success`（全部成功）、`partial`（部分成功）、`failed`（全部失败）、`running`（执行中）。
- 可重试错误自动重试，最多 3 次尝试；`NETWORK`、HTTP 429、HTTP 5xx 视为可重试，间隔 `0.15*n` 秒。
- 彻底失败保留逐条错误：`{index, title, code, message, status, retryable}`；任务级 `error` 保留首因摘要。
- 手动重试创建新任务并写 `retry_of`；**部分失败只重发失败条目**，已成功创建的远端条目不重复提交。
- 成功任务再次重试返回 `CONFLICT/409`；执行中任务返回 `CONFLICT/409`。
- 未知集成类型、空数组、非对象条目、超 50 条、连接器未启用、必需配置缺失均返回明确错误码：`CONFIG`、`ITEM`、`DISABLED`。

### 服务端 API 与权限

- `GET /api/integrations`：连接器列表、任务列表、映射槽位、本地字段、各集成必需配置。
- `GET /api/integrations/jobs`：按 `kind`/`limit` 查询任务。
- `POST /api/integrations/save`、`/mapping`、`/test`、`/sync`、`/retry`：保存、映射、测试、同步、重试。
- 工作组 RBAC：GET 需 `settings.read`，POST 需 `settings.write`；匿名 401、评估师 403，拒绝响应不返回连接器数据。
- `integration_save/test/sync/retry/mapping` 写入 RBAC 审计，详情只含状态、计数、任务 ID，不含密钥。
- 单机版不启用团队页，但本地集成 API 仍可用；`INTEGRATIONS` 初始化失败只禁用同步功能，不阻塞应用启动。

### 前端

- `frontend/src/js/41_integrations.js` + `frontend/src/css/69_integrations.css`：团队页宽卡 `#integrationCard`。
- 3 个连接器摘要 chip 与 tab；按类型动态渲染 GitHub 的 `base_url/repo/token`、Jira 的 `base_url/project_key/issue_type/email/api_token`、GitLab 的 `base_url/project/token`。
- 四个字段映射下拉；保存配置、启用开关、测试连接、仅保存映射。
- 同步区支持粘贴 JSON，或使用当前生成的 `window.__stories`；展示任务日志、状态、成功/总数、错误原因；失败/部分失败任务提供重试按钮。
- 管理员/项目经理可见；评估师隐藏该卡。
- 中英字典各新增 47 个键，服务端新增 `integration.srv_unavailable` 文案。

## 验收证据

| 验收层 | 结果 | 证据 |
|---|---|---|
| 单元测试 | **35/35 PASS** | `results/integrations.json`；真实本地 HTTP Mock，隔离 SQLite/DPAPI |
| HTTP 验收 | **33/33 PASS** | `results/integrations-api.json`；隔离工作组服务，管理员/评估师 |
| UI 验收 | **21/21 PASS** | `results/integrations-ui.json`；真实 CDP 页面 + 本地 Mock 上游 |
| i18n | **17/17 PASS** | 中英各 1,394 键，服务端 67 个 msgKey 全覆盖 |
| RBAC 回归 | **36/36 + 22/22 PASS** | `tests/rbac_api.py`、`--only rbac-sso` |
| 项目签收回归 | **23/23 PASS** | `--only project-workflow`；工作组签收全流程 |
| 可访问性 | axe critical/serious **0** | 集成卡；1440/1024/768 横向溢出 0 |
| 编译/构建 | PASS | `py_compile`、`node --check`、`build_frontend.py` → `frontend/index.html` 1,018,678 B（17 CSS + 30 JS） |

关键实测：

- AC-30：3 个集成均可保存配置、测试连接并创建远端需求/任务；GitHub、Jira、GitLab 的 Mock 上游分别收到正确端点与认证头。
- 字段映射：保存 `title->component`、`body->acceptance` 后，GitHub 远端标题与描述分别取 `component`、`acceptance`，回读映射一致。
- 失败可重试：Mock 连续返回 503，单条任务 3 次尝试后保留 `HTTP 503` 原因；恢复上游后手动重试成功，新任务 `retry_of` 指向失败任务。
- 部分失败：2 条任务首条连续失败、次条成功，任务为 `partial 1/2`；重试只发送 1 条失败条目，成功条目未重复创建。
- 成功任务重复重试返回 `CONFLICT/409`；禁用连接器同步返回 `DISABLED`，且不发出远端请求。
- 密钥安全：SQLite 原始 `config_json` 不含 `ghp-super-secret` / `jira-secret` / `glpat-secret` 明文，公开接口无 `token`/`api_token` 字段。
- RBAC：匿名读取 401 且无连接器；评估师读取/保存 403；管理员保存、测试、同步、重试产生 5 类审计动作，详情不含密钥。
- 只单向创建：单元与 HTTP 用例均断言未出现 `PUT/PATCH/DELETE`，也未回读远端 issue 状态。
- UI：3 个 tab 切换、字段随类型变化、连接测试、映射保存、同步成功、失败展示与重试成功；评估师团队页不显示集成卡；页面 JS 异常 0。

截图：

- `screenshots/integrations_team_1440.png`
- `screenshots/integrations_team_1024.png`
- `screenshots/integrations_team_768.png`

## 复现命令

```powershell
cd C:\Users\hspcadmin\AppData\Local\Temp\eval_t171_clean
F:\Program Files\Python3.14\python.exe tests\integrations.py
F:\Program Files\Python3.14\python.exe tests\integrations_api.py
$env:PHASE3_CDP='http://127.0.0.1:9335'
D:\code\nodejs24\node.exe tests\phase3\run_phase3.mjs --only integrations
F:\Program Files\Python3.14\python.exe tests\i18n_check.py
F:\Program Files\Python3.14\python.exe scripts\build_frontend.py
```

## 边界与已知限制

1. **只做本地 → 远端单向创建**：不读取远端 issue/任务状态，不更新、不关闭、不删除远端对象，不做状态双向同步。
2. **验收使用本地 Mock 上游**：未对真实 GitHub、Jira、GitLab 云租户联调；真实 token 的权限范围、企业代理、Jira Server 与 Cloud 的字段差异需在部署环境复核。
3. **单实例全局连接器**：每种集成只保留一个连接器，未实现项目级/租户级多连接器隔离。
4. **字段映射槽位固定**：只覆盖 `title/body/priority/labels`；GitHub/GitLab 无优先级字段，`priority` 映射仅对 Jira 生效。远端自定义字段、状态、经办人、迭代等未映射。
5. **同步为同步请求**：单次最多 50 条、单请求 12 秒，页面等待结果；未实现后台队列、并发限流、断点续传或定时同步。
6. **重试为手动触发**：自动重试只覆盖单条请求的瞬时错误；任务级重试需用户点击，未实现定时补偿。
7. **安全边界**：`base_url` 由管理员填写，当前只校验 `http/https`，未做内网地址/SSRF 白名单；生产部署应限制可访问上游域名。令牌权限应最小化为仓库 issue 写权限、Jira issue 创建权限、GitLab project issue 权限。
8. **未纳入本轮**：Webhook、Feishu、Azure DevOps、OAuth 安装流程、双向状态同步、远端回读。
