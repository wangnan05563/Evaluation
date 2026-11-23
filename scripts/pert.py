# -*- coding: utf-8 -*-
"""PERT 三点估算：SQLite 数据层 + 计算引擎 + 阜新 V2.0 模板生成。
所有自包含，不依赖 server.py；frozen(exe) 时一并收集。
"""
import json, os, re, shutil, sqlite3, time, zipfile
from pathlib import Path

# 空白母版随包分发（tpl/pert-template.xlsx）；环境 WE_TPL_PERT 可覆盖。
# 两者都不存在时由 generate() 抛出可读错误，不再回退到某台机器的桌面路径。
def _resource_root():
    """只读资源根：开发态=仓库根，打包态=_MEIPASS（与 server._RES 同口径）。

    frozen 下 __file__ 指向包内模块路径，不能拿它推仓库结构；spec 的 datas
    把 tpl/ 整目录收进包内，母版从 _MEIPASS 读取。
    """
    import sys
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def _resolve_pert_template():
    env = os.environ.get("WE_TPL_PERT")
    if env:
        return env
    bundled = _resource_root() / "tpl" / "pert-template.xlsx"
    return str(bundled) if bundled.exists() else None

# 六阶段固定顺序（对齐模板 R6/R7/R8/R32/R33/R34）
PHASES = ["需求分析", "系统设计", "开发", "实施", "公共及远程", "现场维护"]
PHASE_ROW = {"需求分析": 6, "系统设计": 7, "开发": 8, "实施": 32, "公共及远程": 33, "现场维护": 34}
DEV_START, DEV_END = 8, 30          # 开发明细数据区行号
SHEET = "项目工作量估算表"
# T01501 系列（S1192）：zip 内部件名与 XML 片段在多处出现，统一提常量
SHEET_XML = "xl/worksheets/sheet1.xml"
CONTENT_TYPES = "[Content_Types].xml"
RELS_END = "</Relationships>"
SHEET_END = "</worksheet>"
HEADER_FOOTER_RE = re.compile(r"<headerFooter\b.*?</headerFooter>", re.S)
_PRINT_ASSET_PREFIXES = ("xl/media/", "xl/printerSettings/",
                         "xl/drawings/vmlDrawing", "xl/drawings/_rels/vmlDrawing")


class PertDB:
    """围绕单库 sqlite3 的轻封装，避免重复 connect。"""

    def __init__(self, db_path):
        self.db = db_path
        self._init()

    def _connect(self):
        # T01481（P1-1）：busy timeout + WAL，与服务端并发写一致
        con = sqlite3.connect(self.db, timeout=15)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        return con

    def _init(self):
        con = self._connect()
        con.executescript("""
        CREATE TABLE IF NOT EXISTS projects(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          estimator TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now','localtime')),
          doc_name TEXT DEFAULT '',
          gen_count INTEGER DEFAULT 0,
          actual_days REAL,
          actual_note TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS pert_items(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          phase TEXT NOT NULL DEFAULT '开发',
          system TEXT DEFAULT '', module TEXT DEFAULT '', desc TEXT DEFAULT '',
          optimistic REAL, most_likely REAL, pessimistic REAL
        );
        CREATE TABLE IF NOT EXISTS estimate_configs(
          project_id INTEGER PRIMARY KEY,
          cfg TEXT DEFAULT '{}'
        );
        """)
        # 已存在的库：ALTER 补列（CREATE IF NOT EXISTS 不会修改旧表）。
        for ddl in ("ALTER TABLE projects ADD COLUMN actual_days REAL",
                    "ALTER TABLE projects ADD COLUMN actual_note TEXT DEFAULT ''"):
            try:
                con.execute(ddl)
            except sqlite3.OperationalError:
                pass
        con.commit()
        con.close()



# ---------------- 计算 ----------------
def exp(o, m, p):
    """PERT 预期 = (O + 4M + P) / 6。"""
    return (o + 4 * m + p) / 6


def sigma(o, p):
    """标准差 = (P - O) / 6。"""
    return (p - o) / 6


