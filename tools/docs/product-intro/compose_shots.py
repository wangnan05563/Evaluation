# -*- coding: utf-8 -*-
"""把抓到的界面截图整理成文档图版：裁掉无关区域、拼多图、加细边框、统一宽度。
输入 build/shots/*.png（采集底图，仅本地产物），输出 docs/assets/product-intro/*.png（入库图版）。
成品宽度即文档里的展示宽度（220 dpi 折算），文档侧按同一宽度插入。
用法：python tools/docs/product-intro/compose_shots.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SHOTS = os.path.join(ROOT, "build", "shots")
OUT = os.path.join(ROOT, "docs", "assets", "product-intro")
os.makedirs(OUT, exist_ok=True)

BORDER = (0xCB, 0xD5, 0xE1)
INK = (0x1F, 0x4E, 0x79)
MUTED = (0x55, 0x60, 0x70)
GAP = 18
PAD = 10
DPI = 220


def font(size):
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf"):
        p = os.path.join("C:/Windows/Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def load(name):
    return Image.open(os.path.join(SHOTS, name)).convert("RGB")


def crop(name, box):
    return load(name).crop(box)


def bordered(img, width=2):
    out = Image.new("RGB", (img.width + 2 * width, img.height + 2 * width), BORDER)
    out.paste(img, (width, width))
    return out


def badge(img, text, size=96):
    """左上角序号：界面顶部本身是留白，叠一个圆角标签不遮内容。"""
    d = ImageDraw.Draw(img)
    f = font(size)
    pad = size // 3
    tw = d.textlength(text, font=f)
    x, y = 18, 14
    d.rounded_rectangle([x, y, x + tw + 2 * pad, y + size + pad], radius=size // 4,
                        fill=(255, 255, 255), outline=(0x2E, 0x74, 0xB5), width=max(3, size // 24))
    d.text((x + pad, y + pad // 2), text, font=f, fill=(0x2E, 0x74, 0xB5))
    return img


def vstack(imgs, gap=GAP, bg=(255, 255, 255)):
    w = max(i.width for i in imgs)
    h = sum(i.height for i in imgs) + gap * (len(imgs) - 1)
    out = Image.new("RGB", (w, h), bg)
    y = 0
    for i in imgs:
        out.paste(i, ((w - i.width) // 2, y))
        y += i.height + gap
    return out


def label_bar(text, width, height=64, size=34, bg=(255, 255, 255)):
    bar = Image.new("RGB", (width, height), bg)
    d = ImageDraw.Draw(bar)
    d.text((12, (height - size) // 2 - 4), text, font=font(size), fill=MUTED)
    d.line([(12, height - 8), (width - 12, height - 8)], fill=BORDER, width=2)
    return bar


def trim_white(img, thresh=248):
    """裁掉四周纯白边（Excel 导出会在空白行列留白）。"""
    gray = img.convert("L")
    w, h = gray.size
    px = gray.load()
    left, right, top, bottom = w, 0, h, 0
    step = 4
    for y in range(0, h, step):
        for x in range(0, w, step):
            if px[x, y] < thresh:
                left = min(left, x)
                right = max(right, x)
                top = min(top, y)
                bottom = max(bottom, y)
    if right <= left or bottom <= top:
        return img
    return img.crop((max(0, left - 6), max(0, top - 6), min(w, right + 8), min(h, bottom + 8)))


def save(img, name, cm, dpi=DPI):
    target = int(cm / 2.54 * dpi)
    if img.width != target:
        img = img.resize((target, round(img.height * target / img.width)), Image.LANCZOS)
    path = os.path.join(OUT, name)
    img.save(path, optimize=True)
    print("%-22s %4.1fcm  %dx%d  %d KB" % (name, cm, img.width, img.height, os.path.getsize(path) // 1024))


# 1) 封面主界面（IFPUG 估算页全景）
save(bordered(load("01_overview.png")), "fig_cover.png", 16.2)

# 2) 三步流程：三张同宽首屏纵向拼接，左上角标 ①②③（各自裁到内容结束处，避免大段空白）
strip = lambda n, bottom: crop(n, (0, 240, 3200, bottom))
flow = [badge(strip("flow_upload.png", 1080), "①"),
        badge(strip("01_overview.png", 1560), "②"),
        badge(strip("flow_result.png", 1560), "③")]
save(bordered(vstack(flow)), "fig_flow.png", 16.2)

# 3) 审核功能点表格（含底部汇总操作条）
save(bordered(load("03_review_table.png")), "fig_review.png", 12.0)

# 4) NESMA 快速估算
save(bordered(load("04_fast.png")), "fig_fast.png", 16.2)

# 5) PERT：阶段明细 + 汇总
save(bordered(vstack([load("pert_edit.png"), load("pert_gen.png")])), "fig_pert.png", 16.2)

# 6) 配置中心 · 大模型识别增强
save(bordered(load("06_config_llm.png")), "fig_llm.png", 11.5)

# 7) 成品 xlsx 两个 sheet：裁白边后各自加一条 sheet 名标签条
panels = []
for fname, title, w in (("xlsx_scale.png", "《规模估算》：明细 + 公式列（UFP / 重用 / 修改 / US）", 2600),
                        ("xlsx_fee.png", "《费用估算》：规模、工作量与费用区间", 2600)):
    im = trim_white(load(fname))
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    panels.append(vstack([label_bar(title, w), im], gap=0))
save(bordered(vstack(panels, gap=28)), "fig_xlsx.png", 13.5)

# 8) 历史版本对比
save(bordered(load("08_hist_diff.png")), "fig_diff.png", 16.2)

# 9) 用户故事
save(bordered(load("09_story.png")), "fig_story.png", 16.2)

# 10) 桌面版真实窗口（含标题栏）
save(bordered(load("10_desktop.png")), "fig_desktop.png", 14.0)

# 11) 英文 + 深色：截到第二排图表为止（下方图表的数值标签有重影，见派生单）
save(bordered(crop("11_en_dark.png", (0, 0, 3200, 1560))), "fig_en_dark.png", 16.2)

# 12) 历史估算列表（同一需求两版）
save(bordered(load("12_hist_list.png")), "fig_hist_list.png", 16.2)
