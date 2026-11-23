# T06187 稳定功能ID机制 验收

- 任务：Evaluation三期 T06187（urgent，REQ-009 / AC-11）
- 结论：**通过**（单测 24/24；端到端 20/20）
- 证据：`results/stable-ids.json`、`screenshots/stable_ids_review_1440.png`、`tests/unit_history_ids.py`

## 交付

1. `scripts/history.py`（schema v2）
   - 每项明细落库时分配 `stable_id = F- + 10 位十六进制`，全局唯一，只新建不修改。
   - 新增 `item_id_map(stable_id, version_group, item_key, item_type, replaces_id, created_at, retired_at)`。
   - 重开修订优先沿用明细携带的 `stable_id`；缺省时按 `(desc,system)` 匹配上一版本；**类型变更**新建 ID 并写 `replaces_id`，旧 ID 与旧版本保留。
   - 另存为新项目（新版本组）重新发号，不跨组复用 ID。
   - `diff` 匹配优先级：稳定ID → `replaces_id` → `(desc,system)`；描述改名只算变更，类型变更（新 ID）也归为同一条变更并展示 `stable_id` 变化。
   - `validate_ids()` 校验缺失、版本内重复、未知映射、版本组不一致、替换链断裂、跨组复用。
2. 旧数据迁移与回滚
   - 首次打开自动扫 `estimation_history`，对缺 `stable_id` 的明细按 版本组+键+序号 生成确定性 ID（同组跨版本一致）。
   - 迁移前逐行备份 `items_json` 到 `history_items_backup`；`rollback_migration()` 恢复备份并清掉迁移期新建映射。
   - 回滚后不再自动迁移；`migrate_legacy()` 可显式重跑。
3. 接口
   - `GET /api/history/ids/validate`：映射表校验。
   - `POST /api/history/ids/migrate`：显式迁移（回滚后重跑）。
   - `POST /api/history/ids/rollback`：迁移回滚。
   - `/api/generate` 响应回传带 `stable_id` 的明细；前端生成成功后回填当前 `items`。
4. 前端
   - 复核页描述下方展示稳定 ID（等宽小字）。
   - 历史 diff 继续支持改名/类型变更的变更态；导出 JSON 明细自带 `stable_id`。
5. 文档：`docs/概要设计说明.md`、`docs/系统架构设计.md` 补稳定 ID 与迁移/回滚口径。

## 验证

### 单测 `python tests/unit_history_ids.py`：24/24

- 新建版本自动发号；v2/v3 重开 ID 不变；`validate_ids` 6 项/2 映射全通过。
- 描述改名携带 ID → ID 不变；diff `added=0/removed=0/changed=1`，字段含 `desc`。
- 类型 ILF→EI：生成新 ID、`replaces_id` 指向旧 ID、旧版本仍保留旧 ID；diff 归为 1 条变更，字段含 `type/count_item/stable_id`。
- 另存新项目重新发号，与旧组无交集。
- 数据库复制（代表导出/导入）后 ID 不变。
- 旧库 2 版本首次打开自动补 ID 且跨版本一致；回滚恢复旧 `items_json`；回滚后重启不再自动迁移；显式重迁成功。

### 端到端 `node tests/phase3/run_phase3.mjs --only stable-ids`：20/20

隔离 WE_DATA + API 8033 + CDP 9335，真实 `/api/generate` 生成 5 个版本：

- v1 发号 `F-72949F6FAA/F-B5D1E414A9/F-6C66036FC1`；
- v2/v3 重开 ID 完全一致；
- 改名后 ID 不变，diff 只 1 条变更且含 `desc`；
- 类型变更新 ID `F-3517AF2ADF`，`replaces_id=F-72949F6FAA`；旧版本仍保留旧 ID；diff 1 条变更含 `type/stable_id`；
- `/api/history/ids/validate`：5 版本/15 项/4 映射/0 问题；
- 另存新项目 ID 全部重新发号，映射仍通过；
- `/api/data/export` 成功导出含估算库，导出后历史与稳定 ID 仍可读；
- 复核页 3 行均显示稳定 ID；无页面异常。

## 本次回写

- 提交见 MTask T06187 的 git 关联。
- MTask：running → progress start → git link → 本结果 → progress done → done verified。

## 下一步建议

- T06190 可复用本迁移/备份/回滚能力，补「迁移向导 + 双读兼容 + 失败自动回滚」的 API/UI；`item_id_map` 和 `schema_meta` 已就位（仅观察不建单）。
- 旧库确定性 ID 依赖「同描述同系统同序号」；若历史版本间明细顺序大改，ID 仍按出现序号区分，建议后续在识别阶段直接落稳定 ID（仅观察不建单）。
