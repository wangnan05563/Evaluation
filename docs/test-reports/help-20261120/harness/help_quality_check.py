import hashlib
import json
import math
import os
import re
import struct
import sys
import time
import zipfile
import xml.etree.ElementTree as ET

import openpyxl

WB = r'C:\Users\hspcadmin\AppData\Local\Temp\we_help_e2e\generated\帮助页验收-真实文档-工作量评估.xlsx'
DOC = r'E:\test\工作量评估\HUNDSUN票据交易管理平台软件V5.0-铁建财务-票据系统线上审批需求说明文档V1.0.3.docx'
UI = r'C:\Users\hspcadmin\AppData\Local\Doubao\User Data\Default\.doubao\agent_mode\workspace\.sessions\38453923401786370\agents\m_0cwexANLqfk\help_test\round1'
OUT = os.path.join(UI, 'quality_results.json')
results = []


def check(name, ok, detail=''):
    results.append({'name': name, 'ok': bool(ok), 'detail': str(detail)[:500]})
    print(('PASS ' if ok else 'FAIL ') + name + ((' | ' + str(detail)[:300]) if detail else ''))


def close(a, b, tol=1e-6):
    return abs(float(a) - float(b)) <= tol


def norm(s):
    return re.sub(r'[（）()、，,。；;：:\s　]', '', s or '')


def png_size(p):
    with open(p, 'rb') as f:
        sig = f.read(8)
        if sig != b'\x89PNG\r\n\x1a\n':
            return None
        f.read(4)
        f.read(4)
        w, h = struct.unpack('>II', f.read(8))
        return w, h


# ---- file integrity ----
if not os.path.exists(WB):
    check('生成物存在', False, WB)
    sys.exit(1)
check('生成物存在且体积合理', os.path.getsize(WB) >= 20000, f'{os.path.getsize(WB)} bytes')
sha = hashlib.sha256(open(WB, 'rb').read()).hexdigest()
check('生成物 SHA-256 可复核', len(sha) == 64, sha)
try:
    z = zipfile.ZipFile(WB)
    names = z.namelist()
    check('XLSX ZIP 结构完整', z.testzip() is None, f'{len(names)} entries')
    check('无宏/外部链接部件', not any(x.startswith('xl/externalLinks') or x == 'xl/vbaProject.bin' for x in names), '')
    rels = [n for n in names if n.endswith('.rels')]
    ext = []
    for n in rels:
        txt = z.read(n).decode('utf-8', 'ignore')
        if 'TargetMode="External"' in txt:
            ext.append(n)
    check('工作簿无外部目标关系', not ext, ','.join(ext))
    z.close()
except Exception as e:
    check('XLSX ZIP 结构完整', False, f'{type(e).__name__}: {e}')

wbf = openpyxl.load_workbook(WB, data_only=False)
wbv = openpyxl.load_workbook(WB, data_only=True)
check('工作表齐全', wbv.sheetnames == ['项目特征', '规模估算', '费用估算', '模板使用说明&基础参数'], wbv.sheetnames)

# ---- document authenticity ----
doc_text = ''
try:
    dz = zipfile.ZipFile(DOC)
    root = ET.fromstring(dz.read('word/document.xml'))
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    paras = [''.join(t.text or '' for t in p.findall('.//w:t', ns)).strip() for p in root.findall('.//w:p', ns)]
    doc_text = '\n'.join(paras)
    check('需求文档可解析', len(paras) > 100, f'{len(paras)} paragraphs')
except Exception as e:
    check('需求文档可解析', False, f'{type(e).__name__}: {e}')

# ---- scale sheet ----
s = wbv['规模估算']
sf = wbf['规模估算']
rows = []
for r in range(6, 23):
    rows.append({
        'no': s.cell(r, 1).value, 'sys': s.cell(r, 2).value, 'l1': s.cell(r, 3).value,
        'name': s.cell(r, 8).value, 'type': s.cell(r, 9).value, 'ufp': s.cell(r, 10).value,
        'reuse': s.cell(r, 11).value, 'mod': s.cell(r, 12).value, 'us': s.cell(r, 13).value
    })
