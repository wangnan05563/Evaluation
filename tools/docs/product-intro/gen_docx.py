# -*- coding: utf-8 -*-
"""T03664/T03681：生成产品介绍 Word 文档（docs/工作量评估助手-产品介绍.docx）。

结构：封面 → 一、产品简介 → 二、核心功能模块 → 三、应用场景 → 四、行动号召 → 附：计算口径速查。
配图：直接取入库图版 docs/assets/product-intro/*.png（新克隆即可重生成）。
      图版由 compose_shots.py 从 build/shots 底图裁拼，底图由 shots.mjs /
      electron_shot.mjs / xlsx_shot.py 采集（Windows + Chrome/Electron/Excel 环境）。
      联系方式一栏已填真实联系人（王南 / 107038953@qq.com）；群二维码待用户提供后补充。

用法：python tools/docs/product-intro/gen_docx.py [输出路径]
"""
import os

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
OUT = os.path.abspath(os.sys.argv[1]) if len(os.sys.argv) > 1 else os.path.join(ROOT, "docs", "工作量评估助手-产品介绍.docx")
SHOTS = os.path.join(ROOT, "docs", "assets", "product-intro")

BRAND = RGBColor(0x1F, 0x4E, 0x79)      # 深蓝：标题
ACCENT = RGBColor(0x2E, 0x74, 0xB5)     # 亮蓝：强调
GREY = RGBColor(0x80, 0x80, 0x80)
DARK = RGBColor(0x33, 0x33, 0x33)

HEI = "微软雅黑"
SONG = "宋体"
LATIN = "Arial"      # 西文单独指定，避免 IFPUG/NESMA 等术语落到宋体衬线


def set_font(run, name=SONG, size=None, bold=None, color=None, italic=None):
    run.font.name = LATIN
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if color is not None:
        run.font.color.rgb = color


def style_font(style, name, size, color=None, bold=None):
    style.font.name = LATIN
    style.element.rPr.rFonts.set(qn("w:eastAsia"), name)
    style.font.size = Pt(size)
    if bold is not None:
        style.font.bold = bold
    if color is not None:
        style.font.color.rgb = color


def para(doc, text="", size=10.5, name=SONG, indent=0.0, after=6, before=0,
         align=None, color=DARK, bold=False, line=1.5):
    p = doc.add_paragraph()
    p.paragraph_format.first_line_indent = Cm(indent)
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.space_before = Pt(before)
    p.paragraph_format.line_spacing = line
    if align is not None:
        p.alignment = align
    if text:
        set_font(p.add_run(text), name, size, bold, color)
    return p


def bullet(doc, head, body=""):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.line_spacing = 1.4
    set_font(p.add_run(head), SONG, 10.5, True, ACCENT)
    if body:
        set_font(p.add_run("　" + body), SONG, 10.5, False, DARK)
    return p


def heading(doc, text, level):
    h = doc.add_heading("", level=level)
    run = h.add_run(text)
    if level == 1:
        set_font(run, HEI, 16, True, BRAND)
        h.paragraph_format.space_before = Pt(14)
        h.paragraph_format.space_after = Pt(8)
    else:
        set_font(run, HEI, 12.5, True, ACCENT)
        h.paragraph_format.space_before = Pt(12)
        h.paragraph_format.space_after = Pt(4)
    return h


def _pPr(p):
    return p._p.get_or_add_pPr()


def border_and_shade(p, color="BFBFBF", fill="F7F9FC"):
    pPr = _pPr(p)
    pBdr = OxmlElement("w:pBdr")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "dashed")
        el.set(qn("w:sz"), "6")
        el.set(qn("w:space"), "6")
        el.set(qn("w:color"), color)
        pBdr.append(el)
    pPr.append(pBdr)
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), fill)
    pPr.append(shd)


def shot_placeholder(doc, what):
    """功能截图占位框：不生成图片，只标注位置与建议内容。"""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(10)
    p.paragraph_format.line_spacing = 1.2
    # 首尾各留空行，让占位框有足够高度，贴图时直接替换整段即可
    set_font(p.add_run("\n此处插入功能截图"), HEI, 11, True, ACCENT)
    set_font(p.add_run("\n" + what + "\n\n"), SONG, 9, False, GREY)
    border_and_shade(p)
    # 占位框给足高度，方便后续贴图替换
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(14)
    return p


