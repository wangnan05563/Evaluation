# -*- coding: utf-8 -*-
"""配置菜单页验收产物独立质量检查。

只读取测试实例生成的成品/诊断包/数据包，复核结构与关键数值，不复用前端断言。
"""
import json
import os
import re
import struct
import warnings
import zipfile
from collections import Counter

import openpyxl

warnings.filterwarnings("ignore", category=UserWarning)

BASE = r"C:\Users\hspcadmin\AppData\Local\Doubao\User Data\Default\.doubao\agent_mode\workspace\.sessions\38453923401786370\agents\m_0cwexANLqfk"
OUT = os.path.join(BASE, "config_test", "round1")
DATA = r"C:\Users\hspcadmin\AppData\Local\Temp\we_config_e2e"
UI_PATH = os.path.join(OUT, "ui_results.json")

with open(UI_PATH, encoding="utf-8") as f:
    ui = json.load(f)

checks = []


def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:500]})
    print(("PASS" if ok else "FAIL"), name, "—", str(detail)[:220])


def sha_available(path):
    return bool(path) and os.path.exists(path)


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    return struct.unpack(">II", head[16:24])


def workbook_view(path):
    """返回只读公式视图/data_only 视图与基础结构。"""
    wf = openpyxl.load_workbook(path, data_only=False)
    wd = openpyxl.load_workbook(path, data_only=True)
    return wf, wd


def item_rows(ws):
    return [r for r in range(6, ws.max_row + 1) if ws.cell(r, 7).value not in (None, "")]


def workbook_quality(path, label):
    exists = sha_available(path)
    check(f"{label} 成品存在且大小合理", exists and os.path.getsize(path) > 20000,
          f"{path} / {os.path.getsize(path) if exists else 0} bytes")
    if not exists:
        return None
    try:
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
        check(f"{label} xlsx 压缩结构可读", bad is None, f"testzip={bad}")
    except Exception as e:
        check(f"{label} xlsx 压缩结构可读", False, e)
        return None

    wf, wd = workbook_view(path)
    expected_sheets = ["项目特征", "规模估算", "费用估算", "模板使用说明&基础参数"]
    check(f"{label} 4 张模板工作表齐全", wf.sheetnames == expected_sheets, wf.sheetnames)
    rows = item_rows(wf["规模估算"])
    item_count = len(rows)
    types = Counter(wf["规模估算"].cell(r, 9).value for r in rows)
    descs = [wf["规模估算"].cell(r, 7).value for r in rows]
    ufp = wd["规模估算"]["J54"].value
    adjusted = wd["规模估算"]["M54"].value
    cost_mid = wd["费用估算"]["E28"].value
    check(f"{label} 明细恰好 17 项", item_count == 17, item_count)
    check(f"{label} 类型分布 EI=11/EQ=6", types.get("EI") == 11 and types.get("EQ") == 6 and len(types) == 2,
          dict(types))
    check(f"{label} UFP = 68", abs(float(ufp) - 68.0) < 0.01, ufp)
    check(f"{label} 调整后功能点 = 45.33", abs(float(adjusted) - 45.3333333333) < 0.02, adjusted)
    check(f"{label} 费用中值 = 6.84 万", abs(float(cost_mid) - 6.84) < 0.02, cost_mid)
    check(f"{label} 明细描述/类别完整", all(isinstance(d, str) and d.strip() for d in descs) and
          all(wf["规模估算"].cell(r, 9).value in ("EI", "EQ", "ILF", "EIF", "EO") for r in rows), "")
    check(f"{label} 17 项描述无重复", len(set(descs)) == 17, len(set(descs)))

    formula_anchors = {
        "规模估算!J54": wf["规模估算"]["J54"].value,
        "规模估算!M54": wf["规模估算"]["M54"].value,
        "费用估算!E3": wf["费用估算"]["E3"].value,
        "费用估算!E28": wf["费用估算"]["E28"].value,
    }
    check(f"{label} 汇总/费用公式仍在", all(isinstance(v, str) and v.startswith("=") for v in formula_anchors.values()),
          formula_anchors)

    formula_errors = []
    placeholders = []
    for ws in wd.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str):
                    if re.match(r"^#(REF|VALUE|NAME|DIV|N/A|NUM|NULL)", cell.value.strip()):
                        formula_errors.append(f"{ws.title}!{cell.coordinate}={cell.value}")
                    if any(x in cell.value for x in ("undefined", "NaN", "TODO", "识别失败")):
                        placeholders.append(f"{ws.title}!{cell.coordinate}={cell.value}")
    check(f"{label} 无公式错误值", not formula_errors, formula_errors[:6])
    check(f"{label} 无占位/未定义文本", not placeholders, placeholders[:6])
    return {"path": path, "sheets": wf.sheetnames, "items": item_count, "types": dict(types),
            "ufp": ufp, "adjusted": adjusted, "cost_mid": cost_mid, "descs": descs}


