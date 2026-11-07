# -*- coding: utf-8 -*-
"""S2 · 引擎口径单测（FR-5.2）：weight/total_us/summary 不变量断言。退出码 0=全过。"""
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
os.chdir(ROOT)

import engine as g   # noqa: E402
import gb_engine as gb   # noqa: E402
import pert   # noqa: E402

fails = []
check = lambda n, ok, d='': (print(f"  {'PASS' if ok else 'FAIL'}  {n} {d}"), None if ok else fails.append(n))

TYPES = ["EI", "EO", "EQ", "ILF", "EIF"]
ITEMS = [
    {"system": "S1", "m1": "M1", "desc": "查询客户信息", "count_item": "客户查询", "type": "EQ", "reuse": "中", "modify": "新增"},
    {"system": "S1", "m1": "M1", "desc": "维护客户基础数据表", "count_item": "客户维护", "type": "ILF", "reuse": "低", "modify": "新增"},
    {"system": "S2", "m1": "M2", "desc": "生成对账报表并导出", "count_item": "对账报表", "type": "EO", "reuse": "高", "modify": "修改"},
]

# weight：确定性 + 枚举完备 + 未知类别报错
for t in TYPES:
    w = g.weight(t, "估算功能点")
    check(f"weight({t}) 确定性且为正", w == g.weight(t, "估算功能点") and w > 0, f"w={w}")
try:
    g.weight("XX", "估算功能点")
    check("未知类别抛 ValueError", False, "未抛异常")
except ValueError:
    check("未知类别抛 ValueError", True)

# total_us：等于逐条 US 之和
expect = round(sum(g.weight(it["type"]) * g.REUSE[it["reuse"]] * g.MODIFY[it["modify"]] for it in ITEMS), 2)
check("total_us = Σ(权重×重用×修改)", g.total_us(ITEMS, "估算功能点") == expect,
      f"{g.total_us(ITEMS, '估算功能点')} vs {expect}")

# summary：口径链完整（UFP→US→调整后→工作量→费用三值）
s = g.summary(ITEMS, method="估算功能点")
check("summary 键完整", all(k in s for k in ("ufp", "us", "adjusted_fp", "work", "cost")))
check("工作量三值区间有序 low<mid<high", s["work"]["low"] < s["work"]["mid"] < s["work"]["high"])
check("费用三值区间有序且与工作量同向", s["cost"]["low"] < s["cost"]["mid"] < s["cost"]["high"]
      and (s["cost"]["mid"] / s["work"]["mid"]) > 0)
check("调整后规模 = US×因子", abs(s["adjusted_fp"] - round(s["us"] * g.SCALE_CHANGE["估算中期"], 2)) < 0.01,
      f"{s['adjusted_fp']} vs {s['us']}×{g.SCALE_CHANGE['估算中期']}")

# T03724：复杂度仅记录，不参与 UFP/US（母版成品表无复杂度列）
CX_ITEMS = [{"type": "ILF", "reuse": "低", "modify": "新增", "cx": cx} for cx in ("低", "中", "高")]
cx_u = {g.summary([i], method="估算功能点")["ufp"] for i in CX_ITEMS}
cx_s = {g.summary([i], method="估算功能点")["us"] for i in CX_ITEMS}
check("复杂度不影响 UFP（低/中/高同为 10）", cx_u == {10}, str(cx_u))
check("复杂度不影响 US（低/中/高同为 10）", cx_s == {10.0}, str(cx_s))
pre = g.summary([{"type": "ILF", "reuse": "低", "modify": "新增"},
                 {"type": "EIF", "reuse": "低", "modify": "新增"}], method="预估功能点")
check("预估功能点法 ILF=35/EIF=15", pre["ufp"] == 50, str(pre["ufp"]))

