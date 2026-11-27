"""PDF 引擎 Spike：Chromium 两遍渲染 + PyMuPDF 验收（页码/目录/书签/字体/水印/确定性）。"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SPIKE = os.path.join(ROOT, "docs", "spikes", "pdf-engine-20261122")
TEMPLATE = os.path.join(SPIKE, "sample-audit.html")
NODE = shutil.which("node") or "node"
RENDER = os.path.join(ROOT, "tests", "phase3", "pdf_render.mjs")
TITLES = [
    "1. 范围与目标", "2. 估算口径与母版", "3. 功能点识别结果", "4. 复用与修改系数",
    "5. 调整因子与 PERT", "6. 工作量与工期", "7. 费用与费率", "8. 风险与假设",
    "9. 证据链索引", "10. AI 辅助识别记录", "11. 版本对比与变更", "12. 审批与签收",
    "13. 数据来源与脱敏", "14. 复算与对账", "15. 结论与建议", "16. 附录 A：术语表",
    "17. 附录 B：生成参数",
]


def render(html, pdf):
    p = subprocess.run([NODE, RENDER, html, pdf], cwd=ROOT, capture_output=True, text=True, timeout=180)
    if p.returncode != 0:
        raise RuntimeError(f"render failed: {p.stderr[-2000:]}")
    return json.loads([l for l in p.stdout.splitlines() if l.startswith("{")][-1])


def _map_sections(doc):
    pages = {}
    for i, title in enumerate(TITLES, 1):
        for pno in range(2, doc.page_count):
            if title in doc[pno].get_text("text"):
                pages[i] = pno + 1
                break
    missing = [i for i in range(1, 18) if i not in pages]
    if missing:
        raise RuntimeError(f"section pages not found: {missing}; pages={doc.page_count}")
    return pages


def _fill_pages(html, pages):
    for i, p in pages.items():
        html = html.replace(f"{{{{PAGE_{i}}}}}", str(p))
    return html


def _toc_check(doc2, pages):
    toc_text = doc2[1].get_text("text")
    toc_ok, toc_rows = True, []
    for i, title in enumerate(TITLES, 1):
        m = re.search(re.escape(title) + r"\s*(\d+)", toc_text)
        got = int(m.group(1)) if m else -1
        ok = got == pages[i]
        toc_ok = toc_ok and ok
        toc_rows.append({"section": i, "expected": pages[i], "in_toc": got, "ok": ok})
    return toc_ok, toc_rows


def _fonts(doc2):
    fonts = []
    for pno in range(min(3, doc2.page_count)):
        for f in doc2.get_page_fonts(pno):
            base = f[3]
            if base not in fonts:
                fonts.append(base)
    return fonts


def _determinism(final_pdf, pass3, doc2, doc3):
    import hashlib

    def text_hash(d):
        h = hashlib.sha256()
        for p in d:
            h.update(p.get_text("text").encode("utf-8"))
        return h.hexdigest()

    th2, th3 = text_hash(doc2), text_hash(doc3)
    bytes_equal = open(final_pdf, "rb").read() == open(pass3, "rb").read()
    meta_diff = {k: (doc2.metadata.get(k), doc3.metadata.get(k))
                 for k in ("creationDate", "modDate", "producer", "creator")}
    return {"bytes_equal": bytes_equal, "text_hash_equal": th2 == th3, "text_hash": th2, "meta_diff": meta_diff}


def _weasy_info():
    try:
        import weasyprint  # noqa: F401
        return {"available": True, "version": getattr(weasyprint, "__version__", "unknown")}
    except Exception as e:
        return {"available": False, "error": f"{type(e).__name__}: {e}"}


def main():
    import fitz
    t0 = time.time()
    pass1 = os.path.join(SPIKE, "pass1.pdf")
    meta1 = render(TEMPLATE, pass1)
    doc = fitz.open(pass1)
    pages = _map_sections(doc)

    html = _fill_pages(open(TEMPLATE, encoding="utf-8").read(), pages)
    final_html = os.path.join(SPIKE, "sample-audit-final.html")
    open(final_html, "w", encoding="utf-8").write(html)
    final_pdf = os.path.join(SPIKE, "sample-audit-chromium.pdf")
    meta2 = render(final_html, final_pdf)
    doc2 = fitz.open(final_pdf)

    toc_ok, toc_rows = _toc_check(doc2, pages)
    fonts = _fonts(doc2)
    outline = doc2.get_toc(simple=True)
    outline_ok = len(outline) >= 17 and sum(1 for x in outline if any(t in x[1] for t in TITLES)) >= 17
    wm_pages = sum(1 for p in doc2 if "内部演示" in p.get_text("text"))
    footer_pages = sum(1 for p in doc2 if re.search(r"\d+\s*/\s*\d+", p.get_text("text")))

    # 确定性：第三遍渲染，比较文本哈希与页数
    pass3 = os.path.join(SPIKE, "pass3.pdf")
    meta3 = render(final_html, pass3)
    doc3 = fitz.open(pass3)
    determinism = _determinism(final_pdf, pass3, doc2, doc3)
    weasy = _weasy_info()

    result = {
        "ok": toc_ok and outline_ok and len(fonts) > 0 and wm_pages >= 10 and footer_pages >= doc2.page_count - 1,
        "engine": "chromium-printToPDF",
        "template": TEMPLATE,
        "final_html": final_html,
        "pdf": final_pdf,
        "pages": doc2.page_count,
        "size_bytes": os.path.getsize(final_pdf),
        "render_ms_pass1": meta1["render_ms"],
        "render_ms_pass2": meta2["render_ms"],
        "render_ms_pass3": meta3["render_ms"],
        "total_ms": int((time.time() - t0) * 1000),
        "section_pages": pages,
        "toc_ok": toc_ok,
        "toc_rows": toc_rows,
        "fonts": fonts,
        "outline_count": len(outline),
        "outline_ok": outline_ok,
        "watermark_pages": wm_pages,
        "footer_page_number_pages": footer_pages,
        "determinism": determinism,
        "weasyprint": weasy,
    }
    out = os.path.join(SPIKE, "pdf-spike-result.json")
    open(out, "w", encoding="utf-8").write(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
