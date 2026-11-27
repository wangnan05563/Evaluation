# -*- coding: utf-8 -*-
"""T06200 / REQ-022 / AC-30：外部系统同步（GitHub Issues / Jira / GitLab Issues）。

边界（产品已拍板）：
- 只做本地 → 外部的单向「需求/任务」创建，不回读远端状态，不做状态双向同步。
- 每个连接器保存字段映射；同步失败保留逐条原因，可一键重试。
- 凭据由调用方注入 protect/unprotect（服务端用 DPAPI），本模块不落明文。
"""
import base64
import contextlib
import json
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone


# 重复字面量统一为模块常量（SonarQube python:S1192）
ERR_CONNECTOR_NOT_FOUND = '连接器不存在'

KINDS = {
    "github": {"name": "GitHub Issues", "required": ("repo", "token")},
    "jira": {"name": "Jira", "required": ("base_url", "project_key", "email", "api_token")},
    "gitlab": {"name": "GitLab Issues", "required": ("base_url", "project", "token")},
}
SECRET_FIELDS = ("token", "api_token")
MAPPING_SLOTS = ("title", "body", "priority", "labels")
LOCAL_FIELDS = ("title", "body", "priority", "labels", "acceptance", "component")
DEFAULT_MAPPING = {"title": "title", "body": "body", "priority": "priority", "labels": "labels"}
DEFAULT_TIMEOUT = 12
MAX_ITEMS = 50
MAX_ATTEMPTS = 3
ERROR_LIMIT = 400
BODY_LIMIT = 20000


class IntegrationError(Exception):
    def __init__(self, code, message, status=0, retryable=True):
        super().__init__(message)
        self.code = str(code or "SYNC_FAILED")
        self.message = str(message or "")[:ERROR_LIMIT]
        self.status = int(status or 0)
        self.retryable = bool(retryable)