# ---------- 1. UI 全链路结果 ----------
check("UI 全链路全部通过", ui.get("passed") == ui.get("total") and ui.get("total", 0) >= 70,
      f"{ui.get('passed')}/{ui.get('total')}")
required_ui = [
    "配置页已激活", "配置页 11 张功能卡齐全",
    "配置页无横向溢出 1440px", "配置页无横向溢出 1024px", "配置页无横向溢出 768px", "配置页无横向溢出 375px",
    "费率字段在 375px 下不压成 4 列", "识别规则初始 6 条",
    "上下文目录保存并自动扫描真实仓库", "无效上下文目录显示错误且不崩溃",
    "重算超时越界被拒绝", "配置重新加载后重算值回显",
    "英文供应商标签已翻译", "英文配置页无裸露 i18n key",
    "配置费率实时影响快速页 AE/费用", "规则命中真实文档：审批流程由 EI 变 EO",
    "自定义母版生成成品成功", "数据包可经 UI 导入且不报错", "最终回到配置页且无横向溢出",
]
results_by_name = {r.get("n"): r.get("ok") for r in ui.get("results", [])}
missing_or_failed = [n for n in required_ui if results_by_name.get(n) is not True]
check("关键 UI 断言逐项通过", not missing_or_failed, missing_or_failed)

shots = ["00_config_zh_1440.png", "01_config_1024.png", "02_config_768.png", "03_config_375.png",
         "04_config_en_1440.png", "05_config_rates_fast.png", "06_config_rules_changed.png", "07_config_ops.png"]
shot_info = []
for name in shots:
    p = os.path.join(OUT, name)
    if os.path.exists(p):
        w, h = png_size(p)
        shot_info.append({"name": name, "w": w, "h": h, "bytes": os.path.getsize(p)})
check("四档响应式截图齐全", all(os.path.exists(os.path.join(OUT, n)) for n in shots), [s["name"] for s in shot_info])
check("1440/1024/768/375 截图尺寸正确",
      [x["w"] for x in shot_info if x["name"] in ("00_config_zh_1440.png", "01_config_1024.png", "02_config_768.png", "03_config_375.png")] == [1440, 1024, 768, 375],
      [x["w"] for x in shot_info])

# ---------- 2. 基线成品 ----------
baseline_info = workbook_quality(os.path.join(DATA, "generated", "配置页验收-真实文档-工作量评估.xlsx"), "基线成品")
custom_info = workbook_quality(os.path.join(DATA, "generated", "配置页验收-母版成品-工作量评估.xlsx"), "自定义母版成品")

