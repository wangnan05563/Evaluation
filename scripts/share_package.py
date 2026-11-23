# -*- coding: utf-8 -*-
"""T06182：离线脱敏分享包（单文件 HTML，无外部链接、无远程字体）。

- 只接受 `ok === true` 的已确认功能项；未确认项、内部备注、原文证据、trace/AI 字段全部丢弃。
- 单文件内联 CSS，无 `<link>`、无 `src=`、无 `url()`、无 `@import`；字体只用系统字体栈。
- 分享摘要按“已确认项”重新复算，避免把未确认数据带入 KPI。
"""
import hashlib
import html
import json
import re
import time
import uuid
from pathlib import Path

import audit_package

TIMING_ALIAS = {"交付后及运维": "项目交付后及运维阶段"}
ITEM_ALLOW = ("stable_id", "system", "m1", "desc", "count_item", "type", "reuse", "modify",
              "det", "ret", "ftr", "seq")
SECTIONS = ("share-summary", "share-method", "share-composition", "share-items")

CSS = """
:root{--ink:#172033;--muted:#657084;--line:#dbe2ea;--brand:#175cd3;--soft:#f2f7ff;--warn:#92400e}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#eef2f7;color:var(--ink)}
body{font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC","Segoe UI",Arial,sans-serif;font-size:15px;line-height:1.7}
.page{width:210mm;min-height:294mm;margin:18px auto;padding:24mm 20mm 18mm;background:#fff;box-shadow:0 10px 30px rgba(23,32,51,.12);page-break-after:always;position:relative}
.page:last-child{page-break-after:auto}
.cover{display:flex;flex-direction:column;justify-content:center;background:linear-gradient(145deg,#fff 0%,#f4f8ff 55%,#eaf2ff 100%)}
.kicker{color:var(--brand);font-size:12px;font-weight:800;letter-spacing:.16em}
.cover h1{font-size:42px;line-height:1.22;margin:18mm 0 8mm;max-width:150mm}
.cover .sub{font-size:20px;color:var(--muted);margin:0 0 12mm}
.cover .meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:10mm}
.seal{margin-top:16mm;align-self:flex-start;border:2px solid var(--warn);color:var(--warn);padding:6px 14px;font-weight:800;letter-spacing:.08em;transform:rotate(-4deg)}
h2{font-size:25px;line-height:1.3;margin:0 0 8mm;padding-bottom:4mm;border-bottom:2px solid var(--brand)}
h3{font-size:18px;margin:8mm 0 3mm;color:var(--brand)}
p{margin:0 0 4mm;text-align:justify}
.note{background:var(--soft);border-left:4px solid var(--brand);padding:4mm 5mm;color:var(--muted);font-size:13px;margin:5mm 0}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm;margin:8mm 0}
.kpi{border:1px solid var(--line);border-radius:10px;padding:6mm;background:#fff}
.kpi b{display:block;color:var(--brand);font-size:30px;line-height:1.1}
.kpi span{display:block;color:var(--muted);font-size:12px;margin-top:2mm}
table{width:100%;border-collapse:collapse;margin:5mm 0;font-size:13px}
th,td{border:1px solid var(--line);padding:3mm;vertical-align:top;text-align:left}
th{background:var(--soft);font-size:12px;color:#344054}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{color:var(--muted)}
.footer{margin-top:8mm;padding-top:4mm;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--muted);margin-right:6px}
@page{size:A4;margin:0}
@media print{html,body{background:#fff}.page{margin:0;box-shadow:none;width:auto;min-height:auto}}
"""


def _esc(value):
    return html.escape(str(value if value is not None else ""), quote=True)


def _f(value, digits=2):
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "—"


def _name(value, limit=80):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _safe_item(raw, seq):
    clean = {}
    for key in ITEM_ALLOW:
        value = raw.get(key)
        if value is None or value == "":
            continue
        if key == "seq":
            clean["seq"] = seq
        elif key in ("det", "ret", "ftr"):
            try:
                clean[key] = int(value)
            except (TypeError, ValueError):
                pass
        else:
            clean[key] = _name(value, 220)
    clean.setdefault("desc", _name(raw.get("count_item") or raw.get("desc") or f"功能项 {seq}", 220))
    clean["seq"] = seq
    return clean


