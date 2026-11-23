# -*- coding: utf-8 -*-
"""AC-40：诊断包导出后不含密钥、令牌、客户原文/绝对路径，且可一键附工单。"""
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp())
os.environ["WE_DATA"] = str(tmp)
sys.path.insert(0, str(ROOT / "scripts"))
import server  # noqa: E402

(tmp / "logs").mkdir(parents=True, exist_ok=True)
(tmp / "logs" / "server.jsonl").write_text("\n".join([
    json.dumps({"ts": "t", "level": "info", "module": "x", "event": "e", "duration_ms": 3,
                "ok": 1, "path": "/api/generate", "size": 10}, ensure_ascii=False),
    json.dumps({"ts": "t", "level": "error", "module": "x", "event": "err",
                "err": "C:\\Users\\hspcadmin\\客户A需求原文.docx 解析失败", "key": "sk-secret-1234567890"}, ensure_ascii=False),
    json.dumps({"ts": "t", "level": "info", "module": "llm", "event": "call",
                "token": "Bearer abcdefghijklmnop", "msg": "客户原文：票据系统改造需求"}, ensure_ascii=False),
    "not-json 客户原文",
]) + "\n", encoding="utf-8")
(tmp / "recognition_rules.json").write_text(json.dumps({
    "rules": [{"name": "r1", "api_key": "sk-hidden-999999999", "note": "C:\\Users\\hspcadmin\\a.docx"}],
    "customer_text": "客户原始需求片段",
}, ensure_ascii=False), encoding="utf-8")
(tmp / "rates_versions.json").write_text('{"v":1,"token":"abc"}', encoding="utf-8")
(tmp / "schema_ver").write_text("2", encoding="utf-8")
zp = server._build_diag_zip()
with zipfile.ZipFile(zp) as z:
    names = set(z.namelist())
    all_text = "\n".join(z.read(n).decode("utf-8", "replace") for n in names if n.endswith((".json", ".jsonl", ".txt")))
    assert "config.json" not in names, names
    for bad in ("sk-secret-1234567890", "sk-hidden-999999999", "Bearer abcdefghijklmnop",
                "客户原文", "客户A需求原文", "客户原始需求片段", "C:\\Users", "hspcadmin@"):
        assert bad not in all_text, f"leak: {bad}"
    assert "redaction-report.json" in names and "README.txt" in names
    report = json.loads(z.read("redaction-report.json"))
assert report["dropped_fields"], report
print("AC-40 diag redaction PASS:", Path(zp).name, "files=", len(names), "report=", report)
