# -*- coding: utf-8 -*-
"""T06189 增强项目自动分类。

输入：基线明细、当前明细（均含 stable_id / replaces_id 可选）。
输出：ADD / CHG / DEL / CFP / UNCHANGED 建议 + EFP 与更新后 UFP。

口径（IFPUG 增强项目）：
    EFP = ADD + CHGA + CFP + DEL
    更新后 UFP = 基线 UFP + ADD + CHGA - CHGB - DEL
CHGA 取变更后功能的当前 UFP（企业母版/标准 IFPUG 由调用方传 method/cx_mode）。
CFP 为转换功能，计入 EFP，但不计入应用更新后 UFP。
本模块只给建议，不写库、不确认；前端必须逐项人工复核后才能导出。
"""
from typing import Any, Dict, Iterable, List, Optional

import engine

RULES_VERSION = "EFP-1.0"
CATS = ("ADD", "CHG", "DEL", "CFP", "UNCHANGED")
_COUNT_KEYS = ("add", "chg", "del", "cfp", "unchanged")
_CHANGE_FIELDS = ("desc", "system", "type", "count_item", "det", "ret", "ftr")
_FIELD_LABEL = {
    "desc": "描述", "system": "系统/模块", "type": "功能类型",
    "count_item": "计数项", "det": "DET", "ret": "RET", "ftr": "FTR",
}


class EFPError(ValueError):
    """输入不合法或无法计算。"""


