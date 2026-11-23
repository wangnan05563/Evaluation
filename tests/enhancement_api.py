# -*- coding: utf-8 -*-
"""T06189 /api/enhancement/classify 冒烟。"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

API = os.environ.get("WE_API", "http://127.0.0.1:8093")


def item(**kw):
    base = {"desc": "", "system": "票据业务系统", "type": "EI", "reuse": "低",
            "modify": "新增", "count_item": "计数项 1", "cx": "中", "ok": True}
    base.update(kw)
    return base


def fixture():
    base = [
        item(stable_id="F1", desc="用户管理", type="ILF"),
        item(stable_id="F2", desc="登录", type="EI"),
        item(stable_id="F3", desc="报表", type="EO"),
        item(stable_id="F4", desc="查询", type="EQ"),
        item(stable_id="F5", desc="订单转换", type="ILF", conversion=True),
        item(stable_id="F6", desc="支付", type="EI"),
        item(stable_id="F7", desc="外部接口", type="EIF"),
        item(stable_id="F8", desc="旧报表", type="ILF"),
        item(stable_id="F9", desc="旧入口", type="EI"),
        item(stable_id="F10", desc="帮助", type="EQ"),
    ]
    cur = [
        item(stable_id="F1", desc="用户管理", type="ILF"),
        item(stable_id="F2", desc="登录认证", type="EI", modify="修改"),
        item(stable_id="F3", desc="报表", type="EQ", modify="修改"),
        item(stable_id="F4", desc="查询", type="EQ", modify="删除"),
        item(stable_id="F5", desc="订单转换", type="ILF", conversion=True),
        item(stable_id="F7", desc="外部接口", type="EIF"),
        item(stable_id="F91", replaces_id="F9", desc="旧入口", type="EO", modify="修改"),
        item(stable_id="F10", desc="帮助", type="EQ"),
        item(stable_id="F11", desc="发票", type="EI"),
        item(stable_id="F12", desc="配置", type="ILF"),
    ]
    return base, cur


def post(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(API + "/api/enhancement/classify", data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def main():
    base, cur = fixture()
    status, res = post({"baseline": base, "current": cur})
    checks = []
    checks.append(("HTTP 200", status == 200))
    checks.append(("ok=true", res.get("ok") is True))
    checks.append(("ADD/CHG/DEL/CFP 2/3/3/1", res.get("suggested_counts") == {
        "add": 2, "chg": 3, "del": 3, "cfp": 1, "unchanged": 3}, str(res.get("suggested_counts"))))
    checks.append(("EFP=55", res.get("totals", {}).get("efp") == 55, str(res.get("totals"))))
    checks.append(("更新后 UFP=58", res.get("totals", {}).get("updated_ufp") == 58))
    checks.append(("未自动复核", res.get("totals", {}).get("all_reviewed") is False))
    checks.append(("规则版本", res.get("rules_version") == "EFP-1.0"))
    try:
        post({"baseline": [], "current": [{"desc": "x", "type": "ZZ"}]})
        checks.append(("非法类型 HTTP 400", False))
    except urllib.error.HTTPError as e:
        body = json.loads(e.read().decode("utf-8"))
        checks.append(("非法类型 HTTP 400", e.code == 400 and body.get("ok") is False))
    failed = [c for c in checks if not c[1]]
    for name, ok, *extra in checks:
        print(("PASS  " if ok else "FAIL  ") + name + (("  — " + extra[0]) if extra and not ok else ""))
    print(f"enhancement-api: {len(checks)-len(failed)}/{len(checks)} checks passed")
    out = Path(__file__).resolve().parents[1] / "docs" / "test-reports" / "phase3-20261122" / "results"
    out.mkdir(parents=True, exist_ok=True)
    (out / "enhancement-api.json").write_text(json.dumps({
        "suite": "enhancement-api", "pass": len(checks) - len(failed), "total": len(checks),
        "checks": [{"title": n, "ok": ok, "detail": (d[0] if d else "")} for n, ok, *d in checks],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