DEFAULT_CFG = {
    "days_per_man_month": 20.83,   # 每人月工天标准（名称管理器宏变量）
    "hours_per_day": 8,
    "adjust": {"客户协作": 0.06, "质量要求": 0.06, "范围或需求变更": 0.05, "进度变更": 0.06},
}


def load_cfg(con, pid):
    cfg = dict(DEFAULT_CFG)
    row = con.execute("SELECT cfg FROM estimate_configs WHERE project_id=?", (pid,)).fetchone()
    if row and row[0]:
        try:
            cfg.update(json.loads(row[0]))
        except Exception:
            pass
    return cfg


def save_cfg(con, pid, cfg):
    con.execute("INSERT OR REPLACE INTO estimate_configs(project_id,cfg) VALUES(?,?)",
                (pid, json.dumps(cfg, ensure_ascii=False)))
    con.commit()


def _phase_days(rows):
    """按阶段聚合预期人天与条目数，返回 (by_phase, total_days)。

    T01501（S3776）：原循环里同时做 None→float 兜底、期望值累加、字典初始化与
    嵌套字典自增，认知复杂度超阈值。拆出后 summarize 只剩「聚合 → 按阶段展开 → 换算人月」
    三步线性流程，聚合口径（浮点兜底为 0、total 累加顺序）完全不变。
    """
    by = {}
    total = 0.0
    for ph, o, m, p in rows:
        e = exp(float(o or 0), float(m or 0), float(p or 0))
        total += e
        slot = by.setdefault(ph, {"days": 0.0, "count": 0})
        slot["days"] += e
        slot["count"] += 1
    return by, total


def summarize(con, pid):
    """按阶段汇总预期人天与占比，叠加调节系数得人月。"""
    rows = con.execute(
        "SELECT phase,optimistic,most_likely,pessimistic FROM pert_items "
        "WHERE project_id=? ORDER BY id", (pid,)).fetchall()
    by, total = _phase_days(rows)
    phases = []
    for ph in PHASES:
        b = by.get(ph, {"days": 0.0, "count": 0})
        phases.append({"phase": ph, "days": round(b["days"], 2), "count": b["count"],
                       "pct": round(b["days"] / total * 100, 2) if total else 0})
    cfg = load_cfg(con, pid)
    dpm = float(cfg.get("days_per_man_month", 20.83))
    ideal_man = total / dpm
    adj_sum = sum(float(v) for v in cfg.get("adjust", {}).values())
    return {
        "total_days": round(total, 2),
        "ideal_person_month": round(ideal_man, 2),
        "adjust_sum": round(adj_sum, 4),
        "actual_person_month": round(ideal_man * (1 + adj_sum), 2),
        "phases": phases, "cfg": cfg,
    }


def calibration(con, min_samples=5):
    """T06191：按已结项的实际人天计算 MAPE/偏差/校准系数。

    只读：不修改任何历史估算。样本=同时有「有效三点估算」与「实际人天」的项目。
    """
    rows = con.execute(
        "SELECT id,name,actual_days,actual_note FROM projects "
        "WHERE actual_days IS NOT NULL AND actual_days >= 0 ORDER BY id"
    ).fetchall()
    samples = []
    for pid, name, actual, note in rows:
        est = summarize(con, pid)
        expected = float(est["total_days"])
        if expected <= 0:
            continue
        err = float(actual) - expected
        pct = err / expected
        samples.append({
            "id": pid, "name": name, "expected_days": round(expected, 2),
            "actual_days": round(float(actual), 2),
            "variance_days": round(err, 2),
            "variance_pct": round(pct * 100, 2),
            "abs_pct": round(abs(pct) * 100, 2),
            "note": note or "",
        })
    n = len(samples)
    if n == 0:
        return {"ready": False, "sample_count": 0, "min_samples": min_samples,
                "mape": None, "bias_pct": None, "direction": "no_data",
                "factor": None, "suggested_factor": None,
                "message": "暂无同时具备估算与实际人天的项目", "projects": []}
    mape = sum(s["abs_pct"] for s in samples) / n
    total_actual = sum(s["actual_days"] for s in samples)
    total_expected = sum(s["expected_days"] for s in samples)
    factor = total_actual / total_expected if total_expected else 0
    bias = (factor - 1) * 100
    if bias > 5:
        direction = "underestimated"
    elif bias < -5:
        direction = "overestimated"
    else:
        direction = "balanced"
    ready = n >= min_samples
    suggested = max(0.7, min(1.3, round(factor, 2))) if ready else None
    message = (f"样本 {n} 个：MAPE {mape:.1f}%，整体{'低估' if direction == 'underestimated' else ('高估' if direction == 'overestimated' else '基本准确')} "
               f"{abs(bias):.1f}%；建议后续估算系数 ×{suggested:.2f}（不修改历史估算）") if ready else \
              f"样本 {n}/{min_samples}，达到 {min_samples} 个结项项目后生成校准建议"
    return {
        "ready": ready, "sample_count": n, "min_samples": min_samples,
        "mape": round(mape, 2), "bias_pct": round(bias, 2),
        "direction": direction, "factor": round(factor, 4),
        "suggested_factor": suggested, "message": message, "projects": samples,
    }


