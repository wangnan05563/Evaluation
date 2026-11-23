# -*- coding: utf-8 -*-
"""M8/FR-5.6：数据备份（启动自动备份保留 N 份）+ schema 版本迁移框架 + 全量导出/导入。

AC-39 升级回滚：备份集覆盖数据 + 配置 + schema 版本，restore_backup 做精确还原并落审计日志。
"""
import hashlib
import json
import os
import shutil
import sqlite3
import time
import zipfile

SCHEMA_VER = 2            # 数据结构版本号（首版；后续迁移在此登记）
KEEP_BACKUPS = 7          # FR-5.6：备份保留 N 份

# T01501（python:S1192）：备份/导出/导入三处反复出现的数据文件名，提取为常量。
F_PERT_DB = "pert.db"                        # PERT 三点估算库
F_ESTIMATION_DB = "estimation.db"            # M1 估算历史库
F_RECOGNITION_RULES = "recognition_rules.json"   # 识别规则表
F_RATES_VERSIONS = "rates_versions.json"     # 费率版本表
F_SCHEMA_VER = "schema_ver"                  # schema 版本标记文件
F_CONFIG = "config.json"                     # 配置中心（LLM 地址/开关等；密钥字段另行脱敏）
F_TEMPLATE = "template.xlsx"                 # 内置母版
# 参与备份的数据文件（不含 schema_ver：它随迁移写入，单独处理）
DATA_FILES = (F_PERT_DB, F_ESTIMATION_DB, F_RECOGNITION_RULES, F_RATES_VERSIONS)
# AC-39：升级回滚要同时恢复「数据 + 配置 + schema 版本」。
# 旧版 backup_on_start 只备 4 个数据文件，配置损坏后无法回退，因此单列备份集；
# 导出/导入仍沿用 EXPORT_FILES，避免改变既有数据包格式。
BACKUP_FILES = DATA_FILES + (F_CONFIG, F_TEMPLATE, F_SCHEMA_VER)
# 参与导出的数据文件 = 备份集 + schema_ver
EXPORT_FILES = DATA_FILES + (F_SCHEMA_VER,)
F_BACKUP_MANIFEST = "backup.json"

# 迁移登记表：{from_ver: 升级函数(data_dir)->None}，逐级幂等执行
def _m_pert_gen_naming(data_dir):
    """v1→v2（T01573）：pert.db projects 增加 doc_name / gen_count。
    成品表命名需记住需求导入的文档基名并按项目自增版本（V1、V2…）。
    幂等：先查 PRAGMA table_info，缺列才 ALTER；老库无 pert.db 时跳过。"""
    db = os.path.join(data_dir, F_PERT_DB)
    if not os.path.exists(db):
        return
    con = sqlite3.connect(db, timeout=15)
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(projects)")}
        if "doc_name" not in cols:
            con.execute("ALTER TABLE projects ADD COLUMN doc_name TEXT DEFAULT ''")
        if "gen_count" not in cols:
            con.execute("ALTER TABLE projects ADD COLUMN gen_count INTEGER DEFAULT 0")
        con.commit()
    finally:
        con.close()


MIGRATIONS = {1: _m_pert_gen_naming}


