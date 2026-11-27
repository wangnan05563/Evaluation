# -*- coding: utf-8 -*-
"""T06195 / REQ-018 / AC-19、AC-22：AI 候选的原文证据与置信度。

设计目标：
- 证据只来自上传文档的真实段落/表格行，模型给出的“原文引用”必须能在源文档
  中逐字定位；定位不到则丢弃，不允许编造引用。
- 每个候选带 origin（rule/llm）、confidence（0~1）、evidence（locator/quote/context）、
  ai（模型、提示词版本、生成时间）与 can_confirm。
- AC-19：无证据的 AI 候选 can_confirm=False，前后端都不允许进入已确认状态；
  AC-22：审计包按项记录模型、提示词版本、时间、置信度与人工决策。
"""
import re
import time
from pathlib import Path

PROMPT_VERSION = "identify-evidence-v1"
RULES_PROMPT_VERSION = "rules-evidence-v1"
LOCAL_MODEL = "本地规则"
LOW_CONFIDENCE = 0.70
MAX_QUOTE = 300
MAX_CONTEXT = 560

_TAIL_MARK_RE = re.compile(r"[（(][^）)]*(?:来自|识别自|LLM补全)[^）)]*[）)]\s*$")
_SPACE_RE = re.compile(r"\s+")


def now_iso():
    """本地时区 ISO 时间；审计只记录到秒，避免毫秒噪音。"""
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def normalize_confidence(value, default=0.55):
    """接受 0.82 / 82 / "82%"；越界钳制到 0~1，非法值回退 default。"""
    try:
        if isinstance(value, str):
            text = value.strip().rstrip("%")
            val = float(text)
            if "%" in value or val > 1:
                val = val / 100.0
        else:
            val = float(value)
    except (TypeError, ValueError):
        return max(0.0, min(1.0, float(default)))
    return max(0.0, min(1.0, val))


def _norm(text):
    return _SPACE_RE.sub("", str(text or "")).lower()


def _clip(text, limit):
    text = str(text or "").strip()
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _clean_key(text):
    """去掉识别器附加的来源尾注，避免把尾注当成原文。"""
    return _TAIL_MARK_RE.sub("", str(text or "")).strip()


def source_units(path):
    """读取 docx，把可定位的最小单元做成索引：段落 + 表格行。"""
    from docx import Document
    doc = Document(str(path))
    units = []
    for idx, para in enumerate(doc.paragraphs, 1):
        text = (para.text or "").strip()
        if text:
            units.append({"kind": "paragraph", "locator": f"段落 {idx}", "index": idx,
                          "text": text, "cells": []})
    for tidx, table in enumerate(doc.tables, 1):
        for ridx, row in enumerate(table.rows, 1):
            cells = [(c.text or "").strip() for c in row.cells]
            cells = [c for c in cells if c]
            text = " | ".join(cells).strip()
            if text:
                units.append({"kind": "table_row", "locator": f"表格 {tidx} · 第 {ridx} 行",
                              "table": tidx, "row": ridx, "text": text, "cells": cells})
    return units


def _ordered_units(units, prefer):
    if prefer == "table":
        return units
    return [u for u in units if u["kind"] != "table_row"] + [u for u in units if u["kind"] == "table_row"]


def _exact_cell_match(ordered, key_n):
    for unit in ordered:
        if unit["kind"] != "table_row":
            continue
        for cell in unit["cells"]:
            if _norm(cell) == key_n:
                return unit, cell
    return None, ""


def _contains_match(ordered, key_n, key):
    for unit in ordered:
        if key_n not in _norm(unit["text"]):
            continue
        if unit["kind"] == "table_row":
            for cell in unit["cells"]:
                if key_n in _norm(cell):
                    return unit, _clip(key, MAX_QUOTE)
        return unit, _clip(key, MAX_QUOTE)
    return None, ""


def _cell_contains_match(ordered, key_n):
    for unit in ordered:
        if unit["kind"] != "table_row":
            continue
        for cell in unit["cells"]:
            if key_n in _norm(cell):
                return unit, cell
    return None, ""


