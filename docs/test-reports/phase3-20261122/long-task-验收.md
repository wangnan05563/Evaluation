# T06180 长任务进度管理验收

## 结论

T06180 已实现文档识别长任务的**真实阶段进度、剩余时间估算、2 秒内取消、断点续跑**，并在隔离实例完成 UI 与重启演练。

## 验收项

- **进度/剩余时间**：识别改为异步任务通道（`POST /api/recognize/jobs`），解析阶段依次上报 `8% 解析文档结构 → 28% 提取功能点清单 → 42% 扫描正文特征 → 54% 匹配功能点候选 → 56% 本地候选就绪 → 90% 汇总候选清单 → 100% 识别完成`；面板同步显示阶段、百分比与 `预计剩余约 N 秒`。
- **取消**：`POST /api/recognize/cancel` 立即返回；UI 不等待网络，本地先置「已取消」，实测点击到面板变更 **0–9ms**；服务端线程在下一检查点退出。
- **断点续跑**：本地候选（`local_items`）在解析完成时作为断点；任务断点写入 `data/recognize_jobs/<job>.json`。页面刷新/应用重启后读取断点，`POST /api/recognize/resume` 从上次阶段继续；页面显示「有未完成的识别任务」横幅。
- **重开演练**：演练脚本启动服务 → 创建任务 → 取消 → 杀进程 → 同数据目录重启 → 恢复断点 → 续跑完成，6/6 通过；并在 54% 本地候选断点做深续跑，证明重启后不退回 0%、不重复解析。另验证 `../config` 任务查询返回 404，阻止路径穿越。

## 实测证据

- `node tests/phase3/run_phase3.mjs --only long-task`：**16/16 PASS**
  - 初始面板 `8% 解析文档结构`，ETA `预计剩余约 14 秒`；
  - 取消 UI `0ms`（含网络前本地停止；wall 9ms）；
  - 刷新后横幅「上次停在「已取消」，已完成 8%」；
  - 续跑后进入复核页，`#tbody .rowr = 9`；完成后面板收起、断点清除。
- `python tests/long_task_drill.py`：**9/9 PASS**
  - 创建/进度/ETA、取消 0.005s、路径穿越拒绝、服务重启恢复 `canceled 8%`、继续可发起、续跑完成 `items=9`；
  - 54% 本地候选断点取消 → 重启恢复 54%、续跑完成 `items=9`（未重复解析）。
- 回归：
  - `tests/api_smoke.py` 17/17；
  - `tests/unit_engine.py` 全绿；
  - `tests/unit_history_ids.py` 27/27；
  - `node tests/ui_progress.mjs async` 17/17（既有识别/生成进度与超时未退化）；
  - `node tests/phase3/run_phase3.mjs --only a11y-wcag22` 17/17；
  - `node tests/phase3/run_phase3.mjs --only regression-baseline` 12/12；
  - `node tests/phase3/run_phase3.mjs --only review-workbench` 18/18。

## 边界

- 取消是**协作式取消**：UI 与任务状态在 2 秒内停止；已在执行的 Python 解析/LLM 调用只能在下一个检查点退出（不引入独立后台服务，也不强杀线程）。
- 断点文件不保存 LLM key；重启后如启用 LLM，续跑会回读配置中心密钥，缺失时按原逻辑失败，不伪造结果。
- 异步任务记录 TTL 1 小时，过期由下一次读写惰性清理；识别结果仍以复核页/历史库为正式数据源。
- 旧的同步 `/api/recognize` 保留，供旧客户端与既有 API 测试使用。

## 交付文件

- `frontend/src/js/31_long_task.js`、`frontend/src/css/60_long_task.css`
- `frontend/src/index.src.html`、`frontend/src/js/01_core.js`
- `scripts/server.py`
- `tests/phase3/ui_long_task.mjs`、`tests/phase3/run_phase3.mjs`
- `tests/long_task_drill.py`
- `docs/test-reports/phase3-20261122/results/ui-long-task.json`
- `docs/test-reports/phase3-20261122/screenshots/long_task_running_1440.png`、`long_task_canceled_1440.png`、`long_task_resume_result_1440.png`