class Adapter:
    """三个适配器的公共 HTTP 行为；子类只定义端点与载荷。"""
    kind = ""

    def __init__(self, connector, mapping=None):
        self.connector = connector or {}
        self.config = (connector or {}).get("config") or {}
        self.mapping = normalize_mapping(mapping or (connector or {}).get("mapping") or {})
        self.base_url = str(self.config.get("base_url") or "").rstrip("/")

    def _url(self, path):
        if not self.base_url:
            raise IntegrationError("CONFIG", "缺少服务地址 base_url", retryable=False)
        if not (self.base_url.startswith("http://") or self.base_url.startswith("https://")):
            raise IntegrationError("CONFIG", "服务地址必须为 http/https", retryable=False)
        return self.base_url + path

    def _request(self, method, url, headers, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        rq = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(rq, timeout=DEFAULT_TIMEOUT) as resp:
                raw = resp.read().decode("utf-8", "replace")
                try:
                    return resp.status, json.loads(raw) if raw else {}
                except ValueError:
                    return resp.status, {"raw": raw[:ERROR_LIMIT]}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")[:ERROR_LIMIT]
            code = {401: "AUTH_FAILED", 403: "FORBIDDEN", 404: "NOT_FOUND",
                    429: "RATE_LIMITED"}.get(e.code, "HTTP_ERROR")
            raise IntegrationError(code, f"HTTP {e.code}: {raw or e.reason}", e.code,
                                    retryable=e.code >= 500 or e.code == 429) from e
        except urllib.error.URLError as e:
            raise IntegrationError("NETWORK", f"连接失败: {e.reason}", retryable=True) from e
        except Exception as e:
            raise IntegrationError("NETWORK", f"{type(e).__name__}: {e}", retryable=True) from e

    def _headers(self):
        return {"Content-Type": "application/json", "Accept": "application/json"}

    def _missing(self):
        miss = [k for k in KINDS[self.kind]["required"] if not str(self.config.get(k) or "").strip()]
        if miss:
            raise IntegrationError("CONFIG", "缺少配置: " + ", ".join(miss), retryable=False)

    def _value(self, item, slot):
        field = self.mapping.get(slot, slot)
        val = item.get(field)
        return "" if val is None else val

    def _title(self, item):
        title = str(self._value(item, "title") or "").strip()
        if not title:
            raise IntegrationError("ITEM", "缺少标题（检查字段映射 title）", retryable=False)
        return title[:240]

    def _body(self, item):
        body = str(self._value(item, "body") or "")
        return body[:BODY_LIMIT]

    def _labels(self, item):
        val = self._value(item, "labels")
        if isinstance(val, list):
            return [str(x)[:40] for x in val if str(x).strip()][:10]
        if isinstance(val, str) and val.strip():
            return [x.strip()[:40] for x in val.replace("，", ",").split(",") if x.strip()][:10]
        return []

    def test(self):
        raise NotImplementedError

    def create(self, item):
        raise NotImplementedError


class GitHubAdapter(Adapter):
    kind = "github"

    def _headers(self):
        h = super()._headers()
        h["Authorization"] = "Bearer " + str(self.config.get("token") or "")
        h["Accept"] = "application/vnd.github+json"
        h["X-GitHub-Api-Version"] = "2022-11-28"
        return h

    def test(self):
        self._missing()
        repo = urllib.parse.quote(str(self.config.get("repo") or "").strip(), safe="/")
        status, data = self._request("GET", self._url(f"/repos/{repo}"), self._headers())
        return {"detail": f"仓库 {data.get('full_name') or self.config.get('repo')} 可访问", "status": status}

    def create(self, item):
        self._missing()
        repo = urllib.parse.quote(str(self.config.get("repo") or "").strip(), safe="/")
        payload = {"title": self._title(item), "body": self._body(item)}
        labels = self._labels(item)
        if labels:
            payload["labels"] = labels
        status, data = self._request("POST", self._url(f"/repos/{repo}/issues"), self._headers(), payload)
        return {"remote_id": str(data.get("number") or data.get("id") or ""),
                "remote_url": data.get("html_url") or "", "status": status}


class JiraAdapter(Adapter):
    kind = "jira"

    def _headers(self):
        h = super()._headers()
        user = str(self.config.get("email") or "")
        token = str(self.config.get("api_token") or "")
        h["Authorization"] = "Basic " + base64.b64encode(f"{user}:{token}".encode()).decode()
        return h

    def test(self):
        self._missing()
        status, data = self._request("GET", self._url("/rest/api/2/myself"), self._headers())
        return {"detail": f"账号 {data.get('displayName') or data.get('name') or self.config.get('email')} 可访问",
                "status": status}

    def create(self, item):
        self._missing()
        fields = {
            "project": {"key": str(self.config.get("project_key") or "")},
            "issuetype": {"name": str(self.config.get("issue_type") or "Task")},
            "summary": self._title(item),
            "description": self._body(item),
        }
        labels = self._labels(item)
        if labels:
            fields["labels"] = labels
        priority = str(self._value(item, "priority") or "").strip()
        if priority:
            fields["priority"] = {"name": priority}
        status, data = self._request("POST", self._url("/rest/api/2/issue"), self._headers(), {"fields": fields})
        return {"remote_id": str(data.get("key") or data.get("id") or ""),
                "remote_url": (data.get("self") or ""), "status": status}


class GitLabAdapter(Adapter):
    kind = "gitlab"

    def _headers(self):
        h = super()._headers()
        h["PRIVATE-TOKEN"] = str(self.config.get("token") or "")
        return h

    def _project(self):
        return urllib.parse.quote(str(self.config.get("project") or "").strip(), safe="")

    def test(self):
        self._missing()
        status, data = self._request("GET", self._url(f"/api/v4/projects/{self._project()}"), self._headers())
        return {"detail": f"项目 {data.get('path_with_namespace') or self.config.get('project')} 可访问",
                "status": status}

    def create(self, item):
        self._missing()
        payload = {"title": self._title(item), "description": self._body(item)}
        labels = self._labels(item)
        if labels:
            payload["labels"] = ",".join(labels)
        status, data = self._request("POST", self._url(f"/api/v4/projects/{self._project()}/issues"),
                                     self._headers(), payload)
        return {"remote_id": str(data.get("iid") or data.get("id") or ""),
                "remote_url": data.get("web_url") or "", "status": status}


ADAPTERS = {"github": GitHubAdapter, "jira": JiraAdapter, "gitlab": GitLabAdapter}


def build_adapter(kind, connector, mapping=None):
    cls = ADAPTERS.get(kind)
    if not cls:
        raise IntegrationError("CONFIG", f"不支持的集成类型: {kind}", retryable=False)
    return cls(connector, mapping)


def normalize_mapping(mapping):
    out = dict(DEFAULT_MAPPING)
    for slot in MAPPING_SLOTS:
        val = str((mapping or {}).get(slot) or "").strip()
        if val in LOCAL_FIELDS:
            out[slot] = val
    return out


def normalize_items(items):
    if not isinstance(items, list) or not items:
        raise IntegrationError("ITEM", "需要至少一条需求/任务", retryable=False)
    if len(items) > MAX_ITEMS:
        raise IntegrationError("ITEM", f"单次最多 {MAX_ITEMS} 条", retryable=False)
    out = []
    for item in items:
        if not isinstance(item, dict):
            raise IntegrationError("ITEM", "items 必须是对象数组", retryable=False)
        out.append({k: item.get(k) for k in LOCAL_FIELDS if k in item})
    return out


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class IntegrationStore:
    def __init__(self, db_path, protect=None, unprotect=None):
        self.db_path = str(db_path)
        self._protect = protect or (lambda s: s)
        self._unprotect = unprotect or (lambda s: s)
        self._init()

    @contextlib.contextmanager
    def _conn(self):
        con = sqlite3.connect(self.db_path, timeout=10)
        con.row_factory = sqlite3.Row
        try:
            con.execute("PRAGMA foreign_keys=ON")
            yield con
            con.commit()
        finally:
            con.close()

    def _init(self):
        with self._conn() as con:
            con.executescript("""
                CREATE TABLE IF NOT EXISTS connectors(
                  id TEXT PRIMARY KEY, kind TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                  enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}',
                  mapping_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL, last_test_at TEXT, last_test_ok INTEGER,
                  last_test_error TEXT);
                CREATE TABLE IF NOT EXISTS jobs(
                  id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, status TEXT NOT NULL,
                  total INTEGER NOT NULL, succeeded INTEGER NOT NULL, failed INTEGER NOT NULL,
                  attempts INTEGER NOT NULL, error TEXT, errors_json TEXT, payload_json TEXT NOT NULL,
                  retry_of TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_jobs_connector ON jobs(connector_id, created_at DESC);
            """)
            existing = {r["kind"] for r in con.execute("SELECT kind FROM connectors")}
            for kind, meta in KINDS.items():
                if kind not in existing:
                    now = _now()
                    con.execute(
                        "INSERT INTO connectors(id,kind,name,enabled,config_json,mapping_json,created_at,updated_at)"
                        " VALUES(?,?,?,0,'{}',?,?,?)",
                        (str(uuid.uuid4()), kind, meta["name"], json.dumps(DEFAULT_MAPPING), now, now))

    def _decrypt(self, cfg):
        out = dict(cfg or {})
        for key in SECRET_FIELDS:
            if out.get(key):
                try:
                    out[key] = self._unprotect(out[key])
                except Exception:
                    out[key] = ""
        return out

    def _encrypt(self, cfg):
        out = dict(cfg or {})
        for key in SECRET_FIELDS:
            if out.get(key):
                out[key] = self._protect(str(out[key]))
        return out

    def _row(self, row):
        if row is None:
            return None
        cfg = self._decrypt(json.loads(row["config_json"] or "{}"))
        return {
            "id": row["id"], "kind": row["kind"], "name": row["name"],
            "enabled": bool(row["enabled"]), "config": cfg,
            "mapping": normalize_mapping(json.loads(row["mapping_json"] or "{}")),
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            "last_test_at": row["last_test_at"] or "",
            "last_test_ok": None if row["last_test_ok"] is None else bool(row["last_test_ok"]),
            "last_test_error": row["last_test_error"] or "",
        }

    def get(self, kind_or_id):
        with self._conn() as con:
            row = con.execute("SELECT * FROM connectors WHERE id=? OR kind=?",
                              (kind_or_id, kind_or_id)).fetchone()
        return self._row(row)

    def list(self):
        with self._conn() as con:
            rows = con.execute("SELECT * FROM connectors ORDER BY kind").fetchall()
        return [self._row(r) for r in rows]

    def save(self, kind, config=None, mapping=None, enabled=None, name=None):
        if kind not in KINDS:
            raise IntegrationError("CONFIG", f"不支持的集成类型: {kind}", retryable=False)
        conn = self.get(kind)
        if not conn:
            raise IntegrationError("CONFIG", ERR_CONNECTOR_NOT_FOUND, retryable=False)
        cfg = dict(conn["config"])
        for k, v in (config or {}).items():
            if k in ("base_url", "repo", "project", "project_key", "issue_type", "email") or k in SECRET_FIELDS:
                cfg[k] = str(v or "").strip()
        cfg = {k: v for k, v in cfg.items() if v is not None}
        new_mapping = conn["mapping"] if mapping is None else normalize_mapping(mapping)
        en = conn["enabled"] if enabled is None else bool(enabled)
        nm = (name or conn["name"]).strip()[:60] or conn["name"]
        now = _now()
        with self._conn() as con:
            con.execute("UPDATE connectors SET name=?,enabled=?,config_json=?,mapping_json=?,updated_at=?"
                        " WHERE kind=?",
                        (nm, int(en), json.dumps(self._encrypt(cfg), ensure_ascii=False),
                         json.dumps(new_mapping, ensure_ascii=False), now, kind))
        return self.get(kind)

    def save_mapping(self, kind, mapping):
        return self.save(kind, mapping=mapping)

    def record_test(self, kind, ok, error=""):
        now = _now()
        with self._conn() as con:
            con.execute("UPDATE connectors SET last_test_at=?,last_test_ok=?,last_test_error=? WHERE kind=?",
                        (now, int(bool(ok)), str(error or "")[:ERROR_LIMIT], kind))

    def test(self, kind):
        conn = self.get(kind)
        if not conn:
            raise IntegrationError("NOT_FOUND", ERR_CONNECTOR_NOT_FOUND, status=404, retryable=False)
        try:
            result = build_adapter(kind, conn).test()
            self.record_test(kind, True)
            return {"ok": True, "detail": result.get("detail", ""), "tested_at": _now()}
        except IntegrationError as e:
            self.record_test(kind, False, error=e.message)
            return {"ok": False, "code": e.code, "error": e.message, "retryable": e.retryable,
                    "tested_at": _now()}

    def _public_config(self, cfg):
        out = {}
        for k, v in (cfg or {}).items():
            if k in SECRET_FIELDS:
                out[k + "_set"] = bool(v)
            else:
                out[k] = v
        return out

    def public(self, conn):
        if not conn:
            return None
        out = dict(conn)
        out["config"] = self._public_config(conn["config"])
        out["available"] = all(str(conn["config"].get(k) or "").strip() for k in KINDS[conn["kind"]]["required"])
        out.pop("created_at", None)
        return out

    def _new_job(self, connector_id, items, status, retry_of=""):
        jid = str(uuid.uuid4())
        now = _now()
        with self._conn() as con:
            con.execute("INSERT INTO jobs(id,connector_id,status,total,succeeded,failed,attempts,error,"
                        "errors_json,payload_json,retry_of,created_at,updated_at)"
                        " VALUES(?,?,?,?,0,0,0,'','[]',?,?,?,?)",
                        (jid, connector_id, status, len(items), json.dumps(items, ensure_ascii=False),
                         retry_of, now, now))
        return jid

    def sync(self, kind, items):
        if kind not in KINDS:
            raise IntegrationError("CONFIG", f"不支持的集成类型: {kind}", retryable=False)
        conn = self.get(kind)
        if not conn:
            raise IntegrationError("NOT_FOUND", ERR_CONNECTOR_NOT_FOUND, status=404, retryable=False)
        if not conn["enabled"]:
            raise IntegrationError("DISABLED", "连接器未启用，请先保存并启用配置", retryable=False)
        miss = [k for k in KINDS[kind]["required"] if not str(conn["config"].get(k) or "").strip()]
        if miss:
            raise IntegrationError("CONFIG", "缺少配置: " + ", ".join(miss), retryable=False)
        items = normalize_items(items)
        jid = self._new_job(conn["id"], items, "running")
        return self.run_job(jid)

    def _sync_item(self, adapter, item, mapping):
        """单条明细重试同步；返回 (是否成功, 错误字典, 尝试次数)。"""
        last = None
        attempts = 0
        for n in range(1, MAX_ATTEMPTS + 1):
            attempts += 1
            try:
                res = adapter.create(item)
                item["_remote_id"] = res.get("remote_id", "")
                return True, None, attempts
            except IntegrationError as e:
                last = e
                if not e.retryable or n == MAX_ATTEMPTS:
                    break
                time.sleep(0.15 * n)
            except Exception as e:
                last = IntegrationError("SYNC_FAILED", f"{type(e).__name__}: {e}")
                break
        title_key = mapping.get("title", "title")
        err = {"code": last.code, "message": last.message,
               "status": last.status, "retryable": last.retryable}
        err["title"] = str(item.get(title_key) or item.get("title") or "")[:160]
        return False, err, attempts

    def run_job(self, job_id):
        job = self.get_job(job_id)
        if not job:
            raise IntegrationError("NOT_FOUND", "同步任务不存在", status=404, retryable=False)
        conn = self.get(job["connector_id"])
        if not conn:
            raise IntegrationError("NOT_FOUND", ERR_CONNECTOR_NOT_FOUND, status=404, retryable=False)
        adapter = build_adapter(conn["kind"], conn)
        items = json.loads(job["payload_json"])
        mapping = normalize_mapping(conn["mapping"])
        errors, ok_n, attempts = [], 0, 0
        for idx, item in enumerate(items):
            ok, err, tries = self._sync_item(adapter, item, mapping)
            attempts += tries
            if ok:
                ok_n += 1
            else:
                errors.append({"index": idx, **err})
        failed = len(errors)
        status = "success" if not failed else ("failed" if ok_n == 0 else "partial")
        summary = "" if not failed else f"{failed} 条失败，首因：{errors[0]['message']}"[:ERROR_LIMIT]
        now = _now()
        with self._conn() as con:
            con.execute("UPDATE jobs SET status=?,succeeded=?,failed=?,attempts=?,error=?,errors_json=?,"
                        "payload_json=?,updated_at=? WHERE id=?",
                        (status, ok_n, failed, attempts, summary,
                         json.dumps(errors, ensure_ascii=False),
                         json.dumps(items, ensure_ascii=False), now, job_id))
        return self.get_job(job_id)

    def get_job(self, job_id):
        with self._conn() as con:
            row = con.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return self._job_row(row, include_payload=True)

    def _job_row(self, row, include_payload=False):
        if row is None:
            return None
        out = {
            "id": row["id"], "connector_id": row["connector_id"], "status": row["status"],
            "total": row["total"], "succeeded": row["succeeded"], "failed": row["failed"],
            "attempts": row["attempts"], "error": row["error"] or "",
            "errors": json.loads(row["errors_json"] or "[]"),
            "retry_of": row["retry_of"] or "", "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        if include_payload:
            out["payload_json"] = row["payload_json"]
        return out

    def jobs(self, kind="", limit=20):
        limit = max(1, min(int(limit or 20), 100))
        with self._conn() as con:
            if kind:
                conn = self.get(kind)
                if not conn:
                    return []
                rows = con.execute("SELECT * FROM jobs WHERE connector_id=? ORDER BY created_at DESC LIMIT ?",
                                   (conn["id"], limit)).fetchall()
            else:
                rows = con.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [self._job_row(r) for r in rows]

    def retry(self, job_id):
        job = self.get_job(job_id)
        if not job:
            raise IntegrationError("NOT_FOUND", "同步任务不存在", status=404, retryable=False)
        if job["status"] == "running":
            raise IntegrationError("CONFLICT", "任务仍在执行，不能重试", status=409, retryable=False)
        if job["status"] == "success":
            raise IntegrationError("CONFLICT", "任务已成功，无需重试", status=409, retryable=False)
        items = json.loads(job["payload_json"])
        # 部分失败只重发失败条目，避免已创建的远端需求重复生成。
        failed = []
        for err in job.get("errors") or []:
            idx = err.get("index")
            if isinstance(idx, int) and 0 <= idx < len(items):
                item = dict(items[idx])
                item.pop("_remote_id", None)
                failed.append(item)
        if failed:
            items = failed
        jid = self._new_job(job["connector_id"], items, "running", retry_of=job_id)
        return self.run_job(jid)
