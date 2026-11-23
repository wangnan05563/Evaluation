# -*- coding: utf-8 -*-
"""T06183：角色化引导内置样例 — 直连 + API 验收。

验证：
1. 内置样例 docx 可被本地识别链解析（无需大模型），覆盖 EI/EQ/EO/EIF/ILF；
2. GET /api/onboarding/sample 返回可识别 docx；
3. POST /api/recognize 走正常识别链；
4. 全部确认后 POST /api/generate 生成完整结果，返回非零摘要。
"""
import base64
import json
import os
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import server  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8092"
RESULT_DIR = os.path.join(ROOT, "docs", "test-reports", "phase3-20261122", "results")
checks = []


def check(title, ok, detail=""):
    checks.append({"title": title, "ok": bool(ok), "detail": str(detail)})
    print(("PASS  " if ok else "FAIL  ") + title + (("  — " + str(detail)) if detail else ""))


def post(path, obj, timeout=120):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


t0 = time.time()
docx = server._onboarding_sample_docx()
check("内置样例 docx 可生成", len(docx) > 10000, f"{len(docx)} B")
tmp = os.path.join(tempfile.gettempdir(), "t06183_onboarding_sample.docx")
with open(tmp, "wb") as f:
    f.write(docx)
items, meta = server.recognize_doc(tmp)
check("本地识别链命中 6 项", len(items) == 6, len(items))
types = {it.get("type") for it in items}
check("覆盖 EI/EQ/EO/EIF/ILF 五类", types == {"EI", "EQ", "EO", "EIF", "ILF"}, sorted(types))
check("系统名来自文档", all(it.get("system") == "票据业务系统" for it in items), items[0].get("system"))
check("样例不含内部备注/证据字段", all(not any(k in it for k in ("note", "remark", "evidence", "trace")) for it in items))

summary = server.engine.summary([{k: it.get(k) for k in ("type", "reuse", "modify", "det", "ret", "ftr")} for it in items])
check("直连摘要生成", summary.get("ufp", 0) > 0, f"UFP={summary.get('ufp')} US={summary.get('us')}")

with urllib.request.urlopen(BASE + "/api/onboarding/sample", timeout=30) as r:
    sample = json.loads(r.read().decode("utf-8"))
check("API 样例接口 200", sample.get("ok") is True and sample.get("b64"), f"{sample.get('size')} B")
check("API 样例可解码", len(base64.b64decode(sample["b64"])) > 10000)
check("API 样例名称含评估师", "评估师" in sample.get("name", ""), sample.get("name"))

status, rec = post("/api/recognize", {"name": sample["name"], "b64": sample["b64"], "params": {"llm_enabled": False}})
check("API 识别返回 200", status == 200 and rec.get("ok") is True)
check("API 识别命中 6 项", len(rec.get("items") or []) == 6, len(rec.get("items") or []))
api_items = rec.get("items") or []
for it in api_items:
    it["ok"] = True
payload = {"items": api_items, "method": "估算功能点", "cx_mode": "企业母版",
           "title": "评估师样例-票据业务系统", "job": "t06183-onboard"}
status, gen = post("/api/generate", payload, timeout=180)
check("API 生成完整结果 200", status == 200 and gen.get("ok") is True)
check("生成摘要非零", (gen.get("summary") or {}).get("ufp", 0) > 0,
      f"UFP={(gen.get('summary') or {}).get('ufp')} US={(gen.get('summary') or {}).get('us')}")
check("生成文件句柄存在", bool(gen.get("sid")), gen.get("sid"))
elapsed = int((time.time() - t0) * 1000)
check("命令层样例路径 ≤5 分钟", elapsed <= 300000, f"{elapsed} ms")

os.makedirs(RESULT_DIR, exist_ok=True)
out = {"suite": "onboarding-flow", "ok": all(c["ok"] for c in checks),
       "checks": len(checks), "fails": [c for c in checks if not c["ok"]],
       "elapsed_ms": elapsed, "direct_ufp": summary.get("ufp"), "api_ufp": (gen.get("summary") or {}).get("ufp"),
       "types": sorted(types), "items": len(items), "api_items": len(api_items),
       "sample_size": sample.get("size"), "result": checks}
with open(os.path.join(RESULT_DIR, "onboarding-test.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("\n==== 角色化引导测试：%d 失败 ====" % len(out["fails"]))
sys.exit(0 if out["ok"] else 1)
