# -*- coding: utf-8 -*-
"""AC-38：新环境启动本地服务后，健康检查在 5 分钟内返回通过/风险/阻断项。"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _wait_health(process, port, deadline):
    body, status, error = None, None, None
    while time.time() < deadline:
        if process.poll() is not None:
            error = f"server exited {process.returncode}: " + (process.stderr.read() or b"").decode("utf-8", "replace")[-400:]
            break
        body = None
        for path in ("/health", "/api/health"):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=3) as r:
                    status = r.status
                    body = json.loads(r.read().decode("utf-8"))
                break
            except Exception:
                continue
        if body is not None:
            break
        time.sleep(1)
    return body, status, error


def main(out_path=""):
    data = Path(tempfile.mkdtemp())
    env = dict(os.environ, WE_DATA=str(data))
    port = 8099
    t0 = time.time()
    p = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "server.py"), str(port), "--no-open"],
                         cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        body, status, error = _wait_health(p, port, t0 + 300)
    finally:
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except Exception:
                p.kill()
    elapsed = round(time.time() - t0, 2)
    result = {"ok": body is not None, "http_status": status, "elapsed_sec": elapsed,
              "threshold_sec": 300, "body": body, "error": error,
              "pass": bool(body is not None and elapsed <= 300)}
    text = json.dumps(result, ensure_ascii=False, indent=1)
    print(text)
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(text, encoding="utf-8")
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
