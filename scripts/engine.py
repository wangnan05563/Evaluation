# -*- coding: utf-8 -*-
"""M3 规则引擎：按 IFPUG 与成品模板公式口径计算 US 及汇总（正本清源，供校验与前端展示）。
与母版《规模估算/费用估算》公式保持一致：
- UFP 按"估算功能点"方法取类别默认权重：ILF10/EIF7/EI4/EO5/EQ4
- US = UFP × 重用系数 × 修改类型系数
"""
from typing import Iterable

# 权重（估算功能点法）：对应母版 '模板使用说明&基础参数' E22-E26
WEIGHT = {"ILF": 10, "EIF": 7, "EI": 4, "EO": 5, "EQ": 4}
# 母版预估功能点法（E15-E16），仅 ILF/EIF 有值
WEIGHT_PRE = {"ILF": 35, "EIF": 15}
# T01501（python:S1192）：方法名字面量原在 4 个函数签名里重复内联，
# 且 validators.METHODS 另有一份；改口径须同步多处，易漏。提取为常量并由其派生 METHODS。
METHOD_ESTIMATE = "估算功能点"      # 默认口径：全部类别取 WEIGHT
METHOD_PRESELECT = "预估功能点"      # 母版口径：仅 ILF/EIF 取 WEIGHT_PRE，事务类回退 WEIGHT
METHODS = (METHOD_ESTIMATE, METHOD_PRESELECT)
# 母版实际为精确分数：高=1/3、中=2/3（0.333.../0.666...），低=1
REUSE = {"低": 1.0, "中": 2 / 3, "高": 1 / 3}
MODIFY = {"新增": 1.0, "修改": 0.80, "删除": 0.20}
# 规模变更调整因子（估算时机），母版 H51-H54 / I51-I54
SCALE_CHANGE = {"估算早期": 1.39, "估算中期": 1.21, "估算晚期": 1.10, "项目交付后及运维阶段": 1.00}
# T06188：复杂度口径。企业母版（默认）沿用母版类别权重；标准 IFPUG 按 DET/RET/FTR
# 判定低/中/高后取标准权重，仅标准模式改变 UFP，企业母版 US=105.07 不受影响。
CX_MASTER = "企业母版"
CX_STANDARD = "标准IFPUG"
CX_MODES = (CX_MASTER, CX_STANDARD)
STD_WEIGHT = {
    "ILF": {"低": 7, "中": 10, "高": 15},
    "EIF": {"低": 5, "中": 7, "高": 10},
    "EI": {"低": 3, "中": 4, "高": 6},
    "EO": {"低": 4, "中": 5, "高": 7},
    "EQ": {"低": 3, "中": 4, "高": 6},
}
# 切到标准模式但历史明细还没有 DET/RET/FTR 时的默认值：中复杂度、UFP 与企业母版一致。
DEFAULT_DET, DEFAULT_RET, DEFAULT_FTR = 20, 2, 1


def default_det(type_):
    """标准模式缺省 DET：ILF/EIF 用 20；事务类用 10，保证默认都落在中复杂度。"""
    return DEFAULT_DET if type_ in ("ILF", "EIF") else 10


def normalize_cx_mode(mode):
    """接受中文 UI 值或英文别名，非法值抛 ValueError。"""
    if not mode or mode in ("enterprise", "master", CX_MASTER):
        return CX_MASTER
    if mode in ("standard", "ifpug", CX_STANDARD):
        return CX_STANDARD
    raise ValueError(f"未知复杂度口径 {mode}")


def _int_or(v, default):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _band(value, low_max, mid_max):
    if value <= low_max:
        return "低"
    return "中" if value <= mid_max else "高"


def _file_complexity(ret, det):
    if ret <= 1:
        return "低" if det <= 50 else "中"
    if ret <= 5:
        return _band(det, 19, 50)
    return "中" if det <= 19 else "高"


def _transaction_complexity(ftr, det, ftr_low, det_low, det_mid):
    if ftr <= ftr_low:
        return _band(det, det_low, det_mid)
    return "中" if det <= det_low else "高"


