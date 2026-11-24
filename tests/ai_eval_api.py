# -*- coding: utf-8 -*-
"""T06196 / AC-20：/api/eval/* 与生成前 precheck 的真实 HTTP 验收。"""
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8033").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
fails = []
total = 0


def call(path, payload=None, method=None, timeout=120):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(API + path, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def check(name, ok, detail=""):
    global total
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def main():
    print(f"API={API}")
    latest = call("/api/eval/latest")
    check("GET /api/eval/latest 返回数据集摘要",
          latest.get("ok") and latest.get("dataset", {}).get("samples") == 120
          and latest["dataset"].get("groups") == 12,
          json.dumps({k: latest.get("dataset", {}).get(k) for k in ("samples", "groups", "sha256")}, ensure_ascii=False))

    run = call("/api/eval/run", {})
    m, gate = run.get("metrics", {}), run.get("gate", {})
    check("POST /api/eval/run 真实回放 120 条",
          run.get("ok") and run.get("counts", {}).get("predicted") == 120
          and run.get("counts", {}).get("expected") == 120,
          json.dumps(run.get("counts"), ensure_ascii=False))
    check("HTTP 评测 P/R/F1=90.0%、门禁通过",
          m.get("precision") == 0.9 and m.get("recall") == 0.9 and m.get("f1") == 0.9
          and gate.get("passed") is True,
          json.dumps({**m, "gate": gate}, ensure_ascii=False))
    check("HTTP 混淆矩阵 5×5 且合计 120",
          sum(sum(v.values()) for v in run["confusion"]["matrix"].values()) == 120
          and len(run["confusion"]["matrix"]) == 5,
          str(run.get("run_id")))

    after = call("/api/eval/latest")
    check("GET latest 回显最近 run",
          after.get("latest", {}).get("run_id") == run.get("run_id")
          and after["latest"].get("metrics", {}).get("precision") == 0.9,
          str(after.get("latest", {}).get("run_id")))

    bad = [{"seq": 1, "count_item": "重复候选", "desc": "说明", "type": "EI", "origin": "ai", "evidence": []},
           {"seq": 2, "count_item": "重复候选", "desc": "", "type": "ZZ", "origin": "ai", "evidence": []}]
    pre = call("/api/eval/precheck", {"items": bad, "stage": "api-test", "job": "T06196-api"})
    q = pre.get("precheck", {})
    check("POST /api/eval/precheck 检出重复/非法/无证据",
          pre.get("ok") and q.get("duplicate_count") == 1 and len(q.get("invalid", [])) == 1
          and len(q.get("evidence_missing", [])) == 2,
          json.dumps({"run": pre.get("run_id"), "dup": q.get("duplicate_count"),
                      "invalid": len(q.get("invalid", [])), "ev": len(q.get("evidence_missing", []))}, ensure_ascii=False))
    check("precheck 留痕可由 latest 读取",
          call("/api/eval/latest").get("precheck", {}).get("run_id") == pre.get("run_id"),
          str(pre.get("run_id")))

    s = call("/api/onboarding/sample")
    rec = call("/api/recognize", {"name": s["name"], "b64": s["b64"], "params": {}})
    check("样例识别 6 项且带证据",
          rec.get("ok") and len(rec.get("items", [])) == 6
          and all((it.get("evidence") or []) for it in rec["items"]),
          f"n={len(rec.get('items', []))}")
    items = rec["items"]
    hist = [{**it, "cx": "中", "ok": True} for it in items]
    gen = call("/api/generate", {"items": items, "method": "估算功能点", "title": "T06196 质量自检生成",
                                 "job": "t06196_api", "hist_items": hist,
                                 "source_name": s["name"]})
    qp = gen.get("quality_precheck", {})
    check("/api/generate 成功并附带质量自检摘要",
          gen.get("ok") and qp.get("ok") is True and qp.get("checked") == 6
          and qp.get("duplicate_count") == 0 and qp.get("missing_count") == 0,
          json.dumps(qp, ensure_ascii=False))
    check("生成前自检已留痕且 stage=generate",
          qp.get("run_id") and (call("/api/eval/latest").get("precheck", {}).get("meta", {}) or {}).get("stage") == "generate",
          str((call("/api/eval/latest").get("precheck", {}).get("meta", {}) or {}).get("stage")))

    results = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results"
    results.mkdir(parents=True, exist_ok=True)
    out = {"suite": "ai-eval-api", "api": API, "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "ok": not fails, "checks": total, "fails": fails,
           "run_id": run.get("run_id"), "metrics": m, "gate": gate,
           "dataset": {k: latest["dataset"].get(k) for k in ("samples", "groups", "sha256")},
           "precheck": pre.get("run_id"), "generate_precheck": qp.get("run_id")}
    (results / "ai-eval-api.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n==== AI 评测 HTTP：{len(fails)} 失败 / {total} 项 ====")
    for f in fails:
        print("  FAIL:", f)
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
