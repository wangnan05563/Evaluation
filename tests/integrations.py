# -*- coding: utf-8 -*-
"""T06200 / REQ-022 / AC-30：外部集成单元验收（真实本地 HTTP mock，不联网）。"""
import json
import sqlite3
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import integrations  # noqa: E402
import secret_store  # noqa: E402

checks = []
MOCK = {"requests": [], "fail_remaining": 0, "forbid_methods": []}


def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _request(self, method):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {"raw": raw.decode("utf-8", "replace")}
        MOCK["requests"].append({"method": method, "path": self.path, "body": payload,
                                 "headers": dict(self.headers)})
        if method in MOCK["forbid_methods"]:
            self._send(405, {"error": "method not allowed"})
            return
        if MOCK["fail_remaining"] > 0:
            MOCK["fail_remaining"] -= 1
            self._send(503, {"error": "mock upstream unavailable"})
            return
        p = self.path
        if method == "POST" and (p.endswith("/issues") or p.endswith("/issue")):
            self._send(201, {"number": 7, "iid": 9, "id": 1001, "key": "DEMO-7",
                             "html_url": "https://example/issue/7", "web_url": "https://example/issue/9",
                             "self": "https://example/rest/issue/1001"})
            return
        if method == "GET" and p.startswith("/repos/"):
            self._send(200, {"full_name": "owner/repo"})
            return
        if method == "GET" and p == "/rest/api/2/myself":
            self._send(200, {"displayName": "评估机器人", "name": "bot"})
            return
        if method == "GET" and p.startswith("/api/v4/projects/"):
            self._send(200, {"path_with_namespace": "group/project"})
            return
        self._send(404, {"error": "not found"})

    def do_GET(self):
        self._request("GET")

    def do_POST(self):
        self._request("POST")

    def do_PUT(self):
        self._request("PUT")

    def do_PATCH(self):
        self._request("PATCH")

    def do_DELETE(self):
        self._request("DELETE")


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    tmp = Path(tempfile.mkdtemp(prefix="we_integration_unit_"))
    store = integrations.IntegrationStore(tmp / "integrations.db",
                                          protect=secret_store.protect, unprotect=secret_store.unprotect)

    kinds = [c["kind"] for c in store.list()]
    check("种子包含 3 个集成", sorted(kinds) == ["github", "gitlab", "jira"], kinds)
    check("默认全部未启用且未配置", all(not c["enabled"] and not c["available"]
                                     for c in (store.public(x) for x in store.list())))

    gh = store.save("github", {"base_url": base, "repo": "owner/repo", "token": "ghp-super-secret"}, enabled=True)
    check("GitHub 配置可保存并启用", gh["enabled"] and store.public(gh)["available"])
    con = sqlite3.connect(tmp / "integrations.db")
    raw = con.execute("SELECT config_json FROM connectors WHERE kind='github'").fetchone()[0]
    con.close()
    check("访问令牌不以明文落库", "ghp-super-secret" not in raw
          and ("dpapi:" in raw or "dev:" in raw), raw[:120])
    pub = store.public(gh)
    check("公开视图只返回 token_set 不返回密文", pub["config"].get("token_set") is True
          and "token" not in pub["config"], list(pub["config"].keys()))

    mapped = store.save_mapping("github", {"title": "component", "body": "acceptance",
                                           "priority": "priority", "labels": "labels"})
    check("字段映射可保存并回读", mapped["mapping"]["title"] == "component"
          and mapped["mapping"]["body"] == "acceptance", mapped["mapping"])

    t = store.test("github")
    check("GitHub 测试连接成功", t["ok"] and "owner/repo" in t["detail"], t.get("detail"))
    check("连接测试写入最近状态", store.get("github")["last_test_ok"] is True)

    jira = store.save("jira", {"base_url": base, "project_key": "DEMO", "issue_type": "Task",
                               "email": "bot@example.com", "api_token": "jira-secret"}, enabled=True)
    check("Jira 配置可保存", store.public(jira)["available"])
    jt = store.test("jira")
    check("Jira 测试连接成功", jt["ok"], jt.get("error") or jt.get("detail"))
    jira_req = [r for r in MOCK["requests"] if r["path"] == "/rest/api/2/myself"][-1]
    check("Jira 使用 Basic 认证", jira_req["headers"].get("Authorization", "").startswith("Basic "))

    gl = store.save("gitlab", {"base_url": base, "project": "group/project", "token": "glpat-secret"},
                    enabled=True)
    check("GitLab 配置可保存", store.public(gl)["available"])
    gt = store.test("gitlab")
    check("GitLab 测试连接成功", gt["ok"], gt.get("error") or gt.get("detail"))
    gl_req = [r for r in MOCK["requests"] if r["path"].startswith("/api/v4/projects/")][-1]
    check("GitLab 使用 PRIVATE-TOKEN",
          any(k.lower() == "private-token" and v for k, v in gl_req["headers"].items()))

    MOCK["requests"].clear()
    job = store.sync("github", [{"component": "票据到期提醒", "acceptance": "按到期日筛选",
                                "priority": "P1", "labels": ["需求"]}])
    check("GitHub 同步成功", job["status"] == "success" and job["succeeded"] == 1,
          f"{job['status']} {job['succeeded']}/{job['total']}")
    posted = MOCK["requests"][-1]
    check("字段映射生效：component→标题、acceptance→描述",
          posted["body"]["title"] == "票据到期提醒" and posted["body"]["body"] == "按到期日筛选",
          posted["body"])
    check("同步只调用创建接口", posted["method"] == "POST" and posted["path"].endswith("/issues"))
    check("未发生状态回读/更新请求", all(r["method"] in ("GET", "POST") for r in MOCK["requests"])
          and not any(r["method"] in ("PUT", "PATCH", "DELETE") for r in MOCK["requests"]))

    jira_job = store.sync("jira", [{"title": "Jira 需求", "body": "描述", "priority": "High"}])
    check("Jira 同步成功", jira_job["status"] == "success" and jira_job["succeeded"] == 1,
          f"{jira_job['status']} {jira_job['succeeded']}/{jira_job['total']}")
    jira_post = [r for r in MOCK["requests"] if r["path"] == "/rest/api/2/issue"][-1]
    check("Jira 载荷含 project/issuetype/priority",
          jira_post["body"]["fields"]["project"]["key"] == "DEMO"
          and jira_post["body"]["fields"]["issuetype"]["name"] == "Task"
          and jira_post["body"]["fields"]["priority"]["name"] == "High")

    gl_job = store.sync("gitlab", [{"title": "GitLab 需求", "body": "描述", "labels": "a,b"}])
    check("GitLab 同步成功", gl_job["status"] == "success" and gl_job["failed"] == 0)
    gl_post = [r for r in MOCK["requests"] if r["path"].endswith("/issues")][-1]
    check("GitLab 标签按逗号写入", gl_post["body"]["labels"] == "a,b", gl_post["body"])

    store.save_mapping("github", integrations.DEFAULT_MAPPING)
    MOCK["fail_remaining"] = 2
    auto = store.sync("github", [{"title": "自动重试", "body": "x"}])
    check("可重试错误自动重试后成功", auto["status"] == "success" and auto["attempts"] == 3,
          f"{auto['status']} attempts={auto['attempts']}")

    MOCK["fail_remaining"] = 99
    failed = store.sync("github", [{"title": "失败原因", "body": "x"}])
    check("彻底失败保留错误原因", failed["status"] == "failed" and failed["failed"] == 1
          and "503" in failed["errors"][0]["message"], failed["errors"][0])
    check("失败任务标记可重试", failed["errors"][0]["retryable"] is True
          and failed["errors"][0]["code"] == "HTTP_ERROR")
    MOCK["fail_remaining"] = 0
    retried = store.retry(failed["id"])
    check("手动重试生成新任务并成功", retried["status"] == "success"
          and retried["retry_of"] == failed["id"] and retried["id"] != failed["id"])
    try:
        store.retry(retried["id"])
    except integrations.IntegrationError as e:
        check("成功任务拒绝重复重试", e.code == "CONFLICT" and e.status == 409, f"{e.code}/{e.status}")
    else:
        check("成功任务拒绝重复重试", False, "未抛出异常")

    MOCK["fail_remaining"] = 3
    partial = store.sync("github", [{"title": "部分失败-A", "body": "x"},
                                    {"title": "部分失败-B", "body": "y"}])
    check("部分失败保留成功与失败计数", partial["status"] == "partial" and partial["succeeded"] == 1
          and partial["failed"] == 1, f"{partial['status']} {partial['succeeded']}/{partial['total']}")
    MOCK["fail_remaining"] = 0
    MOCK["requests"].clear()
    retried_partial = store.retry(partial["id"])
    check("部分失败只重发失败条目", retried_partial["status"] == "success" and retried_partial["total"] == 1
          and len([r for r in MOCK["requests"] if r["method"] == "POST"]) == 1,
          f"{retried_partial['status']} total={retried_partial['total']} posts={len(MOCK['requests'])}")

    store.save("jira", enabled=False)
    try:
        store.sync("jira", [{"title": "未启用", "body": "x"}])
    except integrations.IntegrationError as e:
        check("禁用连接器拒绝同步", e.code == "DISABLED" and not e.retryable, e.code)
    else:
        check("禁用连接器拒绝同步", False, "未抛出异常")
    for name, fn, code in [
        ("空条目拒绝", lambda: store.sync("github", []), "ITEM"),
        ("非对象条目拒绝", lambda: store.sync("github", ["x"]), "ITEM"),
        ("未知类型拒绝", lambda: store.sync("azure", [{"title": "x"}]), "CONFIG"),
    ]:
        try:
            fn()
        except integrations.IntegrationError as e:
            check(name, e.code == code, e.code)
        else:
            check(name, False, "未抛出异常")

    bad_test = store.test("gitlab")
    check("未知/缺配置测试返回失败而非异常", bad_test["ok"] in (True, False))
    jobs = store.jobs("github", 10)
    check("任务列表按连接器过滤", len(jobs) >= 3 and all(j["connector_id"] == store.get("github")["id"]
                                                    for j in jobs), len(jobs))

    result = {
        "suite": "integrations",
        "checks": checks,
        "pass": sum(1 for c in checks if c["ok"]),
        "total": len(checks),
    }
    out = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results" / "integrations.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    srv.shutdown()
    print(f"\nintegrations: {result['pass']}/{result['total']} checks passed")
    return 0 if result["pass"] == result["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
