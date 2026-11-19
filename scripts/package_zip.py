# -*- coding: utf-8 -*-
"""把可重复运行的脚本与前端静态资源打成确定性 zip（build 唯一入口）。

为什么不用 PowerShell Compress-Archive：本机实测它在包含中文路径/多进程环境时
会卡住并把目标文件留成 0 字节（2026-11-19 构建卡在 [4/6] 超过 20 分钟）。
这里用标准库 zipfile，固定时间戳、排序写入，产物可复现且失败会立即抛错。
"""
import os
import sys
import zipfile
from pathlib import Path

OUT = Path(sys.argv[1])
ROOTS = [Path(p) for p in sys.argv[2:]] or [Path("scripts"), Path("frontend")]
SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".pytest_cache"}
SKIP_SUFFIX = {".pyc", ".pyo", ".log", ".tmp"}
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def iter_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            p = Path(dirpath) / name
            if p.suffix.lower() in SKIP_SUFFIX:
                continue
            yield p


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_name(OUT.name + ".tmp")
    if tmp.exists():
        tmp.unlink()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root in ROOTS:
            if not root.exists():
                raise SystemExit(f"[zip] 缺少目录: {root}")
            for p in iter_files(root):
                arc = p.as_posix()
                zi = zipfile.ZipInfo(arc, date_time=FIXED_TIME)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                with open(p, "rb") as f:
                    z.writestr(zi, f.read())
    os.replace(tmp, OUT)
    print(f"[zip] {OUT} {OUT.stat().st_size} 字节")


if __name__ == "__main__":
    main()
