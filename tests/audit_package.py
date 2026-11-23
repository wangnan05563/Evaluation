# -*- coding: utf-8 -*-
"""T06181 / REQ-007 / AC-08、AC-09：七部分审计包生成与 API 下载验收。

用法：
  python tests/audit_package.py                  # 直连生成器（17 项、30 秒门、PDF 结构/链接）
  python tests/audit_package.py http://127.0.0.1:8033  # 额外验证 POST /api/audit/package + 下载
退出码 0=全过。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import audit_package  # noqa: E402

fails = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def inspect_pdf(path):
    import fitz
    doc = fitz.open(path)
    text = "\n".join(p.get_text("text") for p in doc)
    links = [l for p in doc for l in p.get_links() if l.get("kind") == fitz.LINK_GOTO]
    return {
        "pages": doc.page_count,
        "text": text,
        "links": len(links),
        "link_pages": sorted({l.get("page") for l in links if l.get("page") is not None}),
        "fonts": [f[3] for p in range(min(6, doc.page_count)) for f in doc.get_page_fonts(p)],
    }


def main():
    out = Path(tempfile.mkdtemp(prefix="we_audit_test_"))
    payload = audit_package.sample_payload(17)
    t0 = time.time()
    result = audit_package.generate(payload, out, "audit_test")
    wall_ms = int((time.time() - t0) * 1000)
    print(f"\n# 直连生成：{wall_ms} ms / 生成器 {result.get('elapsed_ms')} ms\n")
    check("生成返回 ok", result.get("ok") is True, json.dumps({k: result.get(k) for k in ("ok", "elapsed_ms", "budget_ok")}, ensure_ascii=False))
    check("AC-08 30 秒门", result.get("budget_ok") is True and result.get("elapsed_ms", 99999) <= 30000,
          f"{result.get('elapsed_ms')} ms")
    check("七部分齐全", result.get("parts_present") is True, str(result.get("section_pages")))
    check("目录页码正确", result.get("toc_ok") is True, json.dumps(result.get("toc_rows"), ensure_ascii=False))
    check("17 项明细与 17 行追溯", result.get("detail_rows") == 17 and result.get("trace_rows") == 17,
          f"{result.get('detail_rows')}/{result.get('trace_rows')}")
    check("每行 UFP/US + 追溯内部链接≥34", result.get("trace_links", 0) >= 34, str(result.get("trace_links")))
    check("水印覆盖全页", result.get("watermark_pages") == result.get("pages"), f"{result.get('watermark_pages')}/{result.get('pages')}")
    check("页脚页码覆盖全页", result.get("footer_page_number_pages") == result.get("pages"),
          f"{result.get('footer_page_number_pages')}/{result.get('pages')}")
    check("字体嵌入", result.get("font_embedded") is True, ",".join(result.get("fonts") or []))
    pdf = Path(result["pdf"])
    check("PDF 文件存在且非空", pdf.is_file() and pdf.stat().st_size > 100000, str(pdf.stat().st_size if pdf.is_file() else 0))
    meta = inspect_pdf(pdf)
    check("PDF 可重新打开", meta["pages"] >= 7, f"pages={meta['pages']}")
    check("摘要 UFP/US/调整后规模同源", "80" in meta["text"] and "42.67" in meta["text"] and "51.63" in meta["text"],
          "摘要数值")
    check("追溯目标页可点击", meta["links"] >= 34 and meta["link_pages"], f"links={meta['links']} pages={meta['link_pages']}")

    api = sys.argv[1] if len(sys.argv) > 1 else ""
    api_result = None
    if api:
        api = api.rstrip("/")
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(api + "/api/audit/package", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as r:
            api_result = json.loads(r.read().decode("utf-8"))
        check("API POST /api/audit/package", api_result.get("ok") is True, json.dumps(api_result, ensure_ascii=False)[:300])
        check("API 返回 30 秒门通过", api_result.get("budget_ok") is True and api_result.get("elapsed_ms", 99999) <= 30000,
              str(api_result.get("elapsed_ms")))
        download = api + api_result.get("download", "")
        local = out / "api_download.pdf"
        with urllib.request.urlopen(download, timeout=30) as r:
            local.write_bytes(r.read())
            ctype = r.headers.get("Content-Type", "")
        check("API 下载 Content-Type=application/pdf", ctype == "application/pdf", ctype)
        check("API 下载 PDF 非空", local.stat().st_size > 100000, str(local.stat().st_size))
        dl_meta = inspect_pdf(local)
        check("API 下载 PDF 可打开且含内部链接", dl_meta["pages"] >= 7 and dl_meta["links"] >= 34,
              f"pages={dl_meta['pages']} links={dl_meta['links']}")

    results_dir = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "suite": "audit-package", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "ok": not fails, "checks": total, "fails": fails,
        "direct": {k: result.get(k) for k in ("ok", "elapsed_ms", "budget_ok", "pages", "detail_rows",
                                             "trace_rows", "trace_links", "toc_ok", "watermark_pages",
                                             "footer_page_number_pages", "font_embedded", "version_hash")},
        "wall_ms": wall_ms, "api": api_result,
    }
    (results_dir / "audit-package-test.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(out, ignore_errors=True)
    print(f"\n==== 审计包测试：{len(fails)} 失败 ====")
    (api and print(f"API: {api}"))
    for f in fails:
        print("  FAIL:", f)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
