# -*- coding: utf-8 -*-
"""T06171：三层 Token（raw / semantic / component）加载、校验与主题文件管理。

设计约束：
- 组件只消费 CSS 变量（semantic 层），新增主题只改 JSON，不改组件代码。
- component 层是把语义 token 显式绑定到具体组件变量（`--c-button-primary-bg`），
  供后续组件按需消费；当前核心按钮仍消费 semantic 的 `--brand`，两者同源。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THEMES_DIR = ROOT / "data" / "themes"
MAX_BYTES = 50 * 1024
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,31}$")
VAR_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
REF_RE = re.compile(r"^\{(raw|semantic)\.([A-Za-z0-9_.-]+)\}$")
HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

CATEGORIES = ("color", "font", "space", "radius", "shadow", "motion")
MIN_CONTRAST = 4.5

# T06193：主题工作室保存前的 WCAG 2.2 AA 文字对比度阻断表。
# 前景/背景都取自 validate() 解析后的 semantic/component 值，避免只校验原始引用。
CONTRAST_PAIRS = (
    ("ink_bg", "正文 / 页面背景", ("semantic", "ink"), ("semantic", "bg")),
    ("ink2_bg", "次级正文 / 页面背景", ("semantic", "ink-2"), ("semantic", "bg")),
    ("muted_bg", "弱化文字 / 页面背景", ("semantic", "muted"), ("semantic", "bg")),
    ("ink_card", "正文 / 卡片背景", ("semantic", "ink"), ("semantic", "card")),
    ("button", "主按钮文字 / 主按钮背景",
     ("component", "button.primary.foreground"),
     ("component", "button.primary.background")),
    ("badge", "品牌徽标文字 / 品牌徽标背景",
     ("component", "badge.brand.foreground"),
     ("component", "badge.brand.background")),
)


class ThemeError(ValueError):
    pass


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def builtin_names():
    if not THEMES_DIR.is_dir():
        return []
    names = []
    for p in sorted(THEMES_DIR.glob("*.json")):
        try:
            t = _read(p)
            if NAME_RE.match(str(t.get("name", ""))):
                names.append({"name": t["name"], "label": t.get("label") or t["name"]})
        except Exception:
            continue
    return names


def load(name=None):
    """按名加载内置主题；name=None 返回全部。路径只来自 THEMES_DIR 的枚举，不拼接用户路径。"""
    if name:
        if not NAME_RE.match(name):
            raise ThemeError("主题名不合法")
        for info in builtin_names():
            if info["name"] == name:
                return validate(_read(THEMES_DIR / f"{name}.json"))[1]
        raise ThemeError(f"主题不存在：{name}")
    return [validate(_read(THEMES_DIR / f"{x['name']}.json"))[1] for x in builtin_names()]


def _resolve(ref, theme, depth=0):
    if isinstance(ref, (int, float)) and not isinstance(ref, bool):
        return str(ref)
    if not isinstance(ref, str):
        raise ThemeError("token 值必须是字符串或数字")
    if depth > 8:
        raise ThemeError("token 引用层级过深")
    m = REF_RE.match(ref.strip())
    key = None
    layer = None
    if m:
        layer, key = m.group(1), m.group(2)
    elif ref.startswith("raw.") or ref.startswith("semantic."):
        layer, key = ref.split(".", 1)
    if layer == "raw":
        if key not in theme.get("raw", {}):
            raise ThemeError(f"raw 引用不存在：{key}")
        return _resolve(theme["raw"][key], theme, depth + 1)
    if layer == "semantic":
        if key not in theme.get("semantic", {}):
            raise ThemeError(f"semantic 引用不存在：{key}")
        return _resolve(theme["semantic"][key], theme, depth + 1)
    return ref


def _hex_rgb(value):
    """把 #RGB / #RRGGBB 解析为 0..255 三元组；非十六进制返回 None。"""
    text = str(value or "").strip()
    if not HEX_RE.match(text):
        return None
    h = text[1:]
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


def _luminance(rgb):
    def channel(c):
        x = c / 255.0
        return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(fg, bg):
    """WCAG 相对亮度对比度；任一颜色不可解析时返回 None。"""
    a, b = _hex_rgb(fg), _hex_rgb(bg)
    if a is None or b is None:
        return None
    la, lb = _luminance(a), _luminance(b)
    light, dark = max(la, lb), min(la, lb)
    return (light + 0.05) / (dark + 0.05)


def _resolved_pair(layer, key, resolved):
    return resolved.get(layer, {}).get(key)