def _find_unit(units, key, prefer="paragraph"):
    """在源文档中定位 key：优先整格精确匹配，再退化为包含匹配。"""
    key_n = _norm(key)
    if not key_n:
        return None, ""
    ordered = _ordered_units(units, prefer)
    unit, quote = _exact_cell_match(ordered, key_n)
    if unit:
        return unit, quote
    unit, quote = _contains_match(ordered, key_n, key)
    if unit:
        return unit, quote
    return _cell_contains_match(ordered, key_n)


def _evidence_object(unit, quote):
    context = _clip(unit.get("text"), MAX_CONTEXT)
    quote = _clip(quote or unit.get("text"), MAX_QUOTE)
    if _norm(quote) not in _norm(context):
        quote = _clip(context, MAX_QUOTE)
    return {
        "kind": unit.get("kind") or "paragraph",
        "locator": unit.get("locator") or "原文",
        "quote": quote,
        "context": context,
        "verified": True,
    }


def _default_confidence(unit):
    if not unit:
        return 0.0
    if unit.get("kind") == "table_row":
        return 0.86
    if "标题" in str(unit.get("locator")):
        return 0.58
    return 0.64


def _candidate_keys(item):
    keys = []
    for field in ("count_item", "m1", "desc"):
        val = _clean_key(item.get(field))
        if val and val not in ("待人工识别",) and val not in keys:
            keys.append(val)
    # 长描述优先截出前一段，避免一段话整体匹配失败
    keys = [k for k in keys if len(k) >= 2]
    return keys[:4]


def _item_origin(item):
    origin = (item.get("origin") or "").strip().lower()
    if origin in ("rule", "llm", "manual"):
        return origin
    if item.get("_llm_added") or "[LLM补全]" in str(item.get("basis") or ""):
        return "llm"
    return "rule"


def _valid_existing_evidence(item, units):
    """校验模型给的 evidence；引用必须在源文档中可定位，否则丢弃。"""
    raw = item.get("evidence")
    if isinstance(raw, str):
        raw = [{"quote": raw}]
    if not isinstance(raw, list):
        return []
    out = []
    for ev in raw:
        if not isinstance(ev, dict):
            continue
        quote = _clip(ev.get("quote"), MAX_QUOTE)
        if not quote:
            continue
        unit, matched = _find_unit(units, quote, prefer="table" if ev.get("kind") == "table_row" else "paragraph")
        if not unit:
            continue
        obj = _evidence_object(unit, matched or quote)
        if ev.get("locator"):
            obj["locator"] = str(ev.get("locator"))[:80]
        obj["verified"] = True
        out.append(obj)
        break
    return out


def _resolve_units(path):
    try:
        return source_units(path)
    except Exception:
        return []


def _find_prefer(item):
    if "功能点清单" in str(item.get("desc") or "") or item.get("kind") == "table_row":
        return "table"
    return "paragraph"


def _match_evidence(item, units):
    existing = _valid_existing_evidence(item, units)
    if existing:
        item["evidence"] = existing
        return True
    hint = item.get("evidence_quote") or item.get("quote")
    prefer = _find_prefer(item)
    unit, quote = _find_unit(units, hint, prefer=prefer) if hint else (None, "")
    if not unit:
        for key in _candidate_keys(item):
            unit, quote = _find_unit(units, key, prefer=prefer)
            if unit:
                break
    if unit:
        item["evidence"] = [_evidence_object(unit, quote)]
        return True
    item["evidence"] = []
    return False


def _set_confidence(item, has_ev):
    raw_conf = item.get("confidence")
    if raw_conf not in (None, ""):
        conf = normalize_confidence(raw_conf, default=0.0)
    else:
        conf = 0.0
        if has_ev:
            ev_kind = item["evidence"][0].get("kind")
            conf = 0.86 if ev_kind == "table_row" else 0.64
    if not has_ev:
        conf = 0.0
    item["confidence"] = round(conf, 4)


def _set_ai(item, origin, meta, model, prompt_version, created):
    ai = dict(item.get("ai") or {})
    if origin == "llm":
        ai.setdefault("model", meta.get("model") or model or "AI 模型")
        ai.setdefault("prompt_version", meta.get("prompt_version") or prompt_version or PROMPT_VERSION)
    else:
        ai.setdefault("model", model or LOCAL_MODEL)
        ai.setdefault("prompt_version", prompt_version or RULES_PROMPT_VERSION)
    ai.setdefault("created_at", created)
    ai.setdefault("confidence", item["confidence"])
    item["ai"] = ai


