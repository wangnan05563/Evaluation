## 根因

T06199 前，系统只有单机版部署与前端入口守卫，没有用户、角色、权限矩阵、会话与 SSO：任何能访问本机端口的人都可以直接调用 `/api/workflow`、`/api/config` 等接口读取项目或改配置，无法满足“越权 100% 拒绝且不泄露数据”。SSO 也没有失败回退路径，一旦接入 IdP 故障就可能把管理员锁在系统外。

## 影响范围

- 数据：新增 `data/rbac.db`（用户、会话、审计、SSO state）与 `config.json` 的 `deployment` / `sso` 段；不改动 `estimation.db`、`workflow.db` 表结构。
- 服务端：`scripts/rbac.py` 新增 RBAC/SSO/审计核心；`scripts/server.py` 新增 12 个 auth/rbac 端点与工作组统一权限守卫。
- 前端：新增 `frontend/src/js/40_rbac_sso.js`、`frontend/src/css/68_rbac_sso.css`；改造 `index.src.html`、`01_core.js`、`39_project_workflow.js`、`guide.js`、`20_components.css`。
- 配置：`deployment.mode` 仅接受 `standalone` / `workgroup`；`sso.client_secret` 以 DPAPI 密文落盘。
- 测试：新增 `tests/rbac.py`、`tests/rbac_api.py`、`tests/phase3/ui_rbac_sso.mjs`，并登记 `run_phase3.mjs` 的 `rbac-sso` 套件。
- i18n：中英字典各 1,347 键，新增认证门禁、团队页、权限矩阵、审计与 SSO 文案。

## 修复

- 角色矩阵：5 角色 × 13 权限；管理员全量，项目经理可写配置/签收，评估师只读项目与估算，评审人可签收/导出审计，只读成员仅使用应用与查看估算。
- 认证：PBKDF2-SHA256 密码哈希；会话令牌只存 SHA-256 摘要；Cookie `HttpOnly + SameSite=Lax`；唯一管理员保护；停用立即踢出会话。
- 越权：工作组全部 `/api/*` 请求走统一守卫，路径映射到权限；401/403 不返回对象数据，403 只带 `permission`；拒绝与匿名访问全部落审计。
- 审计：记录操作人、动作、结果、权限、对象类型/ID、IP、请求方法/路径；2,000 行滚动保留；密码、令牌、SSO state、`client_secret` 不入审计。
- SSO：OIDC 授权码流程；state 一次性、10 分钟有效、只允许站内相对回跳；token/userinfo 失败统一 `fallback=admin`；自动开通只允许非管理员角色。
- 回退：SSO 未配置、失败、state 伪造/重放均保留管理员账号密码入口，登录页显示回退说明与焦点跳转。
- 团队页：认证门禁、初始化管理员、成员管理、角色变更/停用、5×13 矩阵、审计列表、SSO 表单；按权限显隐入口与卡片。
- 签收联动：工作组签收页操作人/角色只读，提交/驳回/修订按 `project.write`、签收/报告按 `project.sign` 控制，服务端仍会覆盖请求值。
- 可访问性：修复团队页引导遮罩残留导致的对比度误报；审计列表恢复 `ol > li` 语义；滚动容器补 `role=region` 与焦点能力。

## 验证

- `python tests\rbac.py`：**35/35 PASS**，覆盖初始化、弱密码、重复用户名、密码非明文、矩阵分层、403 与审计、会话失效、唯一管理员、SSO state 重放、SSO 自动开通、Cookie 属性、审计不含密钥/令牌。
- `python tests\rbac_api.py`：**36/36 PASS**，使用隔离工作组服务与 Mock OIDC；未登录 401、只读成员访问项目 403 且无数据、四类越权全部审计、停用踢出、SSO 成功/失败/伪造 state/回退管理员。
- `node tests\phase3\run_phase3.mjs --only rbac-sso`：干净实例 **22/22 PASS**；团队页 5×13 矩阵、审计行首次进入即 ≥1、UI 添加成员、登出/登录、评估师权限与配置拦截、SSO 失败回退、1440/1024/768 无溢出、团队页/登录门禁 axe 0、JS 异常 0。
- T06198 回归：`--only project-workflow` 在启用工作组认证的实例 **23/23 PASS**；签收页操作人回显登录管理员，签收/报告按 `project.sign` 放行，6 条审计与 64 位哈希完整，报告 9 页。
- `python tests\i18n_check.py`：**17/17 PASS**，中英各 1,347 键。
- `python -m py_compile ...`、`node --check ...`：PASS；`python scripts\build_frontend.py`：16 CSS + 29 JS → `frontend/index.html` 997,068 B。
- 产物：`docs/test-reports/phase3-20261122/rbac-验收.md`、`results/rbac.json`、`rbac-api.json`、`rbac-sso-ui.json`、4 张团队页/登录门禁截图。

## 已知边界

1. 角色矩阵是角色级权限，未实现同角色内项目归属/租户级 ACL。
2. SSO 只按 `sub` 绑定，未做多 IdP 命名空间隔离；更换 IdP 需迁移或清空既有 SSO 账号。
3. 登录失败有审计但无失败次数锁定/验证码；本地服务默认环回监听，外网部署需前置限流。
4. Cookie 未加 `Secure`，因默认 HTTP；HTTPS 部署时应同步开启。
5. 审计只保留最近 2,000 行，长期合规留存依赖备份。
6. UI 验收覆盖中文工作组版；英文只做字典与静态键校验。

---

通道：A（MTask REST 回写；本轮 MCP 连接器不可达）
会话：local-rest-202611242301-t06199
完成时间：2026-11-24T23:01:00+08:00
