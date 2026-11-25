# -*- coding: utf-8 -*-
"""T06353 部署模式切换 API 边界测试。

覆盖：本机恢复令牌、Origin、确认词、配置保留、审计、会话撤销、幂等。
"""
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
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = os.environ.get("PYTHON") or r"F:\Program Files\Python3.14\python.exe"
if not Path(PY).exists():
    PY = sys.executable
CHECKS = []
TOKEN = "test-local-recovery-token-0123456789"
SERVER = None
LOG = []


def check(name, ok, detail=""):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": str(detail)})
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

    def call(self, path, payload=None, headers=None, timeout=30, content_type="application/json"):
        raw = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        h = {"Content-Type": content_type}
        h.update(headers or {})
        req = urllib.request.Request(self.api + path, data=raw,
                                     method="POST" if payload is not None else "GET", headers=h)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                body = r.read().decode("utf-8", "replace")
                return r.status, (json.loads(body) if body else {}), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                obj = json.loads(body)
            except Exception:
                obj = {"raw": body}
            return e.code, obj, dict(e.headers or {})


def wait_health(api, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(api + "/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def db_count(data, table):
    con = sqlite3.connect(data / "rbac.db")
    try:
        return int(con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    finally:
        con.close()


def audit_actions(data):
    con = sqlite3.connect(data / "rbac.db")
    try:
        return con.execute("SELECT action FROM audit ORDER BY id").fetchall()
    finally:
        con.close()


def main():
    global SERVER
    port = free_port()
    api = f"http://127.0.0.1:{port}"
    tmp = Path(tempfile.mkdtemp(prefix="we_deployment_api_"))
    data = tmp / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "config.json").write_text(json.dumps({
        "deployment": {"mode": "workgroup"},
        "provider": "agnes",
        "llm": {"enabled": False, "api": "https://legacy.example/v1", "model": "legacy"},
        "recalc": {"mode": "async", "timeout": 120},
        "sso": {"enabled": False}
    }, ensure_ascii=False), encoding="utf-8")
    env = {**os.environ, "WE_DATA": str(data), "WE_UPDATE_URL": "off",
           "WE_LOCAL_RECOVERY_TOKEN": TOKEN, "WE_LTASK_TEST": "1"}
    SERVER = subprocess.Popen([PY, "-u", "scripts/server.py", str(port), "--serve-frontend"],
                              cwd=str(ROOT), env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    threading.Thread(target=lambda: [LOG.append(line) for line in SERVER.stdout], daemon=True).start()
    client = Client(api)
    try:
        healthy = wait_health(api)
        check("隔离服务健康", healthy, api)
        if not healthy:
            print("--- server log ---\n" + "".join(LOG[-80:]))
            return 1

        st, body, _ = client.call("/api/deployment/standalone", {"confirm": "STANDALONE"},
                                  {"Origin": f"http://127.0.0.1:{port}"})
        check("缺少本机恢复令牌被拒", st == 403 and body.get("code") == "BAD_LOCAL_TOKEN", f"{st} {body}")

        st, body, _ = client.call("/api/deployment/standalone", {"confirm": "STANDALONE"},
                                  {"Origin": f"http://127.0.0.1:{port}", "X-We-Local-Recovery": "wrong"})
        check("错误本机恢复令牌被拒", st == 403 and body.get("code") == "BAD_LOCAL_TOKEN", f"{st} {body}")

        st, body, _ = client.call("/api/deployment/standalone", {"confirm": "STANDALONE"},
                                  {"Origin": "http://evil.example", "X-We-Local-Recovery": TOKEN})
        check("跨站 Origin 被拒", st == 403 and body.get("code") == "BAD_ORIGIN", f"{st} {body}")

        st, body, _ = client.call("/api/deployment/standalone", {"confirm": "STANDALONE"},
                                  {"Origin": "http://127.0.0.1:" + str(port + 1), "X-We-Local-Recovery": TOKEN})
        check("不同端口 Origin 被拒", st == 403 and body.get("code") == "BAD_ORIGIN", f"{st} {body}")

        st, body, _ = client.call("/api/deployment/standalone", {"confirm": "STANDALONE"},
                                  {"Origin": f"https://127.0.0.1:{port}", "X-We-Local-Recovery": TOKEN},
                                  content_type="text/plain")
        check("非 JSON Content-Type 被拒", st == 415 and body.get("code") == "UNSUPPORTED_MEDIA_TYPE",
              f"{st} {body}")

        st, body, _ = client.call("/api/deployment/standalone", {"confirm": "NO"},
                                  {"Origin": f"https://127.0.0.1:{port}", "X-We-Local-Recovery": TOKEN})
        check("HTTPS 同源 Origin 被接受（确认词仍拦截）",
              st == 400 and body.get("code") == "CONFIRM_REQUIRED", f"{st} {body}")

        st, body, _ = client.call("/api/auth/bootstrap", {"username": "root", "password": "AdminPass123",
                                                           "display_name": "系统管理员"})
        check("初始化管理员成功", st == 200 and body.get("user", {}).get("role") == "admin", f"{st} {body}")
        st, body, _ = client.call("/api/auth/login", {"username": "root", "password": "AdminPass123"})
        check("管理员登录成功", st == 200 and body.get("user", {}).get("username") == "root", f"{st} {body}")
        sessions_before = db_count(data, "sessions")
        audit_before = db_count(data, "audit")

        st, body, headers = client.call("/api/deployment/standalone", {"confirm": "STANDALONE"},
                                        {"Origin": f"http://127.0.0.1:{port}", "X-We-Local-Recovery": TOKEN})
        check("合法令牌+Origin 切换成功", st == 200 and body.get("mode") == "standalone"
              and body.get("changed") is True, f"{st} {body}")
        check("切换清除浏览器 Cookie", "Max-Age=0" in (headers.get("Set-Cookie") or ""),
              headers.get("Set-Cookie", "")[:120])
        cfg = json.loads((data / "config.json").read_text(encoding="utf-8"))
        check("只改 deployment.mode，保留其他配置",
              cfg.get("deployment", {}).get("mode") == "standalone"
              and cfg.get("provider") == "agnes"
              and cfg.get("llm", {}).get("enabled") is False
              and cfg.get("sso", {}).get("enabled") is False,
              json.dumps(cfg, ensure_ascii=False)[:220])
        check("切换撤销全部服务端会话", db_count(data, "sessions") == 0,
              f"before={sessions_before} after={db_count(data, 'sessions')}")
        actions = [row[0] for row in audit_actions(data)]
        check("切换新增审计事件", "deployment_switch" in actions,
              f"before={audit_before} after={db_count(data, 'audit')} actions={actions[-4:]}")

        st, body, _ = client.call("/api/deployment/standalone", {"confirm": "STANDALONE"},
                                  {"X-We-Local-Recovery": TOKEN})
        check("无 Origin 但带令牌可幂等调用", st == 200 and body.get("changed") is False, f"{st} {body}")

        # 令牌未配置时必须 fail-closed，而不是退回“无 Origin 放行”
        tmp2 = Path(tempfile.mkdtemp(prefix="we_deployment_notoken_"))
        data2 = tmp2 / "data"
        data2.mkdir(parents=True, exist_ok=True)
        (data2 / "config.json").write_text(json.dumps(
            {"deployment": {"mode": "workgroup"}}), encoding="utf-8")
        port2 = free_port()
        env2 = {**os.environ, "WE_DATA": str(data2), "WE_UPDATE_URL": "off",
                "WE_LTASK_TEST": "1"}
        env2.pop("WE_LOCAL_RECOVERY_TOKEN", None)
        p2 = subprocess.Popen([PY, "-u", "scripts/server.py", str(port2), "--serve-frontend"],
                              cwd=str(ROOT), env=env2, stdout=subprocess.DEVNULL,
                              stderr=subprocess.STDOUT)
        try:
            check("无令牌服务健康", wait_health(f"http://127.0.0.1:{port2}"), f"port={port2}")
            st, body, _ = Client(f"http://127.0.0.1:{port2}").call(
                "/api/deployment/standalone", {"confirm": "STANDALONE"},
                {"Origin": f"http://127.0.0.1:{port2}"})
            check("未配置令牌时 fail-closed", st == 403 and body.get("code") == "LOCAL_TOKEN_UNCONFIGURED",
                  f"{st} {body}")
        finally:
            p2.terminate()
            try:
                p2.wait(timeout=5)
            except Exception:
                p2.kill()
            import shutil
            shutil.rmtree(tmp2, ignore_errors=True)
        return 0 if all(x["ok"] for x in CHECKS) else 1
    finally:
        if SERVER:
            SERVER.terminate()
            try:
                SERVER.wait(timeout=5)
            except Exception:
                SERVER.kill()
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"\nRESULT {sum(1 for x in CHECKS if x['ok'])}/{len(CHECKS)} PASS")


if __name__ == "__main__":
    sys.exit(main())