# ---------------- 蒙特卡洛（T06192 / REQ-014 / AC-14）----------------
MC_DEFAULT_SIMS = 10000
MC_MAX_SIMS = 50000
MC_DEFAULT_SEED = 20261122
MC_SCENARIOS = (("乐观", 0.9), ("基准", 1.0), ("保守", 1.1))


def _mc_label(row):
    """敏感性表用的可读任务名：系统·模块·描述，过长截断。"""
    parts = [str(row.get(k) or "").strip() for k in ("system", "module", "desc")]
    label = "·".join(p for p in parts if p)
    return label[:100] or "未命名任务"


def _mc_params(rows):
    """把三点估算整理为 numpy 数组；非法顺序用 ValueError 截住。"""
    o = [float(r.get("optimistic") or 0) for r in rows]
    m = [float(r.get("most_likely") or 0) for r in rows]
    p = [float(r.get("pessimistic") or 0) for r in rows]
    for i, (a, b, c) in enumerate(zip(o, m, p)):
        if a < 0 or b < 0 or c < 0 or not (a <= b <= c):
            raise ValueError(f"第 {i + 1} 项三点估算非法：需 0 ≤ 乐观 ≤ 最可能 ≤ 悲观")
    return o, m, p


def monte_carlo(rows, simulations=MC_DEFAULT_SIMS, seed=MC_DEFAULT_SEED,
                target_days=None, scenarios=None):
    """PERT-Beta 蒙特卡洛：固定种子复现，输出 P50/P80/P95、达标概率与敏感性 Top5。

    每个任务按 Beta-PERT（λ=4）独立采样，总量为逐任务样本和；敏感性用各任务
    对总方差的贡献占比（独立随机变量方差可加），不依赖外部 AI。
    """
    import numpy as np

    if not rows:
        raise ValueError("没有可模拟的估算条目")
    if simulations < 1000 or simulations > MC_MAX_SIMS:
        raise ValueError(f"模拟次数需在 1000–{MC_MAX_SIMS} 之间")
    if target_days is not None and target_days < 0:
        raise ValueError("目标人天不能为负")

    t0 = time.perf_counter()
    o, m, p = _mc_params(rows)
    o_a, m_a, p_a = np.asarray(o, float), np.asarray(m, float), np.asarray(p, float)
    span = p_a - o_a
    # Beta-PERT：均值=(O+4M+P)/6；span=0 时退化为常量。
    alpha = np.where(span > 0, 1 + 4 * (m_a - o_a) / np.maximum(span, 1e-12), 1.0)
    beta = np.where(span > 0, 1 + 4 * (p_a - m_a) / np.maximum(span, 1e-12), 1.0)
    rng = np.random.default_rng(int(seed))
    x = rng.beta(alpha, beta, size=(int(simulations), len(rows)))
    totals = (o_a + span * x).sum(axis=1)

    q = np.percentile(totals, [50, 80, 95], method="linear")
    mean = float(totals.mean())
    std = float(totals.std(ddof=1)) if simulations > 1 else 0.0
    target = None if target_days is None else float(target_days)
    prob = None if target is None else float((totals <= target).mean() * 100)

    # 各任务方差贡献（Beta 方差公式按 span 缩放）；Top5 即不确定性的主要来源。
    var = np.where(span > 0,
                   span ** 2 * alpha * beta /
                   ((alpha + beta) ** 2 * (alpha + beta + 1)), 0.0)
    total_var = float(var.sum())
    sens = []
    for i in np.argsort(-var)[:5]:
        if var[i] <= 0:
            continue
        sens.append({
            "label": _mc_label(rows[int(i)]),
            "expected_days": round(exp(o[int(i)], m[int(i)], p[int(i)]), 2),
            "variance_days": round(float(var[int(i)]), 2),
            "share_pct": round(float(var[int(i)] / total_var * 100), 1) if total_var else 0.0,
        })

    sc_in = scenarios if scenarios else [{"name": n, "factor": f} for n, f in MC_SCENARIOS]
    scen = []
    for s in sc_in:
        try:
            factor = float(s.get("factor", 1))
        except (TypeError, ValueError):
            raise ValueError("情景系数必须为数字")
        if factor <= 0:
            raise ValueError("情景系数必须大于 0")
        scen.append({
            "name": str(s.get("name") or f"×{factor}")[:20], "factor": factor,
            "p50": round(float(q[0]) * factor, 2),
            "p80": round(float(q[1]) * factor, 2),
            "p95": round(float(q[2]) * factor, 2),
            # 比例情景下 P(T×f ≤ target) = P(T ≤ target/f)
            "probability_pct": None if target is None else
            round(float((totals <= target / factor).mean() * 100), 1),
        })

    return {
        "ok": True, "simulations": int(simulations), "seed": int(seed),
        "tasks": len(rows), "p50": round(float(q[0]), 2),
        "p80": round(float(q[1]), 2), "p95": round(float(q[2]), 2),
        "mean": round(mean, 2), "std_dev": round(std, 2),
        "target_days": target, "probability_pct": None if prob is None else round(prob, 1),
        "sensitivity": sens, "scenarios": scen,
        "sensitivity_method": "variance_share",
        "duration_ms": int((__import__("time").perf_counter() - t0) * 1000),
    }


