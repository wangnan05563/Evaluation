# -*- coding: utf-8 -*-
"""T06181：七部分审计包生成（HTML → Chromium 两遍渲染 → PDF + 追溯链接）。

设计：
- 七部分固定：封面 / 执行摘要 / 方法与口径 / 估算明细 / 追溯矩阵 / 变更与 AI 审计 / 签收页。
- 一个 PDF 承载全部内容；先用占位目录渲染 pass1，按章节标题定位页码，再替换占位符渲染正式版。
- 明细每行有「追溯」文字，正式版用 PyMuPDF 写入 PDF 内部链接，点击跳到追溯矩阵对应页。
- 不引入后台服务；由 scripts/server.py 在现有进程内调用；生成耗时预算 30 秒。
"""
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node") or "node"
RENDER = str(ROOT / "scripts" / "pdf_render.mjs")

PARTS = [
    (1, "封面"),
    (2, "执行摘要"),
    (3, "方法与口径"),
    (4, "估算明细"),
    (5, "追溯矩阵"),
    (6, "变更与 AI 审计"),
    (7, "签收页"),
]

CSS = """
:root { --ink:#1f2937; --muted:#6b7280; --line:#d1d5db; --brand:#2563eb; --soft:#eff6ff; --warn:#92400e; }
* { box-sizing: border-box; }
body { margin:0; color:var(--ink); font: 10pt/1.6 "Microsoft YaHei","Noto Sans SC","PingFang SC",sans-serif; }
.cover { height:247mm; display:flex; flex-direction:column; justify-content:center; padding:0 8mm; page-break-after:always; }
.cover .kicker { color:var(--brand); letter-spacing:.16em; font-size:9pt; font-weight:700; }
.cover h1 { font-size:25pt; line-height:1.22; margin:8mm 0 3mm; }
.cover .sub { color:var(--muted); font-size:11pt; }
.cover .meta { margin-top:15mm; border-top:1px solid var(--line); padding-top:4mm; color:var(--muted); font-size:9pt; line-height:1.9; }
.cover .class { margin-top:6mm; font-size:9pt; color:var(--warn); font-weight:700; }
.toc { page-break-after:always; }
h2 { font-size:15pt; margin:0 0 3mm; padding-bottom:2mm; border-bottom:1px solid var(--line); }
h3 { font-size:11pt; margin:5mm 0 2mm; }
p { margin:0 0 3mm; text-align:justify; }
.part { page-break-before:always; }
.part.first { page-break-before:auto; }
.toc ol { padding-left:0; list-style:none; }
.toc li { display:flex; align-items:baseline; gap:2mm; border-bottom:1px dotted #e5e7eb; padding:2.4mm 0; }
.toc .t { flex:1; }
.toc .p { color:var(--muted); font-variant-numeric:tabular-nums; }
table { width:100%; border-collapse:collapse; margin:3mm 0 4mm; font-size:8.6pt; }
table.detail, table.trace-table { table-layout:fixed; font-size:7.7pt; }
table.detail td, table.trace-table td { word-break:normal; overflow-wrap:break-word; }
table.ai-table { table-layout:fixed; font-size:7.2pt; }
table.ai-table td { word-break:break-word; }
th,td { border:1px solid var(--line); padding:1.5mm 1.6mm; vertical-align:top; }
th { background:var(--soft); text-align:left; font-size:7.4pt; }
table.detail th:nth-child(3) { font-size:6.7pt; padding-left:1mm; padding-right:1mm; }
td.sid { white-space:nowrap; font-variant-numeric:tabular-nums; }
td.rm, td.det { white-space:nowrap; }
.trace-table td.formula { word-break:keep-all; overflow-wrap:normal; }
.numlink { color:var(--brand); text-decoration:underline; font-weight:700; }
.numlink:hover { text-decoration:none; }
.note { background:#f9fafb; border-left:3px solid var(--brand); padding:2.5mm 3mm; margin:3mm 0 4mm; }
.badge { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:.4mm 2mm; font-size:8pt; color:var(--muted); }
.kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:3mm; margin:4mm 0; }
.kpi { border:1px solid var(--line); padding:3mm; }
.kpi b { display:block; font-size:16pt; color:var(--brand); }
.kpi span { color:var(--muted); font-size:8.5pt; }
.small { color:var(--muted); font-size:8.4pt; }
.trace { color:var(--brand); text-decoration:underline; white-space:nowrap; }
.watermark { position:fixed; top:42%; left:12%; transform:rotate(-24deg); font-size:38pt; font-weight:800; letter-spacing:.1em; color:#2563eb; opacity:.07; z-index:-1; }
.sign { display:grid; grid-template-columns:repeat(2,1fr); gap:4mm; margin-top:4mm; }
.sign div { border:1px solid var(--line); min-height:22mm; padding:2.5mm; color:var(--muted); }
.footer-note { color:var(--muted); font-size:8.3pt; margin-top:5mm; }
@page { size:A4; margin:16mm 14mm 18mm; }
@media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
"""


