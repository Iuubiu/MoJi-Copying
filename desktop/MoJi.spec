# -*- mode: python ; coding: utf-8 -*-
"""墨迹 · 小说抄写工作台 —— 桌面版打包配置（单文件、无控制台窗口）。

    cd desktop
    "C:/Users/Yhwhy/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
        -m PyInstaller MoJi.spec --noconfirm \
        --distpath "../outputs/Windows" --workpath build

（这个 spec 里的 .venv 路径是早期写法，本机实际用的是上面的受管环境；
   PyInstaller 6.22.3 + pywebview，Python 3.13）

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
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
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
