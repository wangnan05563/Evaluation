# -*- coding: utf-8 -*-
"""产品介绍文档构建入口：从仓库内图版重生成 docs/工作量评估助手-产品介绍.docx。

默认只跑「生成 docx」——图版（docs/assets/product-intro/*.png）已入库，新克隆开箱即用。
其余步骤按需开启：

    python tools/docs/product-intro/build.py                     # 生成 docx
    python tools/docs/product-intro/build.py --out /tmp/x.docx   # 输出到别处（不动入库件）
    python tools/docs/product-intro/build.py --preview           # 生成后导出逐页 PNG 目检
    python tools/docs/product-intro/build.py --capture           # 重采底图（Windows+Chrome+Electron+Excel）
    python tools/docs/product-intro/build.py --compose           # 用 release/shots 底图重拼图版
    python tools/docs/product-intro/build.py --capture --compose # 采集+拼图+生成，全链路

依赖：python-docx（必需）；--preview 另需 pymupdf + Word；--capture 另需 node、Chrome、
Electron（dev-shell）与 Excel（xlsx_shot.py 走 COM 导出）。采集与拼图是本机重出图版用的，
不是文档构建的必需环节。
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
ASSETS = os.path.join(ROOT, "docs", "assets", "product-intro")
DOCX = os.path.join(ROOT, "docs", "工作量评估助手-产品介绍.docx")
RAW_SHOTS = os.path.join(ROOT, "release", "shots")
PY = sys.executable


def run(step, argv, cwd=ROOT):
    print("\n[%s] %s" % (step, " ".join(argv)), flush=True)
    r = subprocess.run(argv, cwd=cwd)
    if r.returncode != 0:
        raise SystemExit("%s 失败：退出码 %d" % (step, r.returncode))


def capture():
    node = shutil.which("node")
    if not node:
        raise SystemExit("--capture 需要 node（未在 PATH 中找到）")
    run("capture-ui", [node, os.path.join(HERE, "shots.mjs")])
    run("capture-desktop", [node, os.path.join(HERE, "electron_shot.mjs")])
    xlsx = os.path.join(ROOT, "release", "tmp", "_shot_v1.xlsx")
    if not os.path.exists(xlsx):
        raise SystemExit("缺少 %s（由 capture-ui 生成），无法导出成品 xlsx 截图" % xlsx)
    run("capture-xlsx", [PY, os.path.join(HERE, "xlsx_shot.py"), xlsx])


def compose():
    if not os.path.isdir(RAW_SHOTS):
        raise SystemExit("--compose 需要底图目录 %s（先跑 --capture）" % RAW_SHOTS)
    run("compose", [PY, os.path.join(HERE, "compose_shots.py")])


def main():
    ap = argparse.ArgumentParser(description="生成产品介绍 docx（默认只用仓库内图版）")
    ap.add_argument("--out", help="输出 docx 路径，默认 docs/工作量评估助手-产品介绍.docx")
    ap.add_argument("--capture", action="store_true", help="重新采集底图到 release/shots")
    ap.add_argument("--compose", action="store_true", help="从 release/shots 底图重拼图版")
    ap.add_argument("--preview", action="store_true", help="生成后导出逐页 PNG 到 release/shots/doc_preview")
    ap.add_argument("--skip-docx", action="store_true", help="只跑采集/拼图，不生成 docx")
    args = ap.parse_args()

    if args.capture:
        capture()
    if args.compose:
        compose()
    if args.skip_docx:
        return

    figures = sorted(f for f in os.listdir(ASSETS) if f.lower().endswith(".png")) if os.path.isdir(ASSETS) else []
    if not figures:
        raise SystemExit("图版目录为空：%s（先跑 --capture --compose，或从仓库检出图版）" % ASSETS)

    out = os.path.abspath(args.out) if args.out else DOCX
    run("docx", [PY, os.path.join(HERE, "gen_docx.py"), out])
    print("文档：%s（%d 字节，图版 %d 张）" % (out, os.path.getsize(out), len(figures)))

    if args.preview:
        run("preview", [PY, os.path.join(HERE, "docx_preview.py"), out])


if __name__ == "__main__":
    main()
