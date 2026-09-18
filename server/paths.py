"""墨迹 · 路径约定（数据放哪、前端放哪）。集中在一处，桌面外壳与独立后端共用。"""

from __future__ import annotations

import os
import sys

APP_ID = 'MoJi'


def data_dir() -> str:
    """用户数据目录。

    Windows 用 %LOCALAPPDATA%\\MoJi，其它平台用 ~/.local/share/moji。
    桌面版与独立运行的后端默认共享同一个目录 —— 同一份数据，
    不会出现"桌面版里写的，命令行版本看不到"。
    用 MOJI_DATA_DIR 可以整体挪走（测试与多档案都用它）。
    """
    override = os.environ.get('MOJI_DATA_DIR')
    if override:
        os.makedirs(override, exist_ok=True)
        return override
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
        path = os.path.join(base, APP_ID)
    else:
        base = os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share')
        path = os.path.join(base, APP_ID.lower())
    os.makedirs(path, exist_ok=True)
    return path


def default_db_path() -> str:
    return os.path.join(data_dir(), 'moji.sqlite3')


def project_root() -> str:
    """源码树的根目录（server/ 的上一级）。"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def web_dir() -> str:
    """前端资源目录。

    优先用 Vite 的构建产物 `dist/` —— 前后端分离后前端只有这一份，
    桌面版（Tauri）与浏览器模式（这个 Python 后端）读的是同一套页面。
    还没构建过就回退到 `web/`（无需构建的那份），保证 `python -m server`
    在没跑过 npm 的机器上也能开起来。
    """
    if getattr(sys, 'frozen', False):
        base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
        return os.path.join(base, 'web')
    root = project_root()
    built = os.path.join(root, 'dist')
    if os.path.isfile(os.path.join(built, 'index.html')):
        return built
    return os.path.join(root, 'web')
