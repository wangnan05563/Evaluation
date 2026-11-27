# -*- coding: utf-8 -*-
"""T06182 / REQ-008 / AC-10：离线脱敏分享包直连 + API 验收。"""
import json
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import audit_package  # noqa: E402
import share_package  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else ""
RESULT = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results" / "share-package-test.json"
fails = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def http_json(path, body=None):
    req = urllib.request.Request(BASE + path, method="POST" if body is not None else "GET")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()


def _direct_checks(result):
    check("生成返回 ok", result["ok"] is True, json.dumps({k: result[k] for k in ("items", "excluded", "external_links", "font_stack", "sections")}, ensure_ascii=False))
    check("只包含已确认项", result["items"] == 15 and result["excluded"] == 2, f"{result['items']}/{result['excluded']}")
    check("单文件存在且非空", result["size"] > 5000 and Path(result["file"]).is_file(), f"{result['size']} B")
    html = Path(result["file"]).read_text(encoding="utf-8")
    check("内部备注未进入分享包", "SECRET_NOTE" not in html and "SECRET_EVIDENCE" not in html)
    check("未确认项未进入分享包", "UNCONFIRMED_ITEM" not in html)
    check("无外部链接/远程资源", result["external_links"] == 0, ",".join(result["external_tokens"]))
    check("仅系统字体栈", result["font_stack"] is True and "@font-face" not in html and "Microsoft YaHei" in html)
    check("四个正文区块齐全", result["sections"] == 4)
    check("摘要按已确认项复算", result["summary"]["ufp"] < 80 and result["summary"]["work_mid"] < 60,
          json.dumps(result["summary"], ensure_ascii=False))
    check("离线 HTML 可重复读取", len(html) > 5000 and html.startswith("<!doctype html>"))
    return html


def _api_checks():
    p_all = audit_package.sample_payload(17)
    for it in p_all["items"]:
        it["ok"] = True
    p_all["items"][0]["note"] = "SECRET_NOTE_API"
    status, ctype, body = http_json("/api/share/package", p_all)
    api = json.loads(body.decode("utf-8")) if body else {}
    check("API POST /api/share/package", status == 200 and api.get("ok") is True, f"{status} {api.get('file', '')}")
    check("API 返回已确认项与离线自检", api.get("items") == 17 and api.get("external_links") == 0 and api.get("font_stack") is True,
          json.dumps({k: api.get(k) for k in ("items", "excluded", "size", "external_links", "font_stack")}, ensure_ascii=False))
    dl = api.get("download", "")
    status, ctype, data = http_json(dl)
    check("API 下载 Content-Type=text/html", status == 200 and "text/html" in ctype, ctype)
    check("API 下载 HTML 无备注且可打开", b"SECRET_NOTE_API" not in data and data.startswith(b"<!doctype html>") and len(data) > 5000,
          f"{len(data)} B")
    status, _, _ = http_json("/api/share/download?f=..%2Fconfig.json")
    check("下载接口路径穿越 404", status == 404, str(status))
    return api


def _direct_checks(result):
    check("生成返回 ok", result["ok"] is True, json.dumps({k: result[k] for k in ("items", "excluded", "external_links", "font_stack", "sections")}, ensure_ascii=False))
    check("只包含已确认项", result["items"] == 15 and result["excluded"] == 2, f"{result['items']}/{result['excluded']}")
    check("单文件存在且非空", result["size"] > 5000 and Path(result["file"]).is_file(), f"{result['size']} B")
    html = Path(result["file"]).read_text(encoding="utf-8")
    check("内部备注未进入分享包", "SECRET_NOTE" not in html and "SECRET_EVIDENCE" not in html)
    check("未确认项未进入分享包", "UNCONFIRMED_ITEM" not in html)
    check("无外部链接/远程资源", result["external_links"] == 0, ",".join(result["external_tokens"]))
    check("仅系统字体栈", result["font_stack"] is True and "@font-face" not in html and "Microsoft YaHei" in html)
    check("四个正文区块齐全", result["sections"] == 4)
    check("摘要按已确认项复算", result["summary"]["ufp"] < 80 and result["summary"]["work_mid"] < 60,
          json.dumps(result["summary"], ensure_ascii=False))
    check("离线 HTML 可重复读取", len(html) > 5000 and html.startswith("<!doctype html>"))
    return html


def _api_checks():
    p_all = audit_package.sample_payload(17)
    for it in p_all["items"]:
        it["ok"] = True
    p_all["items"][0]["note"] = "SECRET_NOTE_API"
    status, ctype, body = http_json("/api/share/package", p_all)
    api = json.loads(body.decode("utf-8")) if body else {}
    check("API POST /api/share/package", status == 200 and api.get("ok") is True, f"{status} {api.get('file', '')}")
    check("API 返回已确认项与离线自检", api.get("items") == 17 and api.get("external_links") == 0 and api.get("font_stack") is True,
          json.dumps({k: api.get(k) for k in ("items", "excluded", "size", "external_links", "font_stack")}, ensure_ascii=False))
    dl = api.get("download", "")
    status, ctype, data = http_json(dl)
    check("API 下载 Content-Type=text/html", status == 200 and "text/html" in ctype, ctype)
    check("API 下载 HTML 无备注且可打开", b"SECRET_NOTE_API" not in data and data.startswith(b"<!doctype html>") and len(data) > 5000,
          f"{len(data)} B")
    status, _, _ = http_json("/api/share/download?f=..%2Fconfig.json")
    check("下载接口路径穿越 404", status == 404, str(status))
    return api


def main():
    payload = audit_package.sample_payload(17)
    for it in payload["items"]:
        it["ok"] = True
    payload["items"][0]["note"] = "SECRET_NOTE_DO_NOT_SHARE"
    payload["items"][0]["evidence"] = "SECRET_EVIDENCE_DO_NOT_SHARE"
    payload["items"][-2]["ok"] = False
    payload["items"][-2]["desc"] = "UNCONFIRMED_ITEM_SHOULD_NOT_APPEAR"
    payload["items"][-1]["ok"] = False
    payload["items"][-1]["desc"] = "UNCONFIRMED_ITEM_2_SHOULD_NOT_APPEAR"

    tmp = Path(tempfile.mkdtemp(prefix="share_pkg_"))
    t0 = time.time()
    result = share_package.generate(payload, tmp)
    wall = int((time.time() - t0) * 1000)
    print(f"\n# 直连生成：{wall} ms / 生成器 {result['elapsed_ms']} ms\n")
    _direct_checks(result)
    api = _api_checks() if BASE else {}

    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps({
        "suite": "share-package", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "ok": not fails, "checks": total, "fails": fails,
        "direct": {k: result[k] for k in ("ok", "items", "excluded", "size", "sections", "external_links",
                                          "font_stack", "elapsed_ms", "html_sha256", "summary")},
        "api": api,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n==== 分享包测试：{len(fails)} 失败 ====")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