def contact_card(doc, contact_name="王南", contact_email="107038953@qq.com"):
    """联系方式卡片（T03681）：填真实联系人 / 邮箱；群二维码待用户提供后替换。"""
    p0 = doc.add_paragraph()
    p0.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p0.paragraph_format.space_before = Pt(8)
    p0.paragraph_format.space_after = Pt(4)
    p0.paragraph_format.line_spacing = 1.3
    set_font(p0.add_run("联系我们"), HEI, 12, True, BRAND)
    pc = doc.add_paragraph()
    pc.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pc.paragraph_format.space_after = Pt(2)
    set_font(pc.add_run("联系人："), SONG, 10.5, True, DARK)
    set_font(pc.add_run(contact_name), SONG, 10.5, False, ACCENT)
    pe = doc.add_paragraph()
    pe.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pe.paragraph_format.space_after = Pt(2)
    set_font(pe.add_run("邮　箱："), SONG, 10.5, True, DARK)
    set_font(pe.add_run(contact_email), SONG, 10.5, False, ACCENT)
    pn = doc.add_paragraph()
    pn.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pn.paragraph_format.space_before = Pt(2)
    pn.paragraph_format.space_after = Pt(10)
    set_font(pn.add_run("（群二维码待补充，由用户提供后替换此卡片）"), SONG, 9, False, GREY)
    return p0


def shot_figure(doc, name, width_cm, caption=None):
    """插入真实界面截图（图版已带细边框），图注与图同页。"""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(3 if caption else 12)
    p.paragraph_format.keep_with_next = bool(caption)
    p.add_run().add_picture(os.path.join(SHOTS, name), width=Cm(width_cm))
    if caption:
        c = doc.add_paragraph()
        c.alignment = WD_ALIGN_PARAGRAPH.CENTER
        c.paragraph_format.space_after = Pt(12)
        c.paragraph_format.line_spacing = 1.2
        set_font(c.add_run(caption), SONG, 9, False, GREY)
    return p


def bottom_rule(p, color="1F4E79", sz="12"):
    pPr = _pPr(p)
    pBdr = OxmlElement("w:pBdr")
    el = OxmlElement("w:bottom")
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), sz)
    el.set(qn("w:space"), "4")
    el.set(qn("w:color"), color)
    pBdr.append(el)
    pPr.append(pBdr)


def add_field(run, instr):
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), instr)
    run._element.addnext(fld)


# ---------------- 文档骨架 ----------------
doc = Document()

sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.top_margin, sec.bottom_margin = Cm(2.2), Cm(2.0)
sec.left_margin, sec.right_margin = Cm(2.4), Cm(2.4)
sec.different_first_page_header_footer = True

normal = doc.styles["Normal"]
style_font(normal, SONG, 10.5, DARK)
normal.paragraph_format.line_spacing = 1.5

# 页脚页码（封面不显示）
footer_p = sec.footer.paragraphs[0]
footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
set_font(footer_p.add_run("工作量评估助手 · 产品介绍　|　第 "), SONG, 9, False, GREY)
r = footer_p.add_run()
add_field(r, "PAGE")
set_font(footer_p.add_run(" 页"), SONG, 9, False, GREY)

# ---------------- 封面 ----------------
para(doc, "", size=10, after=0)
p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(90)
p.paragraph_format.space_after = Pt(4)
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
set_font(p.add_run("工作量评估助手"), HEI, 34, True, BRAND)

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_after = Pt(6)
set_font(p.add_run("Workload Estimate"), HEI, 13, False, GREY)

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_after = Pt(18)
p.paragraph_format.space_bottom = Pt(18)
set_font(p.add_run("需求文档进，成品造价表出"), HEI, 18, True, ACCENT)
bottom_rule(p, "2E74B5", "8")

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_after = Pt(6)
p.paragraph_format.line_spacing = 1.8
set_font(p.add_run("IFPUG 功能点 · NESMA 快速估算 · PERT 三点估算\n本地运行，需求文档不出本机"), SONG, 11.5, False, DARK)

shot_figure(doc, "fig_cover.png", 16.2)

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(30)
set_font(p.add_run("产品介绍 · 2026 年 10 月"), SONG, 10, False, GREY)
p.add_run().add_break(WD_BREAK.PAGE)   # 分页符挂在日期段末尾，避免单独成段多出一张空白页

# ---------------- 一、产品简介 ----------------
heading(doc, "一、产品简介", 1)

para(doc, "软件项目要报价、要立项、要结算，绕不开一个问题：这份需求到底值多少人天？"
          "靠经验拍脑袋，口径每次都不一样；靠 Excel 手工拆功能点，一份中等规模的需求说明书要拆上一两天，"
          "还容易漏项、算错。", indent=0.74)

