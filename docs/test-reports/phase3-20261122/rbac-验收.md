# T06199 RBAC 与 SSO 集成验收

- 任务：`[PRD] 构建RBAC与SSO集成`（REQ-021 / AC-25 / AC-28 / AC-29）
- 结论：**PASS**
- 验收日期：2026-11-24
- 运行方式：本地 Windows、隔离数据目录、无头 Chrome；UI 通过 `tests/phase3/run_phase3.mjs --only rbac-sso` 在干净工作组实例执行。

## 实现范围

### 角色与权限矩阵

- `scripts/rbac.py` 新增独立 `RbacStore`，使用 `data/rbac.db`，用户、会话、角色、审计、SSO state 与配置均不混入估算库。
- 5 个角色：管理员、项目经理、评估师、评审人、只读成员。
- 13 项权限：`app.use`、`estimate.read/create/write`、`project.read/write/sign`、`settings.read/write`、`user.manage`、`audit.read/export`、`data.manage`。
- 风险权限分层：评估师不可签收、不可管用户；只读成员不可读项目、不可读配置；评审人可签收与导出审计。
- 密码使用 PBKDF2-SHA256（210,000 次、随机盐）；会话令牌只落 SHA-256 摘要，Cookie 为 `HttpOnly + SameSite=Lax`。
- 唯一启用中的管理员不可停用或降级；停用用户立即删除全部会话。

### 越权拒绝与审计

- `scripts/server.py` 在 `deployment.mode=workgroup` 时为全部 `/api/*` 请求加统一权限守卫；单机版保持原行为，不创建 `rbac.db`，也不暴露 auth/rbac 端点。
- 权限映射覆盖 workflow、config/theme/update、rates/rules、audit/share、eval、data、history、pert、recognize/generate、context/pickdir、templates 与未知 API。
- 无会话返回 401；权限不足返回 403；两者均不携带对象数据，403 只返回 `code/msg/permission`。
- 拒绝审计字段：操作人、动作、结果、权限、对象类型、对象 ID、IP、请求方法/路径；匿名拒绝同样落审计。
- 审计只保留最近 2,000 行，防止本地日志无限膨胀；更长期留存由备份承接。
- 密码、明文会话令牌、SSO state、`client_secret` 均不进入审计或接口回显。

### SSO 与管理员回退

- 端点：`GET /api/auth/me`、`POST /api/auth/bootstrap`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/sso/start`、`GET /api/auth/sso/callback`。
- OIDC 授权码流程：state 一次性、10 分钟有效、只接受站内相对回跳；回调先消费 state，再交换 token/userinfo。
- SSO 自动开通只允许非管理员角色，默认只读成员；同一 `sub` 复用已有账号；停用账号拒绝 SSO 登录。
- SSO-only 账号没有本地密码，密码登录统一 401。
- SSO 未启用、配置缺失、state 伪造/重放、token 交换失败、userinfo 失败均返回 `fallback=admin`；登录页保留管理员账号密码入口。
- `client_secret` 使用与 API Key 相同的 DPAPI 口径落盘为 `client_secret_enc`；接口只返回 `client_secret_set` 布尔值。

### 团队页

- `frontend/src/js/40_rbac_sso.js` + `68_rbac_sso.css`：全屏认证门禁、首次初始化管理员、登录/登出、团队页成员卡、5×13 权限矩阵、审计列表、SSO 配置表单。
- `index.src.html` 新增认证门禁、`mi-team`、`pg-team`、成员/SSO/矩阵/审计卡；`01_core.js` 增加工作组未登录阻止跳页、团队页初始化、评估师进入配置中心拦截。
- 工作组版操作人/角色以登录会话为准；签收页按 `project.write` / `project.sign` 控制提交、驳回、修订、签收与报告按钮。
- 切换页面时收起上一页引导遮罩，修复无引导页面（团队页）残留遮罩造成的对比度误报。
- 审计列表保持 `ol > li` 语义；矩阵与成员表滚动容器补 `role="region"`、`aria-labelledby`、`tabindex="0"`。
- 中英字典各 1,347 键，新增 `auth.*`、`team.*`、`rbac.*` 文案。

## 验收证据

| 验收层 | 结果 | 证据 |
|---|---|---|
| 单元测试 | **35/35 PASS** | `docs/test-reports/phase3-20261122/results/rbac.json` |
| HTTP 验收 | **36/36 PASS** | `results/rbac-api.json`；隔离工作组服务，Mock OIDC |
| UI 验收 | **22/22 PASS** | `results/rbac-sso-ui.json`；干净工作组实例 |
| T06198 回归 | **23/23 PASS** | `--only project-workflow`；工作组管理员会话下签收全流程、6 条审计、64 位哈希、9 页报告 |
| 可访问性 | axe critical/serious **0** | 团队页、登录门禁各 0；1024/768 横向溢出 0 |
| i18n | **17/17 PASS** | 中英各 1,347 键，服务端 66 个 msgKey 全覆盖 |
| 编译/构建 | PASS | `py_compile`、`node --check`、`build_frontend.py` → `frontend/index.html` 997,068 B（16 CSS + 29 JS） |

关键实测：

- AC-25：只读成员访问项目列表与具体项目均 403，响应不含 `projects` 数据或项目正文。
- AC-28：评估师访问 `project.read`、`settings.read`、`user.manage`、`audit.read` 四类越权全部 403，四条拒绝审计均含操作人、权限、对象/路径。
- AC-29：SSO 未配置、token 失败、伪造 state 三类失败均返回 `fallback=admin`，管理员密码登录随后成功；SSO 失败不影响管理员回退。
- 管理员通过 UI 添加评估师成员；评估师登录后配置入口隐藏，直接跳转配置中心被拦截。
- 团队页首次进入即等待审计异步加载完成，矩阵 13 行、审计行 ≥1；管理员重登录后审计行 11。
- 1440/1024/768 三档截图与 1440 登录门禁截图均通过；页面 JS 异常 0。

截图：

- `screenshots/rbac_team_1440.png`
- `screenshots/rbac_team_1024.png`
- `screenshots/rbac_team_768.png`
- `screenshots/rbac_login_1440.png`

## 复现命令

```powershell
cd C:\Users\hspcadmin\AppData\Local\Temp\eval_t171_clean
F:\Program Files\Python3.14\python.exe tests\rbac.py
F:\Program Files\Python3.14\python.exe tests\rbac_api.py
$env:PHASE3_CDP='http://127.0.0.1:9335'
D:\code\nodejs24\node.exe tests\phase3\run_phase3.mjs --only rbac-sso
F:\Program Files\Python3.14\python.exe tests\i18n_check.py
F:\Program Files\Python3.14\python.exe scripts\build_frontend.py
```

## 边界与已知限制

1. 工作组成员权限按角色矩阵收敛，未实现同角色内的项目归属/租户隔离；项目级 ACL 不在 T06199 范围。
2. SSO 绑定只按 `sub` 识别，未做多 IdP 命名空间隔离；更换 IdP 前应清空已有 SSO 账号或迁移 `sso_subject`。
3. 登录失败已落审计，但未做失败次数锁定/验证码；本地服务默认只监听环回地址，外网部署需在前置代理增加限流。
4. Cookie 未加 `Secure`，因为本地默认 HTTP；改为 HTTPS 部署时应同步开启。
5. 审计保留最近 2,000 行；需要长期合规留存时依赖备份，不在本地库内无限累积。
6. UI 验收覆盖中文工作组版；英文只做字典一致性与静态键校验，未做英文全流程点击。