# ---------------- 阜新 V2.0 生成 ----------------
def _read_print_parts(master):
    """从母版读 sheet1.xml 与页眉图形/打印机设置等 zip 级资源。"""
    with zipfile.ZipFile(master) as zt:
        tpl_sheet = zt.read(SHEET_XML).decode("utf-8")
        assets = [(n, zt.read(n)) for n in zt.namelist()
                  if n.startswith(_PRINT_ASSET_PREFIXES)]
    return tpl_sheet, assets


def _restore_print_artifacts(master, out):
    """把母版的页眉图形/页脚域/打印设置部件回填到 openpyxl 的产出件。

    openpyxl 3.1 解析不了 &G 页眉图形与自定义页脚，保存后 media/VML/
    printerSettings 整段消失、oddFooter 被写成 &L&C&R、legacyDrawingHF
    与 pageSetup 的 r:id 引用也一并丢失。单元格数据仍由 openpyxl 写，
    这里只做 zip 级回填，不依赖 Excel COM。
    """
    tpl_sheet, assets = _read_print_parts(master)
    hf_m = HEADER_FOOTER_RE.search(tpl_sheet)
    if not hf_m and not assets:
        return
    with zipfile.ZipFile(out) as zs:
        parts = {n: zs.read(n) for n in zs.namelist()}
    sheet = parts[SHEET_XML].decode("utf-8")
    ct = parts[CONTENT_TYPES].decode("utf-8")
    vml = next((n for n, _ in assets
                if n.startswith("xl/drawings/vmlDrawing") and n.endswith(".vml")), None)
    printer = next((n for n, _ in assets if n.startswith("xl/printerSettings/")), None)

    rels_name = "xl/worksheets/_rels/sheet1.xml.rels"
    rels = parts.get(rels_name, b"").decode("utf-8")
    vml_rid, printer_rid = _add_print_relationships(parts, rels_name, rels, vml, printer)

    if hf_m:
        sheet = _merge_header_footer(sheet, hf_m.group(0))
    if printer_rid or vml_rid:
        sheet = _ensure_rel_ns(sheet)
    if printer_rid:
        sheet = re.sub(r"<pageSetup\b[^>]*>",
                       lambda m: _tag_with_rid(m.group(0), printer_rid), sheet, count=1)
    if vml_rid and "<legacyDrawingHF" in tpl_sheet and "<legacyDrawingHF" not in sheet:
        sheet = sheet.replace(SHEET_END, f'<legacyDrawingHF r:id="{vml_rid}"/>{SHEET_END}')

    ct = _merge_content_types(ct, assets, vml, printer)

    parts[SHEET_XML] = sheet.encode("utf-8")
    parts[CONTENT_TYPES] = ct.encode("utf-8")
    for n, data in assets:
        parts[n] = data
    _write_zip_parts(out, parts)


