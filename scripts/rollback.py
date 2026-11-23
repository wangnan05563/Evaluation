# -*- coding: utf-8 -*-
"""AC-39 升级回滚命令行：列出/恢复升级前备份（数据 + 配置 + schema 版本）。

用法（在安装目录 resources/we-eval/ 下，或开发仓库根）：
    python scripts/rollback.py --list
    python scripts/rollback.py --backup 20261123-101500
    python scripts/rollback.py --latest

数据目录优先级：--data-dir > WE_DATA > %APPDATA%\\WorkloadEval（打包）> 仓库 data/（开发）。
回滚过程写入 <data>/logs/rollback.jsonl，成功/失败均有记录。
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import datakeeper  # noqa: E402


def default_data_dir():
    env = os.environ.get("WE_DATA")
    if env:
        return Path(env)
    if getattr(sys, "frozen", False):
        return Path(os.environ.get("APPDATA") or Path(sys.executable).parent) / "WorkloadEval"
    return Path(__file__).resolve().parent.parent / "data"


def main():
    ap = argparse.ArgumentParser(description="工作量评估工具升级回滚")
    ap.add_argument("--data-dir", default="", help="数据目录（默认自动识别）")
    ap.add_argument("--list", action="store_true", help="列出可用备份")
    ap.add_argument("--backup", default="", help="指定备份 id（backups/ 下的目录名）")
    ap.add_argument("--latest", action="store_true", help="恢复最近一份备份（默认行为）")
    args = ap.parse_args()
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    if not data_dir.is_dir():
        print(json.dumps({"ok": False, "error": f"数据目录不存在：{data_dir}"}, ensure_ascii=False))
        return 2
    if args.list:
        print(json.dumps({"ok": True, "data_dir": str(data_dir),
                          "backups": datakeeper.list_backups(str(data_dir))},
                         ensure_ascii=False, indent=1))
        return 0
    try:
        result = datakeeper.restore_backup(str(data_dir), args.backup or None)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
