"""墨迹 · 本地 HTTP 服务：同一个端口上提供前端静态资源与 REST API。

为什么静态资源与 API 同源
    桌面版只起一个服务、只有一个源，浏览器不用处理跨域与 Cookie 的边界；
    用户看到的地址就是 http://127.0.0.1:<port>/index.html，前端 fetch('/api/...')
    天然落在同一个服务上。这一点在本项目里还有历史原因：WebView2 下
    file:// 是不透明源，IndexedDB / localStorage 全都不可靠。

为什么又允许"本机跨源"
    前后端分离的开发方式是前端跑在 5173、后端跑在 8000。只要来源是本机
    （127.0.0.1 / localhost / ::1）就放行，让这种跑法可用；外部域名一律
    不发 CORS 头 —— 本地数据库不能让随便一个网页读走。

/__boot-report 端点
    桌面自检不能依赖 pywebview 注入的 JS 桥（那玩意在这台机器上会随机卡死），
    所以页面把"我初始化完了"的自报结果用 GET 发回来，存在内存里供自检读取。
    用 GET 是为了让页面能用 `new Image().src` 这种最原始的方式发出去。
"""

from __future__ import annotations

import http.server
import json
import os
import socket
import threading
import traceback
import urllib.parse
from functools import partial

from . import api, paths
from .store import MojiStore

BOOT_REPORT_PATH = '/__boot-report'
API_PREFIX = '/api/'

# 优先复用上次成功的端口，其次按顺序尝试这些（都挑不常用的高位端口）。
# 端口参与源（协议+主机+端口），固定端口能避免"换了源 = 换了浏览器存储"的错觉。
PORT_CANDIDATES = (47299, 47289, 47279, 47269, 47259, 47249)

_LOCAL_HOSTS = {'127.0.0.1', 'localhost', '::1', '[::1]'}


def port_is_free(port: int, host: str = '127.0.0.1') -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


