# -*- coding: utf-8 -*-
"""T06189 增强项目分类器测试（合成基线，标签已知）。"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import enhancement as E

CASES = []
def check(name, cond, detail=""):
    CASES.append((name, bool(cond), detail))


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


def main():
    base, cur = fixture()
    res = E.classify(base, cur, method="估算功能点", cx_mode="企业母版")
    labels = {r["stable_id"]: r["auto"] for r in res["rows"]}
    expected = {
        "F1": "UNCHANGED", "F2": "CHG", "F3": "CHG", "F4": "DEL",
        "F5": "CFP", "F7": "UNCHANGED", "F91": "CHG", "F10": "UNCHANGED",
        "F11": "ADD", "F12": "ADD", "F6": "DEL", "F8": "DEL",
    }
    check("自动标签 12/12 与金标准一致", all(labels.get(k) == v for k, v in expected.items()),
          str({k: labels.get(k) for k in expected}))
    check("自动分类准确率 100%", sum(labels.get(k) == v for k, v in expected.items()) / len(expected) == 1.0)
    check("ADD=2", res["suggested_counts"]["add"] == 2, str(res["suggested_counts"]))
    check("CHG=3", res["suggested_counts"]["chg"] == 3, str(res["suggested_counts"]))
    check("DEL=3", res["suggested_counts"]["del"] == 3, str(res["suggested_counts"]))
    check("CFP=1", res["suggested_counts"]["cfp"] == 1, str(res["suggested_counts"]))
    check("UNCHANGED=3", res["suggested_counts"]["unchanged"] == 3, str(res["suggested_counts"]))
    check("EFP = ADD+CHG+CFP+DEL = 55", res["totals"]["efp"] == 55, str(res["totals"]))
    check("更新后 UFP = 58", res["totals"]["updated_ufp"] == 58, str(res["totals"]))
    check("基线 UFP=62 / 当前 UFP=62", res["totals"]["baseline_ufp"] == 62 and res["totals"]["current_ufp"] == 62,
          str(res["totals"]))
    check("CHGB=13 / DEL=18 / CFP=10",
          res["totals"]["chg_before"] == 13 and res["totals"]["del"] == 18 and res["totals"]["cfp"] == 10,
          str(res["totals"]))
    check("自动分类不自动复核", res["totals"]["all_reviewed"] is False, str(res["totals"]))
    check("每行带稳定 ID 与建议理由", all(r["stable_id"] and r["reason_codes"] for r in res["rows"]))
    check("type 变更凭 replaces_id 归为 CHG", labels.get("F91") == "CHG")
    check("未匹配基线项归为 DEL", labels.get("F6") == "DEL" and labels.get("F8") == "DEL")
    check("转换标记归为 CFP", labels.get("F5") == "CFP")

    # 人工复核：改一行最终分类后重算合计（模拟前端复核）
    rows = res["rows"]
    for r in rows:
        r["reviewed"] = True
    rows[0]["final"] = "CHG"
    totals = E._totals(rows)
    check("人工复核可改最终分类并重算", totals["chg"] == 13 + 10 and totals["efp"] == 65,
          str(totals))
    check("全部复核标记可被识别", totals["all_reviewed"] is True)

    # 非法输入
    for bad, label in [
        ([{"desc": "x", "type": "ZZ"}], "非法类型"),
        ({"not": "array"}, "非数组"),
    ]:
        try:
            E.classify(base, bad)
            check(label + "被拒绝", False)
        except E.EFPError:
            check(label + "被拒绝", True)

    failed = [c for c in CASES if not c[1]]
    for name, ok, detail in CASES:
        print(("PASS  " if ok else "FAIL  ") + name + (("  — " + detail) if detail and not ok else ""))
    print(f"enhancement: {len(CASES)-len(failed)}/{len(CASES)} checks passed")
    out = Path(__file__).resolve().parents[1] / "docs" / "test-reports" / "phase3-20261122" / "results"
    out.mkdir(parents=True, exist_ok=True)
    (out / "enhancement-unit.json").write_text(json.dumps({
        "suite": "enhancement-unit", "pass": len(CASES) - len(failed), "total": len(CASES),
        "checks": [{"title": n, "ok": ok, "detail": d} for n, ok, d in CASES],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
