#!/usr/bin/env python3
"""Build Feishu Doc XML for the PRD and report coverage stats."""
from __future__ import annotations

import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MD_PATH = ROOT / "20261121-工作量评估助手-PRD.md"
XML_PATH = ROOT / "feishu-prd-draft.xml"


def inline(text: str) -> str:
    pattern = re.compile(r"(\*\*.+?\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`)")
    parts = pattern.split(text)
    out: list[str] = []
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            out.append("<b>" + inline(part[2:-2]) + "</b>")
        elif part.startswith("[") and "](" in part and part.endswith(")"):
            label, url = part[1:-1].split("](", 1)
            out.append(f'<a href="{html.escape(url, quote=True)}">{inline(label)}</a>')
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            out.append("<span>" + html.escape(part[1:-1]) + "</span>")
        else:
            out.append(html.escape(part))
    return "".join(out)


def strip_heading_number(text: str) -> str:
    text = re.sub(r"^[一二三四五六七八九十]+、\s*", "", text)
    text = re.sub(r"^\d+(?:\.\d+)*[.、]?\s*", "", text)
    return text.strip()


def split_table_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def is_separator(line: str) -> bool:
    cells = split_table_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c) for c in cells)


def render_table(lines: list[str]) -> str:
    rows = [split_table_row(line) for line in lines if not is_separator(line)]
    if not rows:
        return ""
    width = 820 // max(1, len(rows[0]))
    colgroup = "<colgroup>" + "".join(f'<col width="{width}"/>' for _ in rows[0]) + "</colgroup>"
    out = ["<table>", colgroup, "<thead><tr>"]
    for cell in rows[0]:
        out.append(f'<th background-color="light-gray"><p>{inline(cell)}</p></th>')
    out.append("</tr></thead><tbody>")
    for row in rows[1:]:
        out.append("<tr>")
        for cell in row:
            out.append(f'<td vertical-align="top"><p>{inline(cell)}</p></td>')
        out.append("</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def main() -> None:
    text = MD_PATH.read_text(encoding="utf-8")
    lines = text.splitlines()

    story_ids = sorted(set(re.findall(r"E\d+-S\d+", text)))
    research_ids = sorted(set(re.findall(r"(?:CX|FN|UI|TH)-\d{2}", text)))
    print(f"stories={len(story_ids)} research_ids={len(research_ids)}")
    print("story_ids=" + ",".join(story_ids))

    out: list[str] = ["<title>工作量评估助手产品需求文档（PRD）</title>"]
    i = 0
    title_seen = False
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped:
            i += 1
            continue

        if stripped.startswith("# ") and not title_seen:
            title_seen = True
            i += 1
            continue

        if stripped.startswith(">"):
            group = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                group.append(lines[i].strip())
                i += 1
            body = "<br/>".join(inline(line[1:].strip()) for line in group)
            out.append(f"<blockquote><p>{body}</p></blockquote>")
            continue

        if stripped.startswith("## "):
            out.append(f'<h1 seq="auto">{inline(strip_heading_number(stripped[3:]))}</h1>')
            i += 1
            continue
        if stripped.startswith("### "):
            out.append(f'<h2 seq="auto">{inline(strip_heading_number(stripped[4:]))}</h2>')
            i += 1
            continue
        if stripped.startswith("#### "):
            out.append(f'<h3 seq="auto">{inline(strip_heading_number(stripped[5:]))}</h3>')
            i += 1
            continue

        if stripped.startswith("|"):
            group = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                group.append(lines[i].strip())
                i += 1
            out.append(render_table(group))
            continue

        if re.match(r"^- ", stripped):
            items = []
            while i < len(lines) and re.match(r"^- ", lines[i].strip()):
                items.append(lines[i].strip()[2:].strip())
                i += 1
            out.append("<ul>" + "".join(f"<li>{inline(item)}</li>" for item in items) + "</ul>")
            continue

        if re.match(r"^\d+\. ", stripped):
            items = []
            while i < len(lines) and re.match(r"^\d+\. ", lines[i].strip()):
                items.append(re.sub(r"^\d+\.\s*", "", lines[i].strip()))
                i += 1
            out.append("<ol>" + "".join(f"<li>{inline(item)}</li>" for item in items) + "</ol>")
            continue

        if stripped == "---":
            out.append("<hr/>")
            i += 1
            continue

        group = []
        while i < len(lines):
            nxt = lines[i].strip()
            if not nxt:
                break
            if nxt.startswith(("#", ">", "|", "- ")) or re.match(r"^\d+\. ", nxt) or nxt == "---":
                break
            group.append(nxt)
            i += 1
        if group:
            out.append("<p>" + inline("".join(group)) + "</p>")

    XML_PATH.write_text("".join(out), encoding="utf-8")
    print(f"xml={XML_PATH} bytes={XML_PATH.stat().st_size}")


if __name__ == "__main__":
    main()
