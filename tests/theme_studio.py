# -*- coding: utf-8 -*-
"""T06193 主题工作室：三层 Token 对比度阻断与主题保存测试。"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import theme_tokens as T

CASES = []


def check(name, cond, detail=""):
    CASES.append((name, bool(cond), detail))


def load_raw(name):
    return json.loads((ROOT / "data" / "themes" / f"{name}.json").read_text(encoding="utf-8"))


def mutate(base, changes=None, **kw):
    theme = json.loads(json.dumps(base))
    merged = dict(changes or {})
    merged.update(kw)
    for key, value in merged.items():
        layer, token = key.split("__", 1)
        theme[layer][token] = value
    return theme


def main():
    base = load_raw("base")
    lime = load_raw("lime")

    errors, norm = T.validate(base)
    check("默认主题通过校验", not errors and norm is not None, str(errors))
    check("默认主题输出 6 组对比度检查", len(norm["contrast"]) == 6, str(norm.get("contrast")))
    check("默认主题 6/6 对比度通过", all(c["ok"] for c in norm["contrast"]), str(norm["contrast"]))
    check("默认主题主按钮对比度 5.17:1", [c["ratio"] for c in norm["contrast"] if c["key"] == "button"] == [5.17],
          str(norm["contrast"]))

    errors, norm = T.validate(lime)
    check("青柠主题通过校验", not errors and norm is not None, str(errors))
    check("青柠主题主按钮改为深色文字后对比度 7.4:1",
          [c["ratio"] for c in norm["contrast"] if c["key"] == "button"] == [7.4], str(norm["contrast"]))

    low = mutate(base, semantic__brand="#FFFF00")
    low["component"]["button.primary.foreground"] = "#FFFFFF"
    low["label"] = "低对比"
    errors, norm = T.validate(low)
    check("低对比主题被拒绝", bool(errors) and norm is None, str(errors))
    check("拒绝原因包含主按钮对比度不足",
          any("对比度不足" in e and "主按钮" in e for e in errors), str(errors))

    readable = mutate(base, {
        "semantic__brand": "#FFFF00",
        "semantic__brand-ink": "#FFFF00",
        "semantic__brand-soft": "#1A1A00",
        "component__button.primary.foreground": "#000000",
    })
    readable["name"] = "high-contrast-brand"
    errors, norm = T.validate(readable)
    check("修正按钮文字后同主色可通过", not errors and norm is not None, str(errors))
    check("修正后主按钮对比度 19.56:1",
          [c["ratio"] for c in norm["contrast"] if c["key"] == "button"] == [19.56], str(norm["contrast"]))

    bad_color = mutate(base, semantic__ink="not-a-color")
    errors, norm = T.validate(bad_color)
    check("不可解析颜色被阻断", bool(errors) and any("无法解析颜色" in e for e in errors), str(errors))

    with tempfile.TemporaryDirectory() as tmp:
        try:
            T.save_active(tmp, low)
            check("save_active 拒绝低对比主题", False)
        except T.ThemeError as e:
            check("save_active 拒绝低对比主题", "对比度不足" in str(e), str(e))
        saved = T.save_active(tmp, readable)
        check("save_active 写入达标主题并返回对比度", saved["contrast"] and saved["name"] == "high-contrast-brand",
              str(saved))
        loaded = T.load_active(tmp)
        check("持久化后重新加载主题", loaded is not None and loaded["name"] == "high-contrast-brand", str(loaded))
        T.reset_active(tmp)
        check("重置后无生效主题", T.load_active(tmp) is None)

    failed = [c for c in CASES if not c[1]]
    for name, ok, detail in CASES:
        print(("PASS  " if ok else "FAIL  ") + name + (("  — " + detail) if detail and not ok else ""))
    print(f"theme-studio: {len(CASES)-len(failed)}/{len(CASES)} checks passed")
    out = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results"
    out.mkdir(parents=True, exist_ok=True)
    (out / "theme-studio-unit.json").write_text(json.dumps({
        "suite": "theme-studio-unit", "pass": len(CASES) - len(failed), "total": len(CASES),
        "checks": [{"title": n, "ok": ok, "detail": d} for n, ok, d in CASES],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
