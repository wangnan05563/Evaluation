# T06192 蒙特卡洛概率预测 验收

- 任务：Evaluation三期 T06192（urgent，REQ-014 / AC-14）
- 结论：**通过**（20/20 自动化检查；200 任务 / 1 万次模拟 980ms）
- 证据：`results/montecarlo.json`、`screenshots/montecarlo_pert_1440.png`

## 交付

1. 计算引擎 `scripts/pert.py`
   - 新增 `monte_carlo(rows, simulations=10000, seed=20261122, target_days=None)`。
   - 每个任务按 **Beta-PERT（λ=4）** 独立采样：`alpha=1+4(M-O)/(P-O)`、`beta=1+4(P-M)/(P-O)`，总量为 200 个任务样本之和。
   - 输出 `P50/P80/P95`、均值、标准差、达标概率（`P(total ≤ target)`）。
   - 敏感性 Top5：按各任务对总方差的贡献占比排序（独立随机变量方差可加），给出期望人天、方差贡献与占比。
   - 情景对比：乐观 ×0.9 / 基准 ×1.0 / 保守 ×1.1，分别给出 P50/P80/P95 与按 `target/factor` 换算的达标概率。
   - 固定种子使用 `numpy.random.default_rng(seed)`，同种子重复执行逐位一致；模拟次数限制 1000–50000。
2. 接口 `scripts/server.py`
   - 新增 `POST /api/pert/montecarlo`：只读项目估算，不写入任何表；项目不存在 404，非法次数/目标 400。
   - 返回中带 `duration_ms`（服务端实测耗时）。
3. 前端 `frontend/src/js/27_montecarlo.js`
   - PERT 结果页新增「蒙特卡洛概率预测」卡片：模拟次数、随机种子、目标人天、运行按钮。
   - 结果展示 P50/P80/P95、达标概率、均值/标准差、敏感性 Top5 表、情景对比表，并显示固定种子与耗时。
   - 在 `pertStep('gen')` / `pertRefresh` 时按当前项目回显任务数。
4. 打包 `工作量评估工具.spec`：`hiddenimports` 增加 `numpy`，保证 exe 内含模拟引擎依赖。

## 验证

命令：`node tests/phase3/run_phase3.mjs --only montecarlo`，隔离 `WE_DATA`、API 8033、CDP 9335，新建 200 个任务（O=6、M=10、P=14–33）。

实测：
- 200 任务 / 10,000 次：`duration_ms=980`（客户端 wall 1136ms，含建 HTTP 连接），**≤2s**；
- `P50=2316.29 / P80=2354.74 / P95=2391.28`，达标概率 `36.3`（目标 2300 人天）；
- 敏感性 Top5 返回 5 项且按 `share_pct` 降序，口径 `variance_share`；
- 三个情景 P50/P80/P95 单调递增，基准情景与整体分位一致；
- 同种子两次调用 `p50/p80/p95/mean/probability` **完全相等**；不同种子结果不同；
- 999 次模拟 400、负数目标 400、不存在项目 404；
- UI 卡片出现，显示 200 个估算条目；运行后两张表分别为 5 行/3 行，P50/P80/P95、达标概率、敏感性、情景对比均可见；无页面异常。

## 本次回写

- 提交见 MTask T06192 的 git 关联（提交后回写完整 SHA）。
- MTask：`T06192` running → progress start → git link → 本结果 → progress done → done verified。

## 下一步建议

- 当前情景对比为比例系数（×0.9/×1.0/×1.1）；若要按阶段分别调参，需要产品先定义情景模型再另立任务（仅观察不建单）。
- 敏感性目前用方差贡献，若需“剔除某任务后重算 P80”的边际影响，可作为后续增强（仅观察不建单）。
