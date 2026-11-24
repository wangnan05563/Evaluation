# -*- coding: utf-8 -*-
"""T06196 / REQ-019 / AC-20：离线 AI 识别质量评测与提交前自检验收。"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="we_ai_eval_test_"))
os.environ["WE_DATA"] = str(TMP / "data")
sys.path.insert(0, str(ROOT / "scripts"))
import ai_eval  # noqa: E402
import audit_package  # noqa: E402
import server  # noqa: E402

fails = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def main():
    runs_dir = TMP / "eval_runs"
    t0 = time.time()
    print("\n# 1. 标注集")
    doc, info = ai_eval.load_dataset()
    check("120 条样本 / 12 组", info["samples"] == 120 and info["groups"] == 12,
          json.dumps({k: info[k] for k in ("samples", "groups", "sha256")}, ensure_ascii=False))
    check("五类各 24 条", info["self_check"]["class_count"] == {t: 24 for t in ai_eval.TYPES},
          json.dumps(info["self_check"]["class_count"], ensure_ascii=False))
    check("样本集自身自检通过", info["self_check"]["ok"] is True,
          json.dumps(info["self_check"], ensure_ascii=False))
    check("ID/组内名称无重复",
          not info["self_check"]["duplicate_ids"] and not info["self_check"]["duplicate_names"])

    print("\n# 2. 真实 docx 回放评测")
    run = ai_eval.evaluate(server.recognize_local, save_dir=runs_dir)
    m, g = run["metrics"], run["gate"]
    check("Precision / Recall 均为 90.0%",
          m["precision"] == 0.9 and m["recall"] == 0.9 and m["f1"] == 0.9,
          json.dumps(m, ensure_ascii=False))
    check("TP/FP/FN = 108/12/12", (m["tp"], m["fp"], m["fn"]) == (108, 12, 12),
          json.dumps(m, ensure_ascii=False))
    check("P/R ≥ 85% 质量门通过", g["passed"] is True and g["threshold"] == 0.85,
          json.dumps(g, ensure_ascii=False))
    check("120 项全部提取，无漏项/多余",
          run["counts"]["predicted"] == 120 and not run["self_check"]["missing"]
          and not run["self_check"]["extra"],
          json.dumps(run["counts"], ensure_ascii=False))
    check("识别重复 0", run["self_check"]["duplicate_count"] == 0,
          str(run["self_check"]["duplicate_count"]))
    check("类型误判 12 项且可列出", len(run["self_check"]["wrong_types"]) == 12,
          json.dumps([(x["gold"], x["predicted"]) for x in run["self_check"]["wrong_types"]], ensure_ascii=False))
    matrix = run["confusion"]["matrix"]
    diag = sum(int(matrix[t].get(t, 0)) for t in ai_eval.TYPES)
    off = sum(int(matrix[g].get(p, 0)) for g in ai_eval.TYPES for p in ai_eval.TYPES if g != p)
    check("混淆矩阵：对角 108 / 非对角 12 / 合计 120",
          diag == 108 and off == 12 and diag + off == 120,
          f"diag={diag} off={off}")
    check("证据覆盖 120/120、缺失 0",
          run["self_check"]["evidence"]["verified"] == 120
          and not run["self_check"]["evidence"]["missing"],
          json.dumps(run["self_check"]["evidence"], ensure_ascii=False))
    check("评测结果已落盘 latest.json",
          (runs_dir / "latest.json").exists()
          and json.loads((runs_dir / "latest.json").read_text(encoding="utf-8"))["run_id"] == run["run_id"])

    print("\n# 3. 提交前自检")
    src = TMP / "sample.docx"
    src.write_bytes(server._onboarding_sample_docx())
    items, _meta = server.recognize_doc(src)
    pc_ok = ai_eval.precheck_items(items)
    check("真实样例 6 项自检通过", pc_ok["ok"] is True and pc_ok["checked"] == 6
          and not pc_ok["duplicates"] and not pc_ok["missing"] and not pc_ok["invalid"],
          json.dumps(pc_ok, ensure_ascii=False))
    bad = [
        {"seq": 1, "count_item": "重复项", "desc": "说明", "type": "EI", "origin": "ai", "evidence": []},
        {"seq": 2, "count_item": "重复项", "desc": "", "type": "ZZ", "origin": "ai", "evidence": []},
        {"seq": 3, "count_item": "", "desc": "", "type": "EI", "origin": "manual", "evidence": []},
    ]
    pc_bad = ai_eval.precheck_items(bad)
    check("重复候选 1 组", pc_bad["duplicate_count"] == 1, json.dumps(pc_bad["duplicates"], ensure_ascii=False))
    check("漏字段/空名称 2 项", len(pc_bad["missing"]) == 2, json.dumps(pc_bad["missing"], ensure_ascii=False))
    check("非法类型 1 项", len(pc_bad["invalid"]) == 1 and pc_bad["invalid"][0]["type"] == "ZZ",
          json.dumps(pc_bad["invalid"], ensure_ascii=False))
    check("AI 无证据 2 项", len(pc_bad["evidence_missing"]) == 2,
          json.dumps(pc_bad["evidence_missing"], ensure_ascii=False))
    check("自检不通过", pc_bad["ok"] is False)
    trace_bad = ai_eval.save_precheck(bad, runs_dir, {"stage": "generate", "job": "T06196-test"})
    check("自检留痕文件与 latest-precheck 生成",
          (runs_dir / "latest-precheck.json").exists()
          and (runs_dir / f"{trace_bad['run_id']}.json").exists(),
          trace_bad["run_id"])

    print("\n# 4. 审计包留痕")
    payload = {
        "project": {"name": "T06196 质量评测审计样本", "client": "内部", "version": "0.1.20261124-audit",
                    "classification": "内部", "owner": "评估师", "reviewer": "审核人",
                    "date": time.strftime("%Y-%m-%d"), "source": "120 条标注集离线回放"},
        "method": "估算功能点", "timing": "估算中期", "cx_mode": "企业母版",
        "items": items,
        "changes": [{"type": "首版", "detail": "AI 质量评测验收", "before": "—", "after": "首版"}],
        "ai": {"enabled": True, "model": "本地规则", "prompt_version": "rules-evidence-v1",
               "created_at": run["created_at"], "rules_version": "rules-v1",
               "quality": run, "quality_precheck": trace_bad,
               "items": [{"stable_id": it.get("stable_id") or f"FP-{i:03d}", "model": "本地规则",
                          "prompt_version": "rules-evidence-v1", "created_at": run["created_at"],
                          "confidence": f"{round(float(it.get('confidence') or 0) * 100)}%",
                          "decision": it.get("human_decision") or "pending", "decision_at": "—"}
                         for i, it in enumerate(items, 1)]},
        "signoff": {"roles": [{"role": "项目经理", "name": "—", "status": "待签收", "time": "—"}],
                    "opinions": ["AI 质量评测验收。"]},
    }
    out = TMP / "audit"
    out.mkdir()
    result = audit_package.generate(payload, out, "ai_eval_audit")
    check("审计包生成成功", result.get("ok") is True and result.get("pages", 0) >= 7,
          json.dumps({k: result.get(k) for k in ("ok", "pages", "toc_ok", "parts_present", "trace_rows", "budget_ok")}, ensure_ascii=False))
    import fitz
    pdf = fitz.open(result["pdf"])
    text = "\n".join(p.get_text("text") for p in pdf)
    flat = "".join(text.split())
    pdf.close()
    check("PDF 记录质量评测 90.0%", "质量评测" in text and "P90.0%" in flat,
          "P90.0%")
    check("PDF 记录提交前自检告警", "提交前自检" in text and "漏项2" in flat,
          "漏项2")

    elapsed = int((time.time() - t0) * 1000)
    results_dir = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    report = {"suite": "ai-eval", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "ok": not fails, "checks": total, "fails": fails,
              "dataset": {k: info[k] for k in ("samples", "groups", "sha256")},
              "metrics": m, "gate": g,
              "confusion": run["confusion"],
              "counts": run["counts"], "duration_ms": run["duration_ms"], "total_ms": elapsed,
              "audit": {k: result.get(k) for k in ("ok", "pages", "trace_rows", "elapsed_ms", "budget_ok")}}
    (results_dir / "ai-eval.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n==== AI 质量评测测试：{len(fails)} 失败 / {total} 项 ====")
    for f in fails:
        print("  FAIL:", f)
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
