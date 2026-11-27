# -*- coding: utf-8 -*-
"""T06200 / REQ-022 / AC-30：外部集成真实 HTTP 验收（隔离服务 + 本地三类 Mock 上游）。"""
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


# 重复字面量统一为模块常量（SonarQube python:S1192）
API_INTEGRATIONS = '/api/integrations'
API_INTEGRATIONS_SYNC = '/api/integrations/sync'

ROOT = Path(__file__).resolve().parent.parent
PY = os.environ.get("PYTHON") or r"F:\Program Files\Python3.14\python.exe"
if not Path(PY).exists():
    PY = sys.executable
checks = []
LOG = []
MOCK = {"requests": [], "fail_remaining": 0}


def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, api):
        self.api = api.rstrip("/")
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, path, payload=None, method=None, timeout=45):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.api + path, data=data,
                                     method=method or ("POST" if data else "GET"),
                                     headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=timeout) as r:
                body = r.read()
                return r.status, (json.loads(body.decode("utf-8")) if body else {}), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(body), dict(e.headers or {})
            except Exception:
                return e.code, {"raw": body}, dict(e.headers or {})


class MockUpstream(BaseHTTPRequestHandler):
    def log_message(self, *a):
        """静默上游请求日志，避免测试输出噪声。"""

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self, method):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {}
        MOCK["requests"].append({"method": method, "path": self.path, "body": body})
        if MOCK["fail_remaining"] > 0:
            MOCK["fail_remaining"] -= 1
            self._send(503, {"error": "upstream down"})
            return
        p = self.path
        if method == "POST" and (p.endswith("/issues") or p.endswith("/issue")):
            self._send(201, {"number": 11, "iid": 12, "key": "DEMO-11", "html_url": "https://example/11",
                             "web_url": "https://example/12", "self": "https://example/rest/11"})
        elif method == "GET" and p.startswith("/repos/"):
            self._send(200, {"full_name": "owner/repo"})
        elif method == "GET" and p == "/rest/api/2/myself":
            self._send(200, {"displayName": "Mock Bot"})
        elif method == "GET" and p.startswith("/api/v4/projects/"):
            self._send(200, {"path_with_namespace": "group/project"})
        else:
            self._send(404, {"error": "not found"})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def wait_health(api, timeout=45):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(api + "/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def _rbac_checks(anon, admin, evaluator):
    st, boot, _ = admin.call("/api/auth/bootstrap", {"username": "root", "password": "AdminPass123",
                                                      "display_name": "系统管理员"})
    check("初始化管理员", st == 200 and boot.get("user", {}).get("role") == "admin", st)
    st, _, _ = admin.call("/api/rbac/users", {"username": "eval_int", "password": "EvalPass123",
                                                "display_name": "评估师", "role": "evaluator"})
    st2, _, _ = evaluator.call("/api/auth/login", {"username": "eval_int", "password": "EvalPass123"})
    check("评估师账号可登录", st == 200 and st2 == 200)

    st, anon_data, _ = anon.call(API_INTEGRATIONS)
    check("匿名读取集成：401 且无连接器", st == 401 and "connectors" not in anon_data, st)
    st, edata, _ = evaluator.call(API_INTEGRATIONS)
    check("评估师读取集成：403 且无配置", st == 403 and "connectors" not in edata, st)
    st, edata2, _ = evaluator.call("/api/integrations/save", {"kind": "github", "config": {}})
    check("评估师写入集成：403", st == 403 and "connector" not in edata2, st)

    st, data0, _ = admin.call(API_INTEGRATIONS)
    kinds = [c.get("kind") for c in data0.get("connectors", [])]
    check("管理员读到 3 个集成连接器", st == 200 and sorted(kinds) == ["github", "gitlab", "jira"], kinds)
    check("连接器初始未启用", all(not c.get("enabled") for c in data0.get("connectors", [])))


def _save_connectors(admin, base):
    cfg = {
        "github": {"base_url": base, "repo": "owner/repo", "token": "ghp-http-secret"},
        "jira": {"base_url": base, "project_key": "DEMO", "issue_type": "Task",
                  "email": "bot@example.com", "api_token": "jira-http-secret"},
        "gitlab": {"base_url": base, "project": "group/project", "token": "glpat-http-secret"},
    }
    for kind in ("github", "jira", "gitlab"):
        st, saved, _ = admin.call("/api/integrations/save", {"kind": kind, "config": cfg[kind],
                                                              "enabled": True})
        check(f"{kind} 配置保存并启用", st == 200 and saved.get("connector", {}).get("enabled") is True,
              st)
        check(f"{kind} 响应不含明文令牌",
              cfg[kind].get("token", cfg[kind].get("api_token", "")) not in json.dumps(saved))
        st, tested, _ = admin.call("/api/integrations/test", {"kind": kind})
        check(f"{kind} 连接测试成功", st == 200 and tested.get("ok") is True, tested.get("error") or tested.get("detail"))

    st, map_saved, _ = admin.call("/api/integrations/mapping",
                                  {"kind": "github", "mapping": {"title": "component", "body": "acceptance",
                                                                  "priority": "priority", "labels": "labels"}})
    check("字段映射保存接口成功", st == 200 and map_saved.get("connector", {}).get("mapping", {}).get("title") == "component")
    st, data1, _ = admin.call(API_INTEGRATIONS)
    gh = [c for c in data1.get("connectors", []) if c.get("kind") == "github"][0]
    check("字段映射刷新后仍持久化", gh.get("mapping", {}).get("body") == "acceptance")
    check("密钥只暴露 set 标记", gh.get("config", {}).get("token_set") is True
          and "token" not in gh.get("config", {}))


def _sync_checks(admin):
    MOCK["requests"].clear()
    st, sync1, _ = admin.call(API_INTEGRATIONS_SYNC,
                               {"kind": "github", "items": [{"component": "票据提醒", "acceptance": "到期筛选",
                                                              "priority": "P1", "labels": ["需求"]}]})
    job = sync1.get("job", {})
    check("GitHub 同步成功", st == 200 and job.get("status") == "success" and job.get("succeeded") == 1,
          f"{st} {job.get('status')}")
    check("同步响应含计数与失败原因字段", all(k in job for k in ("total", "succeeded", "failed", "errors")))
    post = [r for r in MOCK["requests"] if r["method"] == "POST"][-1]
    check("映射后标题取 component 字段", post.get("body", {}).get("title") == "票据提醒", post.get("body"))

    for kind, items in (("jira", [{"title": "Jira 需求", "body": "描述", "priority": "High"}]),
                        ("gitlab", [{"title": "GitLab 需求", "body": "描述", "labels": "a,b"}])):
        st, out, _ = admin.call(API_INTEGRATIONS_SYNC, {"kind": kind, "items": items})
        check(f"{kind} 同步成功", st == 200 and out.get("job", {}).get("status") == "success", st)

    MOCK["fail_remaining"] = 99
    st, bad, _ = admin.call(API_INTEGRATIONS_SYNC,
                             {"kind": "github", "items": [{"component": "会失败", "acceptance": "x"}]})
    bjob = bad.get("job", {})
    check("失败任务返回 failed 且保留错误原因",
          st == 200 and bjob.get("status") == "failed" and "503" in json.dumps(bjob.get("errors", []), ensure_ascii=False),
          json.dumps(bjob.get("errors", []), ensure_ascii=False)[:160])
    check("错误原因含 HTTP 状态与逐条标题", bjob.get("errors", [{}])[0].get("title") == "会失败"
          and bjob.get("errors", [{}])[0].get("code") == "HTTP_ERROR")
    MOCK["fail_remaining"] = 0
    st, retry, _ = admin.call("/api/integrations/retry", {"job_id": bjob.get("id")})
    rjob = retry.get("job", {})
    check("手动重试成功并记录来源任务", st == 200 and rjob.get("status") == "success"
          and rjob.get("retry_of") == bjob.get("id"), st)
    st, retry2, _ = admin.call("/api/integrations/retry", {"job_id": rjob.get("id")})
    check("成功任务重复重试返回 409", st == 409 and retry2.get("code") == "CONFLICT", st)
    return bjob, rjob


def _audit_checks(admin, data):
    st, jobs, _ = admin.call("/api/integrations/jobs?limit=50")
    check("任务日志可查询且计数完整", st == 200 and len(jobs.get("jobs", [])) >= 5
          and all("errors" in j for j in jobs.get("jobs", [])), len(jobs.get("jobs", [])))
    st, audit, _ = admin.call("/api/rbac/audit?limit=100")
    actions = [a.get("action") for a in audit.get("audit", [])]
    check("集成保存/测试/同步/重试进入 RBAC 审计",
          {"integration_save", "integration_test", "integration_sync", "integration_retry"} <= set(actions),
          sorted({a for a in actions if a and a.startswith("integration")}))
    con = sqlite3.connect(data / "integrations.db")
    raw = "\n".join(r[0] for r in con.execute("SELECT config_json FROM connectors").fetchall())
    con.close()
    check("数据库中三个令牌均非明文", all(s not in raw for s in
          ("ghp-http-secret", "jira-http-secret", "glpat-http-secret")))
    check("同步仅创建，无状态双向请求", all(r["method"] == "POST" for r in MOCK["requests"]
                                        if r["path"].endswith("/issues") or r["path"].endswith("/issue")))


def main():
    port, mock_port = free_port(), free_port()
    api = f"http://127.0.0.1:{port}"
    tmp = Path(tempfile.mkdtemp(prefix="we_integration_api_"))
    data = tmp / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "config.json").write_text(json.dumps({"deployment": {"mode": "workgroup"}},
                                                  ensure_ascii=False), encoding="utf-8")
    env = {**os.environ, "WE_DATA": str(data), "WE_UPDATE_URL": "off", "WE_LTASK_TEST": "1"}
    proc = subprocess.Popen([PY, "-u", "scripts/server.py", str(port)], cwd=str(ROOT), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace")
    threading.Thread(target=lambda: [LOG.append(line) for line in proc.stdout], daemon=True).start()
    mock = ThreadingHTTPServer(("127.0.0.1", mock_port), MockUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{mock_port}"
    anon, admin, evaluator = Client(api), Client(api), Client(api)
    try:
        healthy = wait_health(api)
        check("隔离服务健康", healthy, api)
        if not healthy:
            print("\n".join(LOG[-100:]))
            return 1
        _rbac_checks(anon, admin, evaluator)
        _save_connectors(admin, base)
        _sync_checks(admin)
        _audit_checks(admin, data)

        result = {"suite": "integrations-api", "checks": checks,
                  "pass": sum(1 for c in checks if c["ok"]), "total": len(checks)}
        out = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results" / "integrations-api.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nintegrations-api: {result['pass']}/{result['total']} checks passed")
        if result["pass"] != result["total"] and LOG:
            print("--- server log tail ---\n" + "\n".join(LOG[-80:]))
        return 0 if result["pass"] == result["total"] else 1
    finally:
        mock.shutdown()
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
