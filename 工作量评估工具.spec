# -*- mode: python ; coding: utf-8 -*-
import os
ICON = os.path.abspath(os.path.join("assets", "we_icon.ico"))
# PyInstaller spec：将本地服务打包为单文件 exe（自包含 python + 依赖 + 前端 + 母版）。
# 用法：pyinstaller 工作量评估工具.spec --distpath dist\exe --workpath build --noconfirm
# 产物：dist\exe\工作量评估工具.exe（双击即启动引擎并自动打开浏览器）
a = Analysis(
    ['scripts/server.py'],
    pathex=['scripts'],
    binaries=[],
    # 前端 + 母版 + 界面文案字典作为只读资源打入；运行时 server 从 _MEIPASS 读取。
    # data/i18n 必须收进datas：server 的 _i18n_seed() 从 _RES 播种字典到 %APPDATA%，
    # 不收则安装版首次启动读不到字典，前端静默回退中文（翻译功能整体失效且不易察觉）。
    # 注：data/recognition_rules.json 与 rates_versions.json 至今未收入 datas，
    # 冻结态下依赖 %APPDATA% 已有副本；属既有遗留，非本次引入。
    datas=[('frontend', 'frontend'), ('tpl', 'tpl'), ('data/i18n', 'data/i18n')],
    hiddenimports=['engine', 'generate_xlsx', 'replay_recognize'],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name='工作量评估工具',
    debug=False,
    strip=False,
    upx=True,
    console=True,
    icon=ICON,
)