# -*- coding: utf-8 -*-
"""T06187 稳定功能 ID / 旧数据迁移 / diff 匹配 单测（独立临时库，不碰真实数据）."""
import json
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import history as H  # noqa: E402

PASS = FAIL = 0


def ok(cond, name, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name} {extra}")
    else:
        FAIL += 1
        print(f"  FAIL  {name} {extra}")


def item(desc, typ="ILF", system="核心"):
    return {"desc": desc, "type": typ, "system": system, "cx": "中", "reuse": "低",
            "modify": "新增", "count_item": "内部文件", "seq": 1}


def main():
    tmp = tempfile.mkdtemp(prefix="hist_ids_")
    db = os.path.join(tmp, "est.db")
    try:
        h = H.HistStore(db)
        base = [item("内部文件"), item("外部接口", "EIF")]
        r1 = h.insert(title="项目A", method="IFPUG", items=[dict(x) for x in base], summary={"count": 2})
        v1 = h.get(r1["id"])
        sid1 = [x["stable_id"] for x in v1["items"]]
        ok(len(sid1) == 2 and all(s.startswith("F-") for s in sid1), "新建版本自动分配稳定ID", sid1)

        r2 = h.insert(title="项目A", method="IFPUG", items=[dict(x) for x in base],
                      summary={"count": 2}, reopen_group=r1["version_group"])
        r3 = h.insert(title="项目A", method="IFPUG", items=[dict(x) for x in base],
                      summary={"count": 2}, reopen_group=r1["version_group"])
        ok([x["stable_id"] for x in h.get(r2["id"])["items"]] == sid1, "v2 稳定ID不变")
        ok([x["stable_id"] for x in h.get(r3["id"])["items"]] == sid1, "v3 稳定ID不变")
        val = h.validate_ids()
        ok(val["ok"] and val["rows"] == 3 and val["items"] == 6, "映射表校验通过", val)

        # 描述改名但 ID 不变：diff 仍按同一条变更
        renamed = [dict(base[0], desc="内部文件（改名）", stable_id=sid1[0]),
                   dict(base[1], stable_id=sid1[1])]
        r4 = h.insert(title="项目A", method="IFPUG", items=renamed, summary={"count": 2},
                      reopen_group=r1["version_group"])
        ok([x["stable_id"] for x in h.get(r4["id"])["items"]][0] == sid1[0], "描述改名稳定ID不变")
        d = h.diff(r3["id"], r4["id"])
        ok(d["summary"] == {"added": 0, "removed": 0, "changed": 1}, "改名按变更匹配", d["summary"])
        ok(any(f["field"] == "desc" for f in d["changes"][0]["fields"]), "diff 字段含 desc")

        # 类型变更：新 ID，replaces_id 指向旧 ID，旧 ID 保留在历史
        changed = [dict(renamed[0], type="EI", count_item="录入"), dict(base[1])]
        r5 = h.insert(title="项目A", method="IFPUG", items=changed, summary={"count": 2},
                      reopen_group=r1["version_group"])
        v5 = h.get(r5["id"])
        new_sid = [x["stable_id"] for x in v5["items"]][0]
        ok(new_sid != sid1[0], "类型变更生成新ID", new_sid)
        ok(v5["items"][0].get("replaces_id") == sid1[0], "新ID记录 replaces_id", v5["items"][0].get("replaces_id"))
        old = h.get(r1["id"])
        ok(old["items"][0]["stable_id"] == sid1[0], "旧版本ID保留")
        d2 = h.diff(r4["id"], r5["id"])
        ok(d2["summary"] == {"added": 0, "removed": 0, "changed": 1}, "类型变更 diff 归为变更", d2["summary"])
        ok([f["field"] for f in d2["changes"][0]["fields"]] == ["type", "count_item", "stable_id"],
           "类型变更字段", d2["changes"][0]["fields"])

        # 另存为新项目：不得沿用旧组稳定 ID
        r6 = h.insert(title="项目B", method="IFPUG", items=[dict(x) for x in base], summary={"count": 2})
        sid6 = [x["stable_id"] for x in h.get(r6["id"])["items"]]
        ok(set(sid6).isdisjoint(set(sid1)), "另存新项目重新发号", sid6)
        ok(h.validate_ids()["ok"], "新项目后映射表仍通过")

        # 备份/恢复（代表导出/导入）：复制库后稳定 ID 不变
        db2 = os.path.join(tmp, "copy.db")
        shutil.copy(db, db2)
        h2 = H.HistStore(db2)
        ok([x["stable_id"] for x in h2.get(r1["id"])["items"]] == sid1, "库复制后稳定ID不变")

        # 旧数据迁移 + 回滚
        legacy_db = os.path.join(tmp, "legacy.db")
        con = sqlite3.connect(legacy_db)
        con.executescript("""
        CREATE TABLE estimation_history (
          id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title TEXT NOT NULL,
          source_name TEXT, method TEXT NOT NULL, params_json TEXT NOT NULL, items_json TEXT NOT NULL,
          summary_json TEXT, sid TEXT, version_group TEXT NOT NULL DEFAULT 'g1',
          version_no INTEGER NOT NULL DEFAULT 1, schema_ver INTEGER NOT NULL DEFAULT 1);
        """)
        old_items = json.dumps([{"desc": "内部文件", "type": "ILF", "system": "核心"},
                                {"desc": "外部接口", "type": "EIF", "system": "核心"}], ensure_ascii=False)
        for i in (1, 2):
            con.execute("INSERT INTO estimation_history(id,created_at,updated_at,title,method,params_json,"
                        "items_json,sid,version_group,version_no,schema_ver) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (f"a{i}", "2026-01-01T00:00:00", "2026-01-01T00:00:00", "旧项目", "IFPUG", "{}",
                         old_items, "", "g1", i, 1))
        con.commit()
        con.close()
        hl = H.HistStore(legacy_db)
        rows = hl.list(limit=10)["rows"]
        ok(len(rows) == 2, "旧库加载2个版本")
        i1 = hl.get("a1")["items"]
        i2 = hl.get("a2")["items"]
        ok(all(x["stable_id"].startswith("F-") for x in i1), "首次打开自动补稳定ID", [x["stable_id"] for x in i1])
        ok([x["stable_id"] for x in i1] == [x["stable_id"] for x in i2], "迁移后跨版本ID一致")
        ok(hl.validate_ids()["ok"], "迁移后映射校验通过")
        rb = hl.rollback_migration()
        ok(rb["restored"] == 2, "回滚恢复2个版本", rb)
        ok(all("stable_id" not in x for x in hl.get("a1")["items"]), "回滚后恢复旧 items_json")
        hl3 = H.HistStore(legacy_db)
        ok(all("stable_id" not in x for x in hl3.get("a1")["items"]), "回滚后不再自动迁移")
        mg = hl3.migrate_legacy()
        ok(mg["migrated"] == 2, "回滚后可手动重新迁移", mg)
        ok(hl3.validate_ids()["ok"], "重迁后映射校验通过")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"==== 稳定ID单测 ==== 通过 {PASS} / 失败 {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