para(doc, "工作量评估助手把这段最费时、最容易出分歧的工作做成了流水线："
          "上传需求说明书（.docx）→ 引擎按 IFPUG 规则识别候选功能点 → 逐条人工复核（类别、复杂度、重用、修改类型）→ "
          "一键生成与企业造价模板完全一致的成本评估表（.xlsx）。", indent=0.74)

para(doc, "它不是又一个「估算器网页」，而是一套可以直接嵌入现有评估流程的工具：成品表沿用贵司母版的公式与样式，"
          "Excel 打开即自动重算，评审会上拿出的还是那张熟悉的表——只是这次，数据是算出来的，每一步都可追溯。", indent=0.74)

para(doc, "", after=2)
p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(6)
p.paragraph_format.space_after = Pt(4)
set_font(p.add_run("为什么选择它"), HEI, 11.5, True, BRAND)
bullet(doc, "三种方法论一套工具", "IFPUG 功能点用于正式造价，NESMA 快速估算用于需求早期拿量级，PERT 三点估算用于工期与风险区间，切换页面即可，口径互通。")
bullet(doc, "成品表「零返工」", "生成时直接以贵司母版为基座写入明细，公式、合并单元格、样式原样保留，不需要再手工把数字搬回模板。")
bullet(doc, "数据不出本机", "引擎、数据库、母版全部在本地运行，需求文档不上传任何云端；断网、内网、隔离环境同样可用。")
bullet(doc, "可审计、可比对", "每次估算自动入库留痕，两次估算可逐项对比新增/删除/变更，评审争议从「我觉得」变成「按口径」。")

shot_figure(doc, "fig_flow.png", 16.2, "图 1　三步流程：上传需求 → 复核功能点 → 生成成品表")

# ---------------- 二、核心功能 ----------------
heading(doc, "二、核心功能模块", 1)

heading(doc, "1. IFPUG 功能点估算：从需求文档到造价表", 2)
para(doc, "拖入 .docx 需求说明书，引擎依次解析章节结构、定位功能需求清单表、按动作词与数据结构判定候选功能的 IFPUG 类型"
          "（ILF / EIF / EI / EO / EQ），并给出判定依据。复核环节支持逐条调整类别、复杂度、重用与修改类型，"
          "右侧实时汇总 UFP、US 与费用，改一条看一条。", indent=0.74)
shot_figure(doc, "fig_review.png", 12.0, "图 2　复核页：逐条调整类别 / 复杂度 / 重用 / 修改类型，底部实时汇总 UFP、US 与确认进度")

heading(doc, "2. NESMA 快速估算：十分钟拿到量级", 2)
para(doc, "需求还在讨论阶段、连功能点都拆不细的时候，只需要数清 ILF 与 EIF 的数量，即可按 NESMA 预估法 / 估算法"
          "出规模与费用区间，先给业务方一个可讨论的数字，后续再进入正式功能点评估。", indent=0.74)
shot_figure(doc, "fig_fast.png", 16.2, "图 3　NESMA 快速估算：只数 ILF / EIF 等计数项即可出规模与费用区间，并同步给出国标造价与 PERT 参考")

heading(doc, "3. PERT 三点估算：给工期一个区间而不是一个数", 2)
para(doc, "按项目录入估算项，填写乐观 / 最可能 / 悲观三值，系统按 (O + 4M + P) ÷ 6 计算预期工期、按 (P − O) ÷ 6 计算标准差，"
          "并折算理想人月与实际人月。项目可长期保存，支持需求文档导入候选条目（可人工录入或 AI 拆分）。", indent=0.74)
shot_figure(doc, "fig_pert.png", 16.2, "图 4　PERT 三点估算：阶段明细给出预期值与标准差，汇总为预期总人天、最理想人月与实际预估人月")

heading(doc, "4. 大模型识别增强：把「漏项」交给模型兜底", 2)
para(doc, "配置中心可接入任意 OpenAI 兼容接口（OpenAI / Claude / 通义 / 火山等），支持连接测试与模型列表自动拉取；"
          "启用后由模型对本地规则识别出的候选做复核补全，并可结合项目上下文目录扫描出的技术栈与规模信息，"
          "提升复杂需求的拆分完整度。是否启用、用哪个模型，全部由使用者决定。", indent=0.74)
shot_figure(doc, "fig_llm.png", 11.5, "图 5　配置中心「大模型识别增强」：接口地址、模型与 Key 均在本机填写，开关默认关闭")

