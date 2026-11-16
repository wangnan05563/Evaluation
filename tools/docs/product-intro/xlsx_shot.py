# -*- coding: utf-8 -*-
"""成品 xlsx 截图：Excel 打开真实生成件 → 区域按矢量复制进图表 → 导出 PNG。
本机未装打印机，ExportAsFixedFormat 不可用，故走 CopyPicture + Chart.Export。
两个坑：Chart.Export 按图表对象的磅尺寸出图，故先把对象放大 SCALE 倍再让粘贴的
矢量图铺满；跨工作表连续截图时第二个 sheet 的剪贴板会失效，故每张图带重试与清理。
不写死外部输入：xlsx 路径由调用方传入（默认 release/tmp/_shot_v1.xlsx，由 shots.mjs 生成）。
用法：python tools/docs/product-intro/xlsx_shot.py [成品.xlsx]
"""
import os
import sys
import time

import win32com.client

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
XLSX = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "release", "tmp", "_shot_v1.xlsx"))
OUT = os.path.join(ROOT, "release", "shots")
SCALE = 4            # 导出倍率：成图像素 ≈ 区域磅宽 × 96/72 × SCALE
# 规模估算：1-3 行汇总块 + 5 行表头 + 6-14 行明细；其余行是预格式化的空白行，不入镜
TARGETS = ((2, "规模估算", "A1:N14"), (3, "费用估算", "A1:J32"))


def capture(ws, addr, png, tries=4):
    for attempt in range(1, tries + 1):
        co = None
        try:
            ws.Activate()
            time.sleep(0.2)
            ws.Range("A1").Select()
            rng = ws.Range(addr)
            rng.CopyPicture(1, -4147)          # xlScreen, xlPicture(EMF 矢量)
            time.sleep(0.3)
            w, h = rng.Width * SCALE, rng.Height * SCALE
            co = ws.ChartObjects().Add(0, 0, w, h)
            co.Activate()
            ch = co.Chart
            ch.Paste()
            if ch.Shapes.Count == 0:
                raise RuntimeError("粘贴后图表内无形状")
            sh = ch.Shapes(1)
            sh.LockAspectRatio = 0
            sh.Left, sh.Top, sh.Width, sh.Height = 0, 0, w, h
            ch.Export(png, "PNG")
            return w, h
        except Exception as e:
            if attempt == tries:
                raise
            print("  第 %d 次失败（%s），重试" % (attempt, e))
            time.sleep(0.8)
        finally:
            if co is not None:
                try:
                    co.Delete()
                except Exception:
                    pass


app = win32com.client.DispatchEx("Excel.Application")
app.Visible = True                 # 不可见窗口下 CopyPicture(xlScreen) 取不到内容
app.DisplayAlerts = False
app.WindowState = -4143            # xlNormal
app.Left, app.Top = -2400, 0       # 挪到主屏外，别闪到用户
app.Width, app.Height = 1400, 900
try:
    wb = app.Workbooks.Open(XLSX, ReadOnly=False, UpdateLinks=0)
    for idx, name, addr in TARGETS:
        ws = wb.Worksheets(idx)
        png = os.path.join(OUT, "xlsx_%s.png" % ("scale" if idx == 2 else "fee"))
        w, h = capture(ws, addr, png)
        print("%s: %s  chart=%.0fx%.0fpt  -> %d bytes"
              % (name, addr, w, h, os.path.getsize(png)))
    wb.Close(False)
finally:
    app.Quit()