def complexity(type_: str, det=None, ret=None, ftr=None) -> str:
    """标准 IFPUG DET/RET/FTR → 低/中/高（ILF/EIF 用 RET+DET；EI/EO/EQ 用 FTR+DET）。"""
    if type_ not in STD_WEIGHT:
        raise ValueError(f"未知类别 {type_}")
    d = max(1, _int_or(det, default_det(type_)))
    r = max(1, _int_or(ret, DEFAULT_RET))
    f = max(0, _int_or(ftr, DEFAULT_FTR))
    if type_ in ("ILF", "EIF"):
        return _file_complexity(r, d)
    if type_ == "EI":
        return _transaction_complexity(f, d, 2, 4, 15)
    # EO / EQ
    return _transaction_complexity(f, d, 3, 5, 19)


def standard_weight(type_: str, det=None, ret=None, ftr=None) -> int:
    return STD_WEIGHT[type_][complexity(type_, det, ret, ftr)]


def item_ufp(it: dict, method: str = METHOD_ESTIMATE, cx_mode: str = CX_MASTER) -> int:
    """单条明细 UFP：标准模式优先按 DET/RET/FTR，企业母版沿用类别权重。"""
    if normalize_cx_mode(cx_mode) == CX_STANDARD and it.get("type") in STD_WEIGHT:
        return standard_weight(it["type"], it.get("det"), it.get("ret"), it.get("ftr"))
    return weight(it.get("type"), method)


def weight(type_: str, method: str = METHOD_ESTIMATE) -> int:
    table = WEIGHT_PRE if method == METHOD_PRESELECT else WEIGHT
    if type_ in table:
        return table[type_]
    if method == METHOD_PRESELECT:
        return WEIGHT[type_]  # 预估功能点法母版仅 ILF/EIF 有专门权重，事务类回退估算权重
    raise ValueError(f"未知类别 {type_}")


def us(type_: str, reuse: str, modify: str, method: str = METHOD_ESTIMATE) -> float:
    """US = 类别权重 × 重用系数 × 修改系数（企业母版口径）。"""
    if reuse not in REUSE or modify not in MODIFY:
        raise ValueError(f"非法取值 reuse={reuse}, modify={modify}")
    return weight(type_, method) * REUSE[reuse] * MODIFY[modify]


def item_us(it: dict, method: str = METHOD_ESTIMATE, cx_mode: str = CX_MASTER) -> float:
    """单条明细 US；标准模式下 UFP 走 DET/RET/FTR 矩阵。"""
    reuse, modify = it.get("reuse"), it.get("modify")
    if reuse not in REUSE or modify not in MODIFY:
        raise ValueError(f"非法取值 reuse={reuse}, modify={modify}")
    return item_ufp(it, method, cx_mode) * REUSE[reuse] * MODIFY[modify]


def total_us(items: Iterable[dict], method: str = METHOD_ESTIMATE, cx_mode: str = CX_MASTER) -> float:
    return round(sum(item_us(i, method, cx_mode) for i in items), 2)


def summary(items: Iterable[dict], timing: str = "估算中期", method: str = METHOD_ESTIMATE,
            cx_mode: str = CX_MASTER) -> dict:
    """返回与费用估算链路一致的汇总（工作量月 = 天/22；费用单位万元）。"""
    items = list(items)
    cx_mode = normalize_cx_mode(cx_mode)
    ufp = sum(item_ufp(i, method, cx_mode) for i in items)
    us_sum = total_us(items, method, cx_mode)
    adjusted = round(us_sum * SCALE_CHANGE[timing], 2)  # 调整后规模 = US × 规模变更因子
    eff_mid = 10.67  # 中值生产率(人时/FP)
    work_mid = adjusted * eff_mid / 8            # 未调整工作量(人天)
    work_low, work_high = work_mid * 0.8, work_mid * 1.2
    factor = 0.8                                 # 调整因子链（应用类型1×质量1×完整1×语言1×团队0.8）
    perf = 22
    price = 2.57
    return {
        "ufp": ufp, "us": us_sum, "cx_mode": cx_mode, "adjusted_fp": adjusted,
        "work": {"low": round(work_low * factor, 2), "mid": round(work_mid * factor, 2),
                 "high": round(work_high * factor, 2)},
        "cost": {"low": round(work_low * factor / perf * price, 2),
                 "mid": round(work_mid * factor / perf * price, 2),
                 "high": round(work_high * factor / perf * price, 2)},
    }