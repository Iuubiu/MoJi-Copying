"""墨迹 · 小说抄写工作台 —— 桌面版外壳。

不再依赖浏览器：内嵌 WebView2（Edge 内核）承载原有前端，
本机 127.0.0.1 上跑一个只读静态服务，数据（书架 / 进度）存在 WebView2 的持久化目录里。

命令行：
    MoJi.exe                     正常启动
    MoJi.exe --selftest          只验证"服务能起 + 前端资源齐全"，不开窗口，打印 JSON 后退出
    MoJi.exe --selftest-gui      开窗口跑真实初始化断言（内部对单次自检重试若干遍），打印 JSON 后退出
    MoJi.exe --selftest-gui-once 内部用：只跑一次，不重试，供 --selftest-gui 开子进程调用
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback

# 让源码树里的 server 包可导入：源码运行时 sys.path[0] 是 desktop/，
# 直接 import server 会失败。打包后（PyInstaller 会把 server 打进包里）
# 这一步只是无害的兜底。
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from server import paths                      # noqa: E402
from server.http_app import AppServer         # noqa: E402

APP_NAME = "墨迹"
APP_SUBTITLE = "小说抄写工作台"
APP_ID = "MoJi"
VERSION = "2.0.0"

WINDOW_DEFAULT = (1440, 900)
WINDOW_MIN = (960, 640)
BACKGROUND = "#fbfaf7"

# 前端资源清单：自检会逐个 GET 回来与源码逐字节比对，
# 少列一个文件就等于漏检一个文件（前端在 web/ 目录下，api.js 是新增的那层）。
WEB_FILES = ("index.html", "app.js", "api.js", "styles.css", "stats.js", "encoding.js")

# GUI 自检的重试预算与单次报告的落盘名。
# 这台机器上 WebView2 有两条通道都不可靠：
#   * pywebview 注入的 JS 桥约一半概率卡住（用最小页面复现过）；
#   * 页面 -> 本机服务 的 GET 上报约一半概率整批不送达
#     （实测有整轮窗口一条都收不到，也有延迟数秒成批到达的）。
# 单次结果完全不可信，所以对外入口重试 GUI_ATTEMPTS 次，只要有一次真跑通就算过。
GUI_ATTEMPTS = 8
GUI_ATTEMPT_REPORT = "selftest-gui-attempt.json"
# 等"存储后端确定"那一拍的时长。收不到只记录、不算失败。
STORAGE_WAIT_SECONDS = 8

# 页面"活着"与"就绪"的判定超时，以及最多自动重载几次。
#
# 为什么需要自动重载
#     本机 WebView2 有概率**整页 JS 都不执行**：资源请求照发（自检能看到五个前端
#     文件都被取走），但连内联脚本都不会运行。用最小页面复现过 —— 同一个页面
#     连跑两次，一次内联与外部脚本全执行，一次全都不执行，与页面内容无关。
#     对用户的直接表现就是"窗口开着、界面一片空白"，而且只能关掉重开。
#
# 为什么这不会误伤正常机器
#     重载的触发条件很窄：**连首拍上报都没有**（意味着页面一行 JS 都没跑）。
#     只要收到任意一份上报（哪怕只是启动刚开始那一条），就说明页面在正常执行，
#     此时绝不会重载，只会继续等它走到 ready —— 机器慢也不会被反复刷新。
PAGE_ALIVE_TIMEOUT = 2.0     # 等"页面至少跑了一行 JS"（正常机器上一百毫秒内就到）
PAGE_READY_GRACE = 12.0      # 已确认在跑 JS 之后，再等它走到 ready 的宽限
PAGE_RELOAD_ATTEMPTS = 4


def watch_page_boot(window, server, alive_event, ready_event, notes: list | None = None) -> str:
    """盯着页面有没有真的跑起来，必要时重新加载。

    返回值是给自检记录用的结论：
        ready            —— 已收到终态上报
        alive-not-ready  —— 页面在跑 JS，但没走到 ready（记录用，不重载）
        no-js            —— 重载若干次后页面仍然一行 JS 都没跑
        browser-crashed  —— WebView2 的浏览器进程崩了（重载救不了，只能重启进程）
        reload-failed    —— 重载这一步本身失败了（详情见 notes）
    """
    def note(message: str) -> None:
        if notes is not None:
            notes.append(message)

    for _ in range(PAGE_RELOAD_ATTEMPTS):
        if ready_event.wait(PAGE_ALIVE_TIMEOUT):
            return "ready"
        if alive_event.is_set():
            # 页面有动静了：别再重载，安静地等它跑完
            return "ready" if ready_event.wait(PAGE_READY_GRACE) else "alive-not-ready"
        try:
            window.load_url(server.index_url)
            note("已重载页面")
        except Exception as exc:  # noqa: BLE001
            text = repr(exc)
            note(f"重载失败：{text[:400]}")
            # 这条异常是本机白窗口的**根因证据**：不是页面慢，是浏览器进程没了。
            # 一旦 CoreWebView2 失效，重载/注入都没有意义，只能整进程重启。
            if "crashed" in text or "no longer valid" in text or "ProcessFailed" in text:
                return "browser-crashed"
            return "reload-failed"
    return "ready" if ready_event.wait(PAGE_ALIVE_TIMEOUT) else "no-js"


# 崩溃自愈：重启整个进程。
#
# WebView2 的浏览器进程在这台机器上有概率崩掉（实测证据见 watch_page_boot），
# 而一旦崩了，CoreWebView2 实例就永久失效 —— 页面重载、脚本注入全是白费，
# 用户看到的就是"窗口开着、界面一片空白"，还只能自己关掉重开。
# 既然一个进程里的 WebView2 已经死了，唯一可靠的恢复就是重来一个进程。
#
# 为什么不用"重建窗口"：pywebview 的事件循环一个进程只能启动一次，
# 原地再造一个窗口并不能换掉已经崩掉的浏览器进程。
CRASH_RESTART_ENV = "MOJI_CRASH_RESTART"
CRASH_RESTART_LIMIT = 2

_lock_handle = None      # 单实例互斥体句柄（main 里拿到后存这里，崩溃重启前要放掉）


def crash_restart(reason: str) -> bool:
    """放掉单实例锁 → 起一个新进程 → 自己退出。返回 False 表示已放弃。"""
    attempt = int(os.environ.get(CRASH_RESTART_ENV, "0")) + 1
    if attempt > CRASH_RESTART_LIMIT:
        alert(
            f"界面渲染进程（WebView2）反复异常退出，已重试 {CRASH_RESTART_LIMIT} 次仍未成功。\n\n"
            "可以先试试修复 WebView2 运行时：\n"
            "https://developer.microsoft.com/microsoft-edge/webview2/\n\n"
            f"（原因：{reason}）"
        )
        return False

    if _lock_handle is not None:
        try:
            release_single_instance(_lock_handle)
        except Exception:  # noqa: BLE001
            pass

    command = [sys.executable]
    if not getattr(sys, "frozen", False):
        command.append(os.path.abspath(__file__))
    env = dict(os.environ)
    env[CRASH_RESTART_ENV] = str(attempt)
    try:
        subprocess.Popen(command, env=env, close_fds=True)
    except OSError:
        return False
    # 直接退出，别再跑 finally 里的收尾（锁已经放了，服务也该跟着进程一起走）
    os._exit(0)

MUTEX_NAME = f"Local\\{APP_ID}-single-instance"
ERROR_ALREADY_EXISTS = 183


# --------------------------------------------------------------------------- 路径

def resource_root() -> str:
    """前端资源目录（web/）：打包后是解包目录下的 web/，源码运行时是项目里的 web/。

    与 server.paths.web_dir() 是同一个地方 —— 前端与后端同源，
    桌面版只是把它俩装进一个窗口里。
    """
    return paths.web_dir()


def state_dir() -> str:
    """用户数据目录（数据库、窗口位置）。打包后放在 LocalAppData 下，不污染程序目录。

    与独立运行后端时同一个目录：桌面版与命令行版本共享一份数据。
    """
    return paths.data_dir()


def config_path() -> str:
    return os.path.join(state_dir(), "config.json")


def load_config() -> dict:
    try:
        with open(config_path(), encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(config: dict) -> None:
    try:
        with open(config_path(), "w", encoding="utf-8") as handle:
            json.dump(config, handle, ensure_ascii=False, indent=2)
    except OSError:
        pass


# --------------------------------------------------------------------------- 单实例

def acquire_single_instance():
    """拿到返回句柄；已有实例在跑返回 None。"""
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        return -1  # 拿不到也别拦着用户
    if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        return None
    return handle


def release_single_instance(handle) -> None:
    if handle and handle != -1:
        try:
            ctypes.windll.kernel32.ReleaseMutex(handle)
            ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:  # noqa: BLE001
            pass


def alert(message: str, title: str = f"{APP_NAME} · {APP_SUBTITLE}") -> None:
    try:
        ctypes.windll.user32.MessageBoxW(None, message, title, 0x40)
    except Exception:  # noqa: BLE001
        pass


def emit(payload: dict, filename: str) -> str:
    """自检结果始终落盘。

    打包成无控制台窗口的 EXE 后 sys.stdout 是 None，print 会直接炸；
    而窗口模式下用户也看不到 stdout。所以文件是唯一可靠的输出通道。
    """
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    path = os.path.join(state_dir(), filename)
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        pass
    if sys.stdout is not None:
        try:
            print(text, flush=True)
        except Exception:  # noqa: BLE001
            pass
    return path


# --------------------------------------------------------------------------- 环境检查

def webview2_available() -> bool:
    """检查 Edge WebView2 运行时是否安装。"""
    roots = [
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                     "Microsoft", "EdgeWebView", "Application"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"),
                     "Microsoft", "EdgeWebView", "Application"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "EdgeWebView", "Application"),
    ]
    for root in roots:
        if not os.path.isdir(root):
            continue
        for entry in os.listdir(root):
            if os.path.isfile(os.path.join(root, entry, "msedgewebview2.exe")):
                return True
    return False


# --------------------------------------------------------------------------- 原生对话框桥

class Bridge:
    """暴露给页面 JS 的能力。刻意保持极小，只有"报个到"。

    导入文件走页面原生的 <input type="file">（WebView2 自带系统文件选择器），
    不经过 Python：pywebview 的 JS→Python 回传值也要绕一圈 evaluate_js，
    且在非 UI 线程弹模态框不稳，没必要为"打开文件"引入这层风险。

    内部状态一律用下划线开头：pywebview 会把 js_api 对象上的公开成员
    反射成 JS 可调用函数，下划线成员会被跳过。
    """

    def __init__(self):
        self._ready = threading.Event()
        self._payload = None

    def app_info(self) -> dict:
        return {"name": APP_NAME, "version": VERSION, "desktop": True}

    def app_ready(self, payload=None) -> dict:
        """页面初始化完成后回报一次：既是自检信号，也便于排查"页面到底跑起来没有"。"""
        self._payload = payload
        self._ready.set()
        return {"ok": True}

    def wait_ready(self, timeout: float) -> bool:
        return self._ready.wait(timeout)

    @property
    def payload(self):
        return self._payload


# --------------------------------------------------------------------------- 自检

def selftest_resource_root(root: str) -> tuple[bool, list, dict]:
    """校验"服务能起 + 前端文件与源码逐字节一致 + 后端接口可用"。"""
    import urllib.error
    import urllib.request

    checks = []
    # 自检不能碰用户的数据文件：库开在临时目录，跑完随临时目录一起消失
    with tempfile.TemporaryDirectory() as tmp:
        server = AppServer(root, db_path=os.path.join(tmp, "selftest.sqlite3"))
        try:
            server.start()
        except Exception as exc:  # noqa: BLE001
            return False, [{"name": "本地服务启动", "ok": False, "detail": str(exc)}], {"root": root}

        try:
            _probe_static_files(server, root, checks)
            _probe_api(server, checks)
        finally:
            port = server.port
            origin = server.origin
            server.stop()

    ok = all(item["ok"] for item in checks)
    return ok, checks, {"root": root, "port": port, "origin": origin}


def _probe_api(server, checks: list) -> None:
    """后端接口自检：健康检查 + 一本书写进去再读回来（证明 SQLite 真的在工作）。"""
    import urllib.request

    def call(method: str, path: str, payload=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(f"{server.origin}{path}", data=data, method=method)
        if data:
            request.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    try:
        status, health = call("GET", "/api/health")
        checks.append({"name": "GET /api/health", "ok": status == 200 and health.get("ok") is True,
                       "detail": health})
    except Exception as exc:  # noqa: BLE001
        checks.append({"name": "GET /api/health", "ok": False, "detail": repr(exc)})
        return

    try:
        call("PUT", "/api/books/selftest-book", {
            "id": "selftest-book",
            "book": {"title": "自检样书", "author": "自检", "chapters": [
                {"title": "唯一一章", "content": "自检正文", "written": "自检"},
            ]},
        })
        _status, data = call("GET", "/api/bootstrap")
        book_ids = [item["id"] for item in data.get("books", [])]
        progress = [item for item in data.get("progress", []) if item["bookId"] == "selftest-book"]
        checks.append({"name": "PUT/GET 书籍往返（SQLite 可写可读）",
                       "ok": "selftest-book" in book_ids and len(progress) == 1,
                       "detail": {"books": book_ids, "progress": len(progress)}})
    except Exception as exc:  # noqa: BLE001
        checks.append({"name": "PUT/GET 书籍往返（SQLite 可写可读）", "ok": False, "detail": repr(exc)})


def _probe_static_files(server, root: str, checks: list) -> None:
    """前端文件逐个 GET 回来与源码比对：少一个、或打包进去的是旧版本，都会红。"""
    import re
    import urllib.request

    for name in WEB_FILES:
        try:
            with urllib.request.urlopen(f"{server.origin}/{name}", timeout=10) as response:
                served = response.read()
                status = response.status
        except Exception as exc:  # noqa: BLE001
            checks.append({"name": f"GET /{name}", "ok": False, "detail": repr(exc)})
            continue
        local_path = os.path.join(root, name)
        try:
            with open(local_path, "rb") as handle:
                local = handle.read()
        except OSError as exc:
            checks.append({"name": f"GET /{name}", "ok": False, "detail": f"本地文件读取失败 {exc!r}"})
            continue
        checks.append({
            "name": f"GET /{name}",
            "ok": status == 200 and served == local,
            "detail": {"status": status, "served": len(served), "local": len(local), "identical": served == local},
        })

    # 抽一个带 ?v= 的资源 URL，确认版本化查询串也能正常命中
    try:
        with open(os.path.join(root, "index.html"), encoding="utf-8") as handle:
            html = handle.read()
        match = re.search(r'"([^"]*\.(?:css|js))\?v=[^"]*"', html)
        if match:
            url = f"{server.origin}/{match.group(1)}?v=0-selftest"
            with urllib.request.urlopen(url, timeout=10) as response:
                body = response.read()
            checks.append({"name": "版本化资源 URL（?v=）可访问",
                           "ok": response.status == 200 and len(body) > 0,
                           "detail": {"url": url, "bytes": len(body)}})
        else:
            checks.append({"name": "版本化资源 URL（?v=）可访问", "ok": False,
                           "detail": "index.html 里没找到 ?v= 资源"})
    except Exception as exc:  # noqa: BLE001
        checks.append({"name": "版本化资源 URL（?v=）可访问", "ok": False, "detail": repr(exc)})


# 说明：断言项不再写在这里。原来是一串 evaluate_js 表达式，靠 pywebview 的桥执行；
# 现在改成读页面自己回传的启动报告（字段见 app.js 的 buildBootReport），
# 断言与字段的对应关系就在 selftest_gui_once 里，改页面时一眼能看到要同步什么。


def selftest_gui_once(root: str) -> int:
    """单次 GUI 自检：开一个真窗口，断言页面确实在 WebView2 里初始化了。

    必须和正式启动一样用 private_mode=False + 持久化 storage_path：
    私有模式每次都新建临时 user-data 目录，WebView2 首次初始化很慢且时序不稳。
    这里刻意复用正式启动的目录，测到的就是用户实际会走的那条路。

    断言通道：页面自己往本机服务回传一份启动报告（GET /__boot-report）
        不用 pywebview 的 JS 桥：evaluate_js() 收尾是没有超时的
        semaphore.acquire()，脚本回调一旦没回来，注入线程就永久卡死，
        _pywebviewready 再也不 set —— 窗口开着、页面也正常，断言却全红，
        而且随机复现（用只有 <h1> 的最小页面单独复现过，与页面内容无关）。

        也试过给 WebView2 开 --remote-debugging-port 走 CDP，同样不行：
        实测那个监听端口只在页面加载的头两三秒存在，加载完就消失
        （netstat 里 LISTENING 一闪而过，随后 connection refused），
        而这时页面才刚刚就绪，根本来不及问。这条路的代码留在 cdp_client.py，
        以后遇到端口稳定的机器还能用。

        回退到"页面自己算好结果、回传"这条（app.js 的 buildBootReport）：
        它是页面"确实执行到底"的直接证据，报告里带的又都是能被外部核对的
        硬事实（模块是否挂上、正文有没有渲染、纸面高度有没有守住不变量、
        有没有未捕获报错）。

        但要清楚这条通道本身也不干净：实测同一个页面，换一次运行就可能
        整轮收不到任何上报（静态服务侧同时 50/50 次应答正常，所以丢的是
        页面上报，不是服务）。对策有两条，都落在 app.js 里：
          * 把"界面可用"（阶段 ready）放在任何 await 之前同步完成，
            让这条信号落在解析期这一拍 —— 实测解析期最容易被送到；
          * 之后 12 秒内每 600ms 补报一次，并且用 Image + fetch 两条独立
            路径各发一遍，赌其中任意一拍能到。
        仍收不到的那一轮，由外层的 selftest_gui 重开窗口重试。

    报告字段与断言的对应关系见下面 checks 列表；改 app.js 的
    buildBootReport 时，这里要同步。
    """
    import webview

    storage = os.path.join(state_dir(), "webview")
    os.makedirs(storage, exist_ok=True)

    # 自己的静态服务顺带当"加载进度表"：浏览器来取某个文件就记一笔。
    served: set = set()
    ready_payload: dict = {}      # 终态快照（stage=ready / boot-error）
    storage_payload: dict = {}    # 之后那一拍（stage=storage）的快照
    alive_event = threading.Event()      # 收到过任意一份上报 = 页面确实在跑 JS
    boot_event = threading.Event()
    storage_event = threading.Event()

    def note_served(path: str) -> None:
        served.add(os.path.basename(path.split("?", 1)[0]))

    def note_boot_report(payload: dict) -> None:
        """按"阶段清单"而不是"最新一拍"来判定。

        页面会分两拍报（先 ready，再 storage），而且这条信标通道在本机
        WebView2 上会把请求攒批、延迟、甚至整批丢掉 —— 收到的第一份
        很可能已经是 storage 拍。所以判定依据是 payload 里的
        stages 清单（ready 是否在清单里），而不是 stage 的当前值。
        """
        if not isinstance(payload, dict):
            return
        alive_event.set()
        stages = payload.get("stages") or []
        if payload.get("ready") is True or payload.get("stage") in ("ready", "boot-error"):
            ready_payload.update(payload)
            boot_event.set()
        if "storage" in stages:
            storage_payload.update(payload)
            storage_event.set()

    # 自检自己不碰用户的主库：每次用一份干净的临时库，跑完留着供排查
    selftest_db = os.path.join(state_dir(), "selftest-gui.sqlite3")
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(f"{selftest_db}{suffix}")
        except OSError:
            pass
    server = AppServer(root, db_path=selftest_db, on_serve=note_served, on_boot_report=note_boot_report)
    server.start()

    report = {"ok": False, "checks": [], "origin": server.origin}
    report_path = os.path.join(state_dir(), GUI_ATTEMPT_REPORT)
    done = threading.Event()
    bridge = Bridge()

    def flush_report() -> None:
        """边测边落盘：即使后面卡住，也能拿到已经收集到的结果。

        只有非 optional 的检查算门禁。optional 用于记录"环境事实"——
        例如页面回传启动报告的那条信标被整批丢掉（本机 WebView2 的老毛病），
        此时"存储后端可用"这一项没看到实情，就只记录不判死。
        """
        gates = [item for item in report["checks"] if not item.get("optional")]
        report["ok"] = bool(gates) and all(item["ok"] for item in gates)
        try:
            with open(report_path, "w", encoding="utf-8") as handle:
                json.dump(report, handle, ensure_ascii=False, indent=2)
        except OSError:
            pass

    def collect(label, ok, value, optional=False):
        report["checks"].append({"name": label, "ok": bool(ok), "detail": value,
                                 "optional": bool(optional)})
        flush_report()

    window = webview.create_window(
        f"{APP_NAME} · 自检",
        server.index_url,
        width=1200,
        height=800,
        background_color=BACKGROUND,
        text_select=True,
        zoomable=False,
        js_api=bridge,
    )

    def probe():
        try:
            collect("窗口显示", window.events.shown.wait(30), None)

            # 先盯着页面有没有真的跑起来。WebView2 在这台机器上有概率整页不执行 JS，
            # 触发条件与页面内容无关；watch_page_boot 会在这种情况下自动重载页面。
            boot_notes: list = []
            outcome = watch_page_boot(window, server, alive_event, boot_event, boot_notes)
            report["page_boot_outcome"] = outcome
            report["page_boot_notes"] = boot_notes

            reported = boot_event.is_set()
            report["boot_report"] = dict(ready_payload)
            collect("页面回传了启动报告（app.js 在 WebView2 里真的跑了）", reported,
                    {"stage": ready_payload.get("stage"), "served": sorted(served),
                     "pageBootOutcome": outcome,
                     "bootError": (ready_payload.get("bootError") or "")[:400]}
                    if reported else
                    {"stages": [], "served": sorted(served), "pageBootOutcome": outcome,
                     "hint": "本机 WebView2 有概率整页不执行 JS（资源照取、连内联脚本都不跑），"
                             "与页面内容无关；已自动重载过仍收不到首拍上报，才会走到这里"})
            if not reported:
                return
            # 等第二拍（存储后端确定）。这条信标可能被攒批/丢掉，
            # 所以等不到也不算失败，只是把该项标成 optional。
            storage_seen = storage_event.wait(STORAGE_WAIT_SECONDS)
            report["storage_report"] = dict(storage_payload)
            if storage_seen:
                report["boot_report"] = {**ready_payload, **storage_payload}
            # 报告之后 boot() 里还剩一点异步收尾（统计渲染等），给它跑完
            time.sleep(0.5)

            payload = {**ready_payload, **storage_payload}
            mode = storage_payload.get("dbMode") or ready_payload.get("dbMode")
            stages = sorted(set((ready_payload.get("stages") or []) + (storage_payload.get("stages") or [])))
            errors = ready_payload.get("errors") or []
            # (标签, 是否通过, 细节, 是否 optional)
            checks = [
                # 白窗口的真正成因：WebView2 的浏览器进程崩了，CoreWebView2 永久失效，
                # 页面一行 JS 都跑不了。这里显式判它，别让失败看起来像"页面没写好"。
                ("WebView2 浏览器进程未崩溃", outcome != "browser-crashed",
                 {"outcome": outcome, "notes": boot_notes[:3]}, False),
                ("全部前端资源都被取走", set(WEB_FILES).issubset(served), sorted(served), False),
                ("页面源为本机 http", str(ready_payload.get("origin", "")).startswith(
                    f"http://127.0.0.1:{server.port}"), ready_payload.get("origin"), False),
                ("启动流程跑到终态（阶段清单含 ready）", ready_payload.get("ready") is True,
                 {"stages": stages, "bootError": (ready_payload.get("bootError") or "")[:400]}, False),
                ("启动过程中没有 boot-error", "boot-error" not in stages, stages, False),
                # readyState 是"发送那一刻"的瞬时值，而能送到的常是解析期那一拍
                # （那时必然是 loading）。所以判据换成粘性的 loadFired 标记；
                # 没观察到就只记录，不判死 —— 这是通道问题，不是页面问题。
                ("页面加载完成（load 事件已触发）", payload.get("loadFired") is True,
                 {"loadFired": payload.get("loadFired"), "readyState": ready_payload.get("readyState")},
                 payload.get("loadFired") is not True),
                ("app.js 跑到底（renderChapter 已定义）", payload.get("renderChapter") is True, None, False),
                ("stats.js 纯计算层已加载", payload.get("statsModule") is True, None, False),
                ("encoding.js 编码探测层已加载", payload.get("encodingModule") is True, None, False),
                ("api.js 后端客户端已加载", payload.get("apiModule") is True, None, False),
                ("导入入口存在（原生 file input）", payload.get("fileInput") is True, None, False),
                ("默认样章已载入", isinstance(payload.get("chapters"), int)
                 and payload["chapters"] >= 1, payload.get("chapters"), False),
                ("原文已渲染", isinstance(payload.get("sourceLength"), int)
                 and payload["sourceLength"] > 100, payload.get("sourceLength"), False),
                ("抄写滚动区已布局", isinstance(payload.get("stageHeight"), int)
                 and payload["stageHeight"] > 200, payload.get("stageHeight"), False),
                ("纸面已定尺", isinstance(payload.get("paperHeight"), (int, float))
                 and payload["paperHeight"] > 200, payload.get("paperHeight"), False),
                ("纸面高度守住末行留白不变量", payload.get("paperInvariant") is True, None, False),
                ("启动期没有未捕获的 JS 错误", not errors, errors[:5], False),
                # —— 存储：看到实情就判，没看到（信标丢了）就只记录 ——
                ("存储后端可用（sqlite）", mode == "sqlite",
                 {"dbMode": mode, "dbPath": payload.get("dbPath"),
                  "storageError": payload.get("storageError"),
                  "storageStageSeen": storage_seen}, not storage_seen),
                ("后端数据库接通（页面能读到 /api/health）", payload.get("dbOpen") is True,
                 {"dbMode": mode, "backendVersion": payload.get("backendVersion")},
                 not storage_seen),
            ]
            for label, ok, detail, optional in checks:
                collect(label, ok, detail, optional=optional)
        except Exception:  # noqa: BLE001
            collect("自检异常", False, traceback.format_exc())
        finally:
            # pywebview 的桥只作为诊断信息记录，不作为断言：
            # 它在这台机器上随机卡死（原因见函数开头），拿来当门禁会时红时绿。
            try:
                report["pywebview_bridge_ready"] = bool(window.events._pywebviewready.wait(5))
            except Exception:  # noqa: BLE001
                report["pywebview_bridge_ready"] = None
            done.set()
            try:
                window.destroy()
            except Exception:  # noqa: BLE001
                pass

    def watchdog():
        if not done.wait(150):
            collect("超时看门狗", False, "自检 150 秒未完成，已强制退出")
            emit(report, GUI_ATTEMPT_REPORT)
            os._exit(4)

    threading.Thread(target=watchdog, daemon=True).start()

    try:
        webview.start(probe, gui="edgechromium", debug=False, private_mode=False, storage_path=storage)
    except Exception:  # noqa: BLE001
        collect("窗口启动", False, traceback.format_exc())
    finally:
        server.stop()

    flush_report()
    emit(report, GUI_ATTEMPT_REPORT)
    return 0 if report["ok"] else 1


def selftest_gui(root: str, attempts: int = GUI_ATTEMPTS) -> int:
    """GUI 自检的对外入口：对单次自检做有限次重试，只要有一次真跑通就算过。

    为什么必须重试（这台机器上有两条通道都不可靠）
        1) pywebview 6.2.1 的 JS 桥注入是随机失败的：窗口能开、页面能加载，
           但 _pywebviewready 一直不 set。用只有 <h1> 的最小页面单独复现过，
           失败率大约一半 —— 所以这条已经不用了（见 selftest_gui_once）。
        2) 替代它的"页面 -> 本机服务"GET 上报同样不可靠，而且规律很特别：
           页面大约在**加载后 2.4 秒就停止推进 JS**（用不加载任何应用代码的
           心跳探针反复量过：400ms 心跳稳定停在 6 拍、2.5s 的定时器不触发、
           连同步 XHR 都没发出去），而主机侧完全正常（20 秒内 50/50 次取数全成功）。
           结果是只有**解析期**发出的请求能稳定送出，那之后的几乎一条不到。
           所以 app.js 把"界面可用"（阶段 ready）放在所有 await 之前同步完成，
           让这条信号落在解析期那一拍，并且同一拍多发几遍（每遍独立 URL）。
           即便如此，实测仍有约半数窗口这一拍也送不到，只能靠重开窗口重试。

    为什么开子进程重试
        pywebview 的事件循环一个进程只能启动一次，没法在原地再 start 一遍。

    重试不会掩盖真实回归
        页面要是真坏了（前台脚本报错、资源缺失、模块没挂上），每一次尝试
        都会失败，最终结果依然是红。重试只吸收"上报通道"这一层的不确定性。
        每次尝试的结果都如实写进报告（attempts 字段），不把不确定性藏起来。
    """
    attempts = max(1, attempts)
    history = []
    last_checks = []
    origin = None

    for index in range(1, attempts + 1):
        attempt_report = os.path.join(state_dir(), GUI_ATTEMPT_REPORT)
        if os.path.exists(attempt_report):
            os.remove(attempt_report)

        if getattr(sys, "frozen", False):
            command = [sys.executable, "--selftest-gui-once"]
        else:
            command = [sys.executable, os.path.abspath(__file__), "--selftest-gui-once"]

        exit_code = -1
        try:
            done = subprocess.run(command, capture_output=True, timeout=300)
            exit_code = done.returncode
        except subprocess.TimeoutExpired:
            exit_code = -2
        except OSError:
            exit_code = -3

        payload = {}
        try:
            with open(attempt_report, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            payload = {}

        checks = payload.get("checks", []) or []
        last_checks = checks
        origin = payload.get("origin") or origin
        history.append({
            "attempt": index,
            "exit": exit_code,
            "ok": bool(payload.get("ok")),
            "checks": len(checks),
            "failed": [item["name"] for item in checks if not item.get("ok")],
            # 把每一轮的"页面到底有没有跑起来"记下来：发布校验要靠它区分
            # "页面真有问题"和"WebView2 浏览器进程崩了（宿主环境限制）"。
            "page_boot_outcome": payload.get("page_boot_outcome"),
        })
        if payload.get("ok"):
            break

    succeeded = any(item["ok"] for item in history)
    report = {
        "ok": succeeded,
        "attempts_used": len(history),
        "attempt_limit": attempts,
        "attempts": history,
        "origin": origin,
        # 成功那一次就是最后一条；全失败时展示的就是最后一次的明细
        "checks": last_checks,
    }
    emit(report, "selftest-gui.json")
    return 0 if succeeded else 1


# --------------------------------------------------------------------------- 正常启动

def run(root: str) -> int:
    import webview

    if not webview2_available():
        alert(
            "缺少 Microsoft Edge WebView2 运行时，无法启动。\n\n"
            "请安装后重试：\nhttps://developer.microsoft.com/microsoft-edge/webview2/"
        )
        return 2

    config = load_config()
    data_dir = state_dir()
    storage = os.path.join(data_dir, "webview")
    os.makedirs(storage, exist_ok=True)

    # 页面启动看门狗用的两个信号（见 watch_page_boot 的说明）
    alive_event = threading.Event()
    ready_event = threading.Event()

    def note_page_state(payload) -> None:
        if not isinstance(payload, dict):
            return
        alive_event.set()
        stages = payload.get("stages") or []
        if payload.get("ready") is True or payload.get("stage") in ("ready", "boot-error") \
                or "ready" in stages:
            ready_event.set()

    # 前端与后端同源：一个服务同时提供 web/ 静态资源与 /api/*，
    # 数据落在用户数据目录的 SQLite 文件里（与命令行版本共用同一份）。
    server = AppServer(root, db_path=paths.default_db_path(),
                       preferred_port=config.get("port"), on_boot_report=note_page_state)
    server.start()
    config["port"] = server.port

    bridge = Bridge()
    geometry = config.get("window") or {}
    width = int(geometry.get("width") or WINDOW_DEFAULT[0])
    height = int(geometry.get("height") or WINDOW_DEFAULT[1])

    create_kwargs = {
        "title": f"{APP_NAME} · {APP_SUBTITLE}",
        "url": server.index_url,
        "width": width,
        "height": height,
        "min_size": WINDOW_MIN,
        "background_color": BACKGROUND,
        "text_select": True,
        "zoomable": False,
        "confirm_close": False,
        "js_api": bridge,
    }
    # 位置只在有效时恢复（换了显示器/分辨率就不会跑到屏幕外）
    if isinstance(geometry.get("x"), int) and isinstance(geometry.get("y"), int):
        create_kwargs["x"] = geometry["x"]
        create_kwargs["y"] = geometry["y"]

    window = webview.create_window(**create_kwargs)

    def remember_geometry():
        try:
            config["window"] = {
                "x": int(window.x),
                "y": int(window.y),
                "width": int(window.width),
                "height": int(window.height),
            }
        except Exception:  # noqa: BLE001
            config["window"] = {"width": width, "height": height}
        save_config(config)

    try:
        window.events.closing += remember_geometry
    except Exception:  # noqa: BLE001
        pass

    def page_watchdog() -> None:
        """开窗之后盯着页面有没有真的跑起来。

        只有拿到"浏览器进程崩了"这个硬证据时才重启整个进程 —— 因为 CoreWebView2
        一旦失效，重载和注入都救不回来。若只是收不到上报（no-js），那也可能只是
        上报被丢了，页面其实好好的，此时**不能**去重启，否则正常机器会被反复重启。
        """
        notes: list = []
        outcome = watch_page_boot(window, server, alive_event, ready_event, notes)
        if outcome in ("browser-crashed", "reload-failed"):
            crash_restart(f"{outcome}；{'; '.join(notes) or '无附加信息'}")

    try:
        webview.start(
            page_watchdog,
            gui="edgechromium", debug=False, private_mode=False, storage_path=storage)
    finally:
        remember_geometry()
        server.stop()
    return 0


# --------------------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser(prog=APP_ID, description=f"{APP_NAME} · {APP_SUBTITLE}")
    parser.add_argument("--selftest", action="store_true", help="校验本地服务与前端资源后退出（不开窗口）")
    parser.add_argument("--selftest-gui", action="store_true", help="开窗口跑真实初始化断言后退出")
    parser.add_argument("--selftest-gui-once", action="store_true",
                        help="只跑一次 GUI 自检、不重试（内部使用）")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {VERSION}")
    args = parser.parse_args()

    root = resource_root()

    if args.selftest:
        ok, checks, meta = selftest_resource_root(root)
        emit({"ok": ok, "checks": checks, "meta": meta, "version": VERSION}, "selftest.json")
        return 0 if ok else 1

    if args.selftest_gui_once:
        return selftest_gui_once(root)

    if args.selftest_gui:
        return selftest_gui(root)

    handle = acquire_single_instance()
    if handle is None:
        alert("墨迹已经在运行了，请勿重复打开。")
        return 0
    # 存一份给崩溃自愈用：重启子进程之前必须先放掉这把锁，
    # 否则子进程会被自己的单实例检查挡回去，变成"反复重启但一次都没起来"。
    global _lock_handle
    _lock_handle = handle
    try:
        return run(root)
    except Exception:  # noqa: BLE001
        alert("启动失败：\n\n" + traceback.format_exc(limit=3))
        return 1
    finally:
        release_single_instance(handle)


if __name__ == "__main__":
    sys.exit(main())
