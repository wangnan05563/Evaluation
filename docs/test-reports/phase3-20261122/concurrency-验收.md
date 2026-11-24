# T06201 并发协同性能验收

- 任务：`[PRD] 验证并发协同性能`（AC-27）
- 结论：**PASS**
- 验收日期：2026-11-25
- 运行方式：Linux 云主机、隔离工作组服务、SQLite WAL、20 个独立登录会话、60 轮并发。

## 验收口径

AC-27：给定 20 个并发用户，浏览/编辑项目时，响应 p95 ≤300ms，无数据串号。

每个会话每轮执行 4 个真实 HTTP 请求：

1. `GET /api/auth/me`：会话身份。
2. `GET /api/workflow/projects`：项目列表。
3. `GET /api/workflow/project?project_id=自己的项目`：项目详情与版本哈希。
4. `POST /api/workflow/transition`：提交评审/撤回交替，写入项目事件，模拟编辑。

20 个会话由 `threading.Barrier` 同轮起跑，使用独立 `requests.Session` 与连接池，不共享 Cookie。延迟为客户端端到端 HTTP 耗时。

## 结果

**20 并发 × 60 轮 = 4,800 请求，8/8 检查通过。**

| 指标 | 数值 |
|---|---:|
| p50 | 57.36 ms |
| **p95** | **95.11 ms** |
| p99 | 110.55 ms |
| max | 135.18 ms |
| avg | 61.62 ms |
| 吞吐 | 282.5 rps |
| 总耗时 | 16.99 s |

分接口延迟：

| 接口 | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| `/api/auth/me` | 46.03 | 52.90 | 57.52 | 76.39 |
| `/api/workflow/projects` | 57.38 | 81.17 | 95.94 | 116.97 |
| `/api/workflow/project` | 63.26 | 98.12 | 109.23 | 135.18 |
| `/api/workflow/transition` | 72.35 | 105.69 | 116.36 | 132.64 |

串号与完整性检查：

- 20 个会话的 `/api/auth/me` 返回用户名全部匹配，无会话身份串号。
- 每次项目列表均返回全部 20 个项目、无重复，且包含自己的项目。
- 每次项目详情只返回自己的 `project_id`、标题与版本哈希。
- 4,800 次响应 `errors=0`；每个项目事件的操作人仅为“系统创建 + 本会话用户”，无跨用户写入。
- 最终状态按轮次奇偶正确落在 `draft`/`review`。

完整机器可读结果：`results/concurrency.json`。

## 环境

| 项 | 值 |
|---|---|
| 执行机 | Linux 云主机，2 vCPU，4 GB 内存 |
| 平台 | `Linux-6.6.95.bck.4-rc5-amd64-x86_64-with-glibc2.35` |
| Python | 3.12.11 |
| 部署模式 | `deployment.mode=workgroup` |
| 数据库 | SQLite WAL（`workflow.db`、`rbac.db`） |
| 服务 | 单进程 `ThreadingHTTPServer`，`HTTP/1.1` 长连接 |
| 网络 | 本机回环 `127.0.0.1`，无外网/代理 |

## 关于 Windows 主机基线

在 Windows 开发机上曾取得 p95=4750.77ms 的基线，但该主机 `Win32_Processor.LoadPercentage` 持续为 100%，同时存在 Android 模拟器 `qemu-system-x86_64`（工作集约 5.28GB）及多个无关 Node/vitest/tsc/MCP 进程。该结果包含严重的主机资源争抢，不能归因于应用，也不能作为 AC-27 证据。原始数据保留在 `results/concurrency-windows-host-saturated.json`，仅作诊断记录。

为排除主机争抢，验收迁移到 2 vCPU 的 Linux 云主机。该配置低于常见办公工作站，仍取得 p95=95.11ms，距 300ms 门槛保留约 3.1 倍余量。

同环境对照：将 `scripts/rbac.py` 的会话触达节流与 SQLite `busy_timeout`/`synchronous=NORMAL` 回退后，20 并发 × 8 轮 p95=91.74ms，说明达标并非优化专属；保留优化用于降低 20 会话持续在线时的 `last_seen_at` 写放大。

## 实现与改动

- `scripts/rbac.py`
  - 新增 `SESSION_TOUCH_SECONDS=60.0`：同一会话最多每 60 秒写一次 `sessions.last_seen_at`，避免每个请求一次 `UPDATE + commit`。
  - 新增 `_touch_lock` / `_touch_at` / `_due_touch(token_hash)`；缓存超过 20,000 条时清理过期项。
  - `_connect()` 增加 `PRAGMA busy_timeout=15000`、`PRAGMA synchronous=NORMAL`；`logout()` 同步清理触达缓存。
  - `tests/rbac.py` 复跑 **35/35 PASS**，会话、权限、审计、SSO 行为未变。
- `tests/load_concurrent.py`
  - 自起隔离工作组服务，临时 `WE_DATA`，种 20 个独立项目，初始化 1 个管理员 + 19 个项目经理。
  - 20 线程屏障起跑，逐请求校验身份、列表、详情哈希、事件操作人；结束后逐项目复核事件来源与最终状态。
  - 统计整体与分接口 p50/p95/p99/max/avg，阈值 300ms；结果写入固定 JSON。
  - `WE_LOAD_USERS` 仅用于单会话诊断，验收固定 20。

## 复现命令

Linux 云主机：

```bash
cd /home/user/EvalPerf
python3 tests/load_concurrent.py --cycles 60
```

Windows 开发机（需空闲主机，否则会复现主机争抢噪声）：

```powershell
cd C:\Users\hspcadmin\AppData\Local\Temp\eval_t171_clean
F:\Program Files\Python3.14\python.exe tests\load_concurrent.py --cycles 60
```

## 边界与已知限制

1. 单服务进程、单机 SQLite WAL；未验证多节点共享 PostgreSQL、负载均衡或跨机网络延迟。
2. 并发模型为 20 条 HTTP/1.1 长连接，每会话串行发请求；不是 20 个浏览器同时渲染页面，UI 帧率与首屏另由性能任务覆盖。
3. 写操作为项目状态流转与事件落库，不包含大附件上传、文档生成、导出 PDF 等重任务。
4. 全部请求走 `127.0.0.1`，未叠加 TLS、反向代理、限流或广域网 RTT。
5. 60 轮持续约 17 秒；未做小时级浸泡测试，长稳与内存增长需在部署环境补测。
6. Windows 主机因无关负载饱和，未取得可信的 Windows 本机数据；产品在 Windows 单机/工作组模式下的同等验收需在空闲机复跑。

---

通道：A（MTask REST 回写）
会话：local-rest-202611250125-t06201
完成时间：2026-11-25T01:25:00+08:00