def _add_print_relationships(parts, rels_name, rels, vml, printer):
    """把 vml/打印机设置写成 sheet 级 Relationship，返回 (vml_rid, printer_rid)。"""
    used = set(re.findall(r'Id="(rId\d+)"', rels))
    added = []

    def _rid():
        i = 1
        while f"rId{i}" in used:
            i += 1
        used.add(f"rId{i}")
        return f"rId{i}"

    vml_rid = printer_rid = None
    if vml:
        vml_rid = _rid()
        added.append(f'<Relationship Id="{vml_rid}" Type="http://schemas.openxmlformats.org/'
                     f'officeDocument/2006/relationships/vmlDrawing" '
                     f'Target="../drawings/{Path(vml).name}"/>')
    if printer:
        printer_rid = _rid()
        added.append(f'<Relationship Id="{printer_rid}" Type="http://schemas.openxmlformats.org/'
                     f'officeDocument/2006/relationships/printerSettings" '
                     f'Target="../printerSettings/{Path(printer).name}"/>')
    if not added:
        return vml_rid, printer_rid
    if rels:
        rels = rels.replace(RELS_END, "".join(added) + RELS_END)
    else:
        rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                'relationships">' + "".join(added) + RELS_END)
    parts[rels_name] = rels.encode("utf-8")
    return vml_rid, printer_rid


def _merge_header_footer(sheet, hf):
    """用母版 headerFooter 段替换产出件同名段；没有则追加到 worksheet 末尾。"""
    if HEADER_FOOTER_RE.search(sheet):
        return HEADER_FOOTER_RE.sub(lambda _m: hf, sheet, count=1)
    return sheet.replace(SHEET_END, hf + SHEET_END)


def _ensure_rel_ns(sheet):
    """openpyxl 用不到关系命名空间时会省略声明，补上 r:id 前必须先声明。"""
    if "xmlns:r=" in sheet[:sheet.find(">") + 1]:
        return sheet
    return re.sub(r"<worksheet\b",
                  '<worksheet xmlns:r="http://schemas.openxmlformats.org/'
                  'officeDocument/2006/relationships"', sheet, count=1)


def _tag_with_rid(tag, rid):
    """给 pageSetup 标签补 r:id（已有则不动；自闭合与成对标签分别处理）。"""
    if "r:id=" in tag:
        return tag
    if tag.endswith("/>"):
        return tag[:-2] + f' r:id="{rid}"/>'
    return tag[:-1] + f' r:id="{rid}">'


