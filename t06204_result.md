# T06204 性能与视觉回归扫描 · 结果

- 结论：**通过，38/38 检查**
- 提交：`7d972f6`
- 证据：`docs/test-reports/phase3-20261122/t06204-performance-visual-验收.md`、`results/t06204-regression.json`、`t06204-*.log`

## AC-03 10k 行滚动

- 10000 行 × 8 列，连续滚动 60 秒：**60.007fps / 3601 帧**，白屏 0。
- DOM 虚拟窗口恒为 7 行；`scrollHeight=440000`、`clientHeight=300`，滚到末尾；长帧 2 帧 / 0.06%。

## 性能 p95

- 10k 复核页 render p95 **64.7ms**、搜索输入 p95 **60.9ms**，均 ≤150ms。
- 首屏 FCP 532ms、DCL 611.1ms，导航到可交互 784ms。

## 视觉回归

首轮 4/6 哈希不一致（light_zh/en、contrast_zh/en），定位为基线过期：T06199 `b5a218b` 把导航 `.m-item` 从 `var(--muted)` 改为 `var(--ink-2)`，Light 文字 `#5B6472→#374151`，Contrast `#E0E0E0→#FFFFFF`；Dark 未变故两张一致。像素差仅 0.186%–0.207%、最大通道差 31–36/255，且只落在顶部导航 `y=50–67`，无布局位移/破版。

执行 `--update-baseline` 刷新基线后复跑，**6/6 哈希精确一致、12/12 通过**。同步修正 `regression_baseline.mjs`：非更新运行写 `visual-current/`，不再覆盖基线；目录已加入 `.gitignore`。

## WCAG 2.2 AA

axe-core 4.10.2；work-upload / work-review-20 / config / help 四页 serious/critical 阻断 **0**；200% 缩放四页无横向滚动、裁切控件 0；AX 树 1473 节点无空名称；键盘语义齐备。17/17 通过。

## 缺陷

未发现新的 P0/P1 产品缺陷。视觉差异是测试基线对 T06199 语义色变更的滞后，不是产品破版。