heading(doc, "5. 母版保真出表：Excel 打开即重算", 2)
para(doc, "成品表以贵司母版为基座生成：明细写入数据区，公式、条件格式、合并单元格与列宽样式原样保留。"
          "母版可在配置中心随时替换并登记口径说明，换一家客户、换一版费率不需要改代码。"
          "内置金标准校验确保引擎复算结果与母版口径一致（示例母版 US 合计 = 105.07）。", indent=0.74)
shot_figure(doc, "fig_xlsx.png", 12.8, "图 6　生成的成品 xlsx：《规模估算》逐条列出类型、UFP、重用、修改与 US 公式列；《费用估算》按母版口径给出区间")

heading(doc, "6. 估算历史与版本对比", 2)
para(doc, "每一次估算都会落库留痕，可随时重开继续调整；同一项目的两次估算支持逐项 diff，"
          "新增、删除、金额与工作量变化高亮显示——需求变更带来的成本差异，一眼就能交给评审方。", indent=0.74)
shot_figure(doc, "fig_diff.png", 16.2, "图 7　历史版本对比：新增 / 删除 / 变更逐项高亮，US 与金额变化直接给出（示例 ΔUS −1.33）")

heading(doc, "7. 用户故事导出：从评估结果直达研发待办", 2)
para(doc, "结果页可按 INVEST 模板把已确认的功能点生成为用户故事（含验收标准与规模），导出 MD / CSV，"
          "或一键推送到 GitHub Issues（仓库与 token 由使用者自配）。评估结束不等于文档结束，交付物可以直接进入开发流程。", indent=0.74)
shot_figure(doc, "fig_story.png", 16.2, "图 8　用户故事：按 INVEST 模板生成，可编辑后导出 MD / CSV，或推送至 GitHub Issues")

heading(doc, "8. 桌面应用与无人值守命令行", 2)
para(doc, "桌面版为 Electron 壳 + 本地引擎一体安装包，安装即用、双击启动，无需配置 Python 环境；"
          "关窗前自动检测仍在运行的估算任务并二次确认，避免误关丢结果。"
          "需要批量或定时出表时，使用命令行模式 scripts/we_cli.py，以退出码表达结果（0 成功 / 2 输入非法 / 3 生成失败），"
          "可直接挂进调度脚本。", indent=0.74)
shot_figure(doc, "fig_desktop.png", 14.0, "图 9　桌面版：Electron 窗口自带本地引擎，双击图标即用，无需另外配置 Python 环境")

heading(doc, "9. 细节到位：多语言、主题与可访问性", 2)
para(doc, "界面支持中 / 英双语切换，浅色、深色、高对比三套主题，品牌主色可自定义；"
          "全链路可用键盘完成主流程，语义化 role/aria 与对比度按 WCAG 口径校验，满足内网与企业无障碍规范要求。", indent=0.74)
shot_figure(doc, "fig_en_dark.png", 16.2, "图 10　英文界面 + 深色主题（同一份估算结果，语言与主题即时切换）")

# ---------------- 三、应用场景 ----------------
heading(doc, "三、应用场景", 1)

heading(doc, "场景一：立项与预算评审——先把量级说清楚", 2)
para(doc, "业务部门提需求、财务要预算、技术要资源，三方口径不一。用 NESMA 快速估算十分钟出一版量级，"
          "评审通过后转入 IFPUG 正式评估出造价表，前后口径同源、可解释。", indent=0.74)

heading(doc, "场景二：外包采购与结算——把争议变成对照", 2)
para(doc, "供应商报价与实际交付的差异，往往卡在「这个功能算几个功能点」。用统一规则逐条拆解并留痕，"
          "两次评估的差异可逐项对比，结算依据从口头协商变为可复算的表格。", indent=0.74)
shot_figure(doc, "fig_hist_list.png", 16.2, "图 11　历史估算：同一需求的两次评估各自留痕，勾选两版即可对比差异")

heading(doc, "场景三：多项目并行——产能与风险一起看", 2)
para(doc, "PERT 三点估算给出的是区间而非单点：预期工期配合悲观值，可直接用于排期缓冲与风险披露；"
          "项目库统一管理多个在建项目，估算项可随时补充调整。", indent=0.74)

heading(doc, "场景四：内网 / 隔离环境——不能上云也能用", 2)
para(doc, "全部计算、存储与界面资源本地化：不依赖任何 CDN 与外网服务，图标、图表库本地内联，"
          "需求文档不出本机。银行、政务等对内网隔离有硬性要求的环境可直接部署。（若启用大模型增强则需要用户自行配置可访问的模型服务。）", indent=0.74)

# ---------------- 四、行动号召 ----------------
heading(doc, "四、立即开始", 1)

