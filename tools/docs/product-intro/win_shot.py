# -*- coding: utf-8 -*-
"""按进程号抓真实桌面窗口（含标题栏/边框），用于 Electron 桌面版截图。
用法：python tools/docs/product-intro/win_shot.py <pid> <out.png>
PrintWindow + PW_RENDERFULLCONTENT：窗口被遮挡也能取到内容，不依赖前台焦点。"""
import ctypes
import sys
import time

import win32gui
import win32process
import win32ui
from PIL import Image

PW_RENDERFULLCONTENT = 2

# 本机 150% 缩放：不声明 DPI 感知时 GetWindowRect 返回虚拟化坐标，抓出来只有左下角一块
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()


def top_window(pid):
    found = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd) or not win32gui.GetWindowText(hwnd):
            return
        _, wp = win32process.GetWindowThreadProcessId(hwnd)
        if wp == pid:
            found.append(hwnd)

    win32gui.EnumWindows(cb, None)
    if not found:
        return None
    return max(found, key=lambda h: (lambda r: (r[2] - r[0]) * (r[3] - r[1]))(win32gui.GetWindowRect(h)))


def grab(hwnd, out):
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    w, h = right - left, bottom - top
    hdc = win32gui.GetWindowDC(hwnd)
    src = win32ui.CreateDCFromHandle(hdc)
    mem = src.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(src, w, h)
    mem.SelectObject(bmp)
    ok = ctypes.windll.user32.PrintWindow(hwnd, mem.GetSafeHdc(), PW_RENDERFULLCONTENT)
    if not ok:
        raise RuntimeError("PrintWindow 失败")
    bits = bmp.GetBitmapBits(True)
    img = Image.frombuffer("RGB", (w, h), bits, "raw", "BGRX", 0, 1)
    img.save(out)
    src.DeleteDC()
    mem.DeleteDC()
    win32gui.DeleteObject(bmp.GetHandle())
    win32gui.ReleaseDC(hwnd, hdc)
    return w, h


def main():
    args = sys.argv[1:]
    resize = None
    if "--resize" in args:
        i = args.index("--resize")
        resize = tuple(int(v) for v in args[i + 1].split("x"))
        del args[i:i + 2]
    pid, out = int(args[0]), args[1]
    for _ in range(40):
        hwnd = top_window(pid)
        if hwnd:
            try:
                if resize:
                    # 屏幕只有 1920 宽：窗口可以比屏幕大，PrintWindow 仍能取到整个窗口画面
                    win32gui.SetWindowPos(hwnd, 0, 0, 0, resize[0], resize[1], 0x0004)  # SWP_NOZORDER
                    time.sleep(1.5)
                w, h = grab(hwnd, out)
                img = Image.open(out)
                img.crop((1, 1, img.width - 1, img.height - 1)).save(out)   # 去掉窗口阴影的 1px 黑边
                print("窗口 0x%X %dx%d → %s" % (hwnd, w, h, out))
                return 0
            except Exception as e:
                print("抓图失败（%s），重试" % e)
        time.sleep(0.5)
    print("未找到进程 %d 的可见窗口" % pid)
    return 1


if __name__ == "__main__":
    sys.exit(main())
