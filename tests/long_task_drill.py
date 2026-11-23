# -*- coding: utf-8 -*-
"""T06180 长任务演练：取消 ≤2s / 断点落盘 / 服务重启后继续 / 续跑完成 / 路径校验。
用法：python tests/long_task_drill.py
"""
import base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = os.environ.get("PYTHON") or sys.executable
PORT = 8041
API = f"http://127.0.0.1:{PORT}"
DATA = Path(tempfile.gettempdir()) / "we_long_task_drill"
DOC = ROOT / "data" / "testdocs" / "t00928_req.docx"
b64 = base64.b64encode(DOC.read_bytes()).decode()
checks = []

def check(name, ok, detail=""):
    checks.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name} {detail}")

def start():
    env = dict(os.environ, WE_DATA=str(DATA), WE_UPDATE_URL="off", WE_LTASK_TEST="1")
    p = subprocess.Popen([PY, "-u", "scripts/server.py", str(PORT), "--serve-frontend"], cwd=ROOT,
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            urllib.request.urlopen(API + "/health", timeout=1)
            return p
        except Exception:
            time.sleep(0.3)
    raise RuntimeError("server not ready")

def stop(p):
    p.terminate()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill(); p.wait(timeout=10)

def call(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(API + path, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

shutil.rmtree(DATA, ignore_errors=True)
DATA.mkdir(parents=True, exist_ok=True)
p = start()
try:
    j = call("/api/recognize/jobs", {"job": "rdrill001", "name": "t00928_req.docx",
                                     "b64": b64, "params": {}, "stage_delay_ms": 1000})["job"]
    check("创建识别任务并显示进度/剩余时间", j["status"] == "running" and j.get("eta_s", 0) > 0, f"{j['pct']}% eta={j['eta_s']}s")
    time.sleep(0.4)
    t0 = time.perf_counter()
    canceled = call("/api/recognize/cancel", {"job": "rdrill001"})["job"]
    dt = time.perf_counter() - t0
    check("取消接口 ≤2s 返回", canceled["status"] == "canceled" and dt < 2, f"{dt:.3f}s")
    try:
        call("/api/recognize/job?job=../config")
        traversal_ok = False
    except urllib.error.HTTPError as e:
        traversal_ok = e.code == 404
    check("任务查询拒绝路径穿越", traversal_ok)
finally:
    stop(p)

time.sleep(1)
p = start()
try:
    recovered = call("/api/recognize/job?job=rdrill001")["job"]
    check("服务重启后恢复断点", recovered["status"] == "canceled" and recovered["pct"] >= 8,
          f"{recovered['status']} {recovered['pct']}% {recovered['stage']}")
    check("重启后仍可发起继续", call("/api/recognize/resume", {"job": "rdrill001"})["ok"])
    done = None
    for _ in range(80):
        time.sleep(0.4)
        cur = call("/api/recognize/job?job=rdrill001")["job"]
        if cur["status"] in ("done", "failed"):
            done = cur; break
    items = (done or {}).get("result", {}).get("items") or []
    check("续跑完成并带回功能点", done and done["status"] == "done" and len(items) > 0,
          f"{done['status'] if done else 'timeout'} items={len(items)}")
finally:
    stop(p)

time.sleep(1)
p = start()
try:
    j = call("/api/recognize/jobs", {"job": "rdeep001", "name": "t00928_req.docx",
                                     "b64": b64, "params": {}, "stage_delay_ms": 700})["job"]
    cur = j
    for _ in range(30):
        time.sleep(0.5)
        cur = call("/api/recognize/job?job=rdeep001")["job"]
        if cur["pct"] >= 54:
            break
    call("/api/recognize/cancel", {"job": "rdeep001"})
    check("解析完成后取消可保存本地候选断点", cur["pct"] >= 54, f"{cur['pct']}% {cur['stage']}")
finally:
    stop(p)

time.sleep(1)
p = start()
try:
    recovered = call("/api/recognize/job?job=rdeep001")["job"]
    check("重启后恢复解析断点（不退回 0%）", recovered["pct"] >= 54,
          f"{recovered['status']} {recovered['pct']}%")
    call("/api/recognize/resume", {"job": "rdeep001"})
    done = None
    for _ in range(80):
        time.sleep(0.4)
        cur = call("/api/recognize/job?job=rdeep001")["job"]
        if cur["status"] in ("done", "failed"):
            done = cur; break
    items = (done or {}).get("result", {}).get("items") or []
    check("深断点续跑完成且未重复解析", done and done["status"] == "done" and len(items) == 9,
          f"{done['status'] if done else 'timeout'} items={len(items)}")
finally:
    stop(p)

print(f"\n==== long-task drill ==== 通过 {sum(1 for _, ok in checks if ok)} / {len(checks)}")
sys.exit(0 if all(ok for _, ok in checks) else 1)