para(doc, "三步完成第一份估算：", indent=0)
for i, (h1, b1) in enumerate([
    ("① 安装", "运行安装包 WorkloadEstimate-<版本>-setup.exe，双击桌面图标启动（自动拉起本地引擎并打开界面）。"),
    ("② 试算", "在 IFPUG 估算页拖入一份历史需求文档，走完「识别 → 复核 → 生成」，得到第一张成品造价表。"),
    ("③ 落地", "到配置中心上传贵司母版、录入费率口径，之后所有评估都按这套标准出表。"),
], start=1):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.line_spacing = 1.5
    set_font(p.add_run(h1 + "　"), HEI, 11, True, ACCENT)
    set_font(p.add_run(b1), SONG, 10.5, False, DARK)

para(doc, "", after=4)
p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(10)
p.paragraph_format.space_after = Pt(4)
set_font(p.add_run("获取与支持"), HEI, 11.5, True, BRAND)
bullet(doc, "开源仓库", "源码与历史版本托管于 GitHub：https://github.com/wangnan05563/Evaluation；桌面安装包与版本更新见 Releases：https://github.com/wangnan05563/Evaluation/releases。")
bullet(doc, "安装包", "从 GitHub Releases 获取最新安装包（版本号形如 0.1.YYYYMMDD-NNN，与发布说明一一对应）。")
bullet(doc, "使用方法", "内置帮助文档涵盖 IFPUG / NESMA / PERT 方法论与计算口径，帮助文档页可随时查阅。")
bullet(doc, "反馈渠道", "联系人：王南　邮箱：107038953@qq.com（群二维码待用户提供后补充）。")

contact_card(doc)

# ---------------- 附：计算口径 ----------------
heading(doc, "附：计算口径速查（与母版 Excel 公式一致）", 1)

rows = [
    ("估算功能点 UFP", "ILF = 10，EIF = 7，EI = 4，EO = 5，EQ = 4（预估功能点法：ILF = 35，EIF = 15）"),
    ("未调整规模 US", "UFP × 重用系数（低 1 / 中 2/3 / 高 1/3）× 修改系数（新增 1 / 修改 0.8 / 删除 0.2）"),
    ("调整后规模", "US × 规模变更调整因子（早期 1.39 / 中期 1.21 / 晚期 1.10 / 交付后 1.00）"),
    ("工作量", "调整后规模 × 生产率 10.67 人时/FP ÷ 8 × 调整因子 0.8（低/中/高 ±20%）"),
    ("费用", "工作量 ÷ 22 人/月 × 2.57 万元/人月"),
    ("PERT 预期工期", "(乐观 + 4 × 最可能 + 悲观) ÷ 6，标准差 = (悲观 − 乐观) ÷ 6"),
]
table = doc.add_table(rows=1, cols=2)
try:
    table.style = "Light Grid Accent 1"
except Exception:
    table.style = "Table Grid"
table.alignment = WD_TABLE_ALIGNMENT.CENTER
hdr = table.rows[0].cells
for cell, text in zip(hdr, ("口径项", "计算方式")):
    cell.text = ""
    set_font(cell.paragraphs[0].add_run(text), HEI, 10, True, BRAND)
for k, v in rows:
    cells = table.add_row().cells
    cells[0].text = ""
    cells[1].text = ""
    set_font(cells[0].paragraphs[0].add_run(k), SONG, 9.5, True, DARK)
    set_font(cells[1].paragraphs[0].add_run(v), SONG, 9.5, False, DARK)
table.columns[0].width = Cm(3.4)
table.columns[1].width = Cm(12.6)
for row in table.rows:
    row.cells[0].width = Cm(3.4)
    row.cells[1].width = Cm(12.6)

para(doc, "", after=2)
para(doc, "注：以上口径与内置母版公式一一对应，引擎复算母版示例数据的 US 合计恒为 105.07，作为每次发版的回归校验基线。"
          "更换母版或费率后，以配置中心登记的当期口径为准。", size=9, color=GREY, line=1.3)

# 文档属性
doc.core_properties.title = "工作量评估助手 · 产品介绍"
doc.core_properties.subject = "IFPUG / NESMA / PERT 本地化工作量评估工具"
doc.core_properties.author = "工作量评估助手团队"
doc.core_properties.comments = "配图取自本机运行的真实界面；联系方式已填真实联系人（王南 / 107038953@qq.com），群二维码待用户提供后补充。"

os.makedirs(os.path.dirname(OUT), exist_ok=True)
doc.save(OUT)
print("saved", OUT, os.path.getsize(OUT), "bytes")
