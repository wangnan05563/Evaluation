# -*- coding: utf-8 -*-
"""项目状态机与签收（REQ-020 / AC-23 / AC-24）。

独立库 data/workflow.db，按估算版本组（estimation.db.version_group）维护项目状态：
draft（草稿）→ review（评审）→ rejected（驳回）→ review → signed（签收）。
每次状态变更写 workflow_events，事件包含人、时间、对象、意见与版本哈希；
签收时冻结版本快照哈希，签收页按该记录输出签收人 / 时间 / 意见 / 哈希。

设计边界：
- 单机版默认隐藏，由配置中心 deployment.mode=workgroup 启用；
- 只维护状态与审计，不复制估算明细；明细仍以 estimation.db 为唯一事实源；
- 追加新版本自动回到 draft（已签收版本仍可查，但当前版本须重新走评审）。
"""
import hashlib
import json
import sqlite3
import threading
from datetime import datetime

STATUS_DRAFT = "draft"
STATUS_REVIEW = "review"
STATUS_REJECTED = "rejected"
STATUS_SIGNED = "signed"
STATUSES = (STATUS_DRAFT, STATUS_REVIEW, STATUS_REJECTED, STATUS_SIGNED)

ACTION_SUBMIT = "submit_review"
ACTION_REJECT = "reject"
ACTION_REVISE = "revise"
ACTION_SIGN = "sign"
ACTION_WITHDRAW = "withdraw"

# (action, from_status) -> to_status；不在表内即非法流转（包括对 signed 的任何改写）。
TRANSITIONS = {
    (ACTION_SUBMIT, STATUS_DRAFT): STATUS_REVIEW,
    (ACTION_SUBMIT, STATUS_REJECTED): STATUS_REVIEW,
    (ACTION_REJECT, STATUS_REVIEW): STATUS_REJECTED,
    (ACTION_REVISE, STATUS_REJECTED): STATUS_DRAFT,
    (ACTION_REVISE, STATUS_REVIEW): STATUS_DRAFT,
    (ACTION_WITHDRAW, STATUS_REVIEW): STATUS_DRAFT,
    (ACTION_SIGN, STATUS_REVIEW): STATUS_SIGNED,
}
OPINION_REQUIRED = (ACTION_REJECT, ACTION_SIGN)

DDL = """
CREATE TABLE IF NOT EXISTS project_workflow (
  project_id   TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  version_no   INTEGER NOT NULL DEFAULT 1,
  history_id   TEXT,
  version_hash TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  submitted_by TEXT,
  submitted_at TEXT,
  reviewer     TEXT,
  reviewed_at  TEXT,
  signer       TEXT,
  signed_at    TEXT,
  sign_opinion TEXT,
  revision     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workflow_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  at          TEXT NOT NULL,
  action      TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  role        TEXT NOT NULL,
  opinion     TEXT,
  object_ref  TEXT NOT NULL,
  version_no  INTEGER,
  version_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_wf_events_project ON workflow_events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_wf_updated ON project_workflow(updated_at DESC);
"""


class WorkflowError(Exception):
    """业务错误：code 供 API 映射状态码，message 可直接回显。"""

    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


