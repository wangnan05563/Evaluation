# -*- mode: python ; coding: utf-8 -*-
import os
# SPECPATH 由 PyInstaller 注入 = 本 spec 所在目录（= 仓库根）。
# 原先写相对路径 + 依赖调用方 CWD，从别的目录执行 pyinstaller 会找不到源文件。
ROOT = os.path.abspath(SPECPATH)
ICON = os.path.join(ROOT, "assets", "we_icon.ico")
# PyInstaller spec：将本地服务打包为单文件 exe（自包含 python + 依赖 + 前端 + 母版）。
# 用法：pyinstaller 工作量评估工具.spec --distpath release\exe --workpath release\build --noconfirm
# 产物：release\exe\工作量评估工具.exe（双击即启动引擎并自动打开浏览器）
a = Analysis(
    [os.path.join(ROOT, 'scripts', 'server.py')],
    pathex=[os.path.join(ROOT, 'scripts')],
    binaries=[],
    # 前端 + 母版 + 界面文案字典作为只读资源打入；运行时 server 从 _MEIPASS 读取。
    # data/i18n 必须收进datas：server 的 _i18n_seed() 从 _RES 播种字典到 %APPDATA%，
    # 不收则安装版首次启动读不到字典，前端静默回退中文（翻译功能整体失效且不易察觉）。
    # 识别规则表与费率基准同理：server 启动时从 _RES/data 播种到 %APPDATA%
    # （server.py L195/L210），不收则全新安装无副本，识别回退内置链、费率页降级。
    datas=[(os.path.join(ROOT, 'frontend'), 'frontend'),
           (os.path.join(ROOT, 'tpl'), 'tpl'),
           (os.path.join(ROOT, 'data', 'i18n'), 'data/i18n'),
           (os.path.join(ROOT, 'data', 'recognition_rules.json'), 'data'),
           (os.path.join(ROOT, 'data', 'rates_versions.json'), 'data')],
    hiddenimports=['engine', 'generate_xlsx', 'replay_recognize', 'numpy'],
    hookspath=[],
    runtime_hooks=[],
    # 运行侧只用 numpy/openpyxl/python-docx/Pillow/PyMuPDF/win32com；开发机额外安装的
    # 训练/视觉/数据科学大包会被模块图连带扫入，分析 20 分钟仍未收敛且产物被撑大。
    # 显式排除这些未被任何脚本 import 的可选依赖，保持单文件 sidecar 的体积与构建时长稳定。
    excludes=['tensorflow', 'keras', 'onnxruntime', 'cv2', 'pandas',
              'matplotlib', 'scipy', 'sklearn', 'torch', 'pytest',
              'IPython', 'jupyter', 'notebook'],
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