class _Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'MoJi/0.1'

    def log_message(self, *_args):  # 访问日志静音；错误仍会走 stderr
        pass

    # ── 公共 ────────────────────────────────────────────────────────────

    def _host_ok(self) -> bool:
        """只服务本机来源。

        没有这道校验，局域网里任何一台机器都能读写用户的书架与进度；
        DNS rebinding 也能让外部网页借浏览器之手摸到本机服务。
        """
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]')
        if host in _LOCAL_HOSTS:
            return True
        self._send_json(403, {'error': '只接受本机请求'})
        return False

    def _cors_headers(self) -> None:
        origin = self.headers.get('Origin')
        if not origin or not self._origin_is_local(origin):
            return
        self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Vary', 'Origin')

    @staticmethod
    def _origin_is_local(origin: str) -> bool:
        parsed = urllib.parse.urlparse(origin)
        return parsed.hostname in ('127.0.0.1', 'localhost', '::1')

    def end_headers(self):
        # 桌面端不吃浏览器缓存那一套：永远拿最新文件，避免改了前端却看到旧页面
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    # ── API ─────────────────────────────────────────────────────────────

    def _handle_api(self, method: str) -> None:
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        # 原样传 self.path（含查询串）：/api/import?mode=overwrite 的 mode 就靠它
        try:
            status, payload = api.handle(self.server.store, method, self.path, raw)
        except api.ApiError as error:
            self._send_json(error.status, {'error': error.message})
        except Exception:  # noqa: BLE001
            # 后端内部错误必须留在服务端日志里：只回一句"服务器错误"会让人无从下手
            traceback.print_exc()
            self._send_json(500, {'error': '服务器内部错误，详情见服务端日志'})
        else:
            self._send_json(status, payload)

    def do_GET(self):  # noqa: N802  （http.server 的命名约定）
        if not self._host_ok():
            return
        path, _, query = self.path.partition('?')
        if self.path.startswith(API_PREFIX):
            self._handle_api('GET')
            return
        if path == BOOT_REPORT_PATH:
            self._handle_boot_report(query)
            return
        super().do_GET()

    def do_HEAD(self):  # noqa: N802
        if not self._host_ok():
            return
        super().do_HEAD()

    def do_PUT(self):  # noqa: N802
        if not self._host_ok():
            return
        self._handle_api('PUT')

    def do_POST(self):  # noqa: N802
        if not self._host_ok():
            return
        self._handle_api('POST')

    def do_DELETE(self):  # noqa: N802
        if not self._host_ok():
            return
        self._handle_api('DELETE')

    def _method_not_allowed(self) -> None:
        """未实现的 HTTP 方法也回 JSON —— http.server 默认会吐一个 HTML 错误页，
        前端拿到手只能当"解析失败"，看不出到底发生了什么。"""
        if not self._host_ok():
            return
        self._send_json(405, {'error': f'{self.command} 不被支持，可用：GET, POST, PUT, DELETE'})

    do_PATCH = _method_not_allowed
    do_TRACE = _method_not_allowed

    def do_OPTIONS(self):  # noqa: N802
        if not self._host_ok():
            return
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self._cors_headers()
        self.end_headers()

    # ── 自检通道 ─────────────────────────────────────────────────────────

    def send_head(self):
        """成功返回文件时回调一次（自检靠它判断"页面资源已经真的被加载"）。

        浏览器把 app.js 取走，就说明 HTML 已经解析到最后一个 script 标签了。
        只在上限 200 的分支里回调 —— send_head 返回 None 意味着 404/重定向。
        """
        result = super().send_head()
        hook = getattr(self.server, 'on_serve', None)
        if hook is not None and result is not None:
            try:
                hook(self.path)
            except Exception:  # noqa: BLE001
                pass
        return result

    def _handle_boot_report(self, query: str) -> None:
        params = urllib.parse.parse_qs(query)
        raw = (params.get('d') or [''])[0]
        payload = {}
        if raw:
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = {'unparsed': raw[:300]}
        hook = getattr(self.server, 'on_boot_report', None)
        if hook is not None:
            try:
                hook(payload)
            except Exception:  # noqa: BLE001
                pass
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class AppServer:
    """把前端（root 目录）+ 后端（SQLite）挂在 127.0.0.1 的同一个端口上。"""

    def __init__(self, root: str, db_path: str | None = None, preferred_port: int | None = None,
                 on_serve=None, on_boot_report=None):
        self.root = root
        self.db_path = db_path or paths.default_db_path()
        self.preferred_port = preferred_port
        self.on_serve = on_serve
        self.on_boot_report = on_boot_report
        self.store = MojiStore(self.db_path)
        self._httpd = None
        self._thread = None

    @property
    def port(self) -> int:
        if self._httpd is None:
            raise RuntimeError('server 尚未启动')
        return self._httpd.server_address[1]

    @property
    def origin(self) -> str:
        return f'http://127.0.0.1:{self.port}'

    @property
    def index_url(self) -> str:
        return f'{self.origin}/index.html'

    def _candidate_ports(self):
        # preferred_port=0 也是有效输入（让系统分配），所以判断的是 None 而不是真假
        if self.preferred_port is not None:
            yield self.preferred_port
        for port in PORT_CANDIDATES:
            if port != self.preferred_port:
                yield port
        # 最后退回让系统分配：宁可换了源，也不能起不来
        yield 0

    def start(self) -> str:
        if not os.path.isfile(os.path.join(self.root, 'index.html')):
            raise RuntimeError(f'前端目录里没有 index.html：{self.root}')
        handler = partial(_Handler, directory=self.root)
        last_error = None
        for port in self._candidate_ports():
            try:
                self._httpd = _Server(('127.0.0.1', port), handler)
                self._httpd.store = self.store
                self._httpd.on_serve = self.on_serve
                self._httpd.on_boot_report = self.on_boot_report
                break
            except OSError as exc:  # 端口被占
                last_error = exc
                self._httpd = None
        if self._httpd is None:
            raise RuntimeError(f'无法在本地端口上启动服务: {last_error}')
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True, name='moji-http')
        self._thread.start()
        return self.index_url

    def stop(self) -> None:
        if self._httpd is not None:
            try:
                self._httpd.shutdown()
            except Exception:  # noqa: BLE001
                pass
            try:
                self._httpd.server_close()
            except Exception:  # noqa: BLE001
                pass
            self._httpd = None
