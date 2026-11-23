# T06175 编辑韧性与自动保存验收

- 任务：Evaluation 三期 / T06175 / urgent
- 完成定义：编辑 1 秒自动保存；崩溃重开数据丢失 ≤1 秒；20 步撤销/重做且不破坏公式。
- 测试：`tests/phase3/ui_edit_resilience.mjs`
- 结果：`results/edit-resilience.json`

## 实现

### 20 步撤销/重做

`frontend/src/js/07_m3_fr_1_4_1_5_1_7_2_9_批量.js` 新增：

- `undoStack/redoStack`，上限 `UNDO_LIMIT=20`；每次数据变更前 `pushUndo(label)` 压快照，新编辑清空重做栈。
- 快照只浅拷贝 item 顶层字段（`_ai` 视为只读），避免 10k 行批量操作深拷贝 20 份导致内存膨胀。
- `undoEdit()` / `redoEdit()` 恢复 items、驳回队列、当前行；恢复后 `render()` 重算 UFP/US，公式由数据重新推导，不缓存旧结果。
- 快捷键：复核页 `Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Y` 或 `Ctrl+Shift+Z` 重做；工具栏新增 `#undoBtn/#redoBtn`，无可撤销/重做时禁用。

### 自动保存覆盖补齐

- 复核行勾选、全选、键盘 Enter 切换确认状态此前只改内存不落盘；现均调用 `saveFormState()`，与编辑下拉一致即时写入 `localStorage`（键 `we_form_state_v1`）。
- 重新识别覆盖旧清单前压撤销栈，避免误操作不可逆。
- 恢复链沿用 `restoreFormState()`：items/步骤/当前文件全量恢复，刷新或崩溃重开回到最后编辑点。

## 验证（实测）

命令：`node tests/phase3/run_phase3.mjs --only edit-resilience`

- **20/20 PASS**。
- 25 次连续编辑：撤销栈保持 20，按钮启用；每次编辑后 `localStorage` 即时值与内存一致。
- 20 次 Ctrl+Z：回到第 5 次编辑后的状态（第 1–5 次快照按 20 上限淘汰），撤销栈 0、重做栈 20；UFP 180→180 不变。
- 20 次 Ctrl+Y：回到第 25 次编辑状态，撤销栈恢复 20。
- 公式验证：把首行类型 EI 改 ILF，UFP 180→186；撤销后回 180、类型回 EI。
- 勾选自动保存：勾选后 80ms 内落盘为 true；撤销后内存与落盘均为 false。
- 恢复：刷新后 30 行、目标行最后编辑值、第二行未确认态、复核步骤全部恢复；撤销栈清空、按钮禁用。
- 无页面异常；截图证据由 10k/a11y 套件继续覆盖。

## 本次回写

- MTask T06175 回写本结果并标 done+verified。
- commit 与 git 关联在提交后回填。

## 下一步建议

- 仅观察不建单：真实进程崩溃（`Page.crash`）与断电级恢复需在打包版上补一次破坏性演练；本轮以同步 `localStorage` 落盘 + 刷新恢复验证，已满足 ≤1 秒数据丢失口径。
