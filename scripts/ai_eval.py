# -*- coding: utf-8 -*-
"""T06196 / REQ-019 / AC-20：离线 AI 识别质量评测与提交前自检。

设计口径：
- 100+ 标注样本来自 data/eval_samples.json（12 组 × 10 条，五类均衡）；
- 评测时在临时目录生成真实 docx（功能点清单表），调用调用方注入的本地识别器
  （生产环境为 server.recognize_local），不访问任何在线 API；
- 逐项按功能点名称与标注对齐，统计 Precision/Recall/F1、五类混淆矩阵、
  重复/漏项/多余/类型错误/证据缺失；
- 运行结果与提交前自检均落到 APP_DATA/eval_runs/*.json，形成留痕。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path

from docx import Document

TYPES = ("ILF", "EIF", "EI", "EO", "EQ")
THRESHOLD = 0.85
DATASET_NAME = "eval_samples.json"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _norm(s) -> str:
    return re.sub(r"\s+", "", str(s or "")).strip()


def _dataset_path(path=None) -> Path:
    if path:
        return Path(path)
    return Path(__file__).resolve().parent.parent / "data" / DATASET_NAME


def load_dataset(path=None) -> tuple[dict, dict]:
    p = _dataset_path(path)
    raw = p.read_bytes()
    doc = json.loads(raw.decode("utf-8-sig"))
    samples = doc.get("samples") if isinstance(doc.get("samples"), list) else []
    check = dataset_check(samples, doc.get("groups"))
    return doc, {"path": str(p), "version": doc.get("version") or "—",
                 "samples": len(samples), "groups": len(doc.get("groups") or []),
                 "sha256": hashlib.sha256(raw).hexdigest()[:16], "self_check": check}


def dataset_check(samples, groups=None) -> dict:
    """样本集自身完整性：重复/缺字段/非法类型/类别覆盖。"""
    errors = []
    ids = Counter()
    names_by_group = defaultdict(list)
    class_count = Counter()
    group_ids = {str(g.get("id")) for g in (groups or []) if isinstance(g, dict)}
    seen_groups = set()
    for i, s in enumerate(samples):
        if not isinstance(s, dict):
            errors.append({"index": i, "reason": "sample_not_object"})
            continue
        sid = str(s.get("id") or "").strip()
        group = str(s.get("group") or "").strip()
        name = str(s.get("name") or "").strip()
        gold = str(s.get("gold") or "").strip().upper()
        if not sid:
            errors.append({"index": i, "reason": "missing_id"})
        else:
            ids[sid] += 1
            if ids[sid] > 1:
                errors.append({"id": sid, "reason": "duplicate_id"})
        if not group:
            errors.append({"id": sid or i, "reason": "missing_group"})
        else:
            seen_groups.add(group)
            if group_ids and group not in group_ids:
                errors.append({"id": sid or i, "reason": "unknown_group", "group": group})
        if not name:
            errors.append({"id": sid or i, "reason": "missing_name"})
        elif group:
            names_by_group[group].append(_norm(name))
        if gold not in TYPES:
            errors.append({"id": sid or i, "reason": "bad_gold", "gold": gold})
        else:
            class_count[gold] += 1
    dup_names = []
    for group, names in names_by_group.items():
        c = Counter(names)
        for name, n in c.items():
            if n > 1:
                dup_names.append({"group": group, "name": name, "count": n})
                errors.append({"group": group, "reason": "duplicate_name", "name": name, "count": n})
    if len(samples) < 100:
        errors.append({"reason": "too_few_samples", "actual": len(samples), "min": 100})
    if class_count and len(class_count) != len(TYPES):
        errors.append({"reason": "missing_class", "classes": sorted(class_count)})
    if group_ids and seen_groups != group_ids:
        errors.append({"reason": "group_unused", "groups": sorted(group_ids - seen_groups)})
    return {
        "ok": not errors,
        "errors": errors,
        "duplicate_ids": sorted(k for k, v in ids.items() if v > 1),
        "duplicate_names": dup_names,
        "class_count": {t: class_count.get(t, 0) for t in TYPES},
        "groups": len(seen_groups),
    }


def _write_group_docx(group: str, rows: list[dict], out_dir: Path) -> Path:
    doc = Document()
    doc.add_paragraph(rows[0].get("doc_title") or f"{group} 功能需求说明书")
    tb = doc.add_table(rows=1, cols=5)
    tb.style = "Table Grid"
    for i, h in enumerate(("序号", "功能点名称", "功能类型", "所属系统", "功能描述")):
        tb.rows[0].cells[i].text = h
    for n, r in enumerate(rows, 1):
        cells = tb.add_row().cells
        cells[0].text = str(n)
        cells[1].text = str(r.get("name") or "")
        cells[2].text = str(r.get("gold") or "")
        cells[3].text = str(r.get("system") or "")
        cells[4].text = str(r.get("desc") or "")
    path = out_dir / f"{group}.docx"
    doc.save(path)
    return path


def _call_recognizer(recognize_fn, path: Path):
    result = recognize_fn(path)
    if isinstance(result, tuple):
        items = result[0]
    else:
        items = result
    return items if isinstance(items, list) else []


def _run_id(prefix: str, digest: str) -> str:
    return f"{prefix}-{time.strftime('%Y%m%d-%H%M%S')}-{digest[:8]}"


def evaluate(recognize_fn, dataset_path=None, save_dir=None, runner="local-rules") -> dict:
    """运行一次完整离线评测；recognize_fn(path)->items 或 (items, sys, mod)。"""
    started = time.time()
    doc, info = load_dataset(dataset_path)
    samples = doc.get("samples") or []
    groups = defaultdict(list)
    for s in samples:
        groups[str(s.get("group") or "")].append(s)
    group_titles = {str(g.get("id")): g.get("title") for g in (doc.get("groups") or [])}
    for gid, rows in groups.items():
        if group_titles.get(gid):
            for r in rows:
                r.setdefault("doc_title", f"{group_titles[gid]}功能需求说明书")

    out_dir = Path(tempfile.mkdtemp(prefix="we_ai_eval_"))
    predicted = []
    per_group = {}
    for gid, rows in groups.items():
        path = _write_group_docx(gid, rows, out_dir)
        items = _call_recognizer(recognize_fn, path)
        expected = {_norm(r.get("name")): r for r in rows}
        used = set()
        duplicates = Counter()
        for pos, it in enumerate(items):
            if not isinstance(it, dict):
                continue
            name = str(it.get("count_item") or it.get("m1") or "").strip()
            key = _norm(name)
            typ = str(it.get("type") or "").strip().upper()
            rec = {"group": gid, "pos": pos, "name": name, "key": key, "type": typ,
                   "match": None, "predicted_id": it.get("stable_id"),
                   "evidence": len(it.get("evidence") or [])}
            if key and key in expected and key not in used:
                rec["match"] = expected[key]
                used.add(key)
            predicted.append(rec)
            if key:
                duplicates[key] += 1
        # 记录组内重复候选（同一名称出现 >1 次）
        for key, n in duplicates.items():
            if n > 1 and key in expected:
                per_group.setdefault(gid, []).append({"name": key, "count": n})

    expected_total = len(samples)
    missing, wrong_types, invalid, dup_candidates, extra = [], [], [], [], []
    matrix = {g: {p: 0 for p in TYPES} for g in TYPES}
    tp = 0
    used_expected = set()
    for rec in predicted:
        if not rec["key"]:
            invalid.append({"group": rec["group"], "name": rec["name"], "reason": "empty_name"})
            continue
        if rec["type"] not in TYPES:
            invalid.append({"group": rec["group"], "name": rec["name"], "reason": "bad_type", "type": rec["type"]})
        if rec["match"] is None:
            extra.append({"group": rec["group"], "name": rec["name"], "type": rec["type"]})
            continue
        exp = rec["match"]
        sid = exp.get("id")
        used_expected.add(sid)
        gold = str(exp.get("gold") or "").upper()
        pred = rec["type"] if rec["type"] in TYPES else "INVALID"
        row = matrix.setdefault(gold, {p: 0 for p in TYPES})
        row[pred] = row.get(pred, 0) + 1
        if rec["type"] == gold:
            tp += 1
        else:
            wrong_types.append({"id": sid, "group": rec["group"], "name": rec["name"],
                                "gold": gold, "predicted": rec["type"]})
    for recs in per_group.values():
        dup_candidates.extend(recs)
    duplicate_count = sum(r["count"] - 1 for r in dup_candidates)
    for s in samples:
        if s.get("id") not in used_expected:
            missing.append({"id": s.get("id"), "group": s.get("group"), "name": s.get("name"), "gold": s.get("gold")})
    predicted_total = len([r for r in predicted if r.get("key")])
    precision = tp / predicted_total if predicted_total else 0.0
    recall = tp / expected_total if expected_total else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    evidence_items = [r for r in predicted if r.get("key")]
    evidence_verified = sum(1 for r in evidence_items if r.get("evidence", 0) > 0)
    evidence_missing = [{"group": r["group"], "name": r["name"]} for r in evidence_items
                        if r.get("evidence", 0) <= 0]

    gate = {
        "passed": bool(info["self_check"].get("ok")) and precision >= THRESHOLD and recall >= THRESHOLD,
        "threshold": THRESHOLD,
        "precision_ok": precision >= THRESHOLD,
        "recall_ok": recall >= THRESHOLD,
        "dataset_ok": bool(info["self_check"].get("ok")),
    }
    run = {
        "ok": True,
        "run_id": _run_id("EVAL", info["sha256"]),
        "created_at": _now(),
        "runner": runner,
        "dataset": info,
        "metrics": {
            "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4),
            "accuracy": round(tp / expected_total, 4) if expected_total else 0.0,
            "tp": tp, "fp": predicted_total - tp, "fn": expected_total - tp,
            "predicted": predicted_total, "gold": expected_total, "threshold": THRESHOLD,
        },
        "gate": gate,
        "confusion": {"labels": list(TYPES), "matrix": matrix},
        "self_check": {
            "duplicate_candidates": dup_candidates,
            "duplicate_count": duplicate_count,
            "missing": missing,
            "extra": extra,
            "wrong_types": wrong_types,
            "invalid": invalid,
            "evidence": {"verified": evidence_verified, "missing": evidence_missing},
        },
        "counts": {"groups": len(groups), "expected": expected_total, "predicted": predicted_total,
                   "missing": len(missing), "extra": len(extra), "wrong_types": len(wrong_types)},
        "duration_ms": int((time.time() - started) * 1000),
    }
    if save_dir:
        save_run(run, save_dir)
    return run


def save_run(run: dict, save_dir) -> dict:
    d = Path(save_dir)
    d.mkdir(parents=True, exist_ok=True)
    data = dict(run)
    data["saved_at"] = _now()
    path = d / f"{run.get('run_id')}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    (d / "latest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    # 只保留最近 20 份正式评测，避免长期运行堆满数据目录。
    runs = sorted(d.glob("EVAL-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in runs[20:]:
        try:
            old.unlink()
        except OSError:
            pass
    data["path"] = str(path)
    return data


def latest_run(save_dir) -> dict | None:
    p = Path(save_dir) / "latest.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def precheck_items(items, expected_count=None) -> dict:
    """提交前轻量自检：重复、必填缺失、非法类型、AI 无证据。"""
    rows = []
    names = Counter()
    missing = []
    invalid = []
    evidence_missing = []
    for i, it in enumerate(items or [], 1):
        if not isinstance(it, dict):
            invalid.append({"seq": i, "reason": "not_object"})
            continue
        name = str(it.get("count_item") or it.get("m1") or "").strip()
        desc = str(it.get("desc") or "").strip()
        typ = str(it.get("type") or "").strip().upper()
        origin = str(it.get("origin") or "").lower()
        ev = it.get("evidence") if isinstance(it.get("evidence"), list) else []
        row = {"seq": it.get("seq") or i, "name": name, "type": typ, "origin": origin,
               "confidence": it.get("confidence"), "evidence": len(ev)}
        rows.append(row)
        if not name:
            missing.append({"seq": row["seq"], "reason": "empty_name"})
        elif not desc:
            missing.append({"seq": row["seq"], "name": name, "reason": "empty_desc"})
        if name:
            names[_norm(name)] += 1
        if typ not in TYPES:
            invalid.append({"seq": row["seq"], "name": name, "type": typ})
        if origin in ("ai", "llm") and not ev:
            evidence_missing.append({"seq": row["seq"], "name": name, "reason": "no_evidence"})
    duplicates = [{"name": name, "count": n} for name, n in names.items() if n > 1]
    if expected_count is not None:
        try:
            expected_count = int(expected_count)
        except (TypeError, ValueError):
            expected_count = None
    if expected_count is not None and len(rows) < expected_count:
        missing.append({"reason": "count_short", "expected": expected_count, "actual": len(rows)})
    return {
        "ok": not missing and not invalid and not evidence_missing,
        "checked": len(rows),
        "duplicates": duplicates,
        "duplicate_count": sum(d["count"] - 1 for d in duplicates),
        "missing": missing,
        "invalid": invalid,
        "evidence_missing": evidence_missing,
        "rows": rows[:300],
        "expected_count": expected_count,
    }


def save_precheck(items, save_dir, meta=None) -> dict:
    d = Path(save_dir)
    d.mkdir(parents=True, exist_ok=True)
    check = precheck_items(items)
    payload = {"ok": check["ok"], "created_at": _now(), "meta": meta or {}, "precheck": check}
    digest = hashlib.sha256(json.dumps(check, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:8]
    payload["run_id"] = _run_id("PRECHECK", digest)
    path = d / f"{payload['run_id']}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (d / "latest-precheck.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    payload["path"] = str(path)
    return payload


def latest_precheck(save_dir) -> dict | None:
    p = Path(save_dir) / "latest-precheck.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="离线 AI 识别质量评测（AC-20）")
    ap.add_argument("--dataset", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    import sys
    sys.path.insert(0, str(root / "scripts"))
    # 延迟导入服务端，避免 CLI --help 也触发数据初始化；评测只走本地规则。
    from server import recognize_local  # noqa: E402
    run = evaluate(recognize_local, dataset_path=args.dataset, save_dir=args.out)
    if args.json:
        print(json.dumps(run, ensure_ascii=False, indent=2))
    else:
        print(f"样本 {run['dataset']['samples']}；P {run['metrics']['precision']:.1%}；"
              f"R {run['metrics']['recall']:.1%}；F1 {run['metrics']['f1']:.1%}；"
              f"门禁 {'PASS' if run['gate']['passed'] else 'FAIL'}")
        print(f"混淆矩阵：{json.dumps(run['confusion']['matrix'], ensure_ascii=False)}")
        print(f"自检：重复 {run['self_check']['duplicate_count']}；漏项 {len(run['self_check']['missing'])}；"
              f"多余 {len(run['self_check']['extra'])}；类型错误 {len(run['self_check']['wrong_types'])}；"
              f"非法 {len(run['self_check']['invalid'])}")
    return 0 if run["gate"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
