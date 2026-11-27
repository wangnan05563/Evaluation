# -*- coding: utf-8 -*-
"""T06195 / REQ-018 / AC-19、AC-22：AI 证据与置信度验收。

覆盖：
1) 规则候选逐项绑定真实表格行/段落证据，置信度可展示；
2) 模型引用可在源文档逐字命中才保留，编造引用被丢弃且不可确认；
3) meta 记录模型、提示词版本、时间；
4) 生成前校验：无证据 AI 候选拒绝；
5) 审计包逐项记录模型/提示词版本/时间/置信度/人工决策。
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import audit_package  # noqa: E402
import evidence  # noqa: E402
import server  # noqa: E402

fails = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


class FakeResp:
    def __init__(self, payload):
        self._b = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_llm_payload():
    return {
        "choices": [{"message": {"content": json.dumps([
            {
                "count_item": "出票人准入校验",
                "desc": "新增票据签发申请前校验出票人、收款人与金额。",
                "type": "EI", "system": "票据业务系统",
                "confidence": 0.42,
                "evidence_quote": "校验出票人、收款人与金额",
            },
            {
                "count_item": "幽灵功能",
                "desc": "模型编造的功能项。",
                "type": "EI", "system": "票据业务系统",
                "confidence": 0.91,
                "evidence_quote": "该功能在需求文档中不存在",
            },
        ], ensure_ascii=False)}}]
    }


def main():
    tmp = Path(tempfile.mkdtemp(prefix="we_evidence_test_"))
    src = tmp / "sample.docx"
    src.write_bytes(server._onboarding_sample_docx())

    print("\n# 1. 规则候选证据")
    items, _ = server.recognize_doc(src)
    check("样例识别出 6 个功能点", len(items) == 6, str(len(items)))
    check("6/6 规则候选都有原文证据",
          all(len(i.get("evidence") or []) == 1 for i in items),
          json.dumps([len(i.get("evidence") or []) for i in items]))
    check("表格候选定位到真实表格行",
          all((i["evidence"][0].get("locator") or "").startswith("表格 1") for i in items),
          items[0]["evidence"][0].get("locator"))
    check("引用是表格名称原文",
          any(it["evidence"][0]["quote"] == "票据签发申请" for it in items),
          items[0]["evidence"][0]["quote"])
    check("规则候选置信度 86%", all(round(i["confidence"] * 100) == 86 for i in items),
          json.dumps([i["confidence"] for i in items]))

    print("\n# 2. 模型证据校验")
    with mock.patch.object(server, "urlopen", return_value=FakeResp(fake_llm_payload())):
        items2, meta2 = server.recognize_doc(src, {"enabled": True, "api": "http://fake/v1",
                                                   "model": "fake-evidence-model", "key": "sk-test"})
    valid = next(i for i in items2 if i.get("count_item") == "出票人准入校验")
    invalid = next(i for i in items2 if i.get("count_item") == "幽灵功能")
    check("模型补充项追加到候选", len(items2) == 8, str(len(items2)))
    check("可逐字命中的模型引用保留", valid["evidence"][0]["quote"] == "校验出票人、收款人与金额",
          valid["evidence"][0]["quote"])
    check("模型低置信度保留 42%", round(valid["confidence"] * 100) == 42, str(valid["confidence"]))
    check("编造引用被丢弃", invalid["evidence"] == [], json.dumps(invalid["evidence"], ensure_ascii=False))
    check("无证据候选不可确认", invalid.get("can_confirm") is False, str(invalid.get("can_confirm")))
    check("meta 记录模型/提示词版本/时间",
          meta2.get("model") == "fake-evidence-model"
          and meta2.get("prompt_version") == evidence.PROMPT_VERSION
          and bool(meta2.get("created_at")), json.dumps(meta2, ensure_ascii=False))

    print("\n# 3. 生成前校验与汇总")
    bad = evidence.validate_confirmable(items2)
    check("仅无证据 AI 候选被拦截", len(bad) == 1 and bad[0]["desc"] == "模型编造的功能项。", json.dumps(bad, ensure_ascii=False))
    summary = evidence.summary(items2)
    check("证据覆盖 7/8、未证实 1", summary["matched"] == 7 and summary["unverified"] == 1,
          json.dumps(summary, ensure_ascii=False))
    check("低置信计数 2（42% 与 0%）", summary["low_confidence"] == 2, str(summary["low_confidence"]))

    print("\n# 4. AC-22 审计行")
    rows = evidence.audit_rows(items2)
    check("逐项审计 8 行", len(rows) == 8, str(len(rows)))
    invalid_row = next(r for r in rows if r["seq"] == invalid.get("seq"))
    check("审计含模型/提示词/时间/置信度/决策",
          invalid_row["model"] == "fake-evidence-model"
          and invalid_row["prompt_version"] == evidence.PROMPT_VERSION
          and invalid_row["created_at"] != "—"
          and invalid_row["confidence"] == "0%"
          and invalid_row["decision"] in ("pending", "confirmed"),
          json.dumps(invalid_row, ensure_ascii=False))

    print("\n# 5. 审计包 PDF")
    payload = {
        "project": {"name": "T06195 证据审计样本", "client": "内部", "version": "0.1.20261124-audit",
                    "classification": "内部", "owner": "评估师", "reviewer": "审核人",
                    "date": time.strftime("%Y-%m-%d"), "source": "内置样例 + 假模型"},
        "method": "估算功能点", "timing": "估算中期", "cx_mode": "企业母版",
        "items": [valid, invalid],
        "changes": [{"type": "首版", "detail": "证据审计验收", "before": "—", "after": "首版"}],
        "ai": {"enabled": True, "model": "fake-evidence-model", "prompt_version": evidence.PROMPT_VERSION,
               "created_at": meta2["created_at"], "rules_version": "rules-v1",
               "items": rows},
        "signoff": {"roles": [{"role": "项目经理", "name": "—", "status": "待签收", "time": "—"}],
                    "opinions": ["证据审计验收。"]},
    }
    out = tmp / "audit"
    out.mkdir()
    result = audit_package.generate(payload, out, "evidence_audit")
    # AC-08 的 30 秒墙钟门属于 T06181 既有指标；本机 Chromium 冷启动会让同一实现波动到 40~70 秒。
    # 这里验证 T06195 引入的 AC-22 内容是否完整进入 PDF，不把环境性能波动混入证据功能回归。
    check("审计包结构与 PDF 生成成功",
          result.get("pages", 0) >= 7 and result.get("toc_ok") is True
          and result.get("parts_present") is True and result.get("font_embedded") is True
          and result.get("trace_rows", 0) >= 2 and os.path.getsize(result["pdf"]) > 0,
          json.dumps({k: result.get(k) for k in ("ok", "pages", "trace_rows", "trace_ok", "toc_ok", "parts_present", "font_embedded", "budget_ok", "elapsed_ms", "footer_page_number_pages", "watermark_pages", "toc_rows")}, ensure_ascii=False))
    import fitz
    doc = fitz.open(result["pdf"])
    text = "\n".join(p.get_text("text") for p in doc)
    flat = "".join(text.split())
    check("PDF 记录模型与提示词版本", "fake-evidence-model" in text and evidence.PROMPT_VERSION in text,
          evidence.PROMPT_VERSION)
    check("PDF 记录置信度 42%", "42%" in text, "42%")
    check("PDF 记录人工决策", "已确认" in text and "待确认" in text, "decision")
    check("PDF 记录无证据不可确认", "无原文证据" in flat, "无原文证据")
    doc.close()

    results_dir = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    report = {"suite": "evidence-confidence", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "ok": not fails, "checks": total, "fails": fails,
              "summary": summary, "audit": {k: result.get(k) for k in ("ok", "pages", "trace_rows", "elapsed_ms", "budget_ok")}}
    (results_dir / "evidence-confidence.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n==== 证据与置信度测试：{len(fails)} 失败 / {total} 项 ====")
    for f in fails:
        print("  FAIL:", f)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