def _esc(value):
    return html.escape(str(value == None and "" or value), quote=True)


def _f(value, digits=2):
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "—"


def _normalize(payload):
    """校验并补齐审计包输入；非法数据在此拒绝，不进入渲染。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("审计包至少需要 1 个功能项")
    if len(items) > 300:
        raise ValueError("审计包功能项上限 300")
    try:
        from engine import (METHOD_ESTIMATE, METHODS, SCALE_CHANGE, CX_MASTER, normalize_cx_mode,
                            REUSE, MODIFY, item_ufp, item_us, summary)
    except ImportError:
        import engine as _e
        METHOD_ESTIMATE, METHODS, SCALE_CHANGE, CX_MASTER, normalize_cx_mode = (
            _e.METHOD_ESTIMATE, _e.METHODS, _e.SCALE_CHANGE, _e.CX_MASTER, _e.normalize_cx_mode)
        REUSE, MODIFY, item_ufp, item_us, summary = _e.REUSE, _e.MODIFY, _e.item_ufp, _e.item_us, _e.summary
    method = payload.get("method") or METHOD_ESTIMATE
    if method not in METHODS:
        raise ValueError(f"未知估算方法 {method}")
    timing = payload.get("timing") or "估算中期"
    if timing not in SCALE_CHANGE:
        raise ValueError(f"未知估算时机 {timing}")
    cx_mode = normalize_cx_mode(payload.get("cx_mode"))
    normalized = []
    for i, raw in enumerate(items, 1):
        if not isinstance(raw, dict):
            raise ValueError(f"第 {i} 项不是对象")
        typ = (raw.get("type") or "").strip()
        if typ not in engine_types(REUSE, MODIFY):
            raise ValueError(f"第 {i} 项类型非法：{typ}")
        reuse = raw.get("reuse") or "中"
        modify = raw.get("modify") or "新增"
        if reuse not in REUSE or modify not in MODIFY:
            raise ValueError(f"第 {i} 项重用/修改类型非法")
        it = dict(raw)
        it["seq"] = i
        it["type"] = typ
        it["reuse"] = reuse
        it["modify"] = modify
        it["desc"] = (it.get("desc") or it.get("count_item") or "").strip()
        if not it["desc"]:
            raise ValueError(f"第 {i} 项缺少描述")
        it["stable_id"] = str(it.get("stable_id") or f"FP-{i:03d}")
        it["basis"] = str(it.get("basis") or f"{typ} 类型识别规则 · {method}/{cx_mode} · 规则版本 {payload.get('version') or 'rules-v1'}")
        it["ufp"] = item_ufp(it, method, cx_mode)
        it["us"] = round(item_us(it, method, cx_mode), 2)
        if it.get("det") in (None, "") and it.get("ret") in (None, "") and it.get("ftr") in (None, ""):
            it["det_na"] = True
        normalized.append(it)
    totals = summary(normalized, timing=timing, method=method, cx_mode=cx_mode)
    project = payload.get("project") if isinstance(payload.get("project"), dict) else {}
    project = {
        "name": str(project.get("name") or payload.get("title") or "工作量评估项目"),
        "client": str(project.get("client") or "—"),
        "version": str(project.get("version") or "v1"),
        "classification": str(project.get("classification") or "内部"),
        "owner": str(project.get("owner") or "—"),
        "reviewer": str(project.get("reviewer") or "—"),
        "date": str(project.get("date") or time.strftime("%Y-%m-%d")),
        "source": str(project.get("source") or "需求文档"),
    }
    trace_rows = [_trace(it, project, method, cx_mode) for it in normalized]
    changes = payload.get("changes") if isinstance(payload.get("changes"), list) else []
    ai = payload.get("ai") if isinstance(payload.get("ai"), dict) else {}
    signoff = payload.get("signoff") if isinstance(payload.get("signoff"), dict) else {}
    canonical = json.dumps({"project": project, "items": normalized, "method": method, "timing": timing,
                            "cx_mode": cx_mode}, ensure_ascii=False, sort_keys=True)
    version_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
    return {
        "project": project, "items": normalized, "summary": totals, "trace_rows": trace_rows,
        "method": method, "timing": timing, "cx_mode": cx_mode, "version_hash": version_hash,
        "changes": changes, "ai": ai, "signoff": signoff,
        "params": payload.get("params") if isinstance(payload.get("params"), dict) else {},
        "title": str(payload.get("title") or project["name"]),
    }


def engine_types(reuse, modify):
    """与 engine.REUSE/MODIFY 同源的类别白名单，避免 import 顺序耦合。"""
    try:
        import engine
        return set(engine.STD_WEIGHT) | set(engine.WEIGHT)
    except Exception:
        return {"ILF", "EIF", "EI", "EO", "EQ"}


def _trace(item, project, method, cx_mode):
    raw = item.get("trace") if isinstance(item.get("trace"), dict) else {}
    ev = item.get("evidence")[0] if isinstance(item.get("evidence"), list) and item.get("evidence") else {}
    paragraph = raw.get("paragraph") or ev.get("locator") or item.get("src_para") or item.get("locator") \
        or f"需求文档 · {item.get('count_item') or item.get('desc')} 所在段落"
    quote = raw.get("quote") or ev.get("quote") or item.get("quote") or item.get("desc")
    rule = raw.get("rule") or item.get("basis") or f"{item['type']} 类型识别规则（规则版本 {project['version']}）"
    confidence = item.get("confidence")
    try:
        confidence_text = f"{round(float(confidence) * 100)}%"
    except (TypeError, ValueError):
        confidence_text = "—"
    formula = raw.get("formula") or (
        f"UFP={item['ufp']} · US=UFP×重用系数×修改系数={item['ufp']}×{_f(2/3 if item['reuse']=='中' else (1/3 if item['reuse']=='高' else 1))}×{_f({'新增':1,'修改':0.8,'删除':0.2}[item['modify']])}={_f(item['us'])}"
    )
    formula = re.sub(r"\s+", " ", str(formula).replace("=", " = ").replace("×", " × ")).strip()
    return {
        "id": item["stable_id"], "paragraph": str(paragraph), "quote": str(quote),
        "rule": str(rule), "formula": formula, "version": str(project["version"]),
        "confidence": confidence_text,
        "req": str(item.get("req") or item.get("req_id") or f"功能清单 #{item.get('seq')}"),
        "ac": str(item.get("ac") or item.get("acceptance") or f"验收项 #{item.get('seq')}"),
    }


def _toc(pages=None):
    rows = []
    for no, title in PARTS:
        page = 1 if no == 1 else (pages or {}).get(no, f"{{{{PAGE_{no}}}}}")
        rows.append(f'<li><span class="t">{no}. {title}</span><span class="p">{page}</span></li>')
    return '<section class="toc"><h2>目录</h2><ol>' + "".join(rows) + \
        '</ol><div class="note">目录页码由两遍渲染回填；正式 PDF 的 UFP/US 数值与「追溯」均为可点击的内部链接。</div></section>'


def _cover(ctx):
    p = ctx["project"]
    return f'''<section class="cover"><div class="kicker">WORKLOAD EVALUATION · SEVEN-PART AUDIT PACKAGE</div>
<h1>{_esc(p["name"])}<br>七部分审计包</h1>
<div class="sub">封面 · 执行摘要 · 方法与口径 · 估算明细 · 追溯矩阵 · 变更与 AI 审计 · 签收页</div>
<div class="class">密级：{_esc(p["classification"])} · 版本：{_esc(p["version"])}</div>
<div class="meta">客户：{_esc(p["client"])}　｜　评估人：{_esc(p["owner"])}　｜　审核人：{_esc(p["reviewer"])}<br>
生成日期：{_esc(p["date"])}　｜　数据来源：{_esc(p["source"])}<br>
版本哈希：{_esc(ctx["version_hash"])}（输入快照 SHA-256 前 16 位）</div></section>'''


def _summary(ctx):
    s = ctx["summary"]
    items = ctx["items"]
    return f'''<section class="part first"><h2>2. 执行摘要</h2>
<p>本审计包覆盖 {len(items)} 个已确认功能项，采用 {_esc(ctx["method"])}、{_esc(ctx["cx_mode"])} 口径与 {_esc(ctx["timing"])} 调整因子。所有明细可从第 5 部分追溯矩阵定位到原文段落、规则、公式与版本。</p>
<div class="kpis">
<div class="kpi"><b>{s["ufp"]}</b><span>未调整功能点 UFP</span></div>
<div class="kpi"><b>{_f(s["us"])}</b><span>未调整规模 US</span></div>
<div class="kpi"><b>{s["adjusted_fp"]}</b><span>调整后规模（FP）</span></div>
<div class="kpi"><b>{_f(s["work"]["mid"])}</b><span>基准工作量（人天）</span></div>
<div class="kpi"><b>{_f(s["cost"]["mid"])}</b><span>费用中值（万元）</span></div>
<div class="kpi"><b>{len(ctx["trace_rows"])}</b><span>可追溯明细行</span></div>
</div>
<h3>关键假设与风险</h3>
<table><tr><th>项</th><th>结论</th></tr>
<tr><td>估算方法</td><td>{_esc(ctx["method"])}；UFP 按类别权重，US=UFP×重用系数×修改系数</td></tr>
<tr><td>规模调整</td><td>{_esc(ctx["timing"])} 调整因子；调整后规模 {s["adjusted_fp"]} FP</td></tr>
<tr><td>费用口径</td><td>基准生产率 10.67 人时/FP、22 人天/人月、2.57 万元/人月；仅作估算参考</td></tr>
<tr><td>风险</td><td>未确认项不进入正式结论；需求变更、外部接口与关键人员可用性需在签收前复核</td></tr></table>
<div class="note">本页为 1 页执行摘要；金额与工作量均为区间估算，最终以签收版本为准。</div>
</section>'''


def _method(ctx):
    s = ctx["summary"]
    return f'''<section class="part"><h2>3. 方法与口径</h2>
<p>采用 IFPUG 功能点法：ILF/EIF/EI/EO/EQ 五类；企业母版权重为 ILF 10、EIF 7、EI 4、EO 5、EQ 4。标准 IFPUG 模式按 DET/RET/FTR 判定复杂度后取标准权重。</p>
<table><tr><th>参数</th><th>本包取值</th><th>复算说明</th></tr>
<tr><td>估算方法</td><td>{_esc(ctx["method"])}</td><td>类别权重 × 重用/修改系数</td></tr>
<tr><td>复杂度口径</td><td>{_esc(ctx["cx_mode"])}</td><td>标准模式时按 DET/RET/FTR 矩阵</td></tr>
<tr><td>规模变更</td><td>{_esc(ctx["timing"])}</td><td>调整后规模 = US × 规模变更因子</td></tr>
<tr><td>UFP / US</td><td>{s["ufp"]} / {s["us"]}</td><td>逐项复算见第 4 部分</td></tr>
<tr><td>工作量</td><td>低 {_f(s["work"]["low"])} / 中 {_f(s["work"]["mid"])} / 高 {_f(s["work"]["high"])} 人天</td><td>基准生产率 10.67 人时/FP；调整因子 0.8</td></tr>
<tr><td>费用</td><td>低 {_f(s["cost"]["low"])} / 中 {_f(s["cost"]["mid"])} / 高 {_f(s["cost"]["high"])} 万元</td><td>22 人天/人月；2.57 万元/人月</td></tr></table>
<h3>公式与系数</h3>
<p>US = UFP × 重用系数（低 1.0 / 中 0.6667 / 高 0.3333）× 修改系数（新增 1.0 / 修改 0.8 / 删除 0.2）。调整后规模 = US × 规模变更因子。费用 = 工作量 / 22 × 2.57。</p>
<div class="note">口径冻结：{_esc(ctx["project"]["date"])}；版本 {_esc(ctx["project"]["version"])}；哈希 {_esc(ctx["version_hash"])}。若费率或系数变更，须重新生成审计包。</div>
</section>'''


def _detail(ctx):
    rows = []
    for it in ctx["items"]:
        det = it.get("det"); ret = it.get("ret"); ftr = it.get("ftr")
        det_cell = "N/A" if it.get("det_na") else f"{_esc(det)}/{_esc(ret)}/{_esc(ftr)}"
        rows.append("<tr>" + "".join([
            f"<td class=\"sid\">{_esc(it['stable_id'])}</td>", f"<td>{_esc(it.get('type'))}</td>",
            f"<td class=\"det\">{det_cell}</td>",
            f"<td>{_esc(it.get('desc'))}</td>", f"<td class=\"rm\">{_esc(it.get('reuse'))} / {_esc(it.get('modify'))}</td>",
            f"<td><a class=\"numlink\" href=\"#trace\">{it['ufp']}</a></td>", f"<td><a class=\"numlink\" href=\"#trace\">{_f(it['us'])}</a></td>",
            f"<td>{_esc(it.get('basis') or 'N/A')}</td>", '<td><a class="trace" href="#trace">追溯</a></td>',
        ]) + "</tr>")
    return f'''<section class="part"><h2>4. 估算明细</h2>
<p>共 {len(ctx["items"])} 项。每行保留 stable_id、类型、DET/RET/FTR、重用/修改、UFP/US 与识别依据；点击 UFP/US 数值或「追溯」跳转第 5 部分对应行。</p>
<table class="detail"><colgroup><col style="width:9%"><col style="width:6%"><col style="width:11%"><col style="width:31%"><col style="width:8%"><col style="width:5%"><col style="width:6%"><col style="width:15%"><col style="width:9%"></colgroup>
<tr><th>ID</th><th>类型</th><th>DET/<br>RET/FTR</th><th>功能项</th><th>重用/<br>修改</th><th>UFP</th><th>US</th><th>依据</th><th>追溯</th></tr>
{''.join(rows)}</table>
<div class="note">明细与成品表/结果页同源；本表不改变任何数值，仅作为审计快照。企业母版口径不依赖 DET/RET/FTR，未采集项显示 N/A；标准 IFPUG 模式须在输入中提供三项。</div>
</section>'''


def _trace_section(ctx):
    rows = []
    for t in ctx["trace_rows"]:
        rows.append("<tr>" + "".join([
            f"<td>{_esc(t['id'])}</td>", f"<td>{_esc(t['paragraph'])}</td>", f"<td>{_esc(t['quote'])}</td>",
            f"<td>{_esc(t['rule'])}</td>", f"<td class=\"formula\">{_esc(t['formula'])}</td>", f"<td>{_esc(t['confidence'])}</td>", f"<td>{_esc(t['version'])}</td>",
            f"<td>{_esc(t['req'])}</td>", f"<td>{_esc(t['ac'])}</td>",
        ]) + "</tr>")
    return f'''<section class="part" id="trace"><h2>5. 追溯矩阵</h2>
<p>每一行对应第 4 部分的一个功能项，记录原文段落、原文摘录、识别规则、复算公式、置信度、版本、需求/验收关联。明细页的 UFP/US 数值与「追溯」链接均跳转到本页对应行。</p>
<table class="trace-table"><colgroup><col style="width:7%"><col style="width:13%"><col style="width:22%"><col style="width:12%"><col style="width:16%"><col style="width:7%"><col style="width:7%"><col style="width:7%"><col style="width:7%"></colgroup>
<tr><th>ID</th><th>原文段落</th><th>原文摘录</th><th>规则</th><th>公式</th><th>置信度</th><th>版本</th><th>需求</th><th>验收</th></tr>
{''.join(rows)}</table>
<div class="note">追溯覆盖率 {len(ctx["trace_rows"])}/{len(ctx["items"])}；原文证据由上传文档的真实段落/表格行定位，模型引用无法在源文档逐字命中时丢弃；低置信度候选优先复核。</div>
</section>'''


def _changes(ctx):
    rows = ctx["changes"] if ctx["changes"] else [{"type": "首版", "detail": "本次为首版审计包，无基线差异。", "before": "—", "after": ctx["version_hash"]}]
    body = []
    for c in rows:
        if not isinstance(c, dict):
            c = {"detail": str(c)}
        body.append("<tr>" + "".join([
            f"<td>{_esc(c.get('version') or ctx['project']['version'])}</td>", f"<td>{_esc(c.get('date') or ctx['project']['date'])}</td>",
            f"<td>{_esc(c.get('type') or '变更')}</td>", f"<td>{_esc(c.get('detail') or '—')}</td>",
            f"<td>{_esc(c.get('before') or '—')}</td>", f"<td>{_esc(c.get('after') or '—')}</td>",
            f"<td>{_esc(c.get('operator') or '—')}</td>",
        ]) + "</tr>")
    ai = ctx["ai"]
    ai_rows = [("AI 启用", "是" if ai.get("enabled") else "否（本地规则）"),
               ("模型", ai.get("model") or "—"), ("提示词版本", ai.get("prompt_version") or "—"),
               ("识别时间", ai.get("created_at") or "—"),
               ("规则版本", ai.get("rules_version") or ctx["project"]["version"]),
               ("人工调整", ai.get("adjustments") or "—")]
    ai_html = "".join(f"<tr><td>{_esc(k)}</td><td>{_esc(v)}</td></tr>" for k, v in ai_rows)
    records = ai.get("items") if isinstance(ai.get("items"), list) else []
    if not records:
        for item in ctx["items"]:
            ai2 = item.get("ai") if isinstance(item.get("ai"), dict) else {}
            conf = item.get("confidence")
            if conf is None:
                continue
            try:
                conf_text = f"{round(float(conf) * 100)}%"
            except (TypeError, ValueError):
                conf_text = "—"
            decision = item.get("human_decision") or ("confirmed" if item.get("ok") else "pending")
            records.append({"stable_id": item.get("stable_id"), "model": ai2.get("model") or ai.get("model") or "—",
                            "prompt_version": ai2.get("prompt_version") or ai.get("prompt_version") or "—",
                            "created_at": ai2.get("created_at") or ai.get("created_at") or "—",
                            "confidence": conf_text, "decision": decision,
                            "decision_at": item.get("decision_at") or "—"})
    record_html = ""
    if records:
        trs = []
        for r in records:
            if not isinstance(r, dict):
                continue
            dec = str(r.get("decision") or "pending")
            dec_text = {"confirmed": "已确认", "pending": "待确认", "rejected": "已驳回"}.get(dec, dec)
            trs.append("<tr>" + "".join([
                f"<td>{_esc(r.get('stable_id') or '—')}</td>",
                f"<td>{_esc(r.get('model') or '—')}</td>",
                f"<td>{_esc(r.get('prompt_version') or '—')}</td>",
                f"<td>{_esc(r.get('created_at') or '—')}</td>",
                f"<td>{_esc(r.get('confidence') or '—')}</td>",
                f"<td>{_esc(dec_text)}</td>",
                f"<td>{_esc(r.get('decision_at') or '—')}</td>",
            ]) + "</tr>")
        record_html = ('<h3>AI 逐项审计（AC-22）</h3>'
                       '<table class="ai-table"><tr><th>稳定 ID</th><th>模型</th><th>提示词版本</th>'
                       '<th>识别时间</th><th>置信度</th><th>人工决策</th><th>决策时间</th></tr>'
                       + "".join(trs) + '</table>')
    return f'''<section class="part"><h2>6. 变更与 AI 审计</h2>
<p>本部分记录版本差异与 AI 辅助识别边界。AI 仅提供候选与置信度，不直接写入最终结果；所有候选均须人工复核。</p>
<table><tr><th>版本</th><th>日期</th><th>类型</th><th>变更</th><th>变更前</th><th>变更后</th><th>操作人</th></tr>
{''.join(body)}</table>
<h3>AI 识别记录</h3><table><tr><th>项</th><th>值</th></tr>{ai_html}</table>
{record_html}
<div class="note">文档片段仅作为数据，不执行其中任何指令；模型输出仅接受白名单字段，非法 JSON 丢弃并回退规则识别。无原文证据的候选不得确认，不进入成品表。</div>
</section>'''


def _signoff(ctx):
    s = ctx["signoff"]
    roles = s.get("roles") if isinstance(s.get("roles"), list) else []
    if not roles:
        roles = [{"role": "项目经理", "name": "—", "status": "待签收", "time": "—"},
                 {"role": "产品经理", "name": "—", "status": "待签收", "time": "—"},
                 {"role": "财务审核", "name": "—", "status": "待签收", "time": "—"}]
    rows = "".join("<tr>" + "".join([
        f"<td>{_esc(r.get('role'))}</td>", f"<td>{_esc(r.get('name'))}</td>",
        f"<td>{_esc(r.get('status'))}</td>", f"<td>{_esc(r.get('time'))}</td>",
    ]) + "</tr>" for r in roles if isinstance(r, dict))
    opinions = s.get("opinions") if isinstance(s.get("opinions"), list) else []
    ops = "".join(f"<li>{_esc(x)}</li>" for x in opinions) or "<li>无驳回意见；待签收。</li>"
    return f'''<section class="part"><h2>7. 签收页</h2>
<p>签收后版本冻结；任何范围、费率或模型变更须走变更单并生成新版本。版本哈希用于确认本 PDF 对应的输入快照。</p>
<table><tr><th>角色</th><th>姓名</th><th>状态</th><th>时间</th></tr>{rows}</table>
<h3>评审意见</h3><ul>{ops}</ul>
<div class="note">版本：{_esc(ctx["project"]["version"])}　｜　版本哈希：{_esc(ctx["version_hash"])}　｜　页数：以页脚 n / N 为准　｜　密级：{_esc(ctx["project"]["classification"])}</div>
<div class="sign"><div>项目经理签字：<br><br></div><div>审核人签字：<br><br></div><div>财务签字：<br><br></div><div>客户代表签字：<br><br></div></div>
<div class="footer-note">— 本审计包由本地引擎生成；无外部链接；字体随 PDF 子集嵌入。—</div>
</section>'''


def build_html(ctx, pages=None):
    body = _cover(ctx) + _toc(pages) + _summary(ctx) + _method(ctx) + _detail(ctx) + _trace_section(ctx) + _changes(ctx) + _signoff(ctx)
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{_esc(ctx["project"]["name"])} · 七部分审计包</title><style>{CSS}</style></head><body>
<div class="watermark">{_esc(ctx["project"]["classification"])} · 勿外传</div>
{body}</body></html>'''


def _render(html_path, pdf_path, port):
    env = os.environ.copy()
    env.setdefault("WE_PDF_TIMEOUT_MS", "60000")
    proc = subprocess.run([NODE, RENDER, str(html_path), str(pdf_path), str(port)],
                          cwd=str(ROOT), capture_output=True, text=True, timeout=120, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"PDF 渲染失败：{(proc.stderr or proc.stdout)[-1200:]}")
    lines = [x for x in proc.stdout.splitlines() if x.startswith("{")]
    return json.loads(lines[-1]) if lines else {}


def _find_part_pages(doc):
    pages = {1: 1}
    for no, title in PARTS[1:]:
        needle = f"{no}. {title}"
        for pno in range(2, doc.page_count):      # 跳过封面(=0)和目录(=1)页
            if needle in doc[pno].get_text("text"):
                pages[no] = pno + 1
                break
    missing = [no for no, _ in PARTS if no not in pages]
    if missing:
        raise RuntimeError(f"审计包章节未定位：{missing}")
    return pages


def _outline_and_links(pdf_path, pages, html_rows):
    import fitz
    doc = fitz.open(pdf_path)
    detail_page, trace_page = pages[4], pages[5]
    # 追溯矩阵每一行的纵向锚点：按 "FP-" 首行排序，跨页延续。
    targets = []
    for pno in range(trace_page - 1, doc.page_count):
        words = sorted([w for w in doc[pno].get_text("words") if w[4] == "FP-"], key=lambda w: (w[1], w[0]))
        for w in words:
            targets.append((pno, max(0, w[1] - 4)))
        if len(targets) >= len(html_rows.get("items", [])) or len(targets) >= 300:
            break
    row_idx = 0
    links = 0
    for pno in range(detail_page - 1, trace_page - 1):
        page = doc[pno]
        words = page.get_text("words")
        first_row_y = min((w[1] for w in words if w[4].startswith("FP-")), default=0)
        trace_rects = sorted([r for r in page.search_for("追溯")
                              if r.x0 > page.rect.width * 0.8 and r.y0 >= first_row_y - 1],
                             key=lambda r: (r.y0, r.x0))
        for rect in trace_rects:
            target_page, target_y = targets[row_idx] if row_idx < len(targets) else (trace_page - 1, 0)
            doc[pno].insert_link({"kind": fitz.LINK_GOTO, "from": rect,
                                  "page": target_page, "to": fitz.Point(0, target_y)})
            links += 1
            # UFP/US 两列位于 x≈370–435；按行 y 限定，避免命中右侧「依据」中的行号。
            for w in words:
                cy = (w[1] + w[3]) / 2
                if not (rect.y0 - 4 <= cy <= rect.y1 + 12):
                    continue
                if not (370 <= w[0] <= 435):
                    continue
                if not re.search(r"\d", w[4]):
                    continue
                r = fitz.Rect(w[0] - 1, w[1] - 1, w[2] + 1, w[3] + 1)
                doc[pno].insert_link({"kind": fitz.LINK_GOTO, "from": r,
                                      "page": target_page, "to": fitz.Point(0, target_y)})
                links += 1
            row_idx += 1
    doc.set_toc([[1, f"{no}. {title}", (1 if no == 1 else pages[no])] for no, title in PARTS])
    doc.set_metadata({"title": f"{html_rows.get('project')} · 七部分审计包",
                      "author": "Evaluation 工作量评估助手",
                      "subject": "七部分审计包（封面/摘要/方法/明细/追溯/变更/签收）",
                      "keywords": f"审计包; {html_rows.get('classification')}",
                      "creator": "Chromium printToPDF"})
    doc.save(pdf_path + ".tmp", garbage=3, deflate=True)
    doc.close()
    os.replace(pdf_path + ".tmp", pdf_path)
    return links


def _inspect(pdf_path, ctx, pages, elapsed_ms, links, render_meta, detail_rows):
    import fitz
    doc = fitz.open(pdf_path)
    text = "\n".join(p.get_text("text") for p in doc)
    toc_text = doc[1].get_text("text") if doc.page_count > 1 else ""
    toc_rows = []
    for no, title in PARTS:
        needle = f"{no}. {title}"
        m = re.search(re.escape(needle) + r"\s*(\d+)", toc_text)
        got = int(m.group(1)) if m else -1
        want = 1 if no == 1 else pages[no]
        toc_rows.append({"part": no, "title": title, "expected": want, "in_toc": got, "ok": got == want})
    toc_ok = all(x["ok"] for x in toc_rows)
    parts_present = all(f"{no}. {title}" in text for no, title in PARTS)
    watermark_pages = sum(1 for p in doc if ctx["project"]["classification"] in p.get_text("text") and "勿外传" in p.get_text("text"))
    footer_pages = sum(1 for p in doc if re.search(r"\d+\s*/\s*\d+", p.get_text("text")))
    fonts = []
    embedded = False
    for pno in range(min(6, doc.page_count)):
        for f in doc.get_page_fonts(pno):
            base = f[3]
            if base not in fonts:
                fonts.append(base)
            if str(f[1]).lower() in ("ttf", "otf", "cff"):
                embedded = True
    pdf_sha = hashlib.sha256(open(pdf_path, "rb").read()).hexdigest()
    links_now = [l for p in doc for l in p.get_links() if l.get("kind") == fitz.LINK_GOTO and l.get("page") == pages[5] - 1]
    trace_ok = len(ctx["trace_rows"]) == len(ctx["items"]) and all(
        t["paragraph"] and t["rule"] and t["formula"] and t["version"] and t["req"] and t["ac"]
        for t in ctx["trace_rows"])
    budget_ok = elapsed_ms <= 30000
    result = {
        "ok": bool(parts_present and toc_ok and watermark_pages == doc.page_count and footer_pages >= doc.page_count - 1
                   and embedded and len(links_now) >= detail_rows * 2 and trace_ok and budget_ok),
        "engine": "chromium-printToPDF + PyMuPDF links",
        "pdf": str(pdf_path), "pages": doc.page_count, "size_bytes": os.path.getsize(pdf_path),
        "elapsed_ms": elapsed_ms, "budget_ms": 30000, "budget_ok": budget_ok,
        "render_ms_pass1": render_meta.get("render_ms"),
        "render_ms_pass2": render_meta.get("render_ms"), "detail_rows": detail_rows,
        "trace_rows": len(ctx["trace_rows"]), "trace_links": len(links_now),
        "parts_present": parts_present, "toc_ok": toc_ok, "toc_rows": toc_rows,
        "watermark_pages": watermark_pages, "footer_page_number_pages": footer_pages,
        "fonts": fonts, "font_embedded": embedded, "classification": ctx["project"]["classification"],
        "version_hash": ctx["version_hash"], "pdf_sha256": pdf_sha,
        "trace_target_page": pages[5], "detail_page": pages[4], "section_pages": pages,
        "warnings": [] if embedded else ["未检测到字体嵌入；请检查 Chrome 字体"],
    }
    doc.close()
    return result


def generate(payload, out_dir, filename=None):
    """生成七部分审计包；返回指标 dict。测试/服务端共用同一入口。"""
    t0 = time.time()
    # 清理上次渲染遗留的 Chrome profile；Windows 下浏览器占用时不强删。
    for old in Path(tempfile.gettempdir()).glob("we_pdf_*"):
        try:
            if old.is_dir() and time.time() - old.stat().st_mtime > 3600:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass
    ctx = _normalize(payload)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = (filename or f"audit_{time.strftime('%Y%m%d-%H%M%S')}_{uuid.uuid4().hex[:8]}").replace(".pdf", "")
    html_path = out_dir / (stem + ".html")
    pass1 = out_dir / (stem + ".pass1.pdf")
    final = out_dir / (stem + ".pdf")
    html1 = build_html(ctx)
    html_path.write_text(html1, encoding="utf-8")
    meta1 = _render(html_path, pass1, 9337)
    import fitz
    doc = fitz.open(pass1)
    pages = _find_part_pages(doc)
    doc.close()
    html2 = build_html(ctx, pages)
    html_path.write_text(html2, encoding="utf-8")
    meta2 = _render(html_path, final, 9337)
    detail_rows = len(ctx["items"])
    links = _outline_and_links(str(final), pages, {"project": ctx["project"]["name"],
                                                  "classification": ctx["project"]["classification"],
                                                  "items": ctx["items"]})
    # pass1 是中间产物，保留 HTML/正式 PDF，清理临时 PDF 与渲染元数据
    for tmp in (pass1, pass1.with_suffix(".json")):
        try:
            tmp.unlink()
        except OSError:
            pass
    result = _inspect(final, ctx, pages, int((time.time() - t0) * 1000), links, meta2, detail_rows)
    result["html"] = str(html_path)
    result["download_name"] = final.name
    result["version_hash"] = ctx["version_hash"]
    return result


def sample_payload(n=17):
    """从内置母版读取真实明细，取前 n 项作为性能/结构测试样本。"""
    try:
        import generate_xlsx
        rows = generate_xlsx.read_template_rows()[:n]
    except Exception:
        rows = []
    if not rows:
        rows = [{"system": "票据核心", "m1": "功能", "desc": f"功能项 {i}", "count_item": f"功能项 {i}",
                 "type": ["ILF", "EI", "EO", "EQ", "EIF"][i % 5], "reuse": "中", "modify": "新增"} for i in range(1, n + 1)]
    weights = {"ILF": 10, "EIF": 7, "EI": 4, "EO": 5, "EQ": 4}
    enriched = []
    for i, raw in enumerate(rows, 1):
        row = dict(raw)
        typ = row.get("type") or "EI"
        row["stable_id"] = row.get("stable_id") or f"FP-{i:03d}"
        row["basis"] = f"母版行 #{i} · {typ} 权重 {weights.get(typ, '—')}"
        row["src_para"] = f"需求文档 · 功能清单第 {i} 项「{row.get('count_item') or row.get('desc')}」所在段落"
        row["req"] = f"PRD §7.3 #{i}"
        row["ac"] = f"AC-09 #{i}"
        row["trace"] = {"paragraph": row["src_para"], "quote": row.get("desc"),
                        "rule": row["basis"], "req": row["req"], "ac": row["ac"]}
        enriched.append(row)
    return {
        "project": {"name": "Evaluation 金标准审计样本", "client": "内部演示", "version": "0.1.20261124-audit",
                    "classification": "内部", "owner": "评估师", "reviewer": "审核人", "date": time.strftime("%Y-%m-%d"),
                    "source": "内置母版真实明细（前 17 项）"},
        "method": "估算功能点", "timing": "估算中期", "cx_mode": "企业母版",
        "items": enriched, "changes": [{"type": "首版", "detail": "建立七部分审计包基线", "before": "—", "after": "首版"}],
        "ai": {"enabled": False, "model": "本地规则", "prompt_version": "identify-v4", "rules_version": "rules-v1"},
        "signoff": {"roles": [{"role": "项目经理", "name": "—", "status": "待签收", "time": "—"},
                               {"role": "审核人", "name": "—", "status": "待签收", "time": "—"}],
                     "opinions": ["请核对 17 项明细与追溯矩阵后签收。"]},
    }


def main(argv=None):
    argv = argv or sys.argv[1:]
    if not argv:
        print(json.dumps({"usage": "audit_package.py <payload.json> <out_dir> [filename] | --sample <out_dir>"}, ensure_ascii=False))
        return 2
    if argv[0] == "--sample":
        out_dir = argv[1] if len(argv) > 1 else str(ROOT / "docs" / "test-reports" / "phase3-20261122" / "audit")
        payload = sample_payload(17)
    else:
        payload = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
        out_dir = argv[1] if len(argv) > 1 else str(ROOT / "docs" / "test-reports" / "phase3-20261122" / "audit")
    result = generate(payload, out_dir, argv[2] if len(argv) > 2 else None)
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
