# -*- coding: utf-8 -*-
"""T06199 / REQ-021 / AC-25 / AC-28 / AC-29：本地工作组 RBAC、SSO 与审计。

设计边界：
- 单机版不创建/不启用本模块的权限面；服务端只在 deployment=workgroup 时调用。
- 用户、会话、审计落在独立 ``rbac.db``，不混入 estimation/pert/workflow 数据。
- 密码 PBKDF2-SHA256；会话令牌只落 SHA-256 摘要，Cookie 中保存原始随机令牌。
- 越权检查与拒绝审计在同一个入口收敛，避免某个端点漏记。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

COOKIE_NAME = "we_rbac"
SESSION_HOURS = 12
MAX_AUDIT_ROWS = 2000
PASSWORD_MIN = 8
PASSWORD_MAX = 128
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{2,40}$")
SSO_STATE_TTL = 600
HTTP_TIMEOUT = 10
# T06201 / AC-27：last_seen_at 是会话活跃度展示字段，不必每个请求都落盘。
# 20 并发下逐请求 UPDATE+commit 会把 RBAC 全局锁排成 fsync 队列；按令牌节流到 60s。
SESSION_TOUCH_SECONDS = 60.0

P_APP = "app.use"
P_EST_READ = "estimate.read"
P_EST_CREATE = "estimate.create"
P_EST_WRITE = "estimate.write"
P_PROJ_READ = "project.read"
P_PROJ_WRITE = "project.write"
P_PROJ_SIGN = "project.sign"
P_SET_READ = "settings.read"
P_SET_WRITE = "settings.write"
P_USER = "user.manage"
P_AUDIT_READ = "audit.read"
P_AUDIT_EXPORT = "audit.export"
P_DATA = "data.manage"

PERMISSIONS = [
    (P_APP, "使用应用"),
    (P_EST_READ, "查看估算与历史"),
    (P_EST_CREATE, "创建估算/识别文档"),
    (P_EST_WRITE, "编辑估算与配置估算数据"),
    (P_PROJ_READ, "查看项目与签收轨迹"),
    (P_PROJ_WRITE, "提交/驳回/修订项目"),
    (P_PROJ_SIGN, "签收项目与导出签收报告"),
    (P_SET_READ, "查看系统配置"),
    (P_SET_WRITE, "修改系统配置"),
    (P_USER, "管理用户与角色"),
    (P_AUDIT_READ, "查看审计日志"),
    (P_AUDIT_EXPORT, "导出审计包/分享包"),
    (P_DATA, "导入导出全量数据"),
]
PERMISSION_MAP = dict(PERMISSIONS)
ALL_PERMISSIONS = [code for code, _ in PERMISSIONS]

ROLE_DEFS = {
    "admin": {
        "label": "管理员",
        "permissions": ALL_PERMISSIONS,
    },
    "manager": {
        "label": "项目经理",
        "permissions": [P_APP, P_EST_READ, P_EST_CREATE, P_EST_WRITE, P_PROJ_READ, P_PROJ_WRITE,
                        P_PROJ_SIGN, P_SET_READ, P_SET_WRITE, P_AUDIT_READ, P_AUDIT_EXPORT],
    },
    "evaluator": {
        "label": "评估师",
        "permissions": [P_APP, P_EST_READ, P_EST_CREATE, P_EST_WRITE, P_PROJ_READ],
    },
    "reviewer": {
        "label": "评审人",
        "permissions": [P_APP, P_EST_READ, P_PROJ_READ, P_PROJ_WRITE, P_PROJ_SIGN,
                        P_AUDIT_READ, P_AUDIT_EXPORT],
    },
    "viewer": {
        "label": "只读成员",
        "permissions": [P_APP, P_EST_READ],
    },
}


class RbacError(Exception):
    """带 HTTP 语义的 RBAC/SSO 错误。"""

    def __init__(self, code, message, status=400, extra=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}


class SsoError(RbacError):
    """SSO 失败必须可回退管理员账号（AC-29）。"""

    def __init__(self, code, message, status=400, extra=None):
        super().__init__(code, message, status, {"fallback": "admin", **(extra or {})})


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def _parse_iso(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def _hash_token(token):
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _hash_password(password):
    salt = secrets.token_bytes(16)
    iterations = 210000
    digest = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def _verify_password(password, stored):
    try:
        algo, iterations, salt_hex, digest_hex = str(stored or "").split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", str(password).encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def _sanitize_username(value):
    raw = str(value or "").strip()
    if USERNAME_RE.fullmatch(raw):
        return raw
    cleaned = re.sub(r"[^A-Za-z0-9_.@-]", "", raw)[:40]
    return cleaned if len(cleaned) >= 2 else ""


def _display_name(value, fallback):
    text = str(value or "").strip()
    return text[:60] if text else fallback


class RbacStore:
    """线程安全的本地 RBAC 存储；所有公开方法自行开关连接。"""

    def __init__(self, db_path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._touch_lock = threading.Lock()
        self._touch_at = {}
        self._init()

    # ---------- 基础设施 ----------
    def _connect(self):
        con = sqlite3.connect(str(self.db_path), timeout=15)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("PRAGMA busy_timeout=15000")
        con.execute("PRAGMA synchronous=NORMAL")
        return con

    def _due_touch(self, token_hash):
        """同一会话最多每 SESSION_TOUCH_SECONDS 落一次 last_seen_at。"""
        now = time.monotonic()
        with self._touch_lock:
            last = self._touch_at.get(token_hash, 0.0)
            if now - last < SESSION_TOUCH_SECONDS:
                return False
            self._touch_at[token_hash] = now
            # 防止会话表长期增长时缓存无界；超出 2 万时清理最旧一半。
            if len(self._touch_at) > 20000:
                cutoff = now - SESSION_TOUCH_SECONDS
                self._touch_at = {k: v for k, v in self._touch_at.items() if v >= cutoff}
            return True

    def _init(self):
        with self._lock, self._connect() as con:
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA busy_timeout=15000")
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS users(
                  id TEXT PRIMARY KEY,
                  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                  display_name TEXT NOT NULL DEFAULT '',
                  role TEXT NOT NULL DEFAULT 'viewer',
                  password_hash TEXT NOT NULL DEFAULT '',
                  status TEXT NOT NULL DEFAULT 'active',
                  sso_subject TEXT,
                  email TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  created_by TEXT NOT NULL DEFAULT '',
                  last_login_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS ux_users_sso
                  ON users(sso_subject) WHERE sso_subject IS NOT NULL AND sso_subject <> '';
                CREATE TABLE IF NOT EXISTS sessions(
                  token_hash TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  last_seen_at TEXT NOT NULL,
                  ip TEXT NOT NULL DEFAULT '',
                  user_agent TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS audit(
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  at TEXT NOT NULL,
                  actor_id TEXT NOT NULL DEFAULT '',
                  actor_name TEXT NOT NULL DEFAULT '',
                  action TEXT NOT NULL,
                  result TEXT NOT NULL,
                  permission TEXT NOT NULL DEFAULT '',
                  object_type TEXT NOT NULL DEFAULT '',
                  object_id TEXT NOT NULL DEFAULT '',
                  ip TEXT NOT NULL DEFAULT '',
                  detail TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS ix_audit_at ON audit(at);
                CREATE TABLE IF NOT EXISTS sso_states(
                  state_hash TEXT PRIMARY KEY,
                  created_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  redirect_after TEXT NOT NULL DEFAULT '/'
                );
                """
            )

    # ---------- 账号与会话 ----------
    def user_count(self):
        with self._lock, self._connect() as con:
            return int(con.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])

    def bootstrap_required(self):
        return self.user_count() == 0

    def bootstrap(self, username, password, display_name="", ip="", actor_name="本机初始化"):
        """首次启用工作组时创建唯一管理员；只允许空库执行一次。"""
        username = str(username or "").strip()
        if not USERNAME_RE.fullmatch(username):
            raise RbacError("INVALID_USERNAME", "用户名需为 2–40 位字母、数字或 _ . @ -")
        self._validate_password(password)
        with self._lock, self._connect() as con:
            if con.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]:
                raise RbacError("BOOTSTRAP_CLOSED", "管理员已初始化，请使用登录", 409)
            uid = uuid.uuid4().hex
            now = _iso(_now())
            con.execute(
                "INSERT INTO users(id,username,display_name,role,password_hash,status,created_at,updated_at,created_by) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (uid, username, _display_name(display_name, username), "admin",
                 _hash_password(password), "active", now, now, "bootstrap"),
            )
            con.commit()
        self.record(uid, username, "bootstrap", "success", "", "user", uid, ip, "首次创建管理员")
        token, user = self._new_session(username, password, ip, "bootstrap")
        return {"token": token, "user": user}

    @staticmethod
    def _validate_password(password):
        text = str(password or "")
        if len(text) < PASSWORD_MIN:
            raise RbacError("WEAK_PASSWORD", f"密码至少 {PASSWORD_MIN} 位")
        if len(text) > PASSWORD_MAX:
            raise RbacError("PASSWORD_TOO_LONG", f"密码不能超过 {PASSWORD_MAX} 位")
        return text

    def _new_session(self, username, password, ip="", user_agent=""):
        with self._lock, self._connect() as con:
            row = con.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
            if not row or row["status"] != "active":
                self._audit_failed_login(username, ip, "账号不存在或已停用")
                raise RbacError("LOGIN_FAILED", "用户名或密码错误", 401)
            if not _verify_password(password, row["password_hash"]):
                self._audit_failed_login(username, ip, "密码错误")
                raise RbacError("LOGIN_FAILED", "用户名或密码错误", 401)
            token = secrets.token_urlsafe(32)
            now = _now()
            con.execute(
                "INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at,ip,user_agent) "
                "VALUES(?,?,?,?,?,?,?)",
                (_hash_token(token), row["id"], _iso(now),
                 _iso(now + timedelta(hours=SESSION_HOURS)), _iso(now), str(ip or "")[:64],
                 str(user_agent or "")[:240]),
            )
            con.execute("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?",
                        (_iso(now), _iso(now), row["id"]))
            con.commit()
            self.record(row["id"], row["display_name"] or row["username"], "login", "success",
                        "", "session", "", ip, "用户名密码登录")
            return token, self._user_by_id(row["id"], con=con)

    def _audit_failed_login(self, username, ip, detail):
        self.record("", str(username or "匿名")[:60], "login", "deny", "", "session", "", ip, detail)

    def login(self, username, password, ip="", user_agent=""):
        token, user = self._new_session(username, password, ip, user_agent)
        return {"token": token, "user": user}

    def _user_by_id(self, uid, con=None, token=None):
        own = con is None
        if own:
            con = self._connect()
        try:
            row = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not row:
                return None
            perms = permissions_for(row["role"])
            return {
                "id": row["id"],
                "username": row["username"],
                "display_name": row["display_name"],
                "role": row["role"],
                "role_label": role_label(row["role"]),
                "status": row["status"],
                "email": row["email"],
                "permissions": perms,
                "last_login_at": row["last_login_at"],
                "token": token or "",
            }
        finally:
            if own:
                con.close()

    def session(self, token, ip="", user_agent="", touch=True):
        if not token:
            return None
        token_hash = _hash_token(token)
        with self._lock, self._connect() as con:
            row = con.execute(
                "SELECT s.*,u.id AS uid FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
                (token_hash,),
            ).fetchone()
            if not row:
                return None
            expires = _parse_iso(row["expires_at"])
            if not expires or expires <= _now():
                con.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
                con.commit()
                return None
            user = self._user_by_id(row["uid"], con=con)
            if not user or user.get("status") != "active":
                con.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
                con.commit()
                return None
            if touch and self._due_touch(token_hash):
                con.execute("UPDATE sessions SET last_seen_at=?,ip=?,user_agent=? WHERE token_hash=?",
                            (_iso(_now()), str(ip or "")[:64], str(user_agent or "")[:240], token_hash))
                con.commit()
            return user

    def logout(self, token, ip=""):
        if not token:
            return False
        token_hash = _hash_token(token)
        with self._lock, self._connect() as con:
            user = self.session(token, ip=ip, touch=False)
            if user is None:
                return False
            con.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
            con.commit()
        with self._touch_lock:
            self._touch_at.pop(token_hash, None)
        self.record(user["id"], user["display_name"] or user["username"], "logout", "success",
                    "", "session", "", ip, "")
        return True

    def authorize(self, token, permission, object_type="", object_id="", ip="", method="", path=""):
        """统一权限闸门：失败时写审计并抛 RbacError；成功返回用户。"""
        user = self.session(token, ip=ip)
        if not user:
            self.record("", "匿名", "access", "deny", permission, object_type, object_id, ip,
                        f"{method} {path}".strip())
            raise RbacError("UNAUTHORIZED", "请先登录", 401)
        if not has_permission(user["role"], permission):
            self.record(user["id"], user["display_name"] or user["username"], "access", "deny",
                        permission, object_type, object_id, ip, f"{method} {path}".strip())
            raise RbacError("PERMISSION_DENIED", "权限不足，已拒绝访问并记录审计", 403,
                            {"permission": permission})
        return user

    # ---------- 用户管理 ----------
    def list_users(self):
        with self._lock, self._connect() as con:
            rows = con.execute("SELECT * FROM users ORDER BY created_at,username").fetchall()
            return [{
                "id": r["id"], "username": r["username"], "display_name": r["display_name"],
                "role": r["role"], "role_label": role_label(r["role"]), "status": r["status"],
                "email": r["email"], "created_at": r["created_at"],
                "last_login_at": r["last_login_at"], "sso": bool(r["sso_subject"]),
            } for r in rows]

    def create_user(self, actor, username, password, display_name="", role="viewer", ip=""):
        username = str(username or "").strip()
        if not USERNAME_RE.fullmatch(username):
            raise RbacError("INVALID_USERNAME", "用户名需为 2–40 位字母、数字或 _ . @ -")
        self._validate_password(password)
        if role not in ROLE_DEFS:
            raise RbacError("INVALID_ROLE", "角色不存在")
        with self._lock, self._connect() as con:
            dup = con.execute("SELECT 1 FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
            if dup:
                raise RbacError("USERNAME_TAKEN", "用户名已存在", 409)
            uid = uuid.uuid4().hex
            now = _iso(_now())
            con.execute(
                "INSERT INTO users(id,username,display_name,role,password_hash,status,created_at,updated_at,created_by) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (uid, username, _display_name(display_name, username), role,
                 _hash_password(password), "active", now, now,
                 (actor or {}).get("id", "")),
            )
            con.commit()
        self.record((actor or {}).get("id", ""), (actor or {}).get("display_name", "管理员"),
                    "user_create", "success", P_USER, "user", uid, ip,
                    f"username={username} role={role}")
        return self._user_by_id(uid)

    def update_user(self, actor, user_id, role=None, status=None, display_name=None, ip=""):
        with self._lock, self._connect() as con:
            row = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            if not row:
                raise RbacError("USER_NOT_FOUND", "用户不存在", 404)
            if row["role"] == "admin" and ((role and role != "admin") or (status and status != "active")):
                admin_count = con.execute(
                    "SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'").fetchone()["c"]
                if int(admin_count) <= 1:
                    raise RbacError("LAST_ADMIN", "不能停用或降级唯一启用中的管理员", 409)
            sets, args = [], []
            if role is not None:
                if role not in ROLE_DEFS:
                    raise RbacError("INVALID_ROLE", "角色不存在")
                sets.append("role=?")
                args.append(role)
            if status is not None:
                if status not in ("active", "disabled"):
                    raise RbacError("INVALID_STATUS", "状态非法")
                sets.append("status=?")
                args.append(status)
            if display_name is not None:
                sets.append("display_name=?")
                args.append(_display_name(display_name, row["username"]))
            if not sets:
                raise RbacError("NO_CHANGE", "没有可更新的字段")
            sets.append("updated_at=?")
            args.append(_iso(_now()))
            con.execute("UPDATE users SET " + ",".join(sets) + " WHERE id=?", (*args, user_id))
            if status == "disabled":
                con.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
            con.commit()
            updated = con.execute("SELECT role,status FROM users WHERE id=?", (user_id,)).fetchone()
        action = "user_update"
        detail = f"role={updated['role']} status={updated['status']}"
        self.record((actor or {}).get("id", ""), (actor or {}).get("display_name", "管理员"),
                    action, "success", P_USER, "user", user_id, ip, detail)
        return self._user_by_id(user_id)

    # ---------- 审计 ----------
    def record(self, actor_id, actor_name, action, result, permission="", object_type="",
               object_id="", ip="", detail=""):
        with self._lock, self._connect() as con:
            con.execute(
                "INSERT INTO audit(at,actor_id,actor_name,action,result,permission,object_type,object_id,ip,detail) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (_iso(_now()), str(actor_id or "")[:64], str(actor_name or "匿名")[:60],
                 str(action or "")[:64], str(result or "")[:16], str(permission or "")[:64],
                 str(object_type or "")[:32], str(object_id or "")[:96], str(ip or "")[:64],
                 str(detail or "")[:500]),
            )
            # 只保留最近一段，避免日志无限膨胀；导出/合规需要更久时由备份承接。
            total = con.execute("SELECT COUNT(*) AS c FROM audit").fetchone()["c"]
            if int(total) > MAX_AUDIT_ROWS:
                con.execute("DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY id ASC LIMIT ?)",
                            (int(total) - MAX_AUDIT_ROWS,))
            con.commit()

    def list_audit(self, limit=100, result=None):
        limit = max(1, min(500, int(limit or 100)))
        with self._lock, self._connect() as con:
            if result in ("allow", "deny", "success", "fail"):
                rows = con.execute(
                    "SELECT * FROM audit WHERE result=? ORDER BY id DESC LIMIT ?", (result, limit)).fetchall()
            else:
                rows = con.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
            return [{
                "id": r["id"], "at": r["at"], "actor_name": r["actor_name"], "action": r["action"],
                "result": r["result"], "permission": r["permission"],
                "object_type": r["object_type"], "object_id": r["object_id"],
                "ip": r["ip"], "detail": r["detail"],
            } for r in rows]

    # ---------- 矩阵 ----------
    @staticmethod
    def matrix():
        return {
            "roles": [{"code": code, "label": meta["label"], "permissions": list(meta["permissions"])}
                      for code, meta in ROLE_DEFS.items()],
            "permissions": [{"code": code, "label": label} for code, label in PERMISSIONS],
        }

    # ---------- SSO ----------
    def create_sso_state(self, redirect_after="/"):
        raw = secrets.token_urlsafe(32)
        now = _now()
        safe_redirect = str(redirect_after or "/")
        if not safe_redirect.startswith("/") or safe_redirect.startswith("//"):
            safe_redirect = "/"
        with self._lock, self._connect() as con:
            con.execute("DELETE FROM sso_states WHERE expires_at<=?", (_iso(now),))
            con.execute("INSERT INTO sso_states(state_hash,created_at,expires_at,redirect_after) VALUES(?,?,?,?)",
                        (_hash_token(raw), _iso(now), _iso(now + timedelta(seconds=SSO_STATE_TTL)),
                         safe_redirect[:240]))
            con.commit()
        return raw, safe_redirect

    def consume_sso_state(self, state):
        if not state:
            raise SsoError("SSO_BAD_STATE", "SSO 状态缺失，请重新发起登录")
        h = _hash_token(state)
        with self._lock, self._connect() as con:
            row = con.execute("SELECT * FROM sso_states WHERE state_hash=?", (h,)).fetchone()
            if not row:
                raise SsoError("SSO_BAD_STATE", "SSO 状态无效或已使用，请重新发起登录")
            con.execute("DELETE FROM sso_states WHERE state_hash=?", (h,))
            con.commit()
            expires = _parse_iso(row["expires_at"])
            if not expires or expires <= _now():
                raise SsoError("SSO_STATE_EXPIRED", "SSO 登录超时，请重试")
            return row["redirect_after"]

    def sso_login(self, userinfo, provider, auto_provision=True, default_role="viewer", ip=""):
        subject = str(userinfo.get("sub") or userinfo.get("id") or userinfo.get("email")
                      or userinfo.get("preferred_username") or "").strip()
        if not subject:
            raise SsoError("SSO_NO_SUBJECT", "SSO 未返回用户标识")
        display = _display_name(userinfo.get("name") or userinfo.get("display_name"),
                                userinfo.get("preferred_username") or subject)
        email = str(userinfo.get("email") or "")[:120]
        with self._lock, self._connect() as con:
            row = con.execute("SELECT * FROM users WHERE sso_subject=?", (subject,)).fetchone()
            created = False
            if row and row["status"] != "active":
                raise SsoError("SSO_USER_DISABLED", "SSO 用户已停用，请联系管理员", 403)
            if not row:
                if not auto_provision:
                    raise SsoError("SSO_USER_UNKNOWN", "SSO 用户未开通，请联系管理员", 403)
                if default_role not in ROLE_DEFS or default_role == "admin":
                    raise SsoError("SSO_ROLE_INVALID", "SSO 默认角色配置非法", 500)
                base = _sanitize_username(userinfo.get("preferred_username") or email.split("@")[0] or subject)
                if not base:
                    base = "sso_" + hashlib.sha256(subject.encode("utf-8")).hexdigest()[:10]
                username, n = base, 1
                while con.execute("SELECT 1 FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone():
                    n += 1
                    username = f"{base[:32]}_{n}"
                uid = uuid.uuid4().hex
                now = _iso(_now())
                con.execute(
                    "INSERT INTO users(id,username,display_name,role,password_hash,status,sso_subject,email,created_at,updated_at,created_by) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (uid, username, display, default_role, "", "active", subject, email, now, now, "sso"),
                )
                con.commit()
                row = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                created = True
                self.record(uid, display, "sso_provision", "success", P_USER, "user", uid, ip,
                            f"provider={provider} role={default_role}")
            token = secrets.token_urlsafe(32)
            now = _now()
            con.execute(
                "INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at,ip,user_agent) "
                "VALUES(?,?,?,?,?,?,?)",
                (_hash_token(token), row["id"], _iso(now), _iso(now + timedelta(hours=SESSION_HOURS)),
                 _iso(now), str(ip or "")[:64], "sso"),
            )
            con.execute("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?",
                        (_iso(now), _iso(now), row["id"]))
            con.commit()
        self.record(row["id"], row["display_name"] or row["username"], "sso_login", "success",
                    "", "session", "", ip, f"provider={provider} provision={int(created)}")
        return {"token": token, "user": self._user_by_id(row["id"]), "created": created}


def role_label(code):
    return (ROLE_DEFS.get(code) or {}).get("label", str(code or ""))


def permissions_for(role):
    meta = ROLE_DEFS.get(role)
    if not meta:
        return []
    return list(meta["permissions"])


def has_permission(role, permission):
    return permission in permissions_for(role)


def cookie_header(token, max_age=SESSION_HOURS * 3600):
    return (f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={int(max_age)}")


def clear_cookie_header():
    return f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


def token_from_headers(headers):
    """从 Cookie / Authorization / X-Session-Token 提取会话令牌。"""
    cookie = headers.get("Cookie") or ""
    for part in cookie.split(";"):
        key, _, val = part.strip().partition("=")
        if key == COOKIE_NAME and val:
            return val.strip()
    auth = (headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    explicit = (headers.get("X-Session-Token") or "").strip()
    return explicit or ""


def sso_authorize_url(cfg, redirect_uri, state):
    """拼接标准 OIDC 授权 URL；配置不完整时抛 SSO_NOT_CONFIGURED。"""
    if not cfg.get("enabled"):
        raise SsoError("SSO_DISABLED", "SSO 未启用，可回退管理员账号登录")
    required = ("authorize_url", "token_url", "userinfo_url", "client_id")
    missing = [k for k in required if not str(cfg.get(k) or "").strip()]
    if missing:
        raise SsoError("SSO_NOT_CONFIGURED", "SSO 配置不完整，可回退管理员账号登录",
                       extra={"missing": missing})
    parsed = urllib.parse.urlparse(str(cfg["authorize_url"]).strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SsoError("SSO_BAD_URL", "SSO 授权地址非法")
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query.update({
        "response_type": "code",
        "client_id": str(cfg["client_id"]).strip(),
        "redirect_uri": redirect_uri,
        "scope": str(cfg.get("scope") or "openid profile email").strip(),
        "state": state,
    })
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))


def exchange_sso_code(cfg, code, redirect_uri):
    """用授权码换用户信息（OIDC token + userinfo）；所有失败统一成 SsoError。"""
    if not code:
        raise SsoError("SSO_NO_CODE", "SSO 未返回授权码")
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": str(cfg.get("client_id") or ""),
        "client_secret": str(cfg.get("client_secret") or ""),
    }
    try:
        req = urllib.request.Request(
            str(cfg.get("token_url") or ""),
            data=urllib.parse.urlencode(form).encode("utf-8"),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            token_data = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as e:
        raise SsoError("SSO_TOKEN_FAILED", f"SSO 令牌交换失败：{type(e).__name__}", 502)
    access = str((token_data or {}).get("access_token") or "")
    if not access:
        raise SsoError("SSO_NO_TOKEN", "SSO 未返回 access_token", 502)
    userinfo = (token_data or {}).get("userinfo")
    if isinstance(userinfo, dict) and userinfo:
        return userinfo
    try:
        req = urllib.request.Request(
            str(cfg.get("userinfo_url") or ""),
            headers={"Authorization": "Bearer " + access, "Accept": "application/json"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as e:
        raise SsoError("SSO_USERINFO_FAILED", f"SSO 用户信息读取失败：{type(e).__name__}", 502)
    if not isinstance(data, dict):
        raise SsoError("SSO_BAD_USERINFO", "SSO 用户信息格式非法", 502)
    return data
