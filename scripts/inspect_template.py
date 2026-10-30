# -*- coding: utf-8 -*-
"""读取成品母版中的公式，为模板生成器提供保真依据。"""
import openpyxl

import sys as _sys
if len(_sys.argv) < 2:
    raise SystemExit("用法: %s <母版.xlsx>" % _sys.argv[0])
TPL = _sys.argv[1]

wb = openpyxl.load_workbook(TPL, data_only=False)
for sh in ["项目特征", "规模估算", "费用估算"]:
    ws = wb[sh]
    print(f"===== {sh} ({ws.dimensions}) =====")
    for row in ws.iter_rows():
        for c in row:
            v = c.value
            if isinstance(v, str) and v.startswith("="):
                print(f"{c.coordinate}\t{v}")
    print()