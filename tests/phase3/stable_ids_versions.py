# -*- coding: utf-8 -*-
"""T06194：同一项目 3 个版本导出/导入/重开后的稳定 ID 与映射表校验。

不依赖在线服务；直接使用真实 HistStore + datakeeper 导出/导入 zip，
覆盖 AC-11 的 3 版本迭代、导出、导入、重开与类型变更链。
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import history as H  # noqa: E402
import datakeeper as DK  # noqa: E402

PASS = FAIL = 0
CASES = []


def check(name, cond, detail=""):
    global PASS, FAIL
    CASES.append({"title": name, "ok": bool(cond), "detail": str(detail)})
    if cond:
        PASS += 1
        print(f"  PASS  {name}  — {detail}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  — {detail}")


def item(desc, typ="ILF", system="票据", count="内部文件"):
    return {"desc": desc, "type": typ, "system": system, "cx": "中", "reuse": "低",
            "modify": "新增", "count_item": count, "seq": 1}


def sids(items):
    return [x.get("stable_id") for x in items]


def main():
    tmp = tempfile.mkdtemp(prefix="stable_versions_")
    data = os.path.join(tmp, "data")
    restore = os.path.join(tmp, "restore")
    os.makedirs(data, exist_ok=True)
    os.makedirs(restore, exist_ok=True)
    zip_path = os.path.join(tmp, "data_export.zip")
    try:
        # 导出包要求 pert.db；真实环境会由主程序生成，测试用最小库占位。
        sqlite3.connect(os.path.join(data, "pert.db")).close()
        with open(os.path.join(data, DK.F_SCHEMA_VER), "w", encoding="utf-8") as f:
            f.write(str(DK.SCHEMA_VER))

        h = H.HistStore(os.path.join(data, "estimation.db"))
        base = [item("内部文件"), item("外部接口", "EIF"), item("录入", "EI", count="录入")]
        r1 = h.insert(title="稳定ID三版本", method="IFPUG", items=[dict(x) for x in base],
                      summary={"count": 3})
        v1 = h.get(r1["id"])
        sid1 = sids(v1["items"])
        check("第1版生成3个稳定ID", len(sid1) == 3 and all(s.startswith("F-") for s in sid1), sid1)

        r2 = h.insert(title="稳定ID三版本", method="IFPUG", items=[dict(x) for x in v1["items"]],
                      summary={"count": 3}, reopen_group=r1["version_group"])
        v2 = h.get(r2["id"])
        check("第2版稳定ID不变", sids(v2["items"]) == sid1, sids(v2["items"]))

        changed_desc = [dict(v2["items"][0], desc="内部文件（v3改名）"), dict(v2["items"][1]), dict(v2["items"][2])]
        r3 = h.insert(title="稳定ID三版本", method="IFPUG", items=changed_desc,
                      summary={"count": 3}, reopen_group=r1["version_group"])
        v3 = h.get(r3["id"])
        check("第3版改名但稳定ID不变", sids(v3["items"]) == sid1, sids(v3["items"]))
        check("3个版本 version_no 递增", [v1["version_no"], v2["version_no"], v3["version_no"]] == [1, 2, 3],
              [v1["version_no"], v2["version_no"], v3["version_no"]])
        val = h.validate_ids()
        check("导出前映射表校验通过", val["ok"] and val["rows"] == 3 and val["items"] == 9 and val["mapped"] == 3, val)

        names = DK.export_zip(data, zip_path)
        check("导出包包含估算库与 schema", DK.F_ESTIMATION_DB in names and DK.F_SCHEMA_VER in names, names)
        check("导出包可被 zip 校验读取", os.path.getsize(zip_path) > 0 and zipfile_is_ok(zip_path), os.path.getsize(zip_path))

        imported = DK.import_zip(zip_path, restore)
        check("导入到全新数据目录成功", DK.F_ESTIMATION_DB in imported, imported)

        h2 = H.HistStore(os.path.join(restore, "estimation.db"))
        r1b = h2.get(r1["id"])
        r2b = h2.get(r2["id"])
        r3b = h2.get(r3["id"])
        check("导入后第1版稳定ID不变", sids(r1b["items"]) == sid1, sids(r1b["items"]))
        check("导入后第2版稳定ID不变", sids(r2b["items"]) == sid1, sids(r2b["items"]))
        check("导入后第3版稳定ID不变", sids(r3b["items"]) == sid1, sids(r3b["items"]))
        check("导入后明细字段无丢失",
              [(x["desc"], x["type"], x["system"], x["count_item"]) for x in r3b["items"]] ==
              [(x["desc"], x["type"], x["system"], x["count_item"]) for x in v3["items"]],
              [(x["desc"], x["type"]) for x in r3b["items"]])
        val2 = h2.validate_ids()
        check("导入后映射表校验通过", val2["ok"] and val2["rows"] == 3 and val2["items"] == 9 and val2["mapped"] == 3, val2)

        v4_items = [dict(r3b["items"][0], desc="内部文件（导入后重开）"), dict(r3b["items"][1]), dict(r3b["items"][2])]
        r4 = h2.insert(title="稳定ID三版本", method="IFPUG", items=v4_items,
                       summary={"count": 3}, reopen_group=r3b["version_group"])
        v4 = h2.get(r4["id"])
        check("导入后重开第4版稳定ID不变", sids(v4["items"]) == sid1, sids(v4["items"]))
        check("重开第4版 version_no=4", v4["version_no"] == 4, v4["version_no"])
        d = h2.diff(r3b["id"], r4["id"])
        check("导入后重开 diff 只含1条改名", d["summary"] == {"added": 0, "removed": 0, "changed": 1}, d["summary"])

        v5_items = [dict(v4["items"][0], type="EI", count_item="录入"), dict(v4["items"][1]), dict(v4["items"][2])]
        r5 = h2.insert(title="稳定ID三版本", method="IFPUG", items=v5_items,
                       summary={"count": 3}, reopen_group=r3b["version_group"])
        v5 = h2.get(r5["id"])
        new_sid = sids(v5["items"])[0]
        check("导入后类型变更生成新ID", new_sid != sid1[0], new_sid)
        check("新ID replaces_id 指向旧ID", v5["items"][0].get("replaces_id") == sid1[0], v5["items"][0].get("replaces_id"))
        val3 = h2.validate_ids()
        check("类型变更后映射表/替换链通过", val3["ok"] and val3["rows"] == 5 and val3["items"] == 15 and val3["mapped"] == 4, val3)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    out = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results" / "stable-ids-versions.json"
    out.write_text(json.dumps({
        "suite": "stable-ids-versions",
        "task": "T06194",
        "at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "checks": CASES,
        "pass": PASS,
        "fail": FAIL,
        "total": PASS + FAIL,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"==== 稳定ID三版本导出导入 ==== 通过 {PASS} / 失败 {FAIL}")
    return 1 if FAIL else 0


def zipfile_is_ok(path):
    import zipfile
    try:
        with zipfile.ZipFile(path) as z:
            return z.testzip() is None and DK.F_ESTIMATION_DB in z.namelist()
    except Exception:
        return False


if __name__ == "__main__":
    sys.exit(main())

