# -*- coding: utf-8 -*-
"""生成 README 本地徽章（shields.io flat 样式，离线/内网可用，T01823）。

背景：README 原先直接引用 img.shields.io 外链图片，离线与内网环境渲染为断链。
本脚本把同样的事实画成本地 SVG，仓库自包含、无外部请求。

用法：python scripts/make_badges.py            # 生成到 assets/badges/
"""
import sys
from pathlib import Path

from PIL import ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "assets" / "badges"
FONT = r"C:\Windows\Fonts\arial.ttf"
# shields 用 DejaVu Sans（比 Arial 略宽），按实测比例放宽以留足余量
SCALE = 1.08
FONT_SIZE = 11
HEIGHT = 20
PAD = 6  # 文本左右内边距（每侧）

# (文件名, 左标签, 右值, 右色)
BADGES = [
    ("platform", "platform", "Windows 10+", "2563EB"),
    ("python", "python", "3.10+", "3776AB"),
    ("electron", "electron", "desktop", "47848F"),
    ("tests", "npm test", "12/12 passing", "16A34A"),
    ("i18n", "i18n", "中 / EN", "8B5CF6"),
]

TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{label}: {value}" width="{w}" height="{h}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="{w}" height="{h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="{lw}" height="{h}" fill="#555"/>
    <rect x="{lw}" width="{rw}" height="{h}" fill="#{color}"/>
    <rect width="{w}" height="{h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,Microsoft YaHei,sans-serif" font-size="{fs}">
    <text aria-hidden="true" x="{lxc}" y="14.2" fill="#010101" fill-opacity=".3">{label}</text>
    <text x="{lxc}" y="13.2">{label}</text>
    <text aria-hidden="true" x="{rxc}" y="14.2" fill="#010101" fill-opacity=".3">{value}</text>
    <text x="{rxc}" y="13.2">{value}</text>
  </g>
</svg>
"""


def text_width(s: str) -> float:
    font = ImageFont.truetype(FONT, FONT_SIZE)
    box = font.getbbox(s)
    return (box[2] - box[0]) * SCALE


def build(name: str, label: str, value: str, color: str) -> Path:
    lw = round(text_width(label) + PAD * 2)
    rw = round(text_width(value) + PAD * 2)
    svg = TEMPLATE.format(label=label, value=value, color=color, w=lw + rw, h=HEIGHT,
                          lw=lw, rw=rw, fs=FONT_SIZE, lxc=lw / 2, rxc=lw + rw / 2)
    path = OUTDIR / f"{name}.svg"
    path.write_text(svg, encoding="utf-8", newline="\n")
    return path


def main() -> int:
    OUTDIR.mkdir(parents=True, exist_ok=True)
    for badge in BADGES:
        p = build(*badge)
        print(f"built {p.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