def _items(value: Any, name: str) -> List[Dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise EFPError(f"{name} 必须是数组")
    if len(value) > 5000:
        raise EFPError(f"{name} 超过 5000 行，暂不支持")
    out = []
    for idx, it in enumerate(value):
        if not isinstance(it, dict):
            raise EFPError(f"{name}[{idx}] 不是对象")
        row = dict(it)
        t = str(row.get("type") or "").strip()
        if t not in engine.WEIGHT:
            raise EFPError(f"{name}[{idx}] 类型非法：{t or '空'}")
        out.append(row)
    return out


def _sid(it: Dict[str, Any]) -> str:
    return str(it.get("stable_id") or "").strip()


def _key(it: Dict[str, Any], idx: int) -> tuple:
    d = str(it.get("desc") or "").strip()
    s = str(it.get("system") or "").strip()
    if not d and not s:
        return ("#seq%d" % it.get("seq", idx), "")
    return (d, s)


def _ufp(it: Dict[str, Any], method: str, cx_mode: str) -> int:
    try:
        return int(engine.item_ufp(it, method, cx_mode))
    except Exception as e:
        raise EFPError(f"无法计算 UFP：{e}") from e


def _val(v: Any) -> str:
    return "" if v is None else str(v)


def _changes(base: Dict[str, Any], cur: Dict[str, Any]) -> List[str]:
    return [f for f in _CHANGE_FIELDS if _val(base.get(f)) != _val(cur.get(f))]


def _match(baseline: List[Dict[str, Any]], current: List[Dict[str, Any]]):
    """返回 pairs(当前索引, 基线索引, 匹配方式), 未匹配索引集合。"""
    b_left = set(range(len(baseline)))
    c_left = set(range(len(current)))
    b_by_sid: Dict[str, int] = {}
    for i, it in enumerate(baseline):
        sid = _sid(it)
        if sid:
            b_by_sid.setdefault(sid, i)
    pairs: List[tuple] = []

    def take(cj: int, bi: int, how: str) -> bool:
        if bi is None or bi not in b_left or cj not in c_left:
            return False
        b_left.discard(bi)
        c_left.discard(cj)
        pairs.append((cj, bi, how))
        return True

    # 1) 稳定 ID 完全一致：最高可信
    for cj, it in enumerate(current):
        sid = _sid(it)
        if sid:
            take(cj, b_by_sid.get(sid), "stable_id")
    # 2) 类型变更：当前新 ID 的 replaces_id 指向基线旧 ID
    for cj, it in enumerate(current):
        if cj not in c_left:
            continue
        rep = str(it.get("replaces_id") or "").strip()
        if rep:
            take(cj, b_by_sid.get(rep), "replaces_id")
    # 3) 旧数据/未携带 ID 的兼容匹配：描述+系统；仅作低可信建议
    b_by_key: Dict[tuple, List[int]] = {}
    for bi in list(b_left):
        b_by_key.setdefault(_key(baseline[bi], bi), []).append(bi)
    for cj, it in enumerate(current):
        if cj not in c_left:
            continue
        bucket = b_by_key.get(_key(it, cj)) or []
        if bucket:
            take(cj, bucket.pop(0), "key")

    return pairs, b_left, c_left


def _auto_label(base: Optional[Dict[str, Any]], cur: Optional[Dict[str, Any]],
                how: str, changes: List[str]) -> tuple:
    """返回 (auto, confidence, reason_codes)。只给建议，不改数据。"""
    if cur is None:
        return "DEL", ("high" if base and _sid(base) else "medium"), ["missing_in_current"]
    if base is None:
        return "ADD", ("high" if _sid(cur) else "medium"), ["new_in_current"]
    # 显式转换标记：基线或当前任一携带 conversion=true，视为转换功能
    if bool(base.get("conversion")) or bool(cur.get("conversion")):
        return "CFP", "high", ["conversion_flag"]
    # 显式修改类型优先（当前版本人工标记）
    mod = str(cur.get("modify") or "").strip()
    if mod == "删除":
        return "DEL", "high", ["explicit_delete"]
    if mod == "修改":
        return "CHG", "high", ["explicit_modify"] + (["fields_changed"] if changes else [])
    if changes:
        return "CHG", ("high" if how == "stable_id" else "medium"), ["fields_changed"]
    return "UNCHANGED", ("high" if how == "stable_id" else "low"), ["no_change"]


def _row(seq: int, source: str, base: Optional[Dict[str, Any]], cur: Optional[Dict[str, Any]],
         how: str, changes: List[str], method: str, cx_mode: str) -> Dict[str, Any]:
    auto, confidence, reasons = _auto_label(base, cur, how, changes)
    b_ufp = _ufp(base, method, cx_mode) if base else 0
    c_ufp = _ufp(cur, method, cx_mode) if cur else 0
    chosen = cur or base or {}
    name = str(chosen.get("desc") or "")
    system = str(chosen.get("system") or "")
    return {
        "id": f"{'c' if source == 'current' else 'b'}{seq}",
        "seq": seq,
        "source": source,
        "stable_id": _sid(chosen),
        "name": name,
        "system": system,
        "type": str(chosen.get("type") or ""),
        "modify": str(chosen.get("modify") or ""),
        "auto": auto,
        "final": auto,
        "confidence": confidence,
        "matched_by": how,
        "reason_codes": reasons,
        "field_changes": [{"field": f, "label": _FIELD_LABEL.get(f, f)} for f in changes],
        "baseline_ufp": b_ufp,
        "current_ufp": c_ufp,
        "delta_ufp": c_ufp - b_ufp,
        "reviewed": False,
    }


def _totals(rows: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    rows = list(rows)
    add = sum(r["current_ufp"] for r in rows if r.get("final") == "ADD")
    chg = sum(r["current_ufp"] for r in rows if r.get("final") == "CHG")
    chgb = sum(r["baseline_ufp"] for r in rows if r.get("final") == "CHG")
    dele = sum(r["baseline_ufp"] for r in rows if r.get("final") == "DEL")
    cfp = sum((r["current_ufp"] or r["baseline_ufp"]) for r in rows if r.get("final") == "CFP")
    baseline = sum(r["baseline_ufp"] for r in rows)
    current = sum(r["current_ufp"] for r in rows)
    counts = {}
    for k in _COUNT_KEYS:
        key = {"add": "ADD", "chg": "CHG", "del": "DEL", "cfp": "CFP",
               "unchanged": "UNCHANGED"}[k]
        counts[k] = sum(1 for r in rows if r.get("final") == key)
    updated = baseline + add + chg - chgb - dele
    return {
        "add": add, "chg": chg, "chg_before": chgb, "del": dele, "cfp": cfp,
        "baseline_ufp": baseline, "current_ufp": current,
        "updated_ufp": updated, "efp": add + chg + cfp + dele,
        "counts": counts, "rows": len(rows),
        "all_reviewed": all(bool(r.get("reviewed")) for r in rows),
    }


def classify(baseline: Any, current: Any, method: str = engine.METHOD_ESTIMATE,
             cx_mode: str = engine.CX_MASTER) -> Dict[str, Any]:
    """生成分类建议；不写库、不确认。"""
    try:
        b_items = _items(baseline, "baseline")
        c_items = _items(current, "current")
        m = str(method or engine.METHOD_ESTIMATE)
        if m not in engine.METHODS:
            raise EFPError(f"未知估算方法：{m}")
        cx = engine.normalize_cx_mode(cx_mode)
    except EFPError:
        raise
    except Exception as e:
        raise EFPError(str(e)) from e

    pairs, b_left, c_left = _match(b_items, c_items)
    rows: List[Dict[str, Any]] = []
    for cj in sorted(range(len(c_items))):
        pair = next((p for p in pairs if p[0] == cj), None)
        if pair:
            _, bi, how = pair
            base, cur = b_items[bi], c_items[cj]
            changes = _changes(base, cur)
            rows.append(_row(cj + 1, "current", base, cur, how, changes, m, cx))
        else:
            rows.append(_row(cj + 1, "current", None, c_items[cj], "none", [], m, cx))
    for bi in sorted(b_left):
        base = b_items[bi]
        rows.append(_row(len(c_items) + bi + 1, "baseline", base, None, "none", [], m, cx))

    auto_totals = _totals(rows)
    final_totals = _totals(rows)
    suggestion = {
        "add": sum(1 for r in rows if r["auto"] == "ADD"),
        "chg": sum(1 for r in rows if r["auto"] == "CHG"),
        "del": sum(1 for r in rows if r["auto"] == "DEL"),
        "cfp": sum(1 for r in rows if r["auto"] == "CFP"),
        "unchanged": sum(1 for r in rows if r["auto"] == "UNCHANGED"),
    }
    return {
        "ok": True,
        "rules_version": RULES_VERSION,
        "method": m,
        "cx_mode": cx,
        "rows": rows,
        "suggested_counts": suggestion,
        "auto_totals": auto_totals,
        "totals": final_totals,
        "coverage": {"baseline": len(b_items), "current": len(c_items),
                     "matched": len(pairs), "baseline_only": len(b_left),
                     "current_only": len(c_left)},
        "formula": "EFP = ADD + CHGA + CFP + DEL; updated UFP = baseline + ADD + CHGA - CHGB - DEL",
    }
