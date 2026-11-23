# -*- coding: utf-8 -*-
"""估算历史存储（M1 / FR-1.1、1.8、2.5）。

独立库 data/estimation.db（与 pert.db 平级，职责分离）；单表 estimation_history。
线程模型：ThreadingHTTPServer 多线程访问，内部用互斥锁 + 按次短连接，避免跨线程共用连接。
任何异常由调用方降级（历史功能禁用不影响估算主流程）。
"""
import hashlib
import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime

SCHEMA_VER = 2
# T01501（S1192）：diff 参与字段级比较的属性清单，原内联在 diff 方法里
_DIFF_CMP_FIELDS = ("desc", "system", "type", "cx", "reuse", "modify", "count_item")
MAX_ROWS = max(50, int(os.environ.get("WE_HIST_MAX") or 500))          # 保留上限，惰性清理
MAX_ITEMS_BYTES = 1024 * 1024                                          # items_json 体积上限 1MB

_DDL = """
CREATE TABLE IF NOT EXISTS estimation_history (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  title         TEXT NOT NULL,
  source_name   TEXT,
  method        TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  items_json    TEXT NOT NULL,
  summary_json  TEXT,
  sid           TEXT,
  version_group TEXT NOT NULL,
  version_no    INTEGER NOT NULL DEFAULT 1,
  schema_ver    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_hist_created ON estimation_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hist_vgroup  ON estimation_history(version_group, version_no);

-- T06187：稳定功能 ID 映射表。stable_id 全局唯一，只新建不修改；类型变更时新 ID 的 replaces_id 指向旧 ID。
CREATE TABLE IF NOT EXISTS item_id_map (
  stable_id     TEXT PRIMARY KEY,
  version_group TEXT NOT NULL,
  item_key      TEXT NOT NULL,
  item_type     TEXT,
  replaces_id   TEXT,
  created_at    TEXT NOT NULL,
  retired_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_item_map_group ON item_id_map(version_group);

-- T06187：旧数据迁移前的 items_json 备份，供迁移回滚。
CREATE TABLE IF NOT EXISTS history_items_backup (
  history_id  TEXT PRIMARY KEY,
  items_json  TEXT NOT NULL,
  schema_ver  INTEGER,
  backed_up_at TEXT NOT NULL
);

-- T06187：schema 元信息（迁移状态 / 时间）。
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
"""


