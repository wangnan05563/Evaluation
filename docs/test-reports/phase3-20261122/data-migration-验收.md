# T06190 数据迁移与双读兼容 验收

- 任务：Evaluation三期 T06190（urgent，REQ-012）
- 结论：**通过**（迁移状态/双读/回滚单测 27/27；端到端演练 21/21）
- 证据：`results/data-migration.json`、`screenshots/migration_pending_1440.png`、`screenshots/migration_done_1440.png`

> 说明：RL-012 原文为 REQ-012（schema 版本化、旧数据首次打开生成稳定 ID、双读兼容、失败回滚）。任务描述未给出 AC 编号，按 REQ-012 完成定义验收。

## 交付

1. 后端（在 T06187 稳定 ID 基础上补齐向导）
   - `scripts/history.py` 新增 `migration_status()`：schema 目标版本、当前 schema 版本分布、迁移状态、待迁移行/项、稳定 ID 映射数、备份数、`dual_read`、回滚可用性。
   - 新增 `GET /api/history/ids/status`。
   - 迁移仍为首次打开自动执行、迁移前逐行备份；`POST /api/history/ids/migrate` 支持回滚后重跑，`POST /api/history/ids/rollback` 恢复旧 `items_json` 并清理迁移期映射。
   - 双读兼容：迁移前后 `GET /api/history/{id}`、`/api/history/diff` 均可读旧 schema v1 与 v2 明细；回滚后旧数据不丢失。
2. 前端
   - 历史页新增「数据迁移与双读兼容」向导：显示 Schema 目标/版本分布/迁移状态/历史条数/明细数/映射数/缺失项/备份数/双读状态。
   - 提供「执行迁移」「回滚迁移」「刷新状态」；无缺失时禁用迁移，无备份时禁用回滚。
   - `histOpen()` 自动刷新迁移状态。
3. 测试
   - `tests/unit_history_ids.py` 增加迁移状态、回滚后双读 diff、回滚后待迁移状态断言。
   - 新增 `tests/phase3/ui_migration.mjs`，并在 `run_phase3.mjs` 注册 `data-migration`。
   - 测试编排器向套件透传隔离 `PHASE3_DATA`，用于注入旧 schema 数据做真实迁移演练。

## 验证

### 单测 `python tests/unit_history_ids.py`：27/27

- 旧库 2 版本：首次打开自动补稳定 ID，跨版本一致；
- `migration_status`：`schema_ver=2`、`missing_items=0`、`dual_read=true`、备份 2；
- 回滚：恢复 2 条旧 `items_json`，旧数据仍可读、diff 正常；
- 回滚后状态：`missing_items=4`、`legacy_rows=2`、`can_rollback=false`；
- 回滚后重启不再自动迁移；显式 `migrate_legacy()` 重新迁移成功。

### 端到端 `node tests/phase3/run_phase3.mjs --only data-migration`：21/21

隔离 WE_DATA 中注入旧 schema 两版本（无稳定 ID）：

- 迁移前：`rows=2/items=4/missing=4/legacy_rows=2`，旧版本 `GET` 可读，2 项明细完整；
- 执行迁移：`migrated=2`；迁移后 `missing=0`、`backups=2`、`mapped=2`，两版本稳定 ID 一致、明细数量不变；
- 回滚：`restored=2`；回滚后 `missing=4/legacy_rows=2/can_rollback=false`，旧数据仍在且无稳定 ID；双读 diff 正常（changed=0）；
- 前端向导：徽标「待迁移 4 项」、双读兼容开启、历史列表 2 条；按钮文案「执行迁移 / 回滚迁移」可见；
- UI 执行迁移后徽标「已完成」、提示「迁移完成：本次处理 2 条历史」、状态与接口一致；映射校验 0 问题；
- 无页面异常。

## 本次回写

- 提交见 MTask T06190 的 git 关联。
- MTask：running → progress start → git link → 本结果 → progress done → done verified。

## 下一步建议

- 迁移失败自动回滚目前依赖 SQLite 事务：异常时未 commit 会整体回退；若后续引入跨库步骤，需补显式事务编排（仅观察不建单）。
- 向导文案目前为中文基线，英文界面未做 i18n key 补齐；如需英文迁移向导，另立文案任务（仅观察不建单）。
