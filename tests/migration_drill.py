# -*- coding: utf-8 -*-
"""T06206 数据迁移演练：旧库样本 → 迁移 → 回滚 → 重迁 → 导出/导入 → 备份还原 → 典型故障。

产出 docs/test-reports/phase3-20261122/results/migration-drill.json 与样本日志。
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import history as H          # noqa: E402
import datakeeper as DK      # noqa: E402

PASS = FAIL = 0
CHECKS = []


def ok(cond, name, detail=""):
    global PASS, FAIL
    CHECKS.append({"name": name, "ok": bool(cond), "detail": str(detail)})
    if cond:
        PASS += 1
        print(f"  PASS  {name} {detail}")
    else:
        FAIL += 1
        print(f"  FAIL  {name} {detail}")


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def strip_ids(obj):
    if isinstance(obj, dict):
        return {k: strip_ids(v) for k, v in obj.items() if k not in ("stable_id", "replaces_id")}
    if isinstance(obj, list):
        return [strip_ids(x) for x in obj]
    return obj


def raw_rows(db):
    con = sqlite3.connect(db, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in con.execute(
            "SELECT id,title,version_group,version_no,items_json,summary_json,schema_ver "
            "FROM estimation_history ORDER BY id").fetchall()]
        return rows
    finally:
        con.close()


def raw_hash(db):
    rows = raw_rows(db)
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def logical_hash(db):
    rows = raw_rows(db)
    logical = []
    for r in rows:
        try:
            its = strip_ids(json.loads(r["items_json"] or "[]"))
        except Exception:
            its = "__CORRUPT__"
        logical.append({"id": r["id"], "title": r["title"], "vg": r["version_group"],
                        "vn": r["version_no"], "items": its})
    return hashlib.sha256(json.dumps(logical, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def seed_legacy(data_dir):
    db = os.path.join(data_dir, "estimation.db")
    con = sqlite3.connect(db)
    con.executescript("""
    CREATE TABLE estimation_history (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title TEXT NOT NULL,
      source_name TEXT, method TEXT NOT NULL, params_json TEXT NOT NULL, items_json TEXT NOT NULL,
      summary_json TEXT, sid TEXT, version_group TEXT NOT NULL DEFAULT 'g',
      version_no INTEGER NOT NULL DEFAULT 1, schema_ver INTEGER NOT NULL DEFAULT 1);
    """)
    items = json.dumps([
        {"desc": "内部文件", "type": "ILF", "system": "票据", "reuse": "低", "modify": "新增", "count_item": "内部文件"},
        {"desc": "内部文件", "type": "EIF", "system": "票据", "reuse": "低", "modify": "新增", "count_item": "外部接口"},
        {"desc": "外部接口", "type": "EIF", "system": "票据", "reuse": "低", "modify": "新增", "count_item": "外部接口"},
    ], ensure_ascii=False)
    rows = [
        ("a" * 32, "旧项目A", "gA", 1, items, 1),
        ("b" * 32, "旧项目A", "gA", 2, items, 1),
        ("c" * 32, "旧项目A", "gA", 3, items, 1),
        ("d" * 32, "损坏JSON样本", "gBad", 1, "{this-is-not-json", 1),
    ]
    for hid, title, vg, vn, its, sv in rows:
        con.execute("INSERT INTO estimation_history(id,created_at,updated_at,title,method,params_json,"
                    "items_json,summary_json,sid,version_group,version_no,schema_ver) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (hid, "2026-11-01T00:00:00", "2026-11-01T00:00:00", title, "估算功能点", "{}", its,
                     json.dumps({"count": 3, "us_total": 30}, ensure_ascii=False), "", vg, vn, sv))
    dup = json.dumps([
        {"desc": "重复ID-1", "type": "ILF", "system": "票据", "stable_id": "F-AAAAAAAAAA"},
        {"desc": "重复ID-2", "type": "EIF", "system": "票据", "stable_id": "F-AAAAAAAAAA"},
        {"desc": "缺ID", "type": "EI", "system": "票据"},
    ], ensure_ascii=False)
    con.execute("INSERT INTO estimation_history(id,created_at,updated_at,title,method,params_json,"
                "items_json,summary_json,sid,version_group,version_no,schema_ver) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                ("e" * 32, "2026-11-01T00:00:00", "2026-11-01T00:00:00", "重复ID样本", "估算功能点", "{}", dup,
                 json.dumps({"count": 3, "us_total": 15}, ensure_ascii=False), "", "gDup", 1, 1))
    # 已迁移行（有稳定 ID 但映射缺失），验证迁移会补登记映射
    migrated = json.dumps([
        {"desc": "已迁移项", "type": "ILF", "system": "票据", "stable_id": "F-BBBBBBBBBB"},
    ], ensure_ascii=False)
    con.execute("INSERT INTO estimation_history(id,created_at,updated_at,title,method,params_json,"
                "items_json,summary_json,sid,version_group,version_no,schema_ver) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                ("f" * 32, "2026-11-01T00:00:00", "2026-11-01T00:00:00", "已迁移样本", "估算功能点", "{}", migrated,
                 json.dumps({"count": 1, "us_total": 10}, ensure_ascii=False), "", "gDone", 1, 2))
    con.commit(); con.close()

    # datakeeper v1→v2：旧 pert.db 缺 doc_name/gen_count
    pdb = os.path.join(data_dir, "pert.db")
    pc = sqlite3.connect(pdb)
    pc.executescript("""
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, estimator TEXT, created_at TEXT);
    INSERT INTO projects(id,name,estimator,created_at) VALUES('p1','旧PERT项目','张三','2026-11-01');
    """)
    pc.commit(); pc.close()

    with open(os.path.join(data_dir, "schema_ver"), "w", encoding="utf-8") as f:
        f.write("1")
    with open(os.path.join(data_dir, "rates_versions.json"), "w", encoding="utf-8") as f:
        json.dump({"versions": ["CSBMK-2023"]}, f)
    with open(os.path.join(data_dir, "recognition_rules.json"), "w", encoding="utf-8") as f:
        json.dump({"rules": []}, f)


def main(out_path):
    tmp = tempfile.mkdtemp(prefix="migration_drill_")
    data = os.path.join(tmp, "data")
    os.makedirs(data)
    try:
        seed_legacy(data)
        before_raw = raw_hash(os.path.join(data, "estimation.db"))
        before_logical = logical_hash(os.path.join(data, "estimation.db"))
        ok(os.path.isfile(os.path.join(data, "estimation.db")), "旧库样本就位", before_raw[:12])

        pre = DK.backup_on_start(data, keep=7, reason="drill-pre")
        ok(bool(pre) and os.path.isdir(pre), "迁移前备份生成", pre)
        manifest = json.load(open(os.path.join(pre, "backup.json"), encoding="utf-8"))
        ok(manifest["files"]["estimation.db"]["sha256"] == sha_file(os.path.join(data, "estimation.db")), "备份清单记录旧库哈希")
        pre_ver = DK.list_backups(data)[0]
        ok(pre_ver["schema_ver"] == 1, "备份记录 schema v1", pre_ver["schema_ver"])

        ver, applied = DK._migrate(data)
        ok(ver == 2 and applied == [1], "datakeeper v1→v2 迁移执行", f"ver={ver} applied={applied}")
        pc = sqlite3.connect(os.path.join(data, "pert.db"))
        cols = {r[1] for r in pc.execute("PRAGMA table_info(projects)")}
        pc.close()
        ok({"doc_name", "gen_count"} <= cols, "pert.db 旧库补列", sorted(cols))
        ok(open(os.path.join(data, "schema_ver"), encoding="utf-8").read().strip() == "2", "schema_ver 写入 2")

        obj_hash_before_hist = sha_file(os.path.join(data, "estimation.db"))
        hist = H.HistStore(os.path.join(data, "estimation.db"))
        st = hist.migration_status()
        ok(st["migration_state"] == "migrated" and st["missing_items"] == 0,
           "稳定ID自动迁移完成", json.dumps(st, ensure_ascii=False))
        ok(st["rows"] == 6 and st["items"] == 13, "迁移行/项计数符合样本", f"rows={st['rows']} items={st['items']}")
        ok(st["mapped"] >= 7, "映射表登记全部可迁移 ID", st["mapped"])

        rows = {r["id"]: r for r in raw_rows(os.path.join(data, "estimation.db"))}
        ok(rows["d" * 32]["items_json"] == "{this-is-not-json", "损坏 JSON 行原样保留")
        ok(rows["f" * 32]["schema_ver"] == 2, "已迁移行 schema 保持 v2")

        # 同一 gA 三版本稳定 ID 一致；重复 ID 被拆开
        a_ids = []
        for hid in ("a" * 32, "b" * 32, "c" * 32):
            a_ids.append([x["stable_id"] for x in json.loads(rows[hid]["items_json"])])
        ok(len(set(map(tuple, a_ids))) == 1, "同组三版本稳定 ID 一致", a_ids[0])
        dup_items = json.loads(rows["e" * 32]["items_json"])
        ok(len({x["stable_id"] for x in dup_items}) == 3, "版本内重复 ID 已拆分", [x["stable_id"] for x in dup_items])

        val = hist.validate_ids()
        ok(val["ok"] and not val["issues"], "迁移后映射校验通过", val)
        after_logical = logical_hash(os.path.join(data, "estimation.db"))
        ok(before_logical == after_logical, "迁移前后业务数据逻辑哈希一致", before_logical[:12])
        ok(os.path.isfile(os.path.join(data, "logs", "migration.jsonl")), "迁移日志落盘")
        logs = read_jsonl(os.path.join(data, "logs", "migration.jsonl"))
        ok(any(x.get("event") == "migration_start" for x in logs) and any(x.get("event") == "migration_done" for x in logs),
           "迁移日志含 start/done", [x.get("event") for x in logs])

        # 回滚：items_json 精确恢复
        rb = hist.rollback_migration()
        ok(rb["restored"] == 5, "回滚恢复 5 条旧记录", rb)
        ok(raw_hash(os.path.join(data, "estimation.db")) == before_raw, "回滚后旧库逐字节哈希一致")
        ok(any(x.get("event") == "migration_rollback" for x in read_jsonl(os.path.join(data, "logs", "migration.jsonl"))),
           "回滚日志落盘")

        # 回滚后双读，再显式迁移
        h2 = H.HistStore(os.path.join(data, "estimation.db"))
        ok(all("stable_id" not in x for x in h2.get("a" * 32)["items"]), "回滚后双读旧明细")
        mg = h2.migrate_legacy()
        ok(mg["migrated"] == 5, "回滚后重迁 5 条", mg)
        ok(h2.validate_ids()["ok"], "重迁后映射校验通过（含已迁移行补登记）")
        ok(sha_file(os.path.join(data, "estimation.db")) != obj_hash_before_hist, "重迁后库文件已变化")

        # 导出 → 导入（历史库必须随包恢复）
        zip_path = os.path.join(tmp, "data.zip")
        DK.export_zip(data, zip_path)
        imported = os.path.join(tmp, "imported")
        os.makedirs(imported)
        names = DK.import_zip(zip_path, imported)
        ok("estimation.db" in names, "导出包包含 estimation.db", names)
        ok(os.path.isfile(os.path.join(imported, "estimation.db")), "导入后历史库落盘")
        hi = H.HistStore(os.path.join(imported, "estimation.db"))
        ok(hi.migration_status()["missing_items"] == 0, "导入后无缺失稳定 ID")
        imported_a = [x["stable_id"] for x in hi.get("a" * 32)["items"]]
        source_a = [x["stable_id"] for x in h2.get("a" * 32)["items"]]
        ok(imported_a == source_a, "导出/导入后稳定 ID 不变", imported_a)

        # 备份还原：恢复迁移前 exact 状态
        restored = DK.restore_backup(data, pre_ver["id"])
        ok(restored["ok"] and "estimation.db" in restored["restored"], "备份还原成功", restored)
        ok(raw_hash(os.path.join(data, "estimation.db")) == before_raw, "还原后旧库逐字节哈希一致")
        log_rb = read_jsonl(os.path.join(data, "logs", "rollback.jsonl"))
        ok(any(x.get("action") == "rollback_done" and x.get("ok") for x in log_rb), "rollback.jsonl 含完成记录")
        pc2 = sqlite3.connect(os.path.join(data, "pert.db"))
        cols2 = {r[1] for r in pc2.execute("PRAGMA table_info(projects)")}
        pc2.close()
        ok(not ({"doc_name", "gen_count"} & cols2), "备份还原回旧 pert schema", sorted(cols2))

        # 故障 1：备份文件哈希不符 → 拒绝还原并记日志
        fault = os.path.join(tmp, "fault")
        os.makedirs(os.path.join(fault, "backups", "pre"))
        with open(os.path.join(fault, "estimation.db"), "wb") as f:
            f.write(b"current")
        with open(os.path.join(fault, "backups", "pre", "estimation.db"), "wb") as f:
            f.write(b"corrupt-backup")
        good_hash = hashlib.sha256(b"expected").hexdigest()
        with open(os.path.join(fault, "backups", "pre", "backup.json"), "w", encoding="utf-8") as f:
            json.dump({"created_at": "2026-11-01T00:00:00", "reason": "fault",
                        "files": {"estimation.db": {"exists": True, "sha256": good_hash}}}, f)
        rf = DK.restore_backup(fault, "pre")
        ok(rf["ok"] is False and any("哈希不符" in x.get("reason", "") for x in rf["skipped"]),
           "坏备份被拒绝还原", rf)

        # 故障 2：导入包 schema 高于当前 → 拒绝
        bad_zip = os.path.join(tmp, "future.zip")
        with zipfile.ZipFile(bad_zip, "w") as z:
            z.writestr("pert.db", b"x")
            z.writestr("schema_ver", "99")
        try:
            DK.import_zip(bad_zip, imported)
            high_ok = False
            high_detail = "未抛错"
        except DK.VImportErr as e:
            high_ok = "高于当前" in str(e)
            high_detail = str(e)
        ok(high_ok, "高版本数据包被拒绝", high_detail)

        # 故障 3：损坏 JSON 不阻塞其它行
        ok(rows["d" * 32]["items_json"] == "{this-is-not-json" and rows["a" * 32]["schema_ver"] == 2,
           "单行损坏不阻断迁移", "gBad 保留 / gA 已迁移")

        result = {"suite": "migration-drill", "pass": PASS, "total": PASS + FAIL,
                  "checks": CHECKS, "sample": {"rows": 5, "items": 10, "groups": 4}}
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"\nmigration-drill: {PASS}/{PASS + FAIL} checks passed")
        return 0 if FAIL == 0 else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "test-reports", "phase3-20261122",
                                                  "results", "migration-drill.json"))
    args = ap.parse_args()
    sys.exit(main(args.out))
