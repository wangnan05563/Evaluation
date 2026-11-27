# -*- coding: utf-8 -*-
"""T06199 / REQ-021 / AC-25 / AC-28 / AC-29：RBAC/SSO 真实 HTTP 验收。

自起隔离服务（临时 WE_DATA + workgroup），覆盖：
- 未初始化引导、登录、Cookie、会话失效
- 角色权限矩阵、越权 403、无数据泄露、拒绝审计
- OIDC 授权码 + token + userinfo（本地 Mock IDP）与失败回退管理员
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookiejar import CookieJar
from pathlib import Path


# 重复字面量统一为模块常量（SonarQube python:S1192）
API_AUTH_BOOTSTRAP = '/api/auth/bootstrap'
API_AUTH_LOGIN = '/api/auth/login'
API_AUTH_ME = '/api/auth/me'
API_CONFIG = '/api/config'
API_RBAC_USERS = '/api/rbac/users'
API_WORKFLOW_PROJECTS = '/api/workflow/projects'

ROOT = Path(__file__).resolve().parent.parent
PY = os.environ.get("PYTHON") or r"F:\Program Files\Python3.14\python.exe"
if not Path(PY).exists():
    PY = sys.executable
checks = []
server = None
mock = None
LOG = []


def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, api):
        self.api = api.rstrip("/")
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())

    def call(self, path, payload=None, method=None, timeout=45, raw=False):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.api + path, data=data,
                                     method=method or ("POST" if data else "GET"),
                                     headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=timeout) as r:
                body = r.read()
                if raw:
                    return r.status, body, dict(r.headers)
                return r.status, (json.loads(body.decode("utf-8")) if body else {}), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if raw:
                return e.code, body, dict(e.headers or {})
            try:
                obj = json.loads(body)
            except Exception:
                obj = {"raw": body}
            return e.code, obj, dict(e.headers or {})

    def logout(self):
        return self.call("/api/auth/logout", {})


class MockIDP(BaseHTTPRequestHandler):
    def log_message(self, *args):
        """静默 IdP 请求日志，避免测试输出噪声。"""

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8", "replace")
        form = urllib.parse.parse_qs(raw)
        if self.path == "/token" and (form.get("code") or [""])[0] == "good":
            return self._json(200, {"access_token": "test-access"})
        return self._json(400, {"error": "invalid_grant"})

    def do_GET(self):
        if self.path == "/userinfo" and self.headers.get("Authorization") == "Bearer test-access":
            return self._json(200, {"sub": "idp-001", "preferred_username": "sso.user",
                                    "name": "单点用户", "email": "sso@example.com"})
        return self._json(401, {"error": "unauthorized"})


def wait_health(api, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(api + "/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def _admin_setup(anon, admin):
    st, me, _ = anon.call(API_AUTH_ME)
    check("工作组未登录：要求初始化管理员",
          st == 200 and me.get("mode") == "workgroup" and me.get("authRequired")
          and me.get("bootstrapRequired") and me.get("user") is None and me.get("adminFallback") is True,
          json.dumps(me, ensure_ascii=False))

    st, cfg0, _ = anon.call(API_CONFIG)
    check("未登录访问配置：401 且无 config 数据",
          st == 401 and cfg0.get("code") == "UNAUTHORIZED" and "config" not in cfg0, f"{st} {cfg0.get('code')}")

    st, bad, _ = anon.call(API_AUTH_BOOTSTRAP, {"username": "root", "password": "短"})
    check("初始化弱密码被拒", st == 400 and bad.get("code") == "WEAK_PASSWORD", f"{st} {bad.get('code')}")
    st, boot, hdr = admin.call(API_AUTH_BOOTSTRAP, {"username": "root", "password": "AdminPass123",
                                                       "display_name": "系统管理员"})
    cookie = hdr.get("Set-Cookie", "")
    check("初始化管理员成功并下发 HttpOnly Cookie",
          st == 200 and boot.get("user", {}).get("role") == "admin"
          and "HttpOnly" in cookie and "SameSite=Lax" in cookie, cookie[:120])
    st, me2, _ = admin.call(API_AUTH_ME)
    check("初始化后 me 返回 admin/权限", st == 200 and me2.get("user", {}).get("username") == "root"
          and "user.manage" in (me2.get("permissions") or []), me2.get("user", {}).get("role"))
    st, dup, _ = anon.call(API_AUTH_BOOTSTRAP, {"username": "root2", "password": "AdminPass123"})
    check("重复初始化 409", st == 409 and dup.get("code") == "BOOTSTRAP_CLOSED", f"{st} {dup.get('code')}")

    st, cfg, _ = admin.call(API_CONFIG)
    check("管理员可读配置", st == 200 and cfg.get("config", {}).get("deployment", {}).get("mode") == "workgroup")

    st, mk, _ = admin.call("/api/rbac/matrix")
    check("权限矩阵 API 返回 5 角色/13 权限", st == 200 and len(mk.get("roles", [])) == 5
          and len(mk.get("permissions", [])) == 13, f"{len(mk.get('roles', []))}/{len(mk.get('permissions', []))}")

    st, u1, _ = admin.call(API_RBAC_USERS, {"username": "eval1", "password": "EvalPass123",
                                                "display_name": "评估师甲", "role": "evaluator"})
    st2, u2, _ = admin.call(API_RBAC_USERS, {"username": "viewer1", "password": "ViewPass123",
                                                  "display_name": "只读乙", "role": "viewer"})
    check("管理员创建评估师/只读用户", st == 200 and st2 == 200
          and u1.get("user", {}).get("role") == "evaluator" and u2.get("user", {}).get("role") == "viewer")
    st, users, _ = admin.call(API_RBAC_USERS)
    check("用户列表含三名账号", st == 200 and len(users.get("users", [])) == 3,
          [x.get("username") for x in users.get("users", [])])
    return u1, u2


def _permission_checks(admin, evaluator, viewer):
    st, login_e, _ = evaluator.call(API_AUTH_LOGIN, {"username": "eval1", "password": "EvalPass123"})
    st, login_v, _ = viewer.call(API_AUTH_LOGIN, {"username": "viewer1", "password": "ViewPass123"})
    check("评估师/只读用户登录成功", st == 200 and login_e.get("user", {}).get("role") == "evaluator"
          and login_v.get("user", {}).get("role") == "viewer")
    st, eproj, _ = evaluator.call(API_WORKFLOW_PROJECTS)
    check("评估师可查看项目列表", st == 200 and eproj.get("ok") is True, st)
    st, vproj, _ = viewer.call(API_WORKFLOW_PROJECTS)
    check("只读成员访问项目：403 且无 projects 数据",
          st == 403 and vproj.get("code") == "PERMISSION_DENIED" and "projects" not in vproj
          and "project_id" not in json.dumps(vproj), f"{st} {vproj.get('code')}")
    st, vdetail, _ = viewer.call("/api/workflow/project?project_id=p-secret-403")
    check("只读成员访问具体项目：403 且不回显项目内容",
          st == 403 and "title" not in vdetail and "p-secret-403" not in json.dumps(vdetail),
          json.dumps(vdetail, ensure_ascii=False)[:160])
    st, econf, _ = evaluator.call(API_CONFIG)
    check("评估师读配置：403 且无 config",
          st == 403 and "config" not in econf, f"{st} {econf.get('code')}")
    st, eusers, _ = evaluator.call(API_RBAC_USERS)
    check("评估师读用户表：403", st == 403 and "users" not in eusers, f"{st} {eusers.get('code')}")
    st, eaudit, _ = evaluator.call("/api/rbac/audit")
    check("评估师读审计：403", st == 403 and "audit" not in eaudit, f"{st} {eaudit.get('code')}")

    st, deny_audit, _ = admin.call("/api/rbac/audit?limit=100&result=deny")
    rows = deny_audit.get("audit", [])
    permissions = {r.get("permission") for r in rows}
    check("四类越权全部落审计", st == 200 and len(rows) >= 4
          and {"project.read", "settings.read", "user.manage", "audit.read"} <= permissions,
          sorted(permissions))
    check("审计含操作人/对象/路径",
          any(r.get("actor_name") == "只读乙" and r.get("object_type") == "project"
              and "/api/workflow/project" in r.get("detail", "") for r in rows),
          json.dumps(rows[:2], ensure_ascii=False))


def _role_change_checks(admin, evaluator, viewer, u1, u2):
    # 角色变更立即生效：只读 -> 评估师后可读项目
    st, upd, _ = admin.call("/api/rbac/users/update", {"id": u2["user"]["id"], "role": "evaluator"})
    st2, _, _ = viewer.call(API_WORKFLOW_PROJECTS)
    check("角色变更立即生效", st == 200 and upd.get("user", {}).get("role") == "evaluator"
          and st2 == 200, f"{st}/{st2}")
    # 停用用户后旧 Cookie 立即失效
    st, _, _ = admin.call("/api/rbac/users/update", {"id": u1["user"]["id"], "status": "disabled"})
    _, vme, _ = viewer.call(API_WORKFLOW_PROJECTS)
    st3, _, _ = evaluator.call(API_WORKFLOW_PROJECTS)
    check("停用用户踢出旧会话", st == 200 and st3 == 401 and vme is not None,
          f"disable={st} evaluator={st3}")


def _sso_checks(admin, data, mock_port, api):
    # SSO：未配置时失败并提示回退管理员
    st, ss0, _ = admin.call("/api/auth/sso/start")
    check("SSO 未配置：失败并声明 fallback=admin",
          st == 400 and ss0.get("fallback") == "admin" and ss0.get("code") in ("SSO_DISABLED", "SSO_NOT_CONFIGURED"),
          f"{st} {ss0.get('code')}")

    st, ssave, _ = admin.call("/api/rbac/sso-config", {
        "enabled": True, "provider_name": "MockIDP",
        "authorize_url": f"http://127.0.0.1:{mock_port}/authorize",
        "token_url": f"http://127.0.0.1:{mock_port}/token",
        "userinfo_url": f"http://127.0.0.1:{mock_port}/userinfo",
        "client_id": "web", "client_secret": "secret-value", "auto_provision": True,
        "default_role": "viewer", "admin_fallback": True})
    check("管理员保存 SSO 配置且不回显明文 secret",
          st == 200 and ssave.get("sso", {}).get("enabled") is True
          and "client_secret" not in ssave.get("sso", {}) and ssave.get("sso", {}).get("client_secret_set") is True,
          json.dumps(ssave.get("sso", {}), ensure_ascii=False)[:220])
    raw_cfg = (data / "config.json").read_text(encoding="utf-8")
    check("client_secret 磁盘为密文且无明文", "secret-value" not in raw_cfg and "client_secret_enc" in raw_cfg)

    st, ss1, _ = admin.call("/api/auth/sso/start?next=/work")
    state = ss1.get("state")
    ok_url = ss1.get("authorize_url", "")
    check("SSO 授权 URL 含 client_id/state/redirect_uri",
          st == 200 and "client_id=web" in ok_url and f"state={state}" in ok_url
          and "redirect_uri=" in ok_url and "response_type=code" in ok_url, ok_url[:180])

    sso_client = Client(api)
    st, cb, hdr = sso_client.call(f"/api/auth/sso/callback?state={state}&code=good&format=json")
    check("OIDC 回调成功并下发会话 Cookie", st == 200 and cb.get("user", {}).get("username") == "sso.user"
          and "HttpOnly" in hdr.get("Set-Cookie", ""), f"{st} {cb.get('user', {}).get('username')}")
    st, sme, _ = sso_client.call(API_AUTH_ME)
    check("SSO 自动开通为只读成员", st == 200 and sme.get("user", {}).get("role") == "viewer",
          sme.get("user", {}).get("role"))

    _, ss2, _ = admin.call("/api/auth/sso/start")
    bad_state = ss2.get("state")
    st, fail, _ = Client(api).call(f"/api/auth/sso/callback?state={bad_state}&code=bad&format=json")
    check("SSO token 失败：502 且回退管理员", st == 502 and fail.get("fallback") == "admin"
          and fail.get("code") in ("SSO_TOKEN_FAILED", "SSO_NO_TOKEN"), f"{st} {fail.get('code')}")
    st, fail2, _ = Client(api).call("/api/auth/sso/callback?state=forged&code=good&format=json")
    check("SSO state 伪造：400 且回退管理员", st == 400 and fail2.get("fallback") == "admin",
          f"{st} {fail2.get('code')}")

    # SSO 失败不改管理员密码登录路径：原有 admin 会话仍有效
    st, admin_me, _ = admin.call(API_AUTH_ME)
    check("SSO 失败不影响管理员账号回退", st == 200 and admin_me.get("user", {}).get("role") == "admin",
          admin_me.get("user", {}).get("username"))

    st, aud2, _ = admin.call("/api/rbac/audit?limit=100")
    rows2 = aud2.get("audit", [])
    check("SSO 成败均进入审计", any(a["action"] == "sso_login" and a["result"] == "deny" for a in rows2)
          and any(a["action"] == "sso_login" and a["result"] == "success" for a in rows2))
    check("审计不含 SSO 明文 secret 或 token",
          "secret-value" not in json.dumps(rows2, ensure_ascii=False)
          and "test-access" not in json.dumps(rows2, ensure_ascii=False))


def _logout_checks(admin, anon):
    st, _, _ = admin.call("/api/auth/logout", {})
    _, me3, _ = admin.call(API_AUTH_ME)
    check("登出清 Cookie 后回未登录态", st == 200 and me3.get("user") is None and me3.get("bootstrapRequired") is False)
    st, relog, _ = admin.call(API_AUTH_LOGIN, {"username": "root", "password": "AdminPass123"})
    check("管理员回退登录仍可用", st == 200 and relog.get("user", {}).get("role") == "admin")

    st, page, _ = anon.call("/", raw=True)
    check("登录页静态资源可访问", st == 200 and b"<!doctype" in page.lower())


def main():
    global server, mock
    port = free_port()
    mock_port = free_port()
    api = f"http://127.0.0.1:{port}"
    tmp = Path(tempfile.mkdtemp(prefix="we_rbac_api_"))
    data = tmp / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "config.json").write_text(json.dumps({"deployment": {"mode": "workgroup"},
                                                  "sso": {"enabled": False, "admin_fallback": True}},
                                                 ensure_ascii=False), encoding="utf-8")
    env = {**os.environ, "WE_DATA": str(data), "WE_UPDATE_URL": "off", "WE_LTASK_TEST": "1"}
    server = subprocess.Popen([PY, "-u", "scripts/server.py", str(port), "--serve-frontend"],
                              cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding="utf-8", errors="replace")
    t = threading.Thread(target=lambda: [LOG.append(line) for line in server.stdout], daemon=True)
    t.start()

    mock = ThreadingHTTPServer(("127.0.0.1", mock_port), MockIDP)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    anon = Client(api)
    admin = Client(api)
    evaluator = Client(api)
    viewer = Client(api)
    try:
        healthy = wait_health(api)
        check("隔离服务健康", healthy, api)
        if not healthy:
            time.sleep(1)
            print("--- server log ---\n" + "\n".join(LOG[-100:]))
            return 1
        u1, u2 = _admin_setup(anon, admin)
        _permission_checks(admin, evaluator, viewer)
        _role_change_checks(admin, evaluator, viewer, u1, u2)
        _sso_checks(admin, data, mock_port, api)
        _logout_checks(admin, anon)
    finally:
        try:
            if server:
                server.terminate()
                server.wait(timeout=8)
        except Exception:
            try:
                server.kill()
            except Exception:
                pass
        try:
            mock.shutdown()
            mock.server_close()
        except Exception:
            pass

    result = {"suite": "rbac-api", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "checks": checks, "pass": sum(1 for c in checks if c["ok"]), "total": len(checks)}
    out = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results" / "rbac-api.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nrbac-api: {result['pass']}/{result['total']} checks passed")
    return 0 if result["pass"] == result["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