class HistStore:
    """估算历史存取。insert/get/delete/list/group；线程安全。"""

    def __init__(self, db_path):
        self.db_path = str(db_path)
        self._lock = threading.Lock()
        self._init_schema()

    # ---- 基础 ----
    def _conn(self):
        c = sqlite3.connect(self.db_path, timeout=10)
        c.row_factory = sqlite3.Row
        return c

    def _init_schema(self):
        with self._lock:
            c = self._conn()
            try:
                c.executescript(_DDL)
                c.commit()
            finally:
                c.close()
        self._migrate_legacy_items()

    @staticmethod
    def _now():
        return datetime.now().isoformat(timespec="seconds")

    # ---- T06187：稳定功能 ID ----
    @staticmethod
    def _meta_get(c, key):
        row = c.execute("SELECT value FROM schema_meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    @staticmethod
    def _meta_set(c, key, value):
        c.execute("INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)", (key, str(value)))

    @staticmethod
    def _new_id(con):
        """生成全局唯一稳定 ID：F- + 10 位十六进制。"""
        while True:
            sid = "F-" + uuid.uuid4().hex[:10].upper()
            if not con.execute("SELECT 1 FROM item_id_map WHERE stable_id=?", (sid,)).fetchone():
                return sid

    @staticmethod
    def _migrated_id(group, key, seq):
        """旧数据确定性迁移 ID：同组同键同序号跨版本一致。"""
        raw = f"{group}|{key[0]}|{key[1]}|{seq}".encode("utf-8")
        return "F-" + hashlib.sha1(raw).hexdigest()[:10].upper()

    @staticmethod
    def _same_type(a, b):
        return str((a or {}).get("type") or "").strip() == str((b or {}).get("type") or "").strip()

    def _register(self, c, group, sid, key, it, replaces_id=None):
        c.execute(
            "INSERT OR REPLACE INTO item_id_map(stable_id,version_group,item_key,item_type,replaces_id,created_at) "
            "VALUES(?,?,?,?,?,?)",
            (sid, group, json.dumps(key, ensure_ascii=False), it.get("type"),
             replaces_id or it.get("replaces_id") or None, self._now()))

    def _assign_ids(self, c, group, latest_items, items):
        """给本次落库明细分配稳定 ID。

        - 新建组：全部新 ID；
        - 重开修订：优先沿用明细携带的 stable_id；否则按 (desc,system) 匹配上一版本；
        - 同一 stable_id 但 type 变化：新建 ID，并把 replaces_id 指向旧 ID，旧 ID 保留在历史与映射表。
        """
        latest_by_id = {}
        latest_by_key = {}
        is_new_group = latest_items is None
        for it in (latest_items or []):
            sid = str(it.get("stable_id") or "").strip()
            if sid:
                latest_by_id.setdefault(sid, it)
            latest_by_key.setdefault(self._item_key(it), []).append(it)
        used = set()
        out = []
        for idx, it in enumerate(items or []):
            it = dict(it or {})
            cur = str(it.get("stable_id") or "").strip()
            matched = latest_by_id.get(cur) if (cur and not is_new_group) else None
            if matched is None and not cur and not is_new_group:
                bucket = latest_by_key.get(self._item_key(it)) or []
                for cand in bucket:
                    csid = str(cand.get("stable_id") or "").strip()
                    if csid and csid not in used:
                        matched = cand
                        break
            if matched is not None:
                old_sid = str(matched.get("stable_id") or "").strip()
                if self._same_type(matched, it):
                    sid = old_sid
                    replaces = None
                else:
                    sid = self._new_id(c)
                    replaces = old_sid
                used.add(old_sid)
            elif (not is_new_group) and cur and c.execute("SELECT 1 FROM item_id_map WHERE stable_id=?", (cur,)).fetchone():
                # 历史明细带 ID 但上一版本没有（例如跨组误带）：保留但重新登记
                sid = cur if cur not in used else self._new_id(c)
                replaces = it.get("replaces_id") or None
                used.add(sid)
            else:
                sid = self._new_id(c)
                replaces = it.get("replaces_id") or None
                used.add(sid)
            it["stable_id"] = sid
            if replaces:
                it["replaces_id"] = replaces
            self._register(c, group, sid, self._item_key(it), it, replaces)
            out.append(it)
        # 同版本内去重：重复 ID 视为脏数据，第二项起重新发号
        seen, fixed = set(), []
        for it in out:
            sid = it["stable_id"]
            if sid in seen:
                sid2 = self._new_id(c)
                it["stable_id"] = sid2
                it["replaces_id"] = sid
                self._register(c, group, sid2, self._item_key(it), it, sid)
                sid = sid2
            seen.add(sid)
            fixed.append(it)
        return fixed

    def _migrate_legacy_items(self, force=False):
        """旧数据首次打开自动补 stable_id；迁移前逐行备份，状态记入 schema_meta。"""
        with self._lock:
            c = self._conn()
            try:
                if self._meta_get(c, "migration_state") == "rolled_back" and not force:
                    return {"migrated": 0, "skipped": "rolled_back"}
                rows = c.execute("SELECT id,version_group,items_json,schema_ver FROM estimation_history").fetchall()
                todo = []
                for r in rows:
                    try:
                        its = json.loads(r["items_json"] or "[]")
                    except Exception:
                        continue
                    if any(not str(it.get("stable_id") or "").strip() for it in its):
                        todo.append((r, its))
                if not todo:
                    return {"migrated": 0, "skipped": "already"}
                started = self._now()
                self._meta_set(c, "migration_started_at", started)
                for r, its in todo:
                    c.execute("INSERT OR IGNORE INTO history_items_backup(history_id,items_json,schema_ver,backed_up_at) "
                              "VALUES(?,?,?,?)", (r["id"], r["items_json"], r["schema_ver"], started))
                    seen, occurrence = {}, {}
                    for idx, it in enumerate(its):
                        k = self._item_key(it)
                        occ = occurrence.get(k, 0)
                        occurrence[k] = occ + 1
                        if str(it.get("stable_id") or "").strip():
                            sid = it["stable_id"]
                            seen[sid] = seen.get(sid, 0) + 1
                            if seen[sid] > 1:
                                sid = self._migrated_id(r["version_group"], k, occ)
                                it["stable_id"] = sid
                        else:
                            sid = self._migrated_id(r["version_group"], k, occ)
                            it["stable_id"] = sid
                        self._register(c, r["version_group"], it["stable_id"], k, it,
                                       it.get("replaces_id"))
                    c.execute("UPDATE estimation_history SET items_json=?,schema_ver=? WHERE id=?",
                              (json.dumps(its, ensure_ascii=False), SCHEMA_VER, r["id"]))
                self._meta_set(c, "migration_state", "migrated")
                self._meta_set(c, "migration_done_at", self._now())
                c.commit()
                return {"migrated": len(todo), "started_at": started}
            finally:
                c.close()

    def migrate_legacy(self):
        """显式重新迁移（回滚后再次执行）。"""
        return self._migrate_legacy_items(force=True)

    def rollback_migration(self):
        """回滚旧数据迁移：恢复备份 items_json，并清掉迁移期间新建的映射；回滚后不再自动迁移。"""
        with self._lock:
            c = self._conn()
            try:
                started = self._meta_get(c, "migration_started_at")
                backups = c.execute("SELECT history_id,items_json,schema_ver FROM history_items_backup").fetchall()
                for b in backups:
                    c.execute("UPDATE estimation_history SET items_json=?,schema_ver=? WHERE id=?",
                              (b["items_json"], b["schema_ver"], b["history_id"]))
                if started:
                    c.execute("DELETE FROM item_id_map WHERE created_at>=?", (started,))
                c.execute("DELETE FROM history_items_backup")
                self._meta_set(c, "migration_state", "rolled_back")
                c.commit()
                return {"ok": True, "restored": len(backups)}
            finally:
                c.close()

    def validate_ids(self):
        """映射表校验：缺失、重复、未知映射、版本组不一致、替换链断裂。"""
        with self._lock:
            c = self._conn()
            try:
                rows = c.execute("SELECT id,version_group,items_json FROM estimation_history").fetchall()
                mapped = {r["stable_id"]: dict(r) for r in
                          c.execute("SELECT stable_id,version_group,replaces_id FROM item_id_map").fetchall()}
                issues, seen_global = [], {}
                item_count = 0
                for r in rows:
                    try:
                        its = json.loads(r["items_json"] or "[]")
                    except Exception:
                        continue
                    local = set()
                    for it in its:
                        item_count += 1
                        sid = str(it.get("stable_id") or "").strip()
                        if not sid:
                            issues.append({"kind": "missing", "history_id": r["id"], "desc": it.get("desc")})
                            continue
                        if sid in local:
                            issues.append({"kind": "duplicate", "history_id": r["id"], "stable_id": sid})
                        local.add(sid)
                        seen_global.setdefault(sid, set()).add(r["version_group"])
                        m = mapped.get(sid)
                        if not m:
                            issues.append({"kind": "unmapped", "history_id": r["id"], "stable_id": sid})
                        elif m["version_group"] != r["version_group"]:
                            issues.append({"kind": "group_mismatch", "history_id": r["id"], "stable_id": sid})
                        rep = it.get("replaces_id")
                        if rep and rep not in mapped:
                            issues.append({"kind": "broken_chain", "history_id": r["id"], "stable_id": sid,
                                           "replaces_id": rep})
                for sid, groups in seen_global.items():
                    if len(groups) > 1:
                        issues.append({"kind": "cross_group", "stable_id": sid, "groups": sorted(groups)})
                return {"ok": not issues, "rows": len(rows), "items": item_count,
                        "mapped": len(mapped), "issues": issues}
            finally:
                c.close()

    # ---- 写 ----
    def insert(self, *, title, method, items, params=None, source_name=None,
               summary=None, sid=None, reopen_group=None):
        """写入一条历史。reopen_group 非空 = 重开修订（沿用组，version_no+1）；否则新建组。
        返回 {"id","version_group","version_no"}。items 超 1MB 抛 ValueError。"""
        params_json = json.dumps(params or {}, ensure_ascii=False)
        summary_json = json.dumps(summary, ensure_ascii=False) if summary is not None else None
        now = self._now()
        with self._lock:
            c = self._conn()
            try:
                if reopen_group:
                    row = c.execute("SELECT MAX(version_no) AS m FROM estimation_history WHERE version_group=?",
                                    (reopen_group,)).fetchone()
                    group, vno = reopen_group, (row["m"] or 0) + 1
                    last = c.execute("SELECT items_json FROM estimation_history WHERE version_group=? "
                                     "ORDER BY version_no DESC LIMIT 1", (group,)).fetchone()
                    latest_items = json.loads(last["items_json"] or "[]") if last else []
                else:
                    group, vno = uuid.uuid4().hex, 1
                    latest_items = None
                items = self._assign_ids(c, group, latest_items, items)
                items_json = json.dumps(items, ensure_ascii=False)
                if len(items_json.encode("utf-8")) > MAX_ITEMS_BYTES:
                    raise ValueError("明细体积超过 1MB，暂不入库（可精简后重试）")
                hid = uuid.uuid4().hex
                c.execute(
                    "INSERT INTO estimation_history (id,created_at,updated_at,title,source_name,method,"
                    "params_json,items_json,summary_json,sid,version_group,version_no,schema_ver) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (hid, now, now, title, source_name, method, params_json, items_json,
                     summary_json, sid, group, vno, SCHEMA_VER))
                # 惰性清理：超出保留上限时删最旧
                n = c.execute("SELECT COUNT(*) AS m FROM estimation_history").fetchone()["m"]
                if n > MAX_ROWS:
                    olds = c.execute("SELECT id FROM estimation_history ORDER BY created_at LIMIT ?",
                                     (n - MAX_ROWS,)).fetchall()
                    c.executemany("DELETE FROM estimation_history WHERE id=?", [(r["id"],) for r in olds])
                c.commit()
                return {"id": hid, "version_group": group, "version_no": vno, "items": items}
            finally:
                c.close()

    def delete(self, hid):
        with self._lock:
            c = self._conn()
            try:
                cur = c.execute("DELETE FROM estimation_history WHERE id=?", (hid,))
                c.commit()
                return cur.rowcount > 0
            finally:
                c.close()

    # ---- 读 ----
    def list(self, query="", limit=50, offset=0):
        limit = max(1, min(int(limit or 50), 200))
        offset = max(0, int(offset or 0))
        with self._lock:
            c = self._conn()
            try:
                like = f"%{query.strip()}%"
                total = c.execute(
                    "SELECT COUNT(*) AS m FROM estimation_history WHERE ?='' OR title LIKE ? OR IFNULL(source_name,'') LIKE ?",
                    (query.strip(), like, like)).fetchone()["m"]
                rows = c.execute(
                    "SELECT id,created_at,updated_at,title,source_name,method,sid,version_group,version_no,"
                    "summary_json FROM estimation_history "
                    "WHERE ?='' OR title LIKE ? OR IFNULL(source_name,'') LIKE ? "
                    "ORDER BY created_at DESC LIMIT ? OFFSET ?",
                    (query.strip(), like, like, limit, offset)).fetchall()
                out = []
                for r in rows:
                    d = dict(r)
                    try:
                        s = json.loads(d.pop("summary_json") or "{}")
                        d["count"] = s.get("count")
                        d["us_total"] = s.get("us_total") or s.get("total_us")
                    except Exception:
                        d["count"] = d["us_total"] = None
                    out.append(d)
                return {"ok": True, "total": total, "rows": out}
            finally:
                c.close()

    def get(self, hid):
        with self._lock:
            c = self._conn()
            try:
                r = c.execute("SELECT * FROM estimation_history WHERE id=?", (hid,)).fetchone()
                if not r:
                    return None
                d = dict(r)
                d["params"] = json.loads(d["params_json"] or "{}")
                d["items"] = json.loads(d["items_json"] or "[]")
                d["summary"] = json.loads(d["summary_json"]) if d["summary_json"] else None
                for k in ("params_json", "items_json", "summary_json"):
                    d.pop(k, None)
                return d
            finally:
                c.close()

    def group(self, hid):
        """按任一历史记录 id 返回其版本组的全部版本（路径参数是记录 id，非组键）。"""
        with self._lock:
            c = self._conn()
            try:
                anchor = c.execute("SELECT version_group FROM estimation_history WHERE id=?", (hid,)).fetchone()
                if not anchor:
                    return {"ok": True, "versions": []}
                rows = c.execute(
                    "SELECT id,version_no,created_at,title,sid,version_group FROM estimation_history "
                    "WHERE version_group=? ORDER BY version_no", (anchor["version_group"],)).fetchall()
                return {"ok": True, "versions": [dict(r) for r in rows]}
            finally:
                c.close()

    @staticmethod
    def _item_key(it):
        """功能点匹配键：描述 + 系统（去空格）。同名重复项由 _index_items 加 #seq 后缀去重。"""
        return (str(it.get("desc") or "").strip(),
                str(it.get("system") or "").strip())

    @classmethod
    def _index_items(cls, items):
        """把明细列表按匹配键建索引；同名仅保留首个，避免重复项炸出多余 removed/added。"""
        m = {}
        for idx, it in enumerate(items or []):
            k = cls._item_key(it)
            if not k[0] and not k[1]:
                k = ("#seq%d" % it.get("seq", idx), "")
            m.setdefault(k, it)
        return m

    @staticmethod
    def _field_changes(ai, bi):
        """逐字段比较两份功能点，返回有差异的字段列表。
        缺失字段与空串等价（统一 None→""），否则 count_item 的 None vs "" 会被误判为变更。"""
        out = []
        for f in _DIFF_CMP_FIELDS:
            av, bv = ai.get(f), bi.get(f)
            av = "" if av is None else av
            bv = "" if bv is None else bv
            if str(av) != str(bv):
                out.append({"field": f, "a": av, "b": bv})
        return out

    def diff(self, a_id, b_id):
        """FR-FE05：任选两历史版本生成 diff。

        T06187：匹配优先级改为 稳定ID → replaces_id（类型变更的新旧 ID）→ (desc,system) 兼容旧数据；
        因此描述改名而 ID 不变时仍判「变更」，类型变更产生的新 ID 也能凭 replaces_id 归为同一条变更。
        返回 added/removed/changed 及字段级变化，并附两侧 summary(count/us_total)。
        """
        a = self.get(a_id)
        if not a:
            return {"ok": False, "msg": "基准版本不存在或已被清理", "which": "a"}
        b = self.get(b_id)
        if not b:
            return {"ok": False, "msg": "对比版本不存在或已被清理", "which": "b"}

        a_items, b_items = list(a.get("items") or []), list(b.get("items") or [])
        a_left, b_left = set(range(len(a_items))), set(range(len(b_items)))
        a_by_id = {}
        for i, it in enumerate(a_items):
            sid = str(it.get("stable_id") or "").strip()
            if sid:
                a_by_id.setdefault(sid, i)
        pairs = []

        def take(j, i):
            if i is None or i not in a_left:
                return False
            a_left.discard(i)
            b_left.discard(j)
            pairs.append((i, j))
            return True

        # 1) stable_id 完全一致
        for j in range(len(b_items)):
            if j not in b_left:
                continue
            sid = str(b_items[j].get("stable_id") or "").strip()
            if sid:
                take(j, a_by_id.get(sid))
        # 2) 类型变更：新 ID 通过 replaces_id 指向旧 ID
        for j in range(len(b_items)):
            if j in b_left:
                rep = str(b_items[j].get("replaces_id") or "").strip()
                if rep:
                    take(j, a_by_id.get(rep))
        # 3) 兼容旧数据：按 (desc,system) 匹配
        a_by_key = {}
        for i in a_left:
            it = a_items[i]
            k = self._item_key(it)
            if not k[0] and not k[1]:
                k = ("#seq%d" % it.get("seq", i), "")
            a_by_key.setdefault(k, []).append(i)
        for j in range(len(b_items)):
            if j not in b_left:
                continue
            it = b_items[j]
            k = self._item_key(it)
            if not k[0] and not k[1]:
                k = ("#seq%d" % it.get("seq", j), "")
            bucket = a_by_key.get(k) or []
            if bucket:
                take(j, bucket.pop(0))

        changes = []
        for j in sorted(b_left):
            it = b_items[j]
            changes.append({"kind": "added", "name": it.get("desc"),
                            "system": it.get("system"), "item": it})
        for i in sorted(a_left):
            it = a_items[i]
            changes.append({"kind": "removed", "name": it.get("desc"),
                            "system": it.get("system"), "item": it})
        for i, j in pairs:
            ai, bi = a_items[i], b_items[j]
            fields = self._field_changes(ai, bi)
            old_sid = str(ai.get("stable_id") or "").strip()
            new_sid = str(bi.get("stable_id") or "").strip()
            if old_sid and new_sid and old_sid != new_sid:
                fields.append({"field": "stable_id", "a": old_sid, "b": new_sid})
            if fields:
                changes.append({"kind": "changed", "name": bi.get("desc"),
                                "system": bi.get("system"), "fields": fields,
                                "a": ai, "b": bi})

        def summ(row):
            s = row.get("summary") or {}
            return {"count": s.get("count"), "us_total": s.get("us_total") or s.get("total_us")}

        return {
            "ok": True,
            "a": {"id": a["id"], "title": a["title"], "version_no": a["version_no"],
                  "created_at": a["created_at"], **summ(a)},
            "b": {"id": b["id"], "title": b["title"], "version_no": b["version_no"],
                  "created_at": b["created_at"], **summ(b)},
            "changes": changes,
            "summary": {
                "added": sum(1 for c in changes if c["kind"] == "added"),
                "removed": sum(1 for c in changes if c["kind"] == "removed"),
                "changed": sum(1 for c in changes if c["kind"] == "changed"),
            },
        }
