# -*- mode: python ; coding: utf-8 -*-
"""墨迹 · 小说抄写工作台 —— 桌面版打包配置（目录模式、无控制台窗口）。

    cd desktop
    "C:/Users/Yhwhy/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
        -m PyInstaller MoJi.spec --noconfirm \
        --distpath "../outputs/Windows" --workpath build

产出 outputs/Windows/MoJi/（MoJi.exe + _internal/），
再由 make_release.py 连同「使用说明.md」打成发布 zip。

（上面那条 python 路径是本机打包环境：PyInstaller 6.22.3 + pywebview，Python 3.13；
   项目的开发/运行用的是另一套 Python，两边互不影响。）

前端资源直接引用项目根目录的那一份（不复制、不生成第二份），
避免出现"改了源码但打进包里的还是旧文件"。
清单必须与 app.py 的 WEB_FILES 一致：这里少一个，包里就是缺一个，
自检里那个 GET /xxx 会直接红掉。
"""

block_cipher = None

datas = [
    ('../web/index.html', 'web'),
    ('../web/app.js', 'web'),
    ('../web/api.js', 'web'),
    ('../web/styles.css', 'web'),
    ('../web/stats.js', 'web'),
    ('../web/encoding.js', 'web'),
    ('../web/manifest.webmanifest', 'web'),
    ('../web/sw.js', 'web'),
    ('../web/icon-192.png', 'web'),
    ('../web/icon-512.png', 'web'),
    # 注意：不含 "使用说明.md"。
    # 单文件 EXE 的 datas 会被解到临时目录，用户根本看不到 ——
    # 放进包里等于把说明书藏起来。它改由发布包**放在 exe 旁边**（见打包脚本）。
]

a = Analysis(
    ['app.py'],
    # '..' 是项目根：server 包在那里（app.py 里 sys.path 的那一手是给源码运行用的，
    # 静态分析不会执行它，所以必须在这里也把根目录告诉 PyInstaller）。
    pathex=['.', '..'],
    binaries=[],
    datas=datas,
    # pywebview 的平台后端是运行时动态导入的，静态分析看不见，必须显式声明
    hiddenimports=[
        'webview.platforms.winforms',
        'webview.platforms.edgechromium',
        'clr_loader',
        'pythonnet',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'PyQt5', 'PyQt6', 'PySide2', 'PySide6',
        'numpy', 'PIL', 'pytest',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,          # 目录模式：依赖不进 exe，放在 _internal/ 里
    name='MoJi',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    icon='MoJi.ico',
    version=None,
)

# 目录模式（onedir）而不是单文件：单文件每次启动都要把自己解压到临时目录，
# 冷启动要好几秒，杀软也更容易盯上；目录模式启动快得多，代价是产物是一个文件夹。
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='MoJi',
)