def _migrate(data_dir):
    ver_path = os.path.join(data_dir, F_SCHEMA_VER)
    cur = 1
    if os.path.exists(ver_path):
        try:
            cur = int(open(ver_path, encoding="utf-8").read().strip() or 1)
        except Exception:
            cur = 1
    applied = []
    while cur in MIGRATIONS:
        fn = MIGRATIONS[cur]
        try:
            fn(data_dir)
            applied.append(cur)
        except Exception:
            break                                   # 迁移失败不阻塞启动
        cur += 1
    if applied:
        try:
            with open(ver_path, "w", encoding="utf-8") as f:
                f.write(str(cur))
        except Exception:
            pass
    elif not os.path.exists(ver_path):
        try:
            with open(ver_path, "w", encoding="utf-8") as f:
                f.write(str(SCHEMA_VER))
        except Exception:
            pass
    return cur, applied


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def backup_on_start(data_dir, keep=KEEP_BACKUPS, reason="startup"):
    """FR-5.6 / AC-39：启动时备份数据+配置到 backups/<ts>/，保留最近 keep 份。

    备份清单记录每个文件是否存在于升级前、大小与 sha256，回滚据此做
    「有则还原、无则删除」的精确恢复，而不是只挑存在文件覆盖。
    """
    files = [n for n in BACKUP_FILES if os.path.exists(os.path.join(data_dir, n))]
    if not files:
        return None
    ts = time.strftime("%Y%m%d-%H%M%S")
    dst = os.path.join(data_dir, "backups", ts)
    n = 1
    while os.path.exists(dst):
        dst = os.path.join(data_dir, "backups", f"{ts}-{n}")
        n += 1
    os.makedirs(dst, exist_ok=True)
    manifest = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "reason": reason,
                "schema_ver": None, "files": {}}
    for fname in BACKUP_FILES:
        src = os.path.join(data_dir, fname)
        item = {"exists": os.path.exists(src)}
        if item["exists"]:
            try:
                item["size"] = os.path.getsize(src)
                item["sha256"] = _sha256(src)
                shutil.copy2(src, os.path.join(dst, fname))
            except Exception as e:
                item["error"] = f"{type(e).__name__}: {e}"
        manifest["files"][fname] = item
    ver_path = os.path.join(data_dir, F_SCHEMA_VER)
    if os.path.exists(ver_path):
        try:
            manifest["schema_ver"] = int(open(ver_path, encoding="utf-8").read().strip() or 1)
        except Exception:
            manifest["schema_ver"] = None
    try:
        with open(os.path.join(dst, F_BACKUP_MANIFEST), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
    except Exception:
        pass
    root = os.path.join(data_dir, "backups")
    olds = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
    for d in olds[:-keep]:
        try:
            shutil.rmtree(os.path.join(root, d))
        except Exception:
            pass
    return dst


def list_backups(data_dir):
    """按时间倒序列出可用备份，供回滚 CLI / 支持工单选择。"""
    root = os.path.join(data_dir, "backups")
    if not os.path.isdir(root):
        return []
    out = []
    for name in sorted(os.listdir(root), reverse=True):
        d = os.path.join(root, name)
        if not os.path.isdir(d):
            continue
        manifest = {}
        try:
            mp = os.path.join(d, F_BACKUP_MANIFEST)
            if os.path.exists(mp):
                manifest = json.load(open(mp, encoding="utf-8"))
        except Exception:
            manifest = {}
        try:
            mtime = os.path.getmtime(d)
        except Exception:
            mtime = 0
        out.append({"id": name, "path": d,
                    "created_at": manifest.get("created_at", ""),
                    "reason": manifest.get("reason", ""),
                    "schema_ver": manifest.get("schema_ver"),
                    "files": len(manifest.get("files", {})),
                    "mtime": mtime})
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def _rollback_log(data_dir, record):
    """AC-39「日志完整」：回滚过程单独落 logs/rollback.jsonl，失败也不吞。"""
    try:
        log_dir = os.path.join(data_dir, "logs")
        os.makedirs(log_dir, exist_ok=True)
        record = dict(record)
        record.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S"))
        with open(os.path.join(log_dir, "rollback.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def restore_backup(data_dir, backup_id=None):
    """AC-39：把最近一次（或指定）备份精确恢复到 data_dir。

    - 清单中 exists=True 的文件：校验哈希后原子替换；
    - exists=False 的文件：若升级过程新生成，则删除，恢复升级前状态；
    - 每步写 logs/rollback.jsonl，返回结构化结果供验收断言。
    """
    backups = list_backups(data_dir)
    if not backups:
        raise VImportErr("没有可用备份，无法回滚")
    if backup_id:
        matched = [b for b in backups if b["id"] == backup_id]
        if not matched:
            raise VImportErr(f"备份不存在：{backup_id}")
        chosen = matched[0]
    else:
        chosen = backups[0]
    src_dir = chosen["path"]
    if os.path.abspath(src_dir) == os.path.abspath(data_dir):
        raise VImportErr("备份目录不合法")
    manifest = {}
    try:
        mp = os.path.join(src_dir, F_BACKUP_MANIFEST)
        if os.path.exists(mp):
            manifest = json.load(open(mp, encoding="utf-8"))
    except Exception:
        manifest = {}
    recorded = manifest.get("files") or {}
    # 兼容旧备份：无清单时按目录内实际文件还原，但不删除任何现有文件
    if not recorded:
        recorded = {n: {"exists": True} for n in BACKUP_FILES if os.path.exists(os.path.join(src_dir, n))}
    restored, removed, skipped = [], [], []
    for fname in BACKUP_FILES:
        info = recorded.get(fname)
        if not info:
            continue
        src = os.path.join(src_dir, fname)
        dst = os.path.join(data_dir, fname)
        if info.get("exists"):
            if not os.path.exists(src):
                skipped.append({"file": fname, "reason": "备份文件缺失"})
                continue
            expected = info.get("sha256")
            if expected and _sha256(src) != expected:
                skipped.append({"file": fname, "reason": "备份哈希不符，拒绝还原"})
                _rollback_log(data_dir, {"backup": chosen["id"], "file": fname,
                                         "action": "restore", "ok": False, "reason": "hash_mismatch"})
                continue
            tmp = dst + ".rollback.tmp"
            try:
                shutil.copy2(src, tmp)
                os.replace(tmp, dst)
                if expected and _sha256(dst) != expected:
                    raise VImportErr(f"{fname} 还原后哈希不一致")
                restored.append(fname)
                _rollback_log(data_dir, {"backup": chosen["id"], "file": fname,
                                         "action": "restore", "ok": True, "sha256": expected})
            except Exception as e:
                try:
                    if os.path.exists(tmp):
                        os.remove(tmp)
                except Exception:
                    pass
                skipped.append({"file": fname, "reason": f"{type(e).__name__}: {e}"})
                _rollback_log(data_dir, {"backup": chosen["id"], "file": fname,
                                         "action": "restore", "ok": False,
                                         "reason": f"{type(e).__name__}: {e}"})
        elif os.path.exists(dst):
            try:
                os.remove(dst)
                removed.append(fname)
                _rollback_log(data_dir, {"backup": chosen["id"], "file": fname,
                                         "action": "remove", "ok": True})
            except Exception as e:
                skipped.append({"file": fname, "reason": f"{type(e).__name__}: {e}"})
    ok = not skipped
    _rollback_log(data_dir, {"backup": chosen["id"], "action": "rollback_done",
                             "ok": ok, "restored": restored, "removed": removed,
                             "skipped": skipped})
    return {"ok": ok, "backup": chosen["id"], "created_at": chosen.get("created_at"),
            "restored": restored, "removed": removed, "skipped": skipped}


def export_zip(data_dir, out_path):
    """FR-5.6：导出全部数据（pert.db + json + schema_ver），不含 uploads/generated。"""
    names = [n for n in EXPORT_FILES if os.path.exists(os.path.join(data_dir, n))]
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            z.write(os.path.join(data_dir, n), n)
    return names


def import_zip(zip_path, data_dir):
    """FR-5.6：导入全部数据。校验 schema_ver 不高于当前（防降级/损坏）；导入前先自动备份一份。"""
    bad = zipfile.BadZipFile
    try:
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            if F_PERT_DB not in names:
                raise VImportErr(f"缺少 {F_PERT_DB}，不是有效的数据包")
            if F_SCHEMA_VER in names:
                try:
                    pkg_ver = int(z.read(F_SCHEMA_VER).decode().strip() or 1)
                except Exception:
                    pkg_ver = 1
                if pkg_ver > SCHEMA_VER:
                    raise VImportErr(f"数据包 schema 版本 {pkg_ver} 高于当前 {SCHEMA_VER}，请先升级应用")
            backup_on_start(data_dir, keep=3)      # 导入前自动留档
            for n in (F_PERT_DB, F_RECOGNITION_RULES, F_RATES_VERSIONS, F_SCHEMA_VER):
                if n in names:
                    z.extract(n, data_dir)
            return names
    except bad:
        raise VImportErr("不是有效的 zip 数据包")
    except VImportErr:
        raise
    except Exception as e:
        raise VImportErr(f"导入失败：{e}")


class VImportErr(Exception):
    pass
