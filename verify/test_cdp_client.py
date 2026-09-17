"""验证手写的 CDP 客户端（desktop/cdp_client.py）真的能跟浏览器对话。

手写 WebSocket 很容易在细节上写错（掩码、分片、长度编码），
所以在把它接进桌面自检之前，先用一个真实的浏览器把基本命令跑一遍。

    python verify/test_cdp_client.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "desktop"))

from cdp_client import CdpError, CdpSession, find_page_target, http_json  # noqa: E402

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

PAGE = """
<!doctype html><html><head><meta charset="utf-8"><title>cdp-selftest</title></head>
<body><h1>hello</h1><script>
  window.__flag = 'MOJI_CDP_OK';
  console.error('故意打一条 error，用来验证能抓到控制台错误');
</script></body></html>
"""

checks: list = []


def record(name: str, ok: bool, detail=None) -> None:
    checks.append({"name": name, "ok": bool(ok), "detail": detail})


def main() -> int:
    chrome = os.environ.get("CHROME_PATH") or next(
        (path for path in CHROME_CANDIDATES if os.path.exists(path)), None
    )
    if not chrome:
        print(json.dumps({"ok": False, "reason": "找不到 Chrome/Edge"}, ensure_ascii=False))
        return 2

    page_path = os.path.join(tempfile.mkdtemp(prefix="cdp-selftest-"), "page.html")
    with open(page_path, "w", encoding="utf-8") as handle:
        handle.write(PAGE)

    profile = tempfile.mkdtemp(prefix="cdp-selftest-profile-")
    port = 49321
    proc = subprocess.Popen(
        [chrome, "--headless=new", f"--remote-debugging-port={port}",
         f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
         "--disable-gpu", "--window-size=1200,800", f"file:///{page_path.replace(os.sep, '/')}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    session = None
    try:
        # HTTP 发现接口
        version = http_json(f"http://127.0.0.1:{port}/json/version", timeout=30)
        record("CDP HTTP 发现接口可用", "Browser" in version or "webSocketDebuggerUrl" in version,
               {k: version.get(k) for k in ("Browser", "Protocol-Version")})

        ws_url = find_page_target(port, "page.html", timeout=30)
        record("能定位到页面目标的调试地址", isinstance(ws_url, str) and ws_url.startswith("ws://"),
               {"ws_url": ws_url})

        session = CdpSession(ws_url, timeout=15)
        record("WebSocket 握手成功", True)

        session.call("Runtime.enable")
        session.call("Log.enable")
        record("Runtime.enable / Log.enable 返回正常", True)

        record("Runtime.evaluate 算术", session.evaluate("1 + 1") == 2)
        record("Runtime.evaluate 读 DOM", session.evaluate("document.title") == "cdp-selftest")
        record("Runtime.evaluate 读全局变量", session.evaluate("window.__flag") == "MOJI_CDP_OK")

        # 大一点的返回值：验证分片/长帧解析
        big = session.evaluate("'x'.repeat(200000).length")
        record("能取回较大的返回值（验证长帧解析）", big == 200000, {"length": big})

        # 对象按值返回
        obj = session.evaluate("({a: 1, b: [1,2,3]})")
        record("对象按值返回", obj == {"a": 1, "b": [1, 2, 3]}, obj)

        # 脚本抛错要能被识别，而不是静默返回 None
        raised = False
        try:
            session.evaluate("throw new Error('boom')")
        except CdpError:
            raised = True
        record("页面脚本抛错能被识别", raised)

        # 控制台报错要能被抓到
        errors = session.console_errors()
        record("能抓到启动期的控制台错误", any("故意打一条" in item for item in errors),
               {"errors": errors[:3]})
    finally:
        if session is not None:
            session.close()
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()

    failed = [c["name"] for c in checks if not c["ok"]]
    print(json.dumps({"ok": not failed, "passed": len(checks) - len(failed),
                      "total": len(checks), "failed": failed, "checks": checks},
                     ensure_ascii=False, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
