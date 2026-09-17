"""python -m server —— 一条命令把整套应用跑起来。

    python -m server                     # 127.0.0.1 上的固定高位端口，数据在用户目录
    python -m server --open              # 顺手打开系统浏览器
    python -m server --port 8000 --db ./dev.sqlite3

数据文件默认放在用户数据目录（见 paths.default_db_path），
桌面版与命令行版本共用同一个文件 —— 同一份书架，不会各写各的。
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from . import APP_VERSION, paths
from .http_app import PORT_CANDIDATES, AppServer


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='moji', description='墨迹 · 小说抄写工作台（后端 + 前端）')
    parser.add_argument('--port', type=int, default=PORT_CANDIDATES[0],
                        help=f'监听端口（默认 {PORT_CANDIDATES[0]}；被占用会自动顺延）')
    parser.add_argument('--db', default=None, help='SQLite 文件路径（默认在用户数据目录）')
    parser.add_argument('--web', default=None, help='前端资源目录（默认项目里的 web/）')
    parser.add_argument('--open', dest='open_browser', action='store_true', help='启动后打开系统浏览器')
    parser.add_argument('--version', action='version', version=f'Moji {APP_VERSION}')
    args = parser.parse_args(argv)

    server = AppServer(
        root=args.web or paths.web_dir(),
        db_path=args.db or paths.default_db_path(),
        preferred_port=args.port,
    )
    try:
        url = server.start()
    except RuntimeError as error:
        print(f'启动失败：{error}', file=sys.stderr)
        return 1

    print(f'墨迹已启动：{url}')
    print(f'数据文件：{server.store.path}')
    print('按 Ctrl+C 停止')
    if args.open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        # serve_forever 跑在后台线程里，主线程在这里等着，让 Ctrl+C 能正常收场
        threading.Event().wait()
    except KeyboardInterrupt:
        print('\n正在停止…')
    finally:
        server.stop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
