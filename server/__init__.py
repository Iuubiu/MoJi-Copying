"""墨迹 · 后端（Python 标准库：HTTP + SQLite，无第三方依赖）。

对外只有两个入口：
    python -m server              起本地服务（前端 + API 同端口）
    server.http_app.AppServer     供桌面外壳（pywebview）复用
"""

from .api import APP_VERSION
from .http_app import AppServer
from .store import MojiStore

__all__ = ['APP_VERSION', 'AppServer', 'MojiStore']