types = [x['type'] for x in rows]
check('明细恰为 17 项', len(rows) == 17 and all(x['name'] for x in rows), len(rows))
check('类型分布 EI=11 / EQ=6', types.count('EI') == 11 and types.count('EQ') == 6 and len(types) == 17, {t: types.count(t) for t in set(types)})
check('明细编号连续且无重复', [x['no'] for x in rows] == list(range(1, 18)), [x['no'] for x in rows])
check('17 项名称唯一', len(set(x['name'] for x in rows)) == 17, '')
missing = [x['name'] for x in rows if norm(x['name']) not in norm(doc_text)]
check('17 项均可回溯真实需求文档', not missing, '未命中: ' + ','.join(missing))
check('IFPUG 权重与母版一致（EI/EO/EQ=4/5/4）', all(x['ufp'] == (4 if x['type'] in ('EI', 'EQ') else None) for x in rows), [x['ufp'] for x in rows])
check('重用/修改口径为 中/新增', all(x['reuse'] == '中' and x['mod'] == '新增' for x in rows), '')
check('US 逐行按 UFP×2/3 计算', all(close(x['us'], x['ufp'] * 2 / 3, 1e-5) for x in rows), rows[0]['us'])
check('UFP 合计 68', close(s['J54'].value, 68) and close(s['C2'].value, 68), f'{s["J54"].value}/{s["C2"].value}')
check('US 合计 45.33', close(s['M54'].value, 68 * 2 / 3, 1e-5) and close(s['C3'].value, s['M54'].value, 1e-6), f'{s["M54"].value}/{s["C3"].value}')
jformula = str(sf['J6'].value or '')
mformula = str(sf['M6'].value or '')
check('UFP/US 列由母版公式驱动', all(x in jformula for x in ["'模板使用说明&基础参数'!$E$22", '$E$23', '$E$24', '$E$25', '$E$26']) and all(x in mformula for x in ['$E$5', '$E$6', '$E$7', '$E$10', '$E$11', '$E$12']), jformula[:160])

# ---- fee sheet ----
f = wbv['费用估算']
ff = wbf['费用估算']
scale_us = float(s['M54'].value)
check('费用规模引用 US 合计', close(f['E3'].value, scale_us, 1e-6), f'{f["E3"].value} vs {scale_us}')
check('规模变更因子 1.21', close(f['E4'].value, 1.21), f['E4'].value)
check('调整后规模 = 规模×SCF', close(f['E5'].value, f['E3'].value * f['E4'].value, 1e-6), f'{f["E5"].value}')
check('基准生产率 10.67 人时/FP', close(f['E7'].value, 10.67), f['E7'].value)
check('生产率上下限 0.8×/1.2×', close(f['E6'].value, f['E7'].value * 0.8) and close(f['E8'].value, f['E7'].value * 1.2), [f['E6'].value, f['E7'].value, f['E8'].value])
check('未调整工作量下限 = 规模×0.8生产率/8', close(f['E9'].value, f['E5'].value * f['E6'].value / 8, 1e-5), f'{f["E9"].value}')
check('未调整工作量中值 = 规模×生产率/8', close(f['E10'].value, f['E5'].value * f['E7'].value / 8, 1e-5), f'{f["E10"].value}')
check('未调整工作量上限 = 规模×1.2生产率/8', close(f['E11'].value, f['E5'].value * f['E8'].value / 8, 1e-5), f'{f["E11"].value}')
check('质量/完整性/语言/团队因子可追溯', all(isinstance(f[c].value, (int, float)) for c in ['E12', 'E13', 'E14', 'E15', 'E16', 'E17']), [f[c].value for c in ['E12', 'E13', 'E14', 'E15', 'E16', 'E17']])
exp19 = f['E9'].value * f['E12'].value * f['E13'].value * f['E14'].value * f['E15'].value * f['E16'].value * f['E17'].value + (f['E18'].value or 0)
check('调整后工作量公式一致', close(f['E19'].value, exp19, 1e-5), f'{f["E19"].value} vs {exp19}')
check('人月单价 2.57 万元', close(f['E26'].value, 2.57), f['E26'].value)
exp27 = f['E19'].value * f['E26'].value / 22
check('费用 = 工作量×单价/22', close(f['E27'].value, exp27, 1e-6), f'{f["E27"].value} vs {exp27}')
check('费用公式含 22 人月分母', '/22' in str(ff['E27'].value or ''), str(ff['E27'].value))
check('费用金额非负且有限', f['E27'].value >= 0 and math.isfinite(f['E27'].value), f['E27'].value)