def contrast_checks(resolved):
    """返回 (checks, errors)。checks 用于 API/前端展示，errors 用于阻断保存。"""
    checks, errors = [], []
    for key, label, fg_ref, bg_ref in CONTRAST_PAIRS:
        fg = _resolved_pair(fg_ref[0], fg_ref[1], resolved)
        bg = _resolved_pair(bg_ref[0], bg_ref[1], resolved)
        if fg is None or bg is None:
            errors.append(f"对比度检查缺少令牌：{label}")
            checks.append({"key": key, "label": label, "fg": fg, "bg": bg,
                           "ratio": None, "min": MIN_CONTRAST, "ok": False})
            continue
        ratio = contrast_ratio(fg, bg)
        if ratio is None:
            errors.append(f"对比度检查无法解析颜色：{label}（{fg} / {bg}）")
            checks.append({"key": key, "label": label, "fg": fg, "bg": bg,
                           "ratio": None, "min": MIN_CONTRAST, "ok": False})
            continue
        rounded = round(ratio, 2)
        ok = ratio >= MIN_CONTRAST
        if not ok:
            errors.append(f"对比度不足：{label} = {rounded:.2f}:1（要求 ≥ {MIN_CONTRAST}:1）")
        checks.append({"key": key, "label": label, "fg": fg, "bg": bg,
                       "ratio": rounded, "min": MIN_CONTRAST, "ok": ok})
    return checks, errors


def validate(theme):
    """返回 (errors, normalized)。errors 为空才算合法；normalized 带解析后的 css 变量。"""
    errors = []
    if not isinstance(theme, dict):
        return ["主题必须是 JSON 对象"], None
    name = str(theme.get("name") or "")
    if not NAME_RE.match(name):
        errors.append("name 必须为 2–32 位小写字母/数字/连字符")
    label = str(theme.get("label") or name)
    if len(label) > 40:
        errors.append("label 最长 40 字符")
    if not isinstance(theme.get("version", 1), int):
        errors.append("version 必须是整数")
    for layer in ("raw", "semantic", "component"):
        obj = theme.get(layer)
        if not isinstance(obj, dict) or not obj:
            errors.append(f"{layer} 层必须是非空对象")
            continue
        if len(obj) > 200:
            errors.append(f"{layer} 层最多 200 个 token")
    if errors:
        return errors, None
    raw, sem, comp = theme["raw"], theme["semantic"], theme["component"]
    # raw 键用于被引用，不直接落 CSS；只校验命名与值类型
    for k, v in raw.items():
        if not VAR_RE.match(k):
            errors.append(f"raw 键不合法：{k}")
        if not isinstance(v, (str, int, float)):
            errors.append(f"raw.{k} 必须是字符串或数字")
    for k in sem:
        if not VAR_RE.match(k):
            errors.append(f"semantic 键不合法：{k}（将作为 --{k} 写入）")
    for k in comp:
        if not re.match(r"^[a-z0-9][a-z0-9.-]*$", k):
            errors.append(f"component 键不合法：{k}")
    if errors:
        return errors, None
    resolved_sem = {}
    for k, v in sem.items():
        try:
            resolved_sem[k] = _resolve(v, theme)
        except ThemeError as e:
            errors.append(f"semantic.{k}: {e}")
    resolved_comp = {}
    for k, v in comp.items():
        try:
            resolved_comp[k] = _resolve(v, theme)
        except ThemeError as e:
            errors.append(f"component.{k}: {e}")
    if errors:
        return errors, None
    resolved = {"semantic": resolved_sem, "component": resolved_comp}
    checks, contrast_errors = contrast_checks(resolved)
    if contrast_errors:
        errors.extend(contrast_errors)
    try:
        if len(json.dumps(theme, ensure_ascii=False).encode("utf-8")) > MAX_BYTES:
            errors.append("主题 JSON 超过 50KB")
    except Exception:
        errors.append("主题 JSON 不可序列化")
    if errors:
        return errors, None
    normalized = {
        "name": name,
        "label": label,
        "version": theme.get("version", 1),
        "raw": raw,
        "semantic": sem,
        "component": comp,
        "resolved": resolved,
        "contrast": checks,
    }
    return [], normalized


def load_active(data_dir):
    path = Path(data_dir) / "theme_active.json"
    if not path.is_file():
        return None
    try:
        errors, normalized = validate(_read(path))
        return normalized if not errors else None
    except Exception:
        return None


def save_active(data_dir, theme):
    errors, normalized = validate(theme)
    if errors:
        raise ThemeError("；".join(errors))
    path = Path(data_dir) / "theme_active.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(theme, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    return normalized


def reset_active(data_dir):
    path = Path(data_dir) / "theme_active.json"
    try:
        path.unlink()
    except FileNotFoundError:
        pass
