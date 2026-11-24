## 根因

T06201 前没有可复现的 20 并发验收设施，无法证明工作组版在 20 个独立用户同时浏览/编辑项目时满足 AC-27 的 p95 ≤300ms 与无数据串号；同时 RBAC 会话在每个请求都执行 `UPDATE sessions SET last_seen_at` 并 `commit`，20 会话持续在线时会产生不必要的写放大与 fsync 排队。

Windows 开发机首次基线显示 p95=4750.77ms，但该主机 CPU 持续 100%，存在 Android 模拟器 `qemu-system-x86_64`（约 5.28GB 工作集）及多个无关 Node/vitest/tsc/MCP 进程，结果被主机资源争抢污染，不能作为应用性能结论。

## 影响范围

- 服务端：`scripts/rbac.py` 会话触达节流、SQLite 连接 PRAGMA；不改接口、权限矩阵、审计字段。
- 测试：新增 `tests/load_concurrent.py`，自起隔离工作组服务、20 独立会话、并发压测与串号校验。
- 结果：新增 `docs/test-reports/phase3-20261122/results/concurrency.json`；Windows 饱和基线保留为 `concurrency-windows-host-saturated.json`。
- 文档：新增 `docs/test-reports/phase3-20261122/concurrency-验收.md`。
- 不改动 `estimation.db`、`workflow.db` 表结构，不改前端产物。

## 修复

- 会话触达节流：新增 `SESSION_TOUCH_SECONDS=60.0`，同一 token 最多每 60 秒写一次 `last_seen_at`；`_touch_lock` / `_touch_at` 保证多线程安全，缓存超 2 万条时清理过期项；`logout()` 同步清理。
- SQLite 连接：`_connect()` 增加 `PRAGMA busy_timeout=15000`、`PRAGMA synchronous=NORMAL`，降低写锁竞争时的立即失败与 fsync 开销。
- 压测设施：`tests/load_concurrent.py` 使用临时 `WE_DATA` 启动隔离工作组服务，种子 20 个独立项目；1 个管理员 + 19 个项目经理各自登录；20 线程 `Barrier` 同轮起跑；每轮执行身份、列表、详情、流转 4 个真实 HTTP 请求。
- 串号校验：逐请求校验会话用户名、项目列表完整性/唯一性、详情 `project_id`/标题/版本哈希、事件最后操作人；结束后逐项目复核事件 actor 仅为“系统 + 本会话用户”、最终状态与轮次奇偶一致。
- 结果口径：统计整体与分接口 p50/p95/p99/max/avg、吞吐与总耗时；AC 阈值固定 300ms，20 用户固定，`WE_LOAD_USERS` 仅用于单会话诊断。

## 验证

- Linux 云主机（2 vCPU / 4GB，SQLite WAL，单进程工作组服务）：`python3 tests/load_concurrent.py --cycles 60`，**8/8 PASS**。
- 规模：20 并发 × 60 轮 = **4,800 请求**，16.99 秒完成，282.5 rps。
- 延迟：p50=57.36ms，**p95=95.11ms**，p99=110.55ms，max=135.18ms，avg=61.62ms；p95 距 300ms 门槛约 3.1 倍余量。
- 分接口 p95：身份 52.90ms、列表 81.17ms、详情 98.12ms、流转 105.69ms。
- 串号：4,800 次响应 `errors=0`；20 会话身份全部匹配；项目列表每次完整无重复；详情只返回自己的项目与哈希；项目事件操作人仅为本会话用户；最终状态 `draft`/`review` 正确。
- 同环境对照：回退会话触达节流与连接 PRAGMA 后，20 并发 × 8 轮 p95=91.74ms，说明 300ms 达标并非优化专属；优化保留用于降低持续在线时的写放大。
- RBAC 回归：`tests/rbac.py` **35/35 PASS**，会话、权限、审计、SSO 未回归。
- Windows 主机基线 p95=4750.77ms 仅作诊断保留，不作为验收证据。

## 已知边界

1. 单服务进程、单机 SQLite WAL；未验证多节点共享 PostgreSQL、负载均衡或跨机网络。
2. 并发为 20 条 HTTP/1.1 长连接，每会话串行请求；不是 20 个浏览器同时渲染，UI 帧率与首屏另由性能任务覆盖。
3. 写操作仅项目状态流转与事件落库，不含大附件上传、文档生成、PDF 导出等重任务。
4. 请求走 `127.0.0.1`，未叠加 TLS、反向代理、限流或广域网 RTT。
5. 60 轮持续约 17 秒，未做小时级浸泡；长稳与内存增长需部署环境补测。
6. Windows 本机因无关负载饱和，未取得可信数据；Windows 单机/工作组模式需在空闲机复跑同等验收。

---

通道：A（MTask REST 回写）
会话：local-rest-202611250125-t06201
完成时间：2026-11-25T01:25:00+08:00
