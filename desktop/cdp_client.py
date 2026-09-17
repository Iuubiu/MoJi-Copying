"""极简 CDP 客户端（只用标准库）。

为什么需要它
    GUI 自检要在"真实的 WebView2 窗口"里断言页面确实初始化了。
    原本靠 pywebview 自带的 JS 桥（window.events._pywebviewready），
    但那条桥在本机不可靠，而且失败方式很隐蔽：

        pywebview/platforms/edgechromium.py 里 evaluate_js() 收尾是
            semaphore.acquire()          # ← 没有超时
        一旦 ExecuteScriptAsync 的续延（ContinueWith）没能跑起来，
        这个 acquire() 就永久阻塞，注入线程再也回不来，
        _pywebviewready 永远不会 set。窗口开着、页面也正常，就是"桥起不来"。
        用只有 <h1> 的最小页面单独复现过：同一份代码时而通过、时而卡死，
        和页面内容无关（把 js/css 全摘掉的 index.html 一样会卡）。

    所以自检改走 WebView2 自带的 --remote-debugging-port，
    直接发 CDP 命令拿页面状态。这条链路不依赖 pywebview 的桥，
    结果是确定的，而且还能顺手抓到启动期的控制台报错。

为什么手写 WebSocket 而不是装库
    发布物是单文件 EXE，能不加依赖就不加。CDP 只需要一条
    文本 WebSocket 通道 + 两个 JSON 命令，标准库里够用。

只实现用得到的部分：文本帧、分片合并、ping/pong、Runtime/Page 两条命令。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import urllib.request
from urllib.parse import urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA


class CdpError(RuntimeError):
    """CDP 通道层面的错误（握手失败、连接断开、命令报错）。"""


def _loopback_opener():
    """专门用于回环地址的 opener：显式清空代理。

    这个不能省。本机设了 HTTP_PROXY/HTTPS_PROXY（指向一个本地代理），
    而 urllib 的 proxy_bypass('127.0.0.1') 返回的是 False —— 于是对
    WebView2 调试端口的请求会被发到代理上，代理回一个 502 Bad Gateway。
    现象看起来像"调试端点坏了/时好时坏"，其实是请求压根没走到 127.0.0.1。
    所以凡是对 127.0.0.1 的请求，一律用这个空代理 opener。
    """
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_json(url: str, timeout: float = 5.0):
    """CDP 的 HTTP 发现接口（/json/version、/json/list）返回的是 JSON。"""
    with _loopback_opener().open(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def find_page_target(port: int, url_part: str, timeout: float = 40.0, interval: float = 0.5):
    """等 WebView2 把调试端口和页面目标准备好，返回该目标的 webSocketDebuggerUrl。

    页面还没导航完成时 /json/list 可能是空的或只有 about:blank，所以要轮询。
    """
    import time as _time

    deadline = _time.monotonic() + timeout
    last = None
    while _time.monotonic() < deadline:
        try:
            targets = http_json(f"http://127.0.0.1:{port}/json/list")
        except Exception as exc:  # noqa: BLE001
            last = repr(exc)
            _time.sleep(interval)
            continue
        pages = [t for t in targets if t.get("type") == "page"]
        for target in pages:
            if url_part in (target.get("url") or ""):
                return target.get("webSocketDebuggerUrl")
        last = f"共有 {len(pages)} 个 page 目标，但都不是 {url_part}"
        _time.sleep(interval)
    raise CdpError(f"等不到页面目标（{url_part}）：{last}")


class CdpSession:
    """一条到页面的 CDP 连接。"""

    def __init__(self, ws_url: str, timeout: float = 20.0):
        parsed = urlparse(ws_url)
        if parsed.scheme != "ws":
            raise CdpError(f"只支持 ws:// 的调试地址，拿到的是 {ws_url!r}")
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80
        self.path = parsed.path or "/"
        if parsed.query:
            self.path += f"?{parsed.query}"
        self._timeout = timeout
        self._buffer = b""
        self._next_id = 0
        self.events: list = []
        self._sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self._handshake()

    # ------------------------------------------------------------------ 握手

    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(request.encode("ascii"))

        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise CdpError("WebSocket 握手失败：连接被提前关闭")
            raw += chunk
        head, _, rest = raw.partition(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0].decode("utf-8", "replace")
        if "101" not in status:
            raise CdpError(f"WebSocket 握手失败：{status}")

        expected = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode()
        if expected.lower().encode("ascii") not in head.lower():
            raise CdpError("WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）")
        # 握手响应之后可能已经跟着帧数据，不能丢
        self._buffer = rest

    # ------------------------------------------------------------------ 帧收发

    def _read_exact(self, count: int) -> bytes:
        while len(self._buffer) < count:
            try:
                chunk = self._sock.recv(max(4096, count - len(self._buffer)))
            except TimeoutError:
                # 读超时是调用方自己设的（wait_for 的 timeout），原样抛出去，别混淆成断线
                raise
            except OSError as exc:
                # 页面导航会把调试会话断开，连接被重置是预期内的情况
                raise CdpError(f"CDP 连接已断开：{exc}") from exc
            if not chunk:
                raise CdpError("CDP 连接已断开")
            self._buffer += chunk
        data, self._buffer = self._buffer[:count], self._buffer[count:]
        return data

    def _write_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray()
        header.append(0x80 | opcode)  # FIN + opcode
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)  # 客户端发出的帧必须带掩码
        header.extend(mask)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def _read_message(self) -> bytes:
        data = bytearray()
        while True:
            first, second = self._read_exact(2)
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length) if length else b""
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

            if opcode == OPCODE_PING:
                self._write_frame(OPCODE_PONG, payload)
                continue
            if opcode == OPCODE_PONG:
                continue
            if opcode == OPCODE_CLOSE:
                raise CdpError("CDP 连接被对端关闭")
            if opcode in (OPCODE_TEXT, OPCODE_BINARY, 0x0):
                data.extend(payload)
            if fin:
                return bytes(data)

    # ------------------------------------------------------------------ 命令

    def send(self, method: str, params: dict | None = None) -> int:
        self._next_id += 1
        message = {"id": self._next_id, "method": method}
        if params:
            message["params"] = params
        self._write_frame(OPCODE_TEXT, json.dumps(message).encode("utf-8"))
        return self._next_id

    def wait_for(self, message_id: int, timeout: float | None = None) -> dict:
        """读到指定 id 的回包；途中的事件都收进 self.events 里备用。"""
        self._sock.settimeout(timeout if timeout is not None else self._timeout)
        while True:
            raw = self._read_message()
            if not raw:
                continue
            try:
                message = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            if message.get("id") == message_id:
                if "error" in message:
                    raise CdpError(f"CDP 命令出错：{message['error']}")
                return message
            if "method" in message:
                self.events.append(message)

    def call(self, method: str, params: dict | None = None, timeout: float | None = None) -> dict:
        message_id = self.send(method, params)
        return self.wait_for(message_id, timeout).get("result", {})

    def evaluate(self, expression: str, timeout: float | None = None, await_promise: bool = True):
        """执行一段 JS 并把结果取回（按值返回）。脚本抛错则抛 CdpError。"""
        result = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
            "userGesture": True,
            "timeout": int((timeout or self._timeout) * 1000),
        }, timeout=timeout)
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            text = details.get("exception", {}).get("description") or details.get("text")
            raise CdpError(f"页面脚本抛错：{text}")
        return result.get("result", {}).get("value")

    # ------------------------------------------------------------------ 便利方法

    def console_errors(self) -> list:
        """从收到的事件里挑出控制台 error 与未捕获异常。"""
        found = []
        for event in self.events:
            method = event.get("method")
            params = event.get("params", {})
            if method == "Runtime.consoleAPICalled" and params.get("type") == "error":
                parts = [str(arg.get("value", arg.get("description", "?")))
                         for arg in params.get("args", [])]
                found.append("console.error: " + " ".join(parts))
            elif method == "Runtime.exceptionThrown":
                details = params.get("exceptionDetails", {})
                description = (details.get("exception") or {}).get("description") or details.get("text")
                found.append("uncaught: " + str(description))
            elif method == "Log.entryAdded" and params.get("entry", {}).get("level") == "error":
                found.append("log: " + str(params["entry"].get("text")))
        return found

    def close(self) -> None:
        try:
            self._write_frame(OPCODE_CLOSE, b"")
        except Exception:  # noqa: BLE001
            pass
        try:
            self._sock.close()
        except Exception:  # noqa: BLE001
            pass