def _merge_content_types(ct, assets, vml, printer):
    """补齐母版资源所需的 Default 扩展名声明（已存在则跳过）。"""
    defaults = []
    for ext, mime in (("jpeg", "image/jpeg"), ("jpg", "image/jpeg"),
                      ("png", "image/png"), ("gif", "image/gif")):
        if any(n.lower().endswith("." + ext) for n, _ in assets) \
                and f'Extension="{ext}"' not in ct:
            defaults.append(f'<Default Extension="{ext}" ContentType="{mime}"/>')
    if vml and 'Extension="vml"' not in ct:
        defaults.append('<Default Extension="vml" ContentType="application/vnd.'
                        'openxmlformats-officedocument.vmlDrawing"/>')
    if printer and 'Extension="bin"' not in ct:
        defaults.append('<Default Extension="bin" ContentType="application/vnd.'
                        'openxmlformats-officedocument.spreadsheetml.printerSettings"/>')
    if not defaults:
        return ct
    return ct.replace("</Types>", "".join(defaults) + "</Types>")


def _write_zip_parts(out, parts):
    """按原顺序重打包 zip（母版资源与 sheet 级回填结果一并写入）。"""
    tmp = out + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zw:
        for n, data in parts.items():
            zw.writestr(n, data)
    os.replace(tmp, out)


def generate(project_name, rows, out, est_date=None, estimator="", tpl=None):
    """套模板生成成品。rows: [{phase,system,module,desc,optimistic,most_likely,pessimistic}]
    开发明细写 R8 起(E/F/G)，其余阶段写阶段行(E/F/G)；H/I 列保留模板公式自动计算。
    """
    import openpyxl
    path = _require_template(tpl)
    shutil.copy2(path, out)
    wb = openpyxl.load_workbook(out, data_only=False)
    ws = wb[SHEET]
    _fill_pert_sheet(ws, project_name, est_date, estimator)
    _write_pert_rows(ws, rows)
    wb.calculation.fullCalcOnLoad = True   # 强制 Excel 打开重算 H/I 公式
    wb.save(out)
    _restore_print_artifacts(path, out)
    return out


def _require_template(tpl):
    """解析母版路径；不存在时抛可读错误（并指出当前解析到的路径）。"""
    path = tpl or _resolve_pert_template()
    if not path or not Path(path).exists():
        raise FileNotFoundError(
            "PERT 母版未找到：打包资源 tpl/pert-template.xlsx 缺失；"
            "请设置环境变量 WE_TPL_PERT 指向母版文件"
            + (f"（当前解析到：{path}）" if path else ""))
    return path


def _fill_pert_sheet(ws, project_name, est_date, estimator):
    """写入项目名/评估日期/评估人，并清空模板自带示例数据（D/E/F/G）。"""
    ws["D3"] = project_name
    if est_date:
        ws["D2"] = est_date
    if estimator:
        ws["H2"] = estimator
    # 清空模板自带的示例数据（D/E/F/G），H/I 公式列保留由 Excel 重算。
    # 空白行的 H 公式会在 Excel 打开时按 COUNTA=0 触发 #DIV/0!，由 _write_pert_rows
    # 对未使用行显式置 0；这里只清数据区。
    for r in range(DEV_START, DEV_END + 1):
        for c in (4, 5, 6, 7):
            ws.cell(r, c).value = None
    for r in PHASE_ROW.values():
        for c in (5, 6, 7):
            ws.cell(r, c).value = None
    # 估算比例分母：H40 = 最理想总人月（H35）。母版 H40 留空会让 I 列全部显示空白。
    ws["H40"] = "=H35"


def _pert_desc(r):
    """系统/小模块语义并入描述前缀（B/C 是模板合并只读区，不破坏结构）。"""
    desc = r.get("desc") or ""
    if r.get("system") and desc:
        desc = f"{r['system']}·{desc}"
    if r.get("module") and desc:
        desc = f"{r['module']}·{desc}"
    return desc


def _num(v):
    """三值在生成前已校验齐全；缺失值按 0 处理，保证空白行公式不产生错误。"""
    return v if isinstance(v, (int, float)) else 0


DEV_ROWS = DEV_END - DEV_START + 1


