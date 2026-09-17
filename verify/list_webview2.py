"""列出所有 msedgewebview2.exe 进程，并按 --user-data-dir 归组。

为什么需要：WebView2 被杀（尤其是强制结束）之后，子进程会变成孤儿继续挂在
那个 user-data-dir 上。下一次启动同一个 profile 时，桥接初始化就会一直等不到
pywebviewready —— 表现为"窗口开了，但 JS 桥起不来"，看着像前端崩了，
其实是上一次的残骸堵门。

    python verify/list_webview2.py            # 只看
    python verify/list_webview2.py --kill     # 杀掉（仅限本项目相关目录）
"""

from __future__ import annotations

import collections
import os
import re
import subprocess
import sys

POWERSHELL = (
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
    "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
)

# 只对这些目录下的 profile 动手：本项目自建的目录，以及 CDP 测试的临时目录
OWNED_MARKERS = ("\\MoJi\\", "cdp-run-", "webview-probe")


def query() -> list:
    done = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL],
        capture_output=True, timeout=180,
    )
    rows = []
    for line in done.stdout.decode("utf-8", errors="replace").splitlines():
        if "\t" not in line:
            continue
        pid_text, command = line.split("\t", 1)
        if not pid_text.strip().isdigit():
            continue
        match = re.search(r"--user-data-dir=(\S+)", command)
        rows.append({"pid": int(pid_text), "profile": match.group(1) if match else "(none)",
                     "command": command})
    return rows


def main() -> int:
    kill = "--kill" in sys.argv
    rows = query()
    groups = collections.Counter(row["profile"] for row in rows)
    print(f"msedgewebview2.exe 总数: {len(rows)}")
    for profile, count in groups.most_common():
        mine = any(marker.lower() in profile.lower() for marker in OWNED_MARKERS)
        print(f"  {count:>3}  个  {'[本项目的]' if mine else '[其它程序]'}  {profile}")

    if not kill:
        return 0

    victims = [row["pid"] for row in rows
               if any(marker.lower() in row["profile"].lower() for marker in OWNED_MARKERS)]
    print(f"\n准备结束 {len(victims)} 个本项目残留进程…")
    for pid in victims:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=60)
    remaining = query()
    print(f"清理后剩余: {len(remaining)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
