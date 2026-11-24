## 根因

T06200 前，系统只有旧版 GitHub 用户故事推送，缺少可配置的 Jira、GitHub Issues、GitLab Issues 集成：没有连接器配置、字段映射、失败原因与重试闭环，无法满足 AC-30“3 个集成、可重试、可查看错误原因、字段映射可保存”，也没有限定为只单向同步需求/任务、不做状态双向同步。

## 影响范围

- 数据：新增 `data/integrations.db`（连接器、同步任务、字段映射、错误日志）；不改动 `estimation.db`、`workflow.db`、`rbac.db` 表结构。
- 服务端：新增 `scripts/integrations.py`；`scripts/server.py` 接入 `INTEGRATIONS`、6 个 `/api/integrations*` 路由、`settings.read/write` 权限与集成审计。
- 前端：新增 `frontend/src/js/41_integrations.js`、`frontend/src/css/69_integrations.css`；`index.src.html`、`40_rbac_sso.js` 增加团队页集成卡与显隐。
- 测试：新增 `tests/integrations.py`、`tests/integrations_api.py`、`tests/phase3/ui_integrations.mjs`；`run_phase3.mjs` 登记 `integrations` 套件。
- 产物：新增 `docs/test-reports/phase3-20261122/integration-验收.md`、3 份测试结果与 3 张 1440/1024/768 截图。
- i18n：中英字典各 1,394 键，新增集成配置、映射、同步、重试文案。

## 修复

- 连接器：种子 GitHub Issues、Jira、GitLab Issues 3 个连接器；支持服务地址、仓库/项目、Jira 项目 Key/问题类型/邮箱、令牌、启用状态与最近测试结果。
- 凭据：`token` / `api_token` 经 DPAPI 加密落库；公开接口只返回 `token_set` / `api_token_set`，保存时留空保持旧密文。
- 适配器：GitHub `POST /repos/{repo}/issues` + Bearer；Jira `POST /rest/api/2/issue` + Basic；GitLab `POST /api/v4/projects/{project}/issues` + `PRIVATE-TOKEN`；测试连接分别访问仓库、`myself`、项目。
- 字段映射：`title/body/priority/labels` 四槽位可映射到 `title/body/priority/labels/acceptance/component`，随连接器持久化，支持单独保存；适配器按映射取值后写入远端固定槽位。
- 同步任务：记录总数、成功/失败、尝试次数、任务级首因与逐条错误；可重试错误最多 3 次尝试，指数退避；失败保留 `{index,title,code,message,status,retryable}`。
- 手动重试：生成新任务并写 `retry_of`；部分失败只重发失败条目，避免已成功创建的远端需求重复生成；成功任务重试返回 409。
- 单向边界：只调用创建接口，不读远端状态、不 PATCH/PUT/DELETE，不做状态双向同步；未知类型、空条目、非对象、未启用、缺配置均明确报错。
- RBAC：GET 需 `settings.read`，POST 需 `settings.write`；匿名 401、评估师 403 且不返回连接器数据；保存/测试/同步/重试/映射 5 类动作写入审计，详情不含密钥。
- UI：团队页集成卡含 3 个摘要 chip、3 个 tab、按类型动态字段、四个映射下拉、启用开关、测试连接、JSON/用户故事同步、任务日志、错误原因与失败重试；评估师隐藏该卡。
- 稳定性：修复公开视图 `available` 缺失导致审计 500、任务 `payload_json` 缺失导致同步 500、映射后失败标题为空三个问题。

## 验证

- `python tests\integrations.py`：**35/35 PASS**，真实本地 HTTP Mock；覆盖 3 连接器种子、DPAPI 非明文、公开视图脱敏、映射保存、三类适配器测试/同步、自动重试、彻底失败原因、手动重试、部分失败只重发失败条目、禁用/空条目/未知类型拒绝、仅创建。
- `python tests\integrations_api.py`：**33/33 PASS**，隔离工作组服务；覆盖匿名 401、评估师 403、3 连接器保存/测试、映射持久化、三集成同步、503 失败原因、手动重试、409、5 类审计、数据库无明文、仅创建。
- `node tests\phase3\run_phase3.mjs --only integrations`：干净工作组实例 **21/21 PASS**；3 连接器 UI 配置与测试、映射保存、同步成功、失败展示、重试成功、1440/1024/768 无溢出、axe 0 serious/critical、评估师隐藏集成卡、JS 异常 0。
- `python tests\i18n_check.py`：**17/17 PASS**，中英各 1,394 键，服务端 67 个 msgKey 全覆盖。
- RBAC 回归：`tests\rbac_api.py` **36/36 PASS**；`--only rbac-sso` **22/22 PASS**。
- 项目签收回归：`--only project-workflow` **23/23 PASS**。
- 构建：`py_compile`、`node --check` PASS；`build_frontend.py` 17 CSS + 30 JS → `frontend/index.html` 1,018,678 B。

## 已知边界

1. 只做本地 → 远端单向创建，不读取/更新远端状态，不做双向同步。
2. 验收使用本地 Mock 上游，未对真实 GitHub/Jira/GitLab 云租户联调；真实令牌权限、企业代理、Jira Server 与 Cloud 字段差异需部署环境复核。
3. 每种集成仅一个全局连接器，未实现项目级/租户级多连接器隔离。
4. 字段映射仅四个固定槽位；GitHub/GitLab 无优先级字段，`priority` 映射只对 Jira 生效；远端自定义字段、经办人、迭代未映射。
5. 同步为同步请求，单次最多 50 条、单请求 12 秒，无后台队列、并发限流、断点续传或定时同步。
6. `base_url` 由管理员填写，当前只校验 http/https，未做 SSRF 白名单；生产需限制可访问上游域名。
7. 未实现 Webhook、Feishu、Azure DevOps、OAuth 安装流程与远端状态回读。

---

通道：A（MTask REST 回写；本轮 MCP 连接器不可达）
会话：local-rest-202611250030-t06200
完成时间：2026-11-25T00:30:00+08:00
