# T06207 全量 AC 剩余项兜底审计

- 日期：2026-11-23
- 口径：只对三期矩阵实际关联到 T06207 的 AC 给结论；未实现项不写成 PASS。
- 证据：`results/ac-remaining-audit.json`、`results/ui-single-machine.json`、`tests/phase3/ac_remaining_audit.py`

## 范围校正

任务描述写 AC-26、AC-36、AC-37；但三期需求矩阵只有 AC-01~AC-35，T06207 实际 `req_ids` 为：

- AC-26 单机版功能隔离
- AC-31 白标配置生效
- AC-32 主题对比度阻断
- AC-33 组合看板加载
- AC-34 费率切换追溯
- AC-35 报价版本锁定

AC-36/37 在矩阵中不存在，按“描述笔误”记录，不伪造测试。

## 结论

| AC | 结论 | 证据 / 缺口 |
|---|---|---|
| AC-26 | **PASS** | `ui-single-machine.json` 4/4：无协作/工作组/SSO 入口、`/api/team` 404、上传主流程完整、源码无协作残留 |
| AC-31 白标 | DEFERRED | 无品牌包/Logo/安装器/报告抬头配置面；现有仅 `--brand` 主色与 xlsx 表头联动，属 V2.0 |
| AC-32 主题对比度 | DEFERRED | 只有 `applyBrand` 的 hex 校验，无对比度计算、无保存主题入口、无阻断提示；由 T06193 主题工作室承载 |
| AC-33 组合看板 | DEFERRED | 无组合看板页面与 100 项目数据源，属 V2.1 |
| AC-34 费率切换 | **PARTIAL** | 已有费率版本选择、`gbVerChange` 重算、结果带版本名；缺多费率卡/币种/逐项追溯矩阵，属 V2.1 |
| AC-35 报价锁定 | DEFERRED | 无报价单/锁定/版本生成入口，属 V2.1 |

## 判定

- 本轮任务定义为“兜底验收”，不是“把 V2.x 功能补齐”。
- 6 个实际关联 AC 均有可复查证据/缺口记录，满足“每个 AC 有对应证据”。
- **不满足“所有 AC 通过”**：1 PASS、1 PARTIAL、4 超出本期实现范围；不宣称全量 AC 闭环。
- 无新增 P0/P1 缺陷；AC-31/33/35 属 PRD V2.0/V2.1，AC-32 由 T06193 承载，不在本轮重复建单。

## 复现

```powershell
cd D:\code\otherProjects\Evaluation
& 'F:\Program Files\Python3.14\python.exe' tests\phase3\ac_remaining_audit.py docs\test-reports\phase3-20261122\results\ac-remaining-audit.json
```