def attach(items, path, llm_meta=None, model=None, prompt_version=None):
    """为候选补齐 evidence / confidence / ai / can_confirm，原地修改并返回统计。

    llm_meta: _llm_refine 的 meta（含 model / prompt_version / created_at）；
    model/prompt_version 用于本地规则候选。
    """
    units = _resolve_units(path)
    meta = llm_meta or {}
    created = meta.get("created_at") or now_iso()
    checked = matched = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        origin = _item_origin(item)
        if origin == "manual":
            item.setdefault("can_confirm", True)
            continue
        checked += 1
        has_ev = _match_evidence(item, units)
        if has_ev:
            matched += 1
        _set_confidence(item, has_ev)
        item["origin"] = origin
        item["can_confirm"] = has_ev
        _set_ai(item, origin, meta, model, prompt_version, created)
        # LLM 返回的临时字段不进入前端/审计
        for key in ("evidence_quote", "evidence_locator", "quote"):
            item.pop(key, None)
    rejected = sum(1 for x in items if _item_origin(x) != "manual" and not x.get("evidence"))
    return {"checked": checked, "matched": matched, "rejected": rejected,
            "prompt_version": meta.get("prompt_version") or prompt_version or PROMPT_VERSION,
            "model": meta.get("model") or model or LOCAL_MODEL,
            "created_at": created, "low_confidence_threshold": LOW_CONFIDENCE}


def summary(items):
    """返回识别结果证据覆盖率，供 meta 展示与测试断言。"""
    total = matched = low = 0
    for item in items or []:
        if not isinstance(item, dict) or _item_origin(item) == "manual":
            continue
        total += 1
        ev = item.get("evidence")
        if isinstance(ev, list) and any(isinstance(e, dict) and e.get("quote") for e in ev):
            matched += 1
        try:
            if float(item.get("confidence") or 0) < LOW_CONFIDENCE:
                low += 1
        except (TypeError, ValueError):
            low += 1
    return {"required": True, "total": total, "matched": matched,
            "unverified": total - matched, "low_confidence": low,
            "low_confidence_threshold": LOW_CONFIDENCE}


def validate_confirmable(items):
    """AC-19：AI 候选无原文证据时不可确认；返回违规项（供 /api/generate 拒绝）。"""
    bad = []
    for idx, item in enumerate(items or [], 1):
        if not isinstance(item, dict):
            continue
        origin = _item_origin(item)
        if origin not in ("rule", "llm"):
            continue
        evidence = item.get("evidence")
        ok = isinstance(evidence, list) and any(
            isinstance(e, dict) and str(e.get("quote") or "").strip() for e in evidence)
        if not ok or item.get("can_confirm") is False:
            bad.append({"seq": item.get("seq") or idx,
                        "desc": item.get("desc") or item.get("count_item") or ""})
    return bad


def _audit_confidence(conf):
    try:
        return f"{round(float(conf) * 100)}%"
    except (TypeError, ValueError):
        return "—"


def _audit_row(item, idx, fallback_model):
    ai = item.get("ai") or {}
    ev = item.get("evidence") if isinstance(item.get("evidence"), list) else []
    decision = item.get("human_decision") or ("confirmed" if item.get("ok") else "pending")
    return {
        "seq": item.get("seq") or idx,
        "stable_id": str(item.get("stable_id") or f"FP-{idx:03d}"),
        "model": str(ai.get("model") or fallback_model),
        "prompt_version": str(ai.get("prompt_version") or "—"),
        "created_at": str(ai.get("created_at") or "—"),
        "confidence": _audit_confidence(item.get("confidence")),
        "decision": decision,
        "decision_at": str(item.get("decision_at") or "—"),
        "evidence": ev[0].get("locator") if ev else "无",
    }


def audit_rows(items, fallback_model=LOCAL_MODEL):
    """AC-22：把逐项 AI 审计字段规整成可进 PDF 的行。"""
    rows = []
    for idx, item in enumerate(items or [], 1):
        if not isinstance(item, dict):
            continue
        rows.append(_audit_row(item, idx, fallback_model))
    return rows