def sanitize(payload):
    """输入白名单化；返回只含已确认项的分享草稿。"""
    if not isinstance(payload, dict):
        raise ValueError("分享包请求体必须是 JSON 对象")
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("分享包至少需要 1 个功能项")
    if len(raw_items) > 300:
        raise ValueError("分享包功能项上限 300")
    confirmed = [it for it in raw_items if isinstance(it, dict) and it.get("ok") is True]
    if not confirmed:
        raise ValueError("没有已确认功能项可分享，请先在复核页确认")
    total_items = payload.get("total_items", len(raw_items))
    try:
        total_items = min(max(int(total_items), len(raw_items)), 300)
    except (TypeError, ValueError):
        total_items = len(raw_items)
    project = payload.get("project") if isinstance(payload.get("project"), dict) else {}
    timing = str(payload.get("timing") or "估算中期")
    timing = TIMING_ALIAS.get(timing, timing)
    clean_project = {
        "name": _name(project.get("name") or payload.get("title") or "工作量评估项目", 80),
        "version": _name(project.get("version") or "0.1", 40),
        "date": _name(project.get("date") or time.strftime("%Y-%m-%d"), 20),
    }
    items = [_safe_item(it, i) for i, it in enumerate(confirmed, 1)]
    return {
        "project": clean_project,
        "items": items,
        "method": str(payload.get("method") or "估算功能点"),
        "timing": timing,
        "cx_mode": str(payload.get("cx_mode") or "企业母版"),
        "total_items": total_items,
        "excluded": max(total_items - len(items), 0),
        "title": _name(payload.get("title") or clean_project["name"], 80),
    }


def _calc(ctx):
    items = ctx["items"]
    summary = ctx["summary"]
    systems = {}
    types = {}
    reuse = {}
    for it in items:
        systems[it.get("system") or "未分组"] = systems.get(it.get("system") or "未分组", 0) + float(it.get("us") or 0)
        types[it.get("type") or "—"] = types.get(it.get("type") or "—", 0) + 1
        reuse[it.get("reuse") or "—"] = reuse.get(it.get("reuse") or "—", 0) + 1
    sys_rows = sorted(systems.items(), key=lambda kv: (-kv[1], kv[0]))
    return summary, sys_rows, sorted(types.items(), key=lambda kv: (-kv[1], kv[0])), sorted(reuse.items(), key=lambda kv: (-kv[1], kv[0]))


def build_html(clean, ctx):
    s, sys_rows, types, reuse = _calc(ctx)
    items = ctx["items"]
    system_rows = "".join(
        f"<tr><td>{_esc(name)}</td><td class='num'>{_f(us)}</td><td class='num'>{(us / s['us'] * 100 if s['us'] else 0):.1f}%</td></tr>"
        for name, us in sys_rows[:12])
    if len(sys_rows) > 12:
        rest = sum(us for _, us in sys_rows[12:])
        system_rows += f"<tr><td>其他 {len(sys_rows) - 12} 个系统</td><td class='num'>{_f(rest)}</td><td class='num'>{(rest / s['us'] * 100 if s['us'] else 0):.1f}%</td></tr>"
    type_text = " · ".join(f"{_esc(k)} {v}" for k, v in types) or "—"
    reuse_text = " · ".join(f"{_esc(k)} {v}" for k, v in reuse) or "—"
    item_rows = "".join(
        f"<tr><td>{_esc(it.get('stable_id') or ('FP-%03d' % it.get('seq', 0)))}</td>"
        f"<td>{_esc(it.get('system') or '未分组')}</td><td>{_esc(it.get('desc') or it.get('count_item') or '')}</td>"
        f"<td>{_esc(it.get('type') or '')}</td><td>{_esc(it.get('reuse') or '')} / {_esc(it.get('modify') or '')}</td>"
        f"<td class='num'>{it.get('ufp')}</td><td class='num'>{_f(it.get('us'))}</td></tr>"
        for it in items)
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_esc(clean['title'])} · 脱敏分享包</title>
<style>{CSS}</style></head><body>
<section class="page cover" id="share-cover">
  <div class="kicker">WORKLOAD EVALUATION · OFFLINE SHARE PACKAGE</div>
  <h1>{_esc(clean['project']['name'])}<br>工作量评估分享包</h1>
  <p class="sub">脱敏 · 离线 · 单文件</p>
  <div class="meta"><span>版本 {_esc(clean['project']['version'])}</span><span>生成日期 {_esc(clean['project']['date'])}</span>
    <span>已确认 {len(items)} / 原始 {clean['total_items']} 项</span><span>方法 {_esc(clean['method'])}</span></div>
  <div class="seal">仅含已确认数据 · 脱敏分享</div>
</section>
<section class="page" id="share-summary">
  <h2>执行摘要</h2>
  <p class="note">本包只展示已确认功能项；已隐藏 {clean['excluded']} 项未确认数据，以及内部备注、原文证据、AI 置信度与追溯字段。下方 KPI 按已确认项重新计算。</p>
  <div class="kpis">
    <div class="kpi"><b>{s['ufp']}</b><span>未调整功能点 UFP</span></div>
    <div class="kpi"><b>{_f(s['us'])}</b><span>未调整规模 US</span></div>
    <div class="kpi"><b>{_f(s['adjusted_fp'])}</b><span>调整后规模 FP</span></div>
    <div class="kpi"><b>{_f(s['work']['mid'])}</b><span>基准工作量（人天）</span></div>
    <div class="kpi"><b>{_f(s['cost']['mid'])}</b><span>费用中值（万元）</span></div>
    <div class="kpi"><b>{len(items)}</b><span>已确认功能项</span></div>
  </div>
  <table><tr><th>维度</th><th>低</th><th>中</th><th>高</th></tr>
    <tr><td>工作量（人天）</td><td class="num">{_f(s['work']['low'])}</td><td class="num">{_f(s['work']['mid'])}</td><td class="num">{_f(s['work']['high'])}</td></tr>
    <tr><td>费用（万元）</td><td class="num">{_f(s['cost']['low'])}</td><td class="num">{_f(s['cost']['mid'])}</td><td class="num">{_f(s['cost']['high'])}</td></tr>
  </table>
  <div class="footer">口径：调整后规模 = US × 规模变更因子；费用按 22 人天/人月、2.57 万元/人月估算。</div>
