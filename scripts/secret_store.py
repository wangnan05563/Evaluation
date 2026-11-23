# -*- coding: utf-8 -*-
"""NFR-03：LLM API Key 等敏感值的本机静态保护。

Windows 使用 DPAPI（CryptProtectData，当前用户作用域），密文只能被同一 Windows
用户解密；非 Windows 开发环境退化为 `dev:` + base64（不具安全强度，仅避免明文
肉眼可见，生产构建只在 Windows 运行）。所有密文带前缀，便于迁移与审计。
"""
import base64
import ctypes
import os
import sys

DPAPI_PREFIX = "dpapi:"
DEV_PREFIX = "dev:"


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong),
                ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data):
    buf = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def _dpapi(data, protect):
    from ctypes import wintypes
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    blob_in, buf_in = _blob(data)
    blob_out = _DataBlob()
    pblob_in = ctypes.byref(blob_in)
    pblob_out = ctypes.byref(blob_out)
    if protect:
        fn = crypt32.CryptProtectData
        fn.argtypes = [ctypes.POINTER(_DataBlob), wintypes.LPCWSTR,
                       ctypes.POINTER(_DataBlob), ctypes.c_void_p,
                       ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob)]
        args = (pblob_in, "WorkloadEval", None, None, None, 0, pblob_out)
    else:
        fn = crypt32.CryptUnprotectData
        fn.argtypes = [ctypes.POINTER(_DataBlob), ctypes.POINTER(_DataBlob),
                       ctypes.POINTER(_DataBlob), ctypes.c_void_p,
                       ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob)]
        args = (pblob_in, None, None, None, None, 0, pblob_out)
    fn.restype = wintypes.BOOL
    ok = fn(*args)
    if not ok:
        raise OSError(ctypes.get_last_error(), "DPAPI 调用失败")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def protect(text):
    """明文 → 带前缀密文；空值原样返回。"""
    if not text:
        return ""
    data = str(text).encode("utf-8")
    if os.name == "nt":
        try:
            return DPAPI_PREFIX + base64.b64encode(_dpapi(data, True)).decode("ascii")
        except Exception:
            # 极端环境（无 crypt32）不阻断应用，但审计可识别明文风险
            return DEV_PREFIX + base64.b64encode(data).decode("ascii")
    return DEV_PREFIX + base64.b64encode(data).decode("ascii")


def unprotect(value):
    """带前缀密文 → 明文；兼容历史明文（无前缀直接返回）。"""
    if not value:
        return ""
    s = str(value)
    if s.startswith(DPAPI_PREFIX):
        raw = base64.b64decode(s[len(DPAPI_PREFIX):])
        return _dpapi(raw, False).decode("utf-8")
    if s.startswith(DEV_PREFIX):
        return base64.b64decode(s[len(DEV_PREFIX):]).decode("utf-8")
    return s


def is_protected(value):
    return str(value or "").startswith((DPAPI_PREFIX, DEV_PREFIX))


def backend():
    return "dpapi" if os.name == "nt" else "dev-base64"