def _write_pert_rows(ws, rows):
    """开发明细按行号依次写 R8 起；非开发阶段按阶段汇总写对应阶段行。

    非开发阶段在母版中只有一行，同一阶段多个条目必须对 O/M/P 求和后再写，
    否则后写项会覆盖前项、成品总人天少于页面汇总。PERT 预期是 O/M/P 的线性
    组合，因此“先汇总三值再套公式”与“逐项预期后求和”结果一致。
    开发明细超过 23 行时，溢出项合并进第 23 行（R30），不再回落到 R8 覆盖首项。
    """
    dev_items = [r for r in rows if (r.get("phase") or "开发") == "开发"]
    phase_items = {}
    for r in rows:
        ph = r.get("phase") or "开发"
        if ph != "开发":
            phase_items.setdefault(ph, []).append(r)

    # 开发明细：前 23 项各占一行；超出部分合并进末行，保证合计不丢项。
    for i, r in enumerate(dev_items):
        row = DEV_START + min(i, DEV_ROWS - 1)
        desc = _pert_desc(r)
        if i >= DEV_ROWS:
            old = ws.cell(row, 4).value or ""
            ws.cell(row, 4).value = f"{old}（合并 {i - DEV_ROWS + 2} 项）" if old else desc
            for c, key in ((5, "most_likely"), (6, "optimistic"), (7, "pessimistic")):
                ws.cell(row, c).value = _num(ws.cell(row, c).value) + _num(r.get(key))
            continue
        if desc:
            ws.cell(row, 4).value = desc
        ws.cell(row, 5).value = r.get("most_likely")
        ws.cell(row, 6).value = r.get("optimistic")
        ws.cell(row, 7).value = r.get("pessimistic")

    # 未使用的开发明细行：H 公式置 0，避免空白行 COUNTA=0 导致 H31 小计报错。
    for row in range(DEV_START + len(dev_items), DEV_END + 1):
        ws.cell(row, 8).value = 0
    # 开发阶段无条目时，I8 的比例公式也置空，避免显示 0% 占位。
    if not dev_items:
        ws.cell(8, 9).value = ""

    for ph, arr in phase_items.items():
        row = PHASE_ROW.get(ph)
        if not row:
            continue
        ws.cell(row, 5).value = sum(_num(x.get("most_likely")) for x in arr)
        ws.cell(row, 6).value = sum(_num(x.get("optimistic")) for x in arr)
        ws.cell(row, 7).value = sum(_num(x.get("pessimistic")) for x in arr)

    # 空阶段行：H 置 0、I 置空；保留模板格式与行结构，H35 汇总不会出现错误值。
    for ph, row in PHASE_ROW.items():
        if ph == "开发" or ph in phase_items:
            continue
        ws.cell(row, 8).value = 0
        ws.cell(row, 9).value = ""



def rows_for_generate(con, pid):
    """从库取项目+明细，组装成 generate 需要的 rows。"""
    p = con.execute("SELECT id,name,estimator FROM projects WHERE id=?", (pid,)).fetchone()
    name = p[1] if p else "未命名项目"
    est = p[2] if p else ""
    items = con.execute(
        "SELECT phase,system,module,desc,optimistic,most_likely,pessimistic "
        "FROM pert_items WHERE project_id=? ORDER BY id", (pid,)).fetchall()
    rows = [{"phase": i[0], "system": i[1], "module": i[2], "desc": i[3],
             "optimistic": i[4], "most_likely": i[5], "pessimistic": i[6]} for i in items]
    return name, est, rows


# ---------------- 成品表命名（T01573）----------------
def set_doc_name(con, pid, doc_name):
    """记住本次需求导入的文档基名（不含扩展名），供成品表文件名取用。"""
    con.execute("UPDATE projects SET doc_name=? WHERE id=?", ((doc_name or "").strip(), pid))
    con.commit()


def next_gen_version(con, pid):
    """返回该项目本次生成的自增版本号并落库（1、2、3…→ 展示为 V1、V2…）。"""
    cur = con.execute("SELECT gen_count FROM projects WHERE id=?", (pid,)).fetchone()
    n = (int(cur[0]) if cur and cur[0] is not None else 0) + 1
    con.execute("UPDATE projects SET gen_count=? WHERE id=?", (n, pid))
    con.commit()
    return n


def db_for(app_data):
    """默认 PERT 库路径（data/pert.db）。"""
    return str(Path(app_data) / "pert.db")