# ---- template parameters ----
t = wbv['模板使用说明&基础参数']
weights = [t.cell(r, 5).value for r in range(22, 27)]
check('母版 IFPUG 权重 10/7/4/5/4', weights == [10, 7, 4, 5, 4], weights)
check('母版重用系数 1/3、2/3、1', [round(t.cell(r, 5).value, 6) for r in range(5, 8)] == [round(1 / 3, 6), round(2 / 3, 6), 1], [t.cell(r, 5).value for r in range(5, 8)])
check('母版修改系数 1.0/0.8/0.2', [t.cell(r, 5).value for r in range(10, 13)] == [1, 0.8, 0.2], [t.cell(r, 5).value for r in range(10, 13)])

# ---- error / placeholder scan ----
bad_tokens = ('#REF!', '#VALUE!', '#DIV/0!', '#N/A', '#NAME?', 'NaN', 'undefined', 'TODO', 'help.')
bad = []
for ws in wbv.worksheets:
    for row in ws.iter_rows():
        for c in row:
            v = c.value
            if isinstance(v, str) and any(x in v for x in bad_tokens):
                bad.append(f'{ws.title}!{c.coordinate}={v[:80]}')
check('成品表无公式错误/占位文本', not bad, '; '.join(bad[:5]))
nonfinite = []
for ws in wbv.worksheets:
    for row in ws.iter_rows():
        for c in row:
            if isinstance(c.value, float) and not math.isfinite(c.value):
                nonfinite.append(f'{ws.title}!{c.coordinate}')
check('成品表数值均为有限值', not nonfinite, ','.join(nonfinite))
formula_h = [c.coordinate for row in sf.iter_rows(min_row=6, max_row=53) for c in row if c.column == 8 and isinstance(c.value, str) and c.value.startswith('=')]
check('功能点名称列无公式注入', not formula_h, formula_h)

# ---- UI evidence ----
ui_json = os.path.join(UI, 'ui_results.json')
ui = json.load(open(ui_json, encoding='utf-8')) if os.path.exists(ui_json) else {}
check('UI 结果 83/83 通过', len(ui.get('results', [])) == 83 and all(x.get('ok') for x in ui.get('results', [])), len(ui.get('results', [])))
check('UI 无未捕获异常', not ui.get('errors'), ui.get('errors'))
shots = {
    '00_help_zh_1440.png': (1440, 900), '01_help_docs_1440.png': (1440, 900), '02_help_update_fail.png': (1440, 900),
    '02_help_update_progress.png': (1440, 900), '03_help_update_error.png': (1440, 900), '04_help_1024.png': (1024, 900),
    '05_help_768.png': (768, 900), '06_help_375.png': (375, 812), '07_help_guide_375.png': (375, 812),
    '08_help_en_1440.png': (1440, 900), '09_help_final_1440.png': (1440, 900)
}
shot_bad = []
for n, sz in shots.items():
    p = os.path.join(UI, n)
    got = png_size(p) if os.path.exists(p) and os.path.getsize(p) > 10000 else None
    if not got or got != sz:
        shot_bad.append(f'{n}:{got}')
check('11 张截图存在且尺寸正确', not shot_bad, '; '.join(shot_bad))

summary = {'ok': all(x['ok'] for x in results), 'passed': sum(1 for x in results if x['ok']), 'total': len(results),
           'workbook': WB, 'size': os.path.getsize(WB), 'sha256': sha, 'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
           'results': results}
json.dump(summary, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f'SUMMARY {summary["passed"]}/{summary["total"]} -> {OUT}')
sys.exit(0 if summary['ok'] else 1)