class WorkflowStore:
    def __init__(self, db_path):
        self.db_path = str(db_path)
        self._lock = threading.RLock()
        self._init_schema()
        self._synced = False

    def _conn(self):
        con = sqlite3.connect(self.db_path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        return con

    def _init_schema(self):
        with self._lock:
            con = self._conn()
            try:
                con.executescript(DDL)
                con.commit()
            finally:
                con.close()

    @staticmethod
    def hash_snapshot(*, title, version_no, method, params, items, summary):
        """版本内容哈希：对落库快照做规范化 JSON 的 SHA-256，签收后冻结。"""
        canonical = {
            "title": str(title or ""),
            "version_no": int(version_no or 1),
            "method": str(method or ""),
            "params": params if isinstance(params, dict) else {},
            "items": items if isinstance(items, list) else [],
            "summary": summary if isinstance(summary, dict) else {},
        }
        raw = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def short_hash(value):
        value = str(value or "")
        return value[:16] if value else ""

    def _event(self, con, *, project_id, action, from_status, to_status, actor, role,
               opinion, object_ref, version_no, version_hash, at):
        con.execute(
            "INSERT INTO workflow_events(project_id,at,action,from_status,to_status,actor,role,"
            "opinion,object_ref,version_no,version_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (project_id, at, action, from_status, to_status, str(actor or "系统").strip() or "系统",
             str(role or "系统").strip() or "系统", str(opinion or "").strip(), object_ref,
             int(version_no or 1), str(version_hash or "")),
        )

    def ensure(self, *, project_id, title, version_no, history_id, version_hash):
        """登记/更新项目状态。新版本自动回 draft，并保留旧签收事件供追溯。"""
        project_id = str(project_id or "").strip()
        if not project_id:
            raise WorkflowError("project_required", "缺少项目标识")
        title = str(title or "未命名项目").strip() or "未命名项目"
        vno = max(1, int(version_no or 1))
        with self._lock:
            con = self._conn()
            try:
                row = con.execute("SELECT * FROM project_workflow WHERE project_id=?", (project_id,)).fetchone()
                ts = now_iso()
                if row is None:
                    con.execute(
                        "INSERT INTO project_workflow(project_id,title,status,version_no,history_id,version_hash,"
                        "created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,0)",
                        (project_id, title, STATUS_DRAFT, vno, str(history_id or ""), str(version_hash or ""), ts, ts),
                    )
                    self._event(con, project_id=project_id, action="create", from_status="", to_status=STATUS_DRAFT,
                                actor="系统", role="系统", opinion="首版估算生成，进入草稿",
                                object_ref=f"v{vno} / {history_id or '—'}", version_no=vno,
                                version_hash=version_hash, at=ts)
                elif int(row["version_no"] or 0) < vno or str(row["history_id"] or "") != str(history_id or ""):
                    old_status = str(row["status"] or STATUS_DRAFT)
                    con.execute(
                        "UPDATE project_workflow SET title=?,status=?,version_no=?,history_id=?,version_hash=?,"
                        "updated_at=?,submitted_by=NULL,submitted_at=NULL,reviewer=NULL,reviewed_at=NULL,"
                        "signer=NULL,signed_at=NULL,sign_opinion=NULL WHERE project_id=?",
                        (title, STATUS_DRAFT, vno, str(history_id or ""), str(version_hash or ""), ts, project_id),
                    )
                    self._event(con, project_id=project_id, action="new_version", from_status=old_status,
                                to_status=STATUS_DRAFT, actor="系统", role="系统",
                                opinion=f"新增版本 v{vno}，状态回到草稿", object_ref=f"v{vno} / {history_id or '—'}",
                                version_no=vno, version_hash=version_hash, at=ts)
                else:
                    con.execute("UPDATE project_workflow SET title=?,version_hash=?,updated_at=? WHERE project_id=?",
                                (title, str(version_hash or ""), ts, project_id))
                con.commit()
                return self.get(project_id)
            finally:
                con.close()

    def sync_from_history(self, hist, limit=200):
        """把已有 estimation.db 版本组补登记为草稿项目（幂等，一次进程内只扫一次）。"""
        if self._synced or hist is None:
            return 0
        added = 0
        try:
            rows = hist.list(limit=limit).get("rows") or []
            seen = set()
            for row in rows:
                group = str(row.get("version_group") or "")
                if not group or group in seen:
                    continue
                seen.add(group)
                detail = hist.get(row.get("id"))
                if not detail:
                    continue
                vhash = self.hash_snapshot(title=detail.get("title"), version_no=detail.get("version_no"),
                                           method=detail.get("method"), params=detail.get("params"),
                                           items=detail.get("items"), summary=detail.get("summary"))
                self.ensure(project_id=group, title=detail.get("title"), version_no=detail.get("version_no"),
                            history_id=detail.get("id"), version_hash=vhash)
                added += 1
        finally:
            self._synced = True
        return added

    def list_projects(self):
        with self._lock:
            con = self._conn()
            try:
                rows = con.execute("SELECT * FROM project_workflow ORDER BY updated_at DESC, title").fetchall()
                return [dict(r) for r in rows]
            finally:
                con.close()

    def get(self, project_id):
        with self._lock:
            con = self._conn()
            try:
                row = con.execute("SELECT * FROM project_workflow WHERE project_id=?", (str(project_id),)).fetchone()
                if row is None:
                    return None
                out = dict(row)
                out["events"] = [dict(r) for r in con.execute(
                    "SELECT * FROM workflow_events WHERE project_id=? ORDER BY id", (str(project_id),)).fetchall()]
                out["short_hash"] = self.short_hash(out.get("version_hash"))
                return out
            finally:
                con.close()

    def transition(self, project_id, action, *, actor, role="", opinion="", at=None):
        action = str(action or "").strip()
        actor = str(actor or "").strip()
        role = str(role or "").strip() or "评估师"
        opinion = str(opinion or "").strip()
        if not action:
            raise WorkflowError("action_required", "缺少状态动作")
        if not actor:
            raise WorkflowError("actor_required", "操作人不能为空")
        if action in OPINION_REQUIRED and not opinion:
            raise WorkflowError("opinion_required", "驳回/签收必须填写意见")
        with self._lock:
            con = self._conn()
            try:
                row = con.execute("SELECT * FROM project_workflow WHERE project_id=?", (str(project_id),)).fetchone()
                if row is None:
                    raise WorkflowError("not_found", "项目不存在", 404)
                cur = str(row["status"] or STATUS_DRAFT)
                to = TRANSITIONS.get((action, cur))
                if to is None:
                    raise WorkflowError("invalid_transition", f"状态 {cur} 不允许执行 {action}", 409)
                if action == ACTION_SIGN and not str(row["version_hash"] or "").strip():
                    raise WorkflowError("hash_missing", "版本哈希缺失，不能签收")
                ts = str(at or now_iso())
                fields = {"status": to, "updated_at": ts}
                if action == ACTION_SUBMIT:
                    fields.update(submitted_by=actor, submitted_at=ts)
                elif action == ACTION_REJECT:
                    fields.update(reviewer=actor, reviewed_at=ts)
                elif action == ACTION_REVISE:
                    fields.update(reviewer=None, reviewed_at=None)
                elif action == ACTION_SIGN:
                    fields.update(signer=actor, signed_at=ts, sign_opinion=opinion)
                sets = ",".join(f"{k}=?" for k in fields)
                con.execute(f"UPDATE project_workflow SET {sets} WHERE project_id=?",
                            (*fields.values(), str(project_id)))
                self._event(con, project_id=str(project_id), action=action, from_status=cur, to_status=to,
                            actor=actor, role=role, opinion=opinion,
                            object_ref=f"v{row['version_no']} / {row['history_id'] or '—'}",
                            version_no=row["version_no"], version_hash=row["version_hash"], at=ts)
                con.commit()
                return self.get(str(project_id))
            finally:
                con.close()

    def signoff(self, project_id):
        """返回可直接并入 audit_package payload 的签收段。"""
        detail = self.get(project_id)
        if detail is None:
            raise WorkflowError("not_found", "项目不存在", 404)
        events = detail.get("events") or []
        opinions = [e.get("opinion") for e in events
                    if e.get("action") in (ACTION_REJECT, ACTION_SIGN) and e.get("opinion")]
        status = str(detail.get("status") or STATUS_DRAFT)
        roles = [
            {"role": "评估师", "name": detail.get("submitted_by") or "—",
             "status": "已提交评审" if detail.get("submitted_at") else "待提交", "time": detail.get("submitted_at") or "—"},
            {"role": "审核人", "name": detail.get("reviewer") or "—",
             "status": "已审核" if status in (STATUS_REJECTED, STATUS_SIGNED) else "待审核",
             "time": detail.get("reviewed_at") or "—"},
            {"role": detail.get("signer") and "签收人" or "签收人", "name": detail.get("signer") or "—",
             "status": "已签收" if status == STATUS_SIGNED else "待签收",
             "time": detail.get("signed_at") or "—"},
        ]
        return {
            "status": status,
            "roles": roles,
            "opinions": opinions or ["请核对估算明细与追溯矩阵后签收。"],
            "signer": detail.get("signer") or "",
            "signed_at": detail.get("signed_at") or "",
            "opinion": detail.get("sign_opinion") or "",
            "version_hash": detail.get("version_hash") or "",
            "short_hash": self.short_hash(detail.get("version_hash")),
        }
