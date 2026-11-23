# -*- coding: utf-8 -*-
"""T06207：全量 AC 剩余项兜底审计。

口径：不把未实现能力写成 PASS；每个 AC 给 PASS / PARTIAL / NOT_IMPLEMENTED / N/A，
并附可复查的文件与行号。任务描述里的 AC-36/37 不在三期需求矩阵（矩阵只有 AC-01~AC-35），
单独在 scope_note 说明。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "frontend" / "src"
JS = SRC / "js"
READ = lambda p: p.read_text(encoding="utf-8", errors="ignore") if p.exists() else ""


def find(pattern, paths, flags=re.I):
    files = []
    for p in paths:
        if p.is_dir():
            files.extend([f for f in p.rglob("*") if f.is_file() and f.suffix in (".js", ".html", ".css", ".py", ".nsh", ".json")])
        elif p.is_file():
            files.append(p)
    hits = []
    for p in files:
        for i, line in enumerate(READ(p).splitlines(), 1):
            if re.search(pattern, line, flags):
                hits.append({"file": str(p.relative_to(ROOT)).replace("\\", "/"), "line": i,
                             "text": line.strip()[:160]})
    return hits


def main(out_path=""):
    report = {"task": "T06207", "generated_by": "tests/phase3/ac_remaining_audit.py"}

    single = ROOT / "docs/test-reports/phase3-20261122/results/ui-single-machine.json"
    ui = json.loads(READ(single)) if single.exists() else {}
    report["AC-26"] = {
        "title": "单机版功能隔离",
        "verdict": "PASS" if ui.get("pass") == ui.get("total") == 4 else "FAIL",
        "evidence": {"file": "docs/test-reports/phase3-20261122/results/ui-single-machine.json",
                     "pass": ui.get("pass"), "total": ui.get("total"),
                     "checks": [c.get("title") for c in ui.get("checks", [])]},
    }

    brand_hits = find(r"brand[_-]?package|white[_-]?label|白标|brandPack", [SRC, ROOT / "scripts", ROOT / "build"])
    report["AC-31"] = {
        "title": "白标配置生效",
        "verdict": "NOT_IMPLEMENTED",
        "evidence": {"brand_package_hits": brand_hits[:8],
                     "note": "现有仅有 --brand 主色与 xlsx 表头联动，无品牌包/Logo/安装器/报告抬头配置面"},
    }

    theme_hits = find(r"contrast|对比度|theme.*save|save.*theme|保存主题", [JS, SRC / "index.src.html"])
    report["AC-32"] = {
        "title": "主题对比度阻断",
        "verdict": "NOT_IMPLEMENTED",
        "evidence": {"theme_contrast_hits": theme_hits[:8],
                     "note": "applyBrand 仅做 hex 格式校验；无对比度计算、无保存主题入口、无阻断提示"},
    }

    portfolio_hits = find(r"portfolio|组合看板|100\s*个项目|项目组合", [SRC, ROOT / "scripts"])
    report["AC-33"] = {
        "title": "组合看板加载",
        "verdict": "NOT_IMPLEMENTED",
        "evidence": {"portfolio_hits": portfolio_hits[:8], "note": "PRD 列为 V2.1；当前无组合看板页面与 100 项目数据源"},
    }

    rate_hits = find(r"gbVerChange|ratesVers|/api/rates", [JS])
    rate_ui = find(r"费率|rates", [SRC / "index.src.html"])
    report["AC-34"] = {
        "title": "费率切换追溯",
        "verdict": "PARTIAL",
        "evidence": {"rate_switch_hits": rate_hits[:8], "rate_ui_hits": rate_ui[:8],
                     "note": "已有费率版本选择与 gbVerChange 重算，结果带版本名；缺多费率卡/币种/逐项追溯矩阵"},
    }

    quote_hits = find(r"报价锁定|quote[_-]?lock|quoteLock|报价版本", [SRC, ROOT / "scripts"])
    report["AC-35"] = {
        "title": "报价版本锁定",
        "verdict": "NOT_IMPLEMENTED",
        "evidence": {"quote_lock_hits": quote_hits[:8], "note": "PRD 列为 V2.1；当前无报价单/锁定/版本生成入口"},
    }

    report["scope_note"] = {
        "task_description_acs": ["AC-26", "AC-36", "AC-37"],
        "matrix_acs_for_T06207": ["AC-26", "AC-31", "AC-32", "AC-33", "AC-34", "AC-35"],
        "finding": "AC-36/37 不在三期矩阵（矩阵仅 AC-01~AC-35）；T06207 按实际关联的 6 项审计。",
    }
    report["summary"] = {
        "pass": ["AC-26"], "partial": ["AC-34"],
        "not_implemented": ["AC-31", "AC-32", "AC-33", "AC-35"],
        "all_acs_have_evidence": True,
        "all_acs_pass": False,
    }
    text = json.dumps(report, ensure_ascii=False, indent=1)
    print(text)
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