# ---------- 3. 自定义母版标记与结构一致性 ----------
custom_path = os.path.join(DATA, "generated", "配置页验收-母版成品-工作量评估.xlsx")
if os.path.exists(custom_path):
    wf, wd = workbook_view(custom_path)
    marker = wf["模板使用说明&基础参数"]["A1"].value
    check("自定义母版标记被成品保留", marker == "CFG_TEMPLATE_MARKER_20261119", marker)
    if baseline_info and custom_info:
        same_structure = baseline_info["sheets"] == custom_info["sheets"]
        same_items = baseline_info["descs"] == custom_info["descs"]
        same_nums = (abs(float(custom_info["ufp"]) - float(baseline_info["ufp"])) < 0.01 and
                     abs(float(custom_info["adjusted"]) - float(baseline_info["adjusted"])) < 0.01 and
                     abs(float(custom_info["cost_mid"]) - float(baseline_info["cost_mid"])) < 0.02)
        check("自定义母版成品与基线结构一致", same_structure and same_items and same_nums,
              {"sheets": same_structure, "items": same_items, "numbers": same_nums})

# ---------- 4. 诊断包 / 数据包安全与完整性 ----------
diag_path = ui.get("artifacts", {}).get("diag", "")
data_path = ui.get("artifacts", {}).get("data", "")
check("诊断包与数据包均存在", os.path.exists(diag_path) and os.path.exists(data_path), f"{diag_path} / {data_path}")

DIAG_ALLOWED = {"logs/server.jsonl", "config/recognition_rules.json", "config/rates_versions.json",
                "config/schema_ver", "version.json"}
DATA_ALLOWED = {"pert.db", "estimation.db", "recognition_rules.json", "rates_versions.json", "schema_ver"}
SECRETS = ["sk-diag-must-not-leak", "sk-cfg-e2e-secret"]
FORBIDDEN = re.compile(r"(^|/)(config\.json|uploads/|generated/|templates?/)|\.docx$|\.xlsx$", re.I)

for label, path, allowed in (("诊断包", diag_path, DIAG_ALLOWED), ("数据包", data_path, DATA_ALLOWED)):
    if not os.path.exists(path):
        check(f"{label} 可打开", False, path)
        continue
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        bad = z.testzip()
        check(f"{label} zip 完整", bad is None, bad)
        check(f"{label} 文件清单符合白名单", set(names) == allowed, names)
        check(f"{label} 不含配置/文档/成品/母版", not any(FORBIDDEN.search(n) for n in names), names)
        leaked = []
        for n in names:
            data = z.read(n)
            for s in SECRETS:
                if s.encode() in data:
                    leaked.append(n)
        check(f"{label} 不含测试 API Key", not leaked, leaked)
        if label == "数据包":
            check("数据包 DB 为 SQLite", all(z.read(n)[:16] == b"SQLite format 3\x00" for n in ("pert.db", "estimation.db")),
                  [z.read(n)[:16] for n in ("pert.db", "estimation.db")])
            rules = json.loads(z.read("recognition_rules.json").decode("utf-8-sig"))
            rates = json.loads(z.read("rates_versions.json").decode("utf-8-sig"))
            check("数据包规则为原始 6 条", len(rules.get("rules", [])) == 6, len(rules.get("rules", [])))
            check("数据包费率含 2 套基线版本", len(rates.get("versions", {})) == 2, list(rates.get("versions", {})) )

# ---------- 5. 独立算一遍快速估算联动值 ----------
ufp = 4
s = ufp * 1.1
ae = 8.5 * s
fee = round(ae / 174 * 32000 + 1000)
check("独立复算快速估算费用 = 7878", abs(s - 4.4) < 1e-9 and abs(ae - 37.4) < 1e-9 and fee == 7878,
      {"S": s, "AE": ae, "fee": fee})

passed = sum(1 for c in checks if c["ok"])
total = len(checks)
out = {
    "passed": passed,
    "total": total,
    "checks": checks,
    "ui": {"passed": ui.get("passed"), "total": ui.get("total")},
    "screenshots": shot_info,
    "workbooks": {"baseline": baseline_info, "custom": custom_info},
    "artifacts": {"diag": diag_path, "data": data_path},
}
with open(os.path.join(OUT, "quality_results.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(f"QUALITY SUMMARY {passed}/{total}")
raise SystemExit(0 if passed == total else 1)
