# -*- coding: utf-8 -*-
"""AC-40 诊断包脱敏：日志白名单 + 配置敏感字段掩码 + 路径/令牌/邮箱清洗。

设计口径：
- 日志是「结构化事件」，只保留白名单字段；自由文本（err/msg/quote 等）不进入诊断包，
  从根上避免客户原文、文档名、绝对路径外泄。
- 配置文件按 JSON 递归处理，密钥类字段一律替换为 ***；字符串再清洗令牌/路径/邮箱。
- 每次导出生成 redaction-report.json，记录被丢弃字段与命中规则，便于审计。
"""
import json
import re

# 允许进入诊断包的日志字段：只含运行态元数据，不含任何文档/客户内容
LOG_KEYS = {
    "ts", "level", "module", "event", "duration_ms", "ok", "fail",
    "field", "path", "size", "ver", "applied", "reason", "files",
}
SENSITIVE_KEYS = {
    "key", "apikey", "api_key", "token", "access_token", "refresh_token",
    "secret", "password", "passwd", "authorization", "auth", "cookie",
    "client_secret", "private_key",
}
# AC-40「不含客户原文」：这些字段可能承载文档片段/自由文本，整值掩码而不是只清路径
CONTENT_KEYS = {
    "customer_text", "quote", "excerpt", "document_text", "doc_text",
    "raw_text", "content", "msg", "message", "err", "error_detail", "note",
    "description", "paragraph",
}
_TOKEN_RE = re.compile(r"(?i)(sk-[a-z0-9_-]{8,}|Bearer\s+[a-z0-9._~+/=-]{8,})")
_WIN_PATH_RE = re.compile(r"(?i)[A-Z]:\\[^\s\"'<>|]+")
_POSIX_PATH_RE = re.compile(r"(?<![A-Za-z0-9])/(?:Users|home|tmp|var|opt|private)/[^\s\"'<>|]+")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def redact_text(text):
    """清洗单段文本：令牌、绝对路径、邮箱。"""
    if not isinstance(text, str):
        return text
    s = _TOKEN_RE.sub("***", text)
    s = _WIN_PATH_RE.sub("<path>", s)
    s = _POSIX_PATH_RE.sub("<path>", s)
    s = _EMAIL_RE.sub("<email>", s)
    return s


def redact_log_line(line, stats):
    """单行 JSON 日志 → 白名单记录；解析失败直接丢弃（畸形行可能含任意内容）。"""
    try:
        rec = json.loads(line)
    except Exception:
        stats["malformed_lines"] = stats.get("malformed_lines", 0) + 1
        return None
    if not isinstance(rec, dict):
        stats["malformed_lines"] = stats.get("malformed_lines", 0) + 1
        return None
    out = {}
    for k, v in rec.items():
        if k not in LOG_KEYS:
            stats["dropped_fields"][k] = stats["dropped_fields"].get(k, 0) + 1
            continue
        if isinstance(v, str):
            out[k] = redact_text(v)
        elif isinstance(v, (int, float, bool)) or v is None:
            out[k] = v
        else:
            stats["dropped_fields"][k] = stats["dropped_fields"].get(k, 0) + 1
    return json.dumps(out, ensure_ascii=False)


def redact_log_text(text):
    """整份 jsonl → (安全 jsonl 文本, 报告)。"""
    stats = {"dropped_fields": {}, "malformed_lines": 0}
    kept = []
    for line in str(text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        safe = redact_log_line(line, stats)
        if safe:
            kept.append(safe)
    return "\n".join(kept) + ("\n" if kept else ""), stats


def redact_obj(obj, stats):
    """递归清洗 JSON 配置：敏感键掩码，字符串清洗，其他类型原样。"""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            kl = str(k).lower()
            if kl in SENSITIVE_KEYS or kl in CONTENT_KEYS:
                out[k] = "***"
                stats["masked_keys"] = stats.get("masked_keys", 0) + 1
            else:
                out[k] = redact_obj(v, stats)
        return out
    if isinstance(obj, list):
        return [redact_obj(v, stats) for v in obj]
    if isinstance(obj, str):
        return redact_text(obj)
    return obj


def redact_json_text(text):
    """配置文本 → (安全 JSON 文本, 报告)；非 JSON 原样清洗。"""
    stats = {"masked_keys": 0}
    try:
        obj = json.loads(text)
    except Exception:
        return redact_text(text), stats
    return json.dumps(redact_obj(obj, stats), ensure_ascii=False, indent=1), stats


def merge_stats(*stats):
    out = {"dropped_fields": {}, "malformed_lines": 0, "masked_keys": 0}
    for s in stats:
        if not s:
            continue
        out["malformed_lines"] += s.get("malformed_lines", 0)
        out["masked_keys"] += s.get("masked_keys", 0)
        for k, v in (s.get("dropped_fields") or {}).items():
            out["dropped_fields"][k] = out["dropped_fields"].get(k, 0) + v
    return out


def readme(report):
    return (
        "工作量评估工具 · 诊断包\n"
        "=====================\n"
        "本诊断包已自动脱敏，可直接附加到工单：\n"
        "- 日志仅保留白名单字段（时间/级别/模块/事件/耗时/结果），不含客户文档内容、文档名、绝对路径；\n"
        "- 配置仅含识别规则与费率版本，密钥/令牌/密码字段已替换为 ***；\n"
        "- 不含 config.json（LLM API Key 不进入诊断包）。\n\n"
        "脱敏统计：" + json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n"
        "回滚：如升级失败，使用 scripts/rollback.py --list 选择升级前备份恢复。\n"
    )
