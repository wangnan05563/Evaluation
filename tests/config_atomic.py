# -*- coding: utf-8 -*-
"""T06353 配置读写安全测试：损坏回退、原子写、备份。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = os.environ.get("PYTHON") or r"F:\Program Files\Python3.14\python.exe"
if not Path(PY).exists():
    PY = sys.executable
CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def run_case(name, setup, code, timeout=120):
    tmp = Path(tempfile.mkdtemp(prefix="we_config_"))
    data = tmp / "data"
    data.mkdir(parents=True, exist_ok=True)
    setup(data)
    env = {**os.environ, "WE_DATA": str(data), "WE_UPDATE_URL": "off"}
    script = (
        "import json, sys\n"
        "sys.path.insert(0, r'" + str(ROOT) + "')\n"
        "from scripts import server\n"
        + code
    )
    p = subprocess.run([PY, "-c", script], cwd=str(ROOT), env=env,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout)
    check(name, p.returncode == 0, (p.stdout + p.stderr).strip()[-500:])
    shutil.rmtree(tmp, ignore_errors=True)


def main():
    run_case(
        "主/备配置均损坏时 fail-closed 到 workgroup",
        lambda d: ((d / "config.json").write_text("{bad", encoding="utf-8"),
                   (d / "config.json.bak").write_text("{also_bad", encoding="utf-8")),
        "assert server.load_config()['deployment']['mode'] == 'workgroup'\n",
    )
    run_case(
        "配置文件不存在时保持 standalone 默认",
        lambda d: None,
        "assert server.load_config()['deployment']['mode'] == 'standalone'\n",
    )
    run_case(
        "save_config 原子替换并保留上一次备份",
        lambda d: (d / "config.json").write_text(json.dumps(
            {"provider": "agnes", "deployment": {"mode": "workgroup"}}), encoding="utf-8"),
        "server.save_config({'deployment': {'mode': 'standalone'}})\n"
        "cfg=json.loads(server.CONF_FILE.read_text(encoding='utf-8'))\n"
        "assert cfg['deployment']['mode'] == 'standalone'\n"
        "assert server.CONF_BAK.exists()\n"
        "assert not server.CONF_TMP.exists()\n",
    )
    run_case(
        "主配置损坏但备份可用时，写回不覆盖可用备份",
        lambda d: ((d / "config.json").write_text("{bad", encoding="utf-8"),
                   (d / "config.json.bak").write_text(json.dumps(
                       {"provider": "agnes", "deployment": {"mode": "workgroup"}}), encoding="utf-8")),
        "server.save_config({'deployment': {'mode': 'standalone'}})\n"
        "cfg=json.loads(server.CONF_FILE.read_text(encoding='utf-8'))\n"
        "bak=json.loads(server.CONF_BAK.read_text(encoding='utf-8'))\n"
        "assert cfg['provider'] == 'agnes'\n"
        "assert cfg['deployment']['mode'] == 'standalone'\n"
        "assert bak['provider'] == 'agnes'\n",
    )
    run_case(
        "替换失败时保留原文件且清理 tmp",
        lambda d: (d / "config.json").write_text(json.dumps(
            {"provider": "agnes", "deployment": {"mode": "workgroup"}}), encoding="utf-8"),
        "orig=server.os.replace\n"
        "def boom(a,b): raise OSError('simulated replace failure')\n"
        "server.os.replace=boom\n"
        "try:\n"
        "    server.save_config({'deployment': {'mode': 'standalone'}})\n"
        "except OSError:\n"
        "    pass\n"
        "finally:\n"
        "    server.os.replace=orig\n"
        "cfg=json.loads(server.CONF_FILE.read_text(encoding='utf-8'))\n"
        "assert cfg['deployment']['mode'] == 'workgroup'\n"
        "assert not server.CONF_TMP.exists()\n",
    )
    return 0 if all(x["ok"] for x in CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
