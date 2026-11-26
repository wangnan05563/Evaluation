from pathlib import Path
import re

p = Path(r"D:\code\otherProjects\Evaluation\docs\prd\20261121-工作量评估助手-PRD.md")
lines = p.read_text(encoding="utf-8").splitlines()

bad = []
i = 0
while i < len(lines):
    if lines[i].strip().startswith("|"):
        group = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            group.append(lines[i].strip())
            i += 1
        widths = [len([c for c in row.strip().strip("|").split("|")]) for row in group]
        if len(set(widths)) != 1:
            bad.append((i - len(group) + 1, widths, group[0][:80]))
    else:
        i += 1

print("table_mismatches", len(bad))
for item in bad:
    print(item)

story_ids = re.findall(r"E\d+-S\d+", p.read_text(encoding="utf-8"))
print("story_mentions", len(story_ids), "unique", len(set(story_ids)))