# M6/FR-2.1：NESMA 快算口径
check("NESMA 预估法 35×ILF+15×EIF", gb.nesma_ufp({"ILF": 2, "EIF": 3}, "pre") == 35*2+15*3)
check("NESMA 估算法 7/5/4/5/4", gb.nesma_ufp({"ILF": 1, "EIF": 1, "EI": 2, "EO": 1, "EQ": 1}, "est") == 7+5+8+5+4)
check("NESMA 未知类别忽略", gb.nesma_ufp({"XX": 5}, "est") == 0)
# M6/FR-2.2：GB 造价方程（手算交叉验证：S=100×1×1.25=125；AE=6.96×125×1.67×1.0=1452.3；费用=1452.3/174×28000=233,713.79…）
o = gb.gb_cost(ufp=100, gsc=1.0, cf=1.25, swf=1.67, rdf=1.0, pdr=6.96, rate=28000, dnhc=0)
check("GB 造价 S = UFP×GSC×CF", abs(o["s"] - 125.0) < 1e-9, str(o["s"]))
check("GB 造价 AE = PDR×S×SWF×RDF", abs(o["ae"] - 6.96*125*1.67) < 0.01, str(o["ae"]))
check("GB 造价 费用 = AE/174×费率", abs(o["fee"] - round(o["ae"]/174*28000, 0)) < 1, str(o["fee"]))
# M6/FR-2.3：费率版本合法性
check("rates_ok 正常版本通过", gb.rates_ok({"pdr": 6.96, "rate": 28000, "unit_price": 850, "dnhc": 0}))
check("rates_ok 负数拒绝", not gb.rates_ok({"pdr": -1, "rate": 28000}))
check("rates_ok 超界拒绝", not gb.rates_ok({"pdr": 99999, "rate": 28000}))
check("rates_ok 非数值拒绝", not gb.rates_ok({"pdr": "abc", "rate": 28000}))

# ---- T03680：PERT 母版随包就位 + 生成链路 ----
import openpyxl

TPL = os.path.join(ROOT, 'tpl', 'pert-template.xlsx')
check("PERT 母版随包就位（tpl/pert-template.xlsx）", os.path.isfile(TPL), TPL)

