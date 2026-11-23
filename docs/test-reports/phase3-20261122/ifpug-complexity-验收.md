# T06188 标准 IFPUG 复杂度模式 验收

- 任务：Evaluation三期 T06188（urgent，REQ-010 / AC-16）
- 结论：**通过**（17/17 自动化检查；企业母版 US=105.07 不回归）
- 证据：`results/ifpug-complexity.json`、`screenshots/ifpug_standard_1440.png`

## 交付

1. 引擎 `scripts/engine.py`
   - 新增 `CX_MASTER=企业母版` / `CX_STANDARD=标准IFPUG` 两种口径，默认企业母版。
   - `complexity(type, det, ret, ftr)` 实现标准 IFPUG 复杂度矩阵：
     - ILF/EIF 用 RET + DET；EI 用 FTR + DET；EO/EQ 用 FTR + DET，输出低/中/高。
     - 标准权重：ILF 7/10/15、EIF 5/7/10、EI 3/4/6、EO 4/5/7、EQ 3/4/6。
   - `item_ufp/item_us/total_us/summary` 增加 `cx_mode`；仅标准模式改变 UFP，`US` 仍按重用/修改系数。
   - 标准模式缺省 DET/RET/FTR（ILF/EIF 20/2、事务类 10/2/1）落在中复杂度，UFP 与企业母版一致，切换不突兀。
2. 接口 `scripts/server.py`
   - 新增 `POST /api/ifpug/summary`：按 `cx_mode` 返回汇总与逐项复杂度/UFP/US；非法口径 400、空明细 400。
   - `/api/generate` 接收 `cx_mode`，汇总与历史记录带口径；`/api/recognize` 支持 `params.cx_mode`。
   - 标准模式生成成品表时，`generate_xlsx.py` 把 J 列母版权重公式替换为按 DET/RET/FTR 算出的标准 UFP 数值，M 列 US 公式保留。
3. 前端
   - `index.src.html` 项目参数新增「复杂度口径」下拉：企业母版（默认）/ 标准IFPUG。
   - `01_core.js` 实现标准矩阵、实时 UFP/US、DET/RET/FTR 输入与复杂度自动判定；模式/语言切换刷新提示。
   - `07_*.js` 表单状态记忆 `cxMode`；`02_*.js` 生成请求携带 `cx_mode` 与明细 DET/RET/FTR。
4. 文档：`docs/概要设计说明.md`、`docs/系统架构设计.md` 更新 UFP 双口径说明。

## 验证

命令：`node tests/phase3/run_phase3.mjs --only ifpug-complexity`（隔离 WE_DATA + API 8033 + CDP 9335）。

手工矩阵基准（5 条明细，全部 低重用/新增）：

| 类别 | DET | RET/FTR | 复杂度 | 标准 UFP |
|---|---:|---:|---|---:|
| ILF | 10 | RET=1 | 低 | 7 |
| EIF | 30 | RET=6 | 高 | 10 |
| EI | 16 | FTR=1 | 高 | 6 |
| EO | 6 | FTR=4 | 高 | 7 |
| EQ | 5 | FTR=2 | 低 | 3 |

实测：
- 标准模式 `UFP=33 / US=33`，逐项 `7/10/6/7/3`，复杂度 `低/高/高/高/低`，与手工矩阵一致；
- 企业母版同明细 `UFP=30 / US=30`，默认口径不回归；
- 标准模式缺省 DET/RET/FTR 时 `UFP=30`，与企业母版一致；
- 非法口径 400、空明细 400；
- UI：复核页出现口径选择器；切标准后 5 行 DET/RET/FTR 输入出现，UFP=33、US=33.00；DET 改为 60 后首行 UFP=10、UFP 合计 36、US=36.00、复杂度=中；提示文案为「已切换标准 IFPUG…」；无页面异常；
- 标准模式生成 `t06188_standard.xlsx`：J 列 `[7,10,6,7,3]`，M 列 US 公式保留，引擎 US=33.0；
- `python tests/unit_engine.py` 全部通过；`python scripts/generate_xlsx.py --verify` 输出 **45 条明细 / US 合计 105.07 / 通过 ✓**。

## 本次回写

- 提交见 MTask T06188 的 git 关联（提交后回写完整 SHA）。
- MTask：`T06188` running → progress start → git link → 本结果 → progress done → done verified。

## 下一步建议

- 标准模式目前保留 DET/RET/FTR 手工录入，未做从需求文档自动抽取 DET/RET/FTR 的 AI 规则；若要自动抽取，需扩展识别规则并另立任务（仅观察不建单）。
- 标准模式生成件 J 列为数值、M 列公式保留；若要求 J/M 全公式化，需要另做支持复杂度矩阵的母版模板（仅观察不建单）。
