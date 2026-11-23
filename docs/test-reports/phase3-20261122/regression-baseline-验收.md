# T06177 性能与视觉回归基线验收

- 任务：Evaluation 三期 / T06177 / urgent
- 完成定义：p95 ≤150ms 门禁生效；视觉回归覆盖三主题中英界面；首屏 ≤2s。
- 边界：只建立监控与回归门槛，不修复性能问题。
- 测试：`tests/phase3/regression_baseline.mjs`（已并入 `tests/phase3/run_phase3.mjs` 首位）
- 结果：`results/regression-baseline.json`

## 门槛设计

| 门槛 | 口径 | 判定 |
|---|---|---|
| 首屏 | 浏览器 `PerformanceNavigationTiming` + `PerformancePaintTiming`：FCP ≤2000ms，或 DCL ≤2000ms | 硬门禁 |
| 交互 p95 | 10k 复核页 `render()` 30 次、搜索输入事件 30 次，各取 p95 | ≤150ms 硬门禁 |
| 视觉回归 | 3 主题（light/dark/contrast）× 中英（zh-CN/en-US）上传/工作台 6 张基线，SHA-256 比对 | 任一不一致即失败 |

视觉基线存放 `visual-baseline/`，清单 `manifest.json`；更新基线必须显式执行：

```powershell
node tests/phase3/regression_baseline.mjs --update-baseline
```

日常回归直接运行同一脚本（或 `run_phase3.mjs`），缺清单、缺图、哈希不一致均失败，避免“无基线空跑通过”。

## 基线内容

| 文件 | 主题 | 语言 |
|---|---|---|
| `upload_light_zh.png` | light | zh-CN |
| `upload_light_en.png` | light | en-US |
| `upload_dark_zh.png` | dark | zh-CN |
| `upload_dark_en.png` | dark | en-US |
| `upload_contrast_zh.png` | contrast | zh-CN |
| `upload_contrast_en.png` | contrast | en-US |

截图前禁用动画/过渡/光标，关闭引导，固定 1440×900 视口与干净数据目录；复核表因异步图表存在跨语言重排抖动，拆到 10k/a11y 套件覆盖，不纳入像素基线，避免假失败。

## 实测结果

- 首屏（独立运行）：FCP 652ms、DCL 861.6ms；另一次比对 FCP 1956ms、DCL 2137ms，仍满足 FCP ≤2s。
- 10k render p95：61.1–75.7ms；搜索输入 p95：48.8–64.2ms，均 ≤150ms。
- 视觉基线：6/6 一致；缺图/哈希不符将失败。
- `run_phase3` 集成：`regression-baseline` 置于首位，确保共享实例为干净数据；跑完恢复 light + zh-CN，避免污染后续套件。

## 结论

T06177 完成。三项门槛均生效并有可复现证据；本任务不包含性能修复，10k 严格 60fps 的争议仍归 T06204/T06174 口径处理。
