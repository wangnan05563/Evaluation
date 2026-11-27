# -*- coding: utf-8 -*-
"""T06201 / AC-27：20 并发用户浏览/编辑项目性能与串号验收。

自起隔离工作组服务，20 个独立登录会话并发执行：
- GET /api/auth/me（会话身份）
- GET /api/workflow/projects（项目列表）
- GET /api/workflow/project?project_id=自己的项目（项目详情）
- POST /api/workflow/transition（提交评审/撤回，模拟编辑）

统计整体与分组 p50/p95/p99，要求 p95 ≤300ms；同时校验每个会话只读到自己的
项目详情、每次流转操作人只落在自己的项目事件中，无跨用户串号。
"""
import argparse
import json
import math
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import project_workflow  # noqa: E402


# 重复字面量统一为模块常量（SonarQube python:S1192）
API_AUTH_ME = '/api/auth/me'
API_WORKFLOW_PROJECTS = '/api/workflow/projects'

PY = os.environ.get("PYTHON") or r"F:\Program Files\Python3.14\python.exe"
if not Path(PY).exists():
    PY = sys.executable
# 默认严格 20；WE_LOAD_USERS 仅供诊断单会话基线，不用于验收。
USERS = int(os.environ.get("WE_LOAD_USERS", "20"))
THRESHOLD_MS = 300.0
PASSWORD = "LoadPass123"


class Client:
    """一个浏览器会话：独立 Cookie 与连接池。"""

    def __init__(self, api):
        self.api = api.rstrip("/")
        self.session = requests.Session()
        self.username = ""
        self.display_name = ""

    def call(self, path, payload=None, method=None, timeout=30):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        started = time.perf_counter()
        try:
            r = self.session.request(method or ("POST" if data else "GET"), self.api + path,
                                     data=data, timeout=timeout,
                                     headers={"Content-Type": "application/json"} if data else None)
            elapsed = (time.perf_counter() - started) * 1000
            try:
                body = r.json()
            except ValueError:
                body = {"raw": r.text[:500]}
            return r.status_code, body, elapsed
        except Exception as e:
            delta = time.perf_counter() - started
            elapsed = delta * 1000
            return 0, {"error": f"{type(e).__name__}: {e}"}, elapsed

    def close(self):
        self.session.close()


