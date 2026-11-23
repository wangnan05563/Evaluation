# T06206 数据迁移演练验证 验收

- 任务：Evaluation三期 T06206（urgent，REQ-012）
- 结论：**通过**（演练 36/36；含迁移成功、回滚、重迁、导出/导入、备份还原、3 类故障）
- 证据：`results/migration-drill.json`、`results/migration-drill.txt`

## 演练样本（旧库真实数据）

- `estimation.db` schema v1：6 条历史 / 4 个版本组 / 13 项明细
  - 同组 3 版本（同名重复功能 2 项），验证跨版本稳定 ID 与重复名区分；
  - 1 条损坏 JSON（`{this-is-not-json`），验证单行损坏不阻断迁移；
  - 1 条版本内重复 `stable_id` + 1 项缺 ID，验证重复拆分；
  - 1 条已迁移行（有 ID 但映射缺失），验证迁移补登记映射。
- `pert.db` v1：旧 `projects` 表（缺 `doc_name/gen_count`）。
- `schema_ver=1`、费率/识别规则 JSON。
- 迁移前生成 `backups/<ts>/`，`backup.json` 记录各文件 sha256。

## 演练结果（36/36）

1. **备份**：迁移前备份 5 个文件，清单记录旧 `estimation.db` sha256、schema v1。
2. **datakeeper v1→v2**：`pert.db` 补 `doc_name/gen_count`，`schema_ver` 写 2。
3. **稳定 ID 迁移**：自动迁移后 6 行/13 项、missing=0、mapped=7、`dual_read=true`。
   - 损坏 JSON 原样保留（不参与迁移，不阻断其它行）；
   - 同组三版本稳定 ID 完全一致；
   - 版本内重复 ID 拆为 3 个唯一 ID；
   - 已迁移行 schema 保持 v2，映射补登记。
4. **数据完整性**：迁移前后条数不变、业务数据逻辑哈希一致（剥离新增 `stable_id`/`replaces_id` 后逐项相同）；映射校验 0 问题。
5. **回滚**：`rollback_migration()` 恢复 5 条旧记录，`estimation.db` **逐字节哈希**与迁移前一致；日志含 `migration_rollback`。
6. **双读 + 重迁**：回滚后旧明细可读（无 `stable_id`），显式重迁成功；已迁移行也补登记映射，校验通过。
7. **导出/导入**：zip 包含 `estimation.db`；导入后历史库落盘、无缺失、稳定 ID 不变（修复 `import_zip` 漏恢复 estimation.db 的问题）。
8. **备份还原**：`restore_backup` 恢复 5 个文件，`estimation.db` 与迁移前逐字节一致，`pert.db` 回到旧 schema（无新增列），`logs/rollback.jsonl` 有 `rollback_done` 成功记录。
9. **故障场景**
   - 备份文件哈希不符：`ok=false`，`skipped` 指出「备份哈希不符，拒绝还原」，不覆盖当前数据；
   - 导入包 schema=99 高于当前：抛 `VImportErr`「请先升级应用」，拒绝导入；
   - 单行 JSON 损坏：保留原行、其它行正常迁移，迁移不中断。

## 发现并修复

- `scripts/datakeeper.py` `import_zip` 原只解压 `pert.db`/规则/费率/schema，漏了 `estimation.db`，导致「导出→导入」后历史与稳定 ID 丢失；已补齐并纳入演练断言。
- `scripts/history.py` 迁移多了「已迁移行但映射缺失」的补登记；迁移/回滚新增 `data/logs/migration.jsonl` 审计日志。

## 本次回写

- 提交见 MTask T06206 的 git 关联。
- MTask：running → progress start → git link → 本结果 → progress done → done verified。

## 下一步建议

- 当前演练依赖 Python/SQLite 本地环境；若要在安装包内自助演练，可将 `tests/migration_drill.py` 封装为 `--diagnose-migration` CLI（仅观察不建单）。
- 迁移过程未单独记录逐行 ID 变更；如审计要求逐项追踪，可扩展 `migration.jsonl` 明细（仅观察不建单）。
