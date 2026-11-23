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

CATEGORIES = ("color", "font", "space", "radius", "shadow", "motion")


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
        "resolved": {"semantic": resolved_sem,
                     "component": {k: v for k, v in resolved_comp.items()}},
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