def free_port():
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_health(api, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with requests.get(api + "/health", timeout=2) as r:
                if r.status_code == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def percentile(values, p):
    """nearest-rank 百分位。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100.0 * len(ordered)))
    return round(ordered[min(rank - 1, len(ordered) - 1)], 2)


def summary(values):
    return {
        "count": len(values),
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
        "p99": percentile(values, 99),
        "max": round(max(values), 2) if values else 0.0,
        "avg": round(statistics.fmean(values), 2) if values else 0.0,
    }


def seed_projects(data_dir):
    store = project_workflow.WorkflowStore(data_dir / "workflow.db")
    projects = []
    for i in range(1, USERS + 1):
        pid = f"load-project-{i:02d}"
        title = f"并发验收项目 {i:02d}"
        vhash = project_workflow.WorkflowStore.hash_snapshot(
            title=title, version_no=1, method="IFPUG", params={"load": i},
            items=[{"name": f"需求 {i}"}], summary={"hours": i * 4})
        store.ensure(project_id=pid, title=title, version_no=1,
                     history_id=f"load-history-{i:02d}", version_hash=vhash)
        projects.append({"project_id": pid, "title": title, "hash": vhash})
    return projects


def _warmup(clients, projects, fail):
    # 顺序预热，避免把首次 history 扫描/连接建立计入正式样本
    for i, c in enumerate(clients):
        st, me, _ = c.call(API_AUTH_ME)
        if st != 200 or (me.get("user") or {}).get("username") != c.username:
            fail(f"预热 me 身份错误 user={i + 1} status={st}")
        st, _p, _ = c.call(API_WORKFLOW_PROJECTS)
        if st != 200:
            fail(f"预热项目列表失败 user={i + 1} status={st}")
        st, _d, _ = c.call(f"/api/workflow/project?project_id={projects[i]['project_id']}")
        if st != 200:
            fail(f"预热项目详情失败 user={i + 1} status={st}")


def _check_me(st, me, c, cycle, add_err):
    if st != 200 or (me.get("user") or {}).get("username") != c.username:
        add_err(f"cycle {cycle}: me 身份串号或失败 status={st}")


def _check_projects(st, pl, ep_ids, ep_titles, own_id, cycle, add_err):
    rows = (pl.get("projects") or []) if st == 200 else []
    ids = [r.get("project_id") for r in rows]
    if st != 200 or len(rows) != USERS or set(ids) != set(ep_ids):
        add_err(f"cycle {cycle}: 项目列表不完整/重复 status={st} rows={len(rows)}")
    elif ep_titles.get(own_id) not in [r.get("title") for r in rows]:
        add_err(f"cycle {cycle}: 列表缺少自己的项目 {own_id}")


def _check_detail(st, detail, own_id, own_title, own, cycle, add_err):
    p = (detail.get("project") or {}) if st == 200 else {}
    if st != 200 or p.get("project_id") != own_id or p.get("title") != own_title:
        add_err(f"cycle {cycle}: 详情串号 status={st} got={p.get('project_id')}/{p.get('title')}")
    elif p.get("version_hash") != own["hash"]:
        add_err(f"cycle {cycle}: 详情版本哈希不符 {p.get('version_hash')}")


def _check_transition(st, tr, c, own_id, own_title, action, cycle, add_err):
    tp = (tr.get("project") or {}) if st == 200 else {}
    if st != 200 or tp.get("project_id") != own_id or tp.get("title") != own_title:
        add_err(f"cycle {cycle}: 流转串号/失败 action={action} status={st}")
        return
    events = tp.get("events") or []
    if not events or events[-1].get("actor") != c.display_name:
        add_err(f"cycle {cycle}: 流转操作人错误 {events[-1].get('actor') if events else 'none'}")


def _run_cycle(call, c, own_id, own_title, own, ep_ids, ep_titles, cycle, add_err):
    st, me, _ = call("me", API_AUTH_ME)
    _check_me(st, me, c, cycle, add_err)
    st, pl, _ = call("projects", API_WORKFLOW_PROJECTS)
    _check_projects(st, pl, ep_ids, ep_titles, own_id, cycle, add_err)
    st, detail, _ = call("detail", f"/api/workflow/project?project_id={own_id}")
    _check_detail(st, detail, own_id, own_title, own, cycle, add_err)
    action = "submit_review" if cycle % 2 == 0 else "withdraw"
    st, tr, _ = call("transition", "/api/workflow/transition",
                     {"project_id": own_id, "action": action,
                      "opinion": "" if action == "withdraw" else "并发验收提交"})
    _check_transition(st, tr, c, own_id, own_title, action, cycle, add_err)


def _final_validation(clients, projects, args, errors):
    # 最终串号校验：每个项目事件只能是系统创建 + 自己会话的 8 次操作
    for i, c in enumerate(clients):
        own = projects[i]
        st, detail, _ = c.call(f"/api/workflow/project?project_id={own['project_id']}")
        p = (detail.get("project") or {}) if st == 200 else {}
        events = p.get("events") or []
        actors = {e.get("actor") for e in events}
        own_actions = [e for e in events if e.get("actor") == c.display_name]
        foreign = actors - {"系统", c.display_name}
        if st != 200 or foreign or len(own_actions) != args.cycles:
            errors.append(f"最终串号 user={i + 1} status={st} foreign={sorted(foreign)} "
                          f"own_actions={len(own_actions)}")
        if p.get("status") != ("draft" if args.cycles % 2 == 0 else "review"):
            errors.append(f"最终状态错误 user={i + 1} status={p.get('status')}")


def measure(args, clients, projects):
    latencies = []
    samples = {"me": [], "projects": [], "detail": [], "transition": []}
    errors = []
    lock = threading.Lock()
    barrier = threading.Barrier(USERS)
    ep_ids = [p["project_id"] for p in projects]
    ep_titles = {p["project_id"]: p["title"] for p in projects}

    def fail(msg):
        with lock:
            errors.append(msg)

    if args.warmup:
        _warmup(clients, projects, fail)

    def worker(i):
        c = clients[i]
        own = projects[i]
        own_id = own["project_id"]
        own_title = own["title"]
        barrier.wait()
        local = {"lat": [], "samples": {"me": [], "projects": [], "detail": [], "transition": []}, "err": []}

        def call(kind, path, payload=None):
            st, body, ms = c.call(path, payload)
            local["lat"].append(ms)
            local["samples"][kind].append(ms)
            return st, body, ms

        def add_err(msg):
            local["err"].append(msg)

        try:
            for cycle in range(args.cycles):
                _run_cycle(call, c, own_id, own_title, own, ep_ids, ep_titles, cycle, add_err)
        except threading.BrokenBarrierError:
            add_err("并发屏障被破坏")
        except Exception as e:
            add_err(f"线程异常 {type(e).__name__}: {e}")
        return local

    with ThreadPoolExecutor(max_workers=USERS) as pool:
        futures = [pool.submit(worker, i) for i in range(USERS)]
        for f in futures:
            local = f.result()
            latencies.extend(local["lat"])
            for k in samples:
                samples[k].extend(local["samples"][k])
            for e in local["err"]:
                errors.append(e)

    _final_validation(clients, projects, args, errors)
    return latencies, samples, errors


def _setup_accounts(api, clients, checks):
    admin = Client(api)
    clients.append(admin)
    st, boot, _ = admin.call("/api/auth/bootstrap", {
        "username": "load01", "password": PASSWORD, "display_name": "并发用户01"})
    checks.append({"name": "初始化管理员 load01", "ok": st == 200, "detail": st})
    if st != 200:
        raise RuntimeError(f"bootstrap failed {st} {boot}")
    admin.username = "load01"
    admin.display_name = "并发用户01"

    # 创建 19 个项目经理账号
    for i in range(2, USERS + 1):
        st, u, _ms = admin.call("/api/rbac/users", {
            "username": f"load{i:02d}", "password": PASSWORD,
            "display_name": f"并发用户{i:02d}", "role": "manager"})
        if st != 200:
            raise RuntimeError(f"create load{i:02d} failed {st} {u}")
    checks.append({"name": "创建 20 个独立会话账号", "ok": True,
                   "detail": "1 admin + 19 manager"})

    for i in range(2, USERS + 1):
        c = Client(api)
        st, login, _ = c.call("/api/auth/login", {"username": f"load{i:02d}", "password": PASSWORD})
        if st != 200:
            raise RuntimeError(f"login load{i:02d} failed {st} {login}")
        c.username = f"load{i:02d}"
        c.display_name = f"并发用户{i:02d}"
        clients.append(c)

    # 确认 20 个会话身份各自独立
    for i, c in enumerate(clients):
        st, me, _ = c.call(API_AUTH_ME)
        if st != 200 or (me.get("user") or {}).get("username") != c.username:
            raise RuntimeError(f"session identity mismatch {i}: {st} {me}")
    checks.append({"name": "20 个会话身份独立", "ok": True, "detail": "me 全部匹配"})

    # 首次项目列表触发 history 同步，放到预热/计时之外
    st, _pl, _ = admin.call(API_WORKFLOW_PROJECTS)
    if st != 200:
        raise RuntimeError(f"warm project list failed {st}")


def _record_metrics(args, latencies, samples, errors, result, checks, wall):
    result["requests"] = len(latencies)
    result["wall_seconds"] = round(wall, 2)
    result["throughput_rps"] = round(len(latencies) / wall, 1) if wall else 0
    result["latency_ms"] = summary(latencies)
    result["by_endpoint"] = {k: summary(v) for k, v in samples.items()}
    result["errors"] = errors
    p95 = result["latency_ms"]["p95"]
    checks.append({"name": "20 并发 p95 ≤300ms", "ok": p95 <= THRESHOLD_MS,
                   "detail": f"p95={p95}ms p50={result['latency_ms']['p50']}ms "
                             f"p99={result['latency_ms']['p99']}ms"})
    checks.append({"name": "20 会话无数据串号", "ok": not errors,
                   "detail": f"errors={len(errors)}"})
    checks.append({"name": "所有项目事件操作人正确", "ok": not errors,
                   "detail": "仅系统创建 + 本会话操作"})
    checks.append({"name": "20 会话并发完整完成", "ok": len(latencies) == USERS * args.cycles * 4,
                   "detail": f"{len(latencies)}/{USERS * args.cycles * 4} 请求"})


def _print_summary(checks, result, errors, wall):
    print("\n== concurrency ==")
    for x in checks:
        print(f"  {'PASS' if x['ok'] else 'FAIL'}  {x['name']}"
              + (f"  — {x['detail']}" if x['detail'] != '' else ""))
    print(f"\np50={result['latency_ms']['p50']}ms p95={result['latency_ms']['p95']}ms "
          f"p99={result['latency_ms']['p99']}ms max={result['latency_ms']['max']}ms "
          f"rps={result['throughput_rps']} wall={wall:.1f}s")
    if errors:
        print("errors:")
        for e in errors[:20]:
            print(" -", e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cycles", type=int, default=8)
    ap.add_argument("--users", type=int, default=USERS)
    ap.add_argument("--warmup", action="store_true", default=True)
    ap.add_argument("--no-warmup", dest="warmup", action="store_false")
    ap.add_argument("--result", default=str(ROOT / "docs" / "test-reports" / "phase3-20261122" / "results" / "concurrency.json"))
    args = ap.parse_args()
    if args.users != USERS:
        raise SystemExit("AC-27 固定 20 并发用户")

    port = free_port()
    api = f"http://127.0.0.1:{port}"
    tmp = Path(tempfile.mkdtemp(prefix="we_concurrency_"))
    data = tmp / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "config.json").write_text(json.dumps({"deployment": {"mode": "workgroup"},
                                                  "sso": {"enabled": False, "admin_fallback": True}},
                                                 ensure_ascii=False), encoding="utf-8")
    projects = seed_projects(data)
    log_path = tmp / "server.log"
    log_file = open(log_path, "w", encoding="utf-8")
    env = {**os.environ, "WE_DATA": str(data), "WE_UPDATE_URL": "off", "WE_LTASK_TEST": "1"}
    server = subprocess.Popen([PY, "-u", "scripts/server.py", str(port), "--serve-frontend"],
                              cwd=str(ROOT), env=env, stdout=log_file, stderr=subprocess.STDOUT,
                              text=True, encoding="utf-8", errors="replace")
    clients = []
    checks = []
    result = {"suite": "concurrency", "users": USERS, "cycles": args.cycles,
              "threshold_ms": THRESHOLD_MS, "requests": 0, "checks": checks,
              "environment": {"platform": platform.platform(),
                              "python": platform.python_version(),
                              "cpu_count": os.cpu_count(),
                              "database": "sqlite-wal",
                              "deployment": "workgroup"},
              "latency_ms": {}, "by_endpoint": {}, "errors": []}
    try:
        health = wait_health(api)
        checks.append({"name": "隔离工作组服务健康", "ok": health, "detail": api})
        if not health:
            print("--- server log ---\n" + log_path.read_text(encoding="utf-8", errors="replace")[-4000:])
            return 1
        _setup_accounts(api, clients, checks)
        wall0 = time.perf_counter()
        latencies, samples, errors = measure(args, clients, projects)
        wall = time.perf_counter() - wall0
        _record_metrics(args, latencies, samples, errors, result, checks, wall)
        _print_summary(checks, result, errors, wall)
    finally:
        for c in clients:
            c.close()
        try:
            server.terminate()
            server.wait(timeout=8)
        except Exception:
            try:
                server.kill()
            except Exception:
                pass
        log_file.close()

    result["pass"] = sum(1 for c in checks if c["ok"])
    result["total"] = len(checks)
    result["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    out = Path(args.result)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nconcurrency: {result['pass']}/{result['total']} checks passed")
    return 0 if result["pass"] == result["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
