# -*- coding: utf-8 -*-
"""AC-31：把品牌包编译为 NSIS 安装器品牌资源。

输入只认主题 JSON（与 Theme Studio / 报告表头同源）：
- 优先 data/theme_active.json
- 其次 %APPDATA%/WorkloadEval/theme_active.json
- 最后回退 data/themes/base.json

输出（默认 release/brand/）：
- installerHeader.bmp   150x57，NSIS MUI 页眉
- installerSidebar.bmp  164x314，NSIS 欢迎页/完成页侧栏
- uninstallerSidebar.bmp 164x314，卸载器侧栏
- brand-assets.json     主题名、解析色值、尺寸与 SHA-256，供构建/验收核对

只配置品牌包即可换色，不需要改 NSIS 脚本或前端代码。图标沿用产品统一
assets/we_icon.ico，避免品牌换色时误改产品识别。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import theme_tokens  # noqa: E402

HEADER_SIZE = (150, 57)
SIDEBAR_SIZE = (164, 314)
DEFAULT_OUT = ROOT / "release" / "brand"
FONT_CANDIDATES = (
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "msyhbd.ttc",
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "msyh.ttc",
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "simhei.ttf",
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "Deng.ttf",
)
PRODUCT_NAME = "工作量评估工具"
PRODUCT_EN = "WorkloadEval"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = FONT_CANDIDATES if bold else FONT_CANDIDATES[:1] + FONT_CANDIDATES[1:]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            return ImageFont.truetype(str(path), size)
        except Exception:
            continue
    try:
        return ImageFont.truetype("arial.ttf", size)
    except Exception:
        return ImageFont.load_default()


def _fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int,
              start: int, bold: bool = True) -> ImageFont.ImageFont:
    for size in range(start, 5, -1):
        font = _font(size, bold)
        if draw.textlength(text, font=font) <= max_width:
            return font
    return _font(6, bold)


def _read_theme(path: Path):
    try:
        theme = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise theme_tokens.ThemeError(f"读取主题失败 {path}: {exc}") from exc
    errors, normalized = theme_tokens.validate(theme)
    if errors:
        raise theme_tokens.ThemeError("；".join(errors))
    return normalized


def resolve_theme(theme_path: str | None, data_dir: str | None) -> tuple[dict, Path]:
    candidates = []
    if theme_path:
        candidates.append(Path(theme_path))
    else:
        candidates.append(ROOT / "data" / "theme_active.json")
        appdata = Path(os.environ.get("APPDATA", ""))
        if appdata:
            candidates.append(appdata / "WorkloadEval" / "theme_active.json")
        if data_dir:
            candidates.append(Path(data_dir) / "theme_active.json")
        candidates.append(ROOT / "data" / "themes" / "base.json")
    for path in candidates:
        if path.is_file():
            return _read_theme(path), path
    raise theme_tokens.ThemeError("未找到品牌包：请传 --theme，或放置 data/theme_active.json")


def _best_text(brand: str, candidates: list[str]) -> str:
    best, best_ratio = candidates[0], -1.0
    for value in candidates:
        ratio = theme_tokens.contrast_ratio(value, brand)
        if ratio is None:
            continue
        if ratio >= 4.5:
            return value
        if ratio > best_ratio:
            best, best_ratio = value, ratio
    return best


def _rounded(draw: ImageDraw.ImageDraw, box, radius: int, fill: str) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def render_header(theme: dict) -> Image.Image:
    res = theme["resolved"]["semantic"]
    brand = res.get("brand") or "#2563EB"
    bg = res.get("bg") or "#FFFFFF"
    ink = res.get("ink") or "#1F2937"
    muted = res.get("muted") or "#5B6472"
    soft = res.get("brand-soft") or bg
    text_on_brand = _best_text(brand, ["#FFFFFF", ink, "#111827"])

    img = Image.new("RGB", HEADER_SIZE, bg)
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, 5, HEADER_SIZE[1]), fill=brand)
    _rounded(draw, (12, 16, 37, 41), 5, brand)
    mark_font = _fit_font(draw, "WE", 22, 10)
    tw = draw.textlength("WE", font=mark_font)
    draw.text((12 + (25 - tw) / 2, 18), "WE", font=mark_font, fill=text_on_brand)
    name_font = _fit_font(draw, PRODUCT_NAME, 96, 11)
    draw.text((44, 9), PRODUCT_NAME, font=name_font, fill=ink)
    sub_font = _font(7)
    draw.text((44, 27), f"{PRODUCT_EN} · 品牌安装包", font=sub_font, fill=muted)
    draw.rectangle((44, 43, 140, 44), fill=soft)
    return img


def render_sidebar(theme: dict) -> Image.Image:
    res = theme["resolved"]["semantic"]
    brand = res.get("brand") or "#2563EB"
    ink = res.get("ink") or "#1F2937"
    brand_ink = res.get("brand-ink") or brand
    text_on_brand = _best_text(brand, ["#FFFFFF", ink, "#111827"])

    img = Image.new("RGB", SIDEBAR_SIZE, brand)
    draw = ImageDraw.Draw(img)
    # 轻量品牌几何：右下角用更深的品牌色做一条斜切，避免纯色块过于单调
    draw.polygon([(0, 314), (164, 212), (164, 314)], fill=brand_ink)
    # 顶部徽标
    _rounded(draw, (44, 38, 120, 114), 14, text_on_brand)
    mark_font = _fit_font(draw, "WE", 60, 38)
    tw = draw.textlength("WE", font=mark_font)
    draw.text((44 + (76 - tw) / 2, 49), "WE", font=mark_font, fill=brand)
    name_font = _fit_font(draw, PRODUCT_NAME, 140, 15)
    tw = draw.textlength(PRODUCT_NAME, font=name_font)
    draw.text(((164 - tw) / 2, 144), PRODUCT_NAME, font=name_font, fill=text_on_brand)
    draw.rectangle((28, 174, 136, 175), fill=text_on_brand)
    sub_font = _font(10)
    label = "品牌安装包"
    tw = draw.textlength(label, font=sub_font)
    draw.text(((164 - tw) / 2, 186), label, font=sub_font, fill=text_on_brand)
    en_font = _font(7)
    tw = draw.textlength(PRODUCT_EN, font=en_font)
    draw.text(((164 - tw) / 2, 205), PRODUCT_EN, font=en_font, fill=text_on_brand)
    theme_label = str(theme.get("label") or theme.get("name") or "")
    tag_font = _fit_font(draw, theme_label, 132, 9, bold=False)
    tw = draw.textlength(theme_label, font=tag_font)
    draw.text(((164 - tw) / 2, 282), theme_label, font=tag_font, fill=text_on_brand)
    return img


def build_assets(theme: dict, source: Path, out_dir: Path,
                 preview_dir: Path | None = None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    header = render_header(theme)
    sidebar = render_sidebar(theme)
    files = {
        "installerHeader.bmp": header,
        "installerSidebar.bmp": sidebar,
        "uninstallerSidebar.bmp": sidebar.copy(),
    }
    for name, image in files.items():
        image.save(out_dir / name, "BMP")
    if preview_dir:
        preview_dir.mkdir(parents=True, exist_ok=True)
        header.save(preview_dir / "installerHeader.png", "PNG")
        sidebar.save(preview_dir / "installerSidebar.png", "PNG")

    res = theme["resolved"]["semantic"]
    manifest = {
        "schema": "brand-installer-assets/v1",
        "theme": {
            "name": theme["name"],
            "label": theme.get("label"),
            "version": theme.get("version", 1),
            "source": str(source),
        },
        "brand": {
            "brand": res.get("brand"),
            "brand_ink": res.get("brand-ink"),
            "brand_soft": res.get("brand-soft"),
            "bg": res.get("bg"),
            "ink": res.get("ink"),
        },
        "product": PRODUCT_NAME,
        "assets": {
            name: {
                "size": list(files[name].size),
                "mode": files[name].mode,
                "sha256": _sha256(out_dir / name),
            }
            for name in files
        },
        "icon": "assets/we_icon.ico",
    }
    (out_dir / "brand-assets.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def verify_assets(out_dir: Path, theme: dict) -> list[str]:
    errors = []
    expected = {
        "installerHeader.bmp": HEADER_SIZE,
        "installerSidebar.bmp": SIDEBAR_SIZE,
        "uninstallerSidebar.bmp": SIDEBAR_SIZE,
    }
    for name, size in expected.items():
        path = out_dir / name
        if not path.is_file():
            errors.append(f"缺少资源：{name}")
            continue
        try:
            with Image.open(path) as img:
                if img.size != size:
                    errors.append(f"{name} 尺寸 {img.size} != {size}")
                if img.mode != "RGB":
                    errors.append(f"{name} 模式 {img.mode} != RGB")
        except Exception as exc:
            errors.append(f"{name} 无法读取：{exc}")
    manifest_path = out_dir / "brand-assets.json"
    if not manifest_path.is_file():
        errors.append("缺少 brand-assets.json")
        return errors
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"brand-assets.json 无法解析：{exc}")
        return errors
    if manifest.get("theme", {}).get("name") != theme["name"]:
        errors.append("manifest 主题名不一致")
    expected_brand = theme["resolved"]["semantic"].get("brand")
    if manifest.get("brand", {}).get("brand") != expected_brand:
        errors.append("manifest 品牌主色不一致")
    for name in expected:
        got = manifest.get("assets", {}).get(name, {}).get("sha256")
        if got != _sha256(out_dir / name):
            errors.append(f"{name} 哈希不一致")
    # 页眉/侧栏必须真实带品牌主色，防止只生成纯白占位图
    brand_rgb = theme_tokens._hex_rgb(expected_brand)
    if brand_rgb:
        for name in ("installerHeader.bmp", "installerSidebar.bmp"):
            with Image.open(out_dir / name).convert("RGB") as img:
                colors = img.getcolors(maxcolors=1 << 24) or []
                if not any(rgb == brand_rgb and count > 0 for count, rgb in colors):
                    errors.append(f"{name} 未出现品牌主色 {expected_brand}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成 NSIS 安装器品牌资源（AC-31）")
    parser.add_argument("--theme", help="品牌包 JSON 路径；缺省读 theme_active.json / base")
    parser.add_argument("--data-dir", help="额外搜索 theme_active.json 的数据目录")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出目录，默认 release/brand")
    parser.add_argument("--preview-dir", help="额外输出 PNG 预览，供验收报告引用")
    parser.add_argument("--verify", action="store_true", help="生成后校验尺寸、哈希与主色")
    parser.add_argument("--ensure-default", action="store_true",
                        help="无激活主题时回退 base（构建链使用；语义与默认行为一致）")
    args = parser.parse_args(argv)
    try:
        theme, source = resolve_theme(args.theme, args.data_dir)
        manifest = build_assets(theme, source, Path(args.out), Path(args.preview_dir) if args.preview_dir else None)
    except theme_tokens.ThemeError as exc:
        print(f"[brand-installer] ERROR {exc}")
        return 2
    print(f"[brand-installer] theme={manifest['theme']['name']} brand={manifest['brand']['brand']}")
    for name, info in manifest["assets"].items():
        print(f"[brand-installer] {name} {info['size'][0]}x{info['size'][1]} sha256={info['sha256'][:12]}")
    if args.verify:
        errors = verify_assets(Path(args.out), theme)
        if errors:
            for error in errors:
                print(f"[brand-installer] VERIFY FAIL {error}")
            return 1
        print("[brand-installer] VERIFY OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