if os.path.isfile(TPL):
    _saved_env = os.environ.pop("WE_TPL_PERT", None)
    try:
        check("未设 WE_TPL_PERT 时默认解析到内置母版",
              os.path.normcase(os.path.normpath(pert._resolve_pert_template() or '')) ==
              os.path.normcase(os.path.normpath(TPL)),
              pert._resolve_pert_template())

        # 打包态：_MEIPASS 下 tpl/ 才是母版所在，不能用 __file__ 反推仓库结构
        with tempfile.TemporaryDirectory() as _td:
            os.makedirs(os.path.join(_td, 'tpl'))
            shutil.copy2(TPL, os.path.join(_td, 'tpl', 'pert-template.xlsx'))
            _old_meipass = getattr(sys, "_MEIPASS", None)
            sys._MEIPASS = _td
            try:
                _got = pert._resolve_pert_template()
            finally:
                if _old_meipass is None:
                    del sys._MEIPASS
                else:
                    sys._MEIPASS = _old_meipass
            check("打包态（_MEIPASS）解析到包内母版",
                  os.path.normcase(os.path.normpath(_got or '')) ==
                  os.path.normcase(os.path.normpath(os.path.join(_td, 'tpl', 'pert-template.xlsx'))), _got)
    finally:
        if _saved_env is not None:
            os.environ["WE_TPL_PERT"] = _saved_env

    wb_t = openpyxl.load_workbook(TPL, data_only=False)
    ws_t = wb_t["项目工作量估算表"]
    EMPTY = ["D2", "H2", "D3", "C8", "C20", "C28", "D8", "D30",
             "E6", "G7", "E8", "G30", "E32", "G34"]
    check("母版项目数据区已清空", all(ws_t[a].value in (None, "") for a in EMPTY),
          [a for a in EMPTY if ws_t[a].value not in (None, "")])
    residue = [c.coordinate for row in ws_t.iter_rows() for c in row
               if isinstance(c.value, str) and "票据" in c.value]
    check("母版无原项目文案残留", not residue, residue[:3])
    check("母版公式保留（H/I/小计/总投入）",
          all(str(ws_t[a].value or "").startswith("=") for a in
              ("H6", "I6", "E31", "H35", "H40")))
    check("名称管理器每人月工天标准=20.83",
          {n.name: n.attr_text for n in wb_t.defined_names.values()}.get("每人月工天标准") == "20.83")
    wb_t.close()

    with tempfile.TemporaryDirectory() as _td:
        _out = os.path.join(_td, 'pert_gen.xlsx')
        pert.generate("母版自检项目", [
            {"phase": "开发", "system": "核心系统", "module": "查询", "desc": "列表页",
             "optimistic": 6, "most_likely": 6, "pessimistic": 7},
            {"phase": "需求分析", "system": "", "module": "", "desc": "",
             "optimistic": 8, "most_likely": 10, "pessimistic": 14},
        ], _out, est_date="2026-11-07", estimator="S2")
        wb_g = openpyxl.load_workbook(_out, data_only=False)
        ws_g = wb_g["项目工作量估算表"]
        check("generate 写出 D3/H2/D2（项目/估算人/日期）",
              ws_g["D3"].value == "母版自检项目" and ws_g["H2"].value == "S2"
              and ws_g["D2"].value == "2026-11-07")
        d8 = str(ws_g["D8"].value or "")
        check("generate 开发明细写入 D/E/F/G",
              all(k in d8 for k in ("核心系统", "查询", "列表页"))
              and (ws_g["E8"].value, ws_g["F8"].value, ws_g["G8"].value) == (6, 6, 7), d8)
        check("generate 阶段行写入三值",
              (ws_g["E6"].value, ws_g["F6"].value, ws_g["G6"].value) == (10, 8, 14))
        check("生成件保留 H/I 公式",
              str(ws_g["H6"].value or "").startswith("=") and str(ws_g["I6"].value or "").startswith("="))
        wb_g.close()

        # ---- T04570：openpyxl 保存会丢页眉图形/页脚域，须从母版 zip 回填 ----
        import re
        import zipfile
        with zipfile.ZipFile(_out) as _z:
            _names = set(_z.namelist())
            _sheet_xml = _z.read("xl/worksheets/sheet1.xml").decode("utf-8")
            _ct_xml = _z.read("[Content_Types].xml").decode("utf-8")
        with zipfile.ZipFile(TPL) as _zt:
            _hf = re.search(r"<headerFooter\b.*?</headerFooter>",
                            _zt.read("xl/worksheets/sheet1.xml").decode("utf-8"), re.S)
        _artifacts = {"xl/media/image1.jpeg", "xl/drawings/vmlDrawing1.vml",
                      "xl/drawings/_rels/vmlDrawing1.vml.rels",
                      "xl/worksheets/_rels/sheet1.xml.rels",
                      "xl/printerSettings/printerSettings1.bin"}
        check("生成件回填页眉 logo 部件（media/VML/rels/打印设置）",
              _artifacts <= _names, sorted(_artifacts - _names))
        check("生成件 Content_Types 注册 jpeg/vml/bin",
              all(f'Extension="{e}"' in _ct_xml for e in ("jpeg", "vml", "bin")))
        check("生成件 headerFooter 与母版逐字一致",
              _hf is not None and _hf.group(0) in _sheet_xml,
              _hf.group(0) if _hf else None)
        check("生成件 legacyDrawingHF 与 pageSetup r:id 就位",
              "<legacyDrawingHF" in _sheet_xml
              and re.search(r'<pageSetup\b[^>]*\br:id="rId\d+"', _sheet_xml) is not None)

print(f"==== S2 汇总 ==== 失败 {len(fails)}")
sys.exit(1 if fails else 0)