</section>
<section class="page" id="share-method">
  <h2>方法与口径</h2>
  <table><tr><th>项目</th><th>口径</th></tr>
    <tr><td>估算方法</td><td>{_esc(clean['method'])}</td></tr>
    <tr><td>规模计数时机</td><td>{_esc(clean['timing'])}</td></tr>
    <tr><td>复杂度口径</td><td>{_esc(clean['cx_mode'])}</td></tr>
    <tr><td>功能点分类</td><td>{type_text}</td></tr>
    <tr><td>重用度分布</td><td>{reuse_text}</td></tr>
    <tr><td>数据范围</td><td>仅包含复核页已确认的 {len(items)} 项；不包含未确认项</td></tr>
  </table>
  <p>US = UFP × 重用系数（低 1.0 / 中 0.6667 / 高 0.3333）× 修改系数（新增 1.0 / 修改 0.8 / 删除 0.2）。</p>
  <p>本文件为本地生成的静态 HTML，使用系统字体栈，不依赖远程字体、外部样式、图片或网络资源；复制到离线环境后可直接打开。</p>
</section>
<section class="page" id="share-composition">
  <h2>规模构成</h2>
  <table><tr><th>系统</th><th>US</th><th>占比</th></tr>{system_rows}</table>
  <p class="muted">功能点类型：{type_text}</p>
</section>
<section class="page" id="share-items">
  <h2>已确认功能项清单</h2>
  <p class="muted">共 {len(items)} 项；已隐藏内部备注、原文证据与未确认数据。UFP/US 为按上述口径复算值。</p>
  <table><tr><th>ID</th><th>系统</th><th>功能项</th><th>类型</th><th>重用/修改</th><th>UFP</th><th>US</th></tr>{item_rows}</table>
  <div class="footer">脱敏分享包 · 单文件离线版 · 分享指纹 {hashlib.sha256(json.dumps(clean, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()[:16]}</div>
</section>
</body></html>"""


def inspect_html(text):
    low = text.lower()
    external = []
    for token in ("<link", "<script", "src=", "href=", "@import", "url(", "http://", "https://", "ftp://"):
        if token in low:
            external.append(token)
    font_stack = "microsoft yahei" in low and "pingfang sc" in low and "@font-face" not in low
    sections = sum(1 for sid in SECTIONS if f'id="{sid}"' in text)
    return {
        "external_links": len(external),
        "external_tokens": external,
        "font_stack": font_stack,
        "sections": sections,
        "sections_ok": sections == len(SECTIONS),
    }


def generate(payload, out_dir):
    t0 = time.time()
    clean = sanitize(payload)
    ctx = audit_package._normalize({
        "project": clean["project"], "items": clean["items"], "method": clean["method"],
        "timing": clean["timing"], "cx_mode": clean["cx_mode"], "title": clean["title"],
    })
    doc = build_html(clean, ctx)
    inspect = inspect_html(doc)
    ok = inspect["external_links"] == 0 and inspect["font_stack"] and inspect["sections_ok"]
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"share_{time.strftime('%Y%m%d-%H%M%S')}_{uuid.uuid4().hex[:8]}.html"
    path = out_dir / name
    path.write_text(doc, encoding="utf-8")
    return {
        "ok": ok,
        "file": str(path),
        "download_name": name,
        "download": "/api/share/download?f=" + name,
        "size": len(doc.encode("utf-8")),
        "items": len(ctx["items"]),
        "excluded": clean["excluded"],
        "sections": inspect["sections"],
        "external_links": inspect["external_links"],
        "external_tokens": inspect["external_tokens"],
        "font_stack": inspect["font_stack"],
        "html_sha256": hashlib.sha256(doc.encode("utf-8")).hexdigest(),
        "elapsed_ms": int((time.time() - t0) * 1000),
        "summary": {"ufp": ctx["summary"]["ufp"], "us": ctx["summary"]["us"],
                    "adjusted_fp": ctx["summary"]["adjusted_fp"],
                    "work_mid": ctx["summary"]["work"]["mid"], "cost_mid": ctx["summary"]["cost"]["mid"]},
    }


def main(argv=None):
    argv = argv or []
    if not argv:
        print(json.dumps({"usage": "share_package.py <payload.json> <out_dir>"}, ensure_ascii=False))
        return 2
    payload = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    result = generate(payload, argv[1])
    print(json.dumps(result, ensure_ascii=False, indent=2)[:1200])
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    import sys
    raise SystemExit(main(sys.argv[1:]))
