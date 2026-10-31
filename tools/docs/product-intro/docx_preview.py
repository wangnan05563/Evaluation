# -*- coding: utf-8 -*-
"""把 docx 渲染成逐页 PNG，做版式目检：Word 导出 PDF → pymupdf 渲染。
用法：python tools/docs/product-intro/docx_preview.py [docx 路径]
"""
import os
import sys

import pymupdf
import win32com.client

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DOCX = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "工作量评估助手-产品介绍.docx")
OUT = os.path.join(ROOT, "build", "shots", "doc_preview")
DPI = 110

os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith(".png"):
        os.remove(os.path.join(OUT, f))
pdf = os.path.join(OUT, "_preview.pdf")

word = win32com.client.DispatchEx("Word.Application")
word.Visible = False
word.DisplayAlerts = False
try:
    d = word.Documents.Open(DOCX, ReadOnly=True)
    d.ExportAsFixedFormat(pdf, 17)          # 17 = wdExportFormatPDF
    pages = d.ComputeStatistics(2)          # 2 = wdStatisticPages
    d.Close(False)
    print("Word 统计页数：", pages)
finally:
    word.Quit()

doc = pymupdf.open(pdf)
print("PDF 页数：", doc.page_count)
for i, page in enumerate(doc, 1):
    pix = page.get_pixmap(dpi=DPI)
    p = os.path.join(OUT, "p%02d.png" % i)
    pix.save(p)
    print("  p%02d  %dx%d  %d KB" % (i, pix.width, pix.height, os.path.getsize(p) // 1024))
doc.close()
os.remove(pdf)
