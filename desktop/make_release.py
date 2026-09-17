"""把 PyInstaller 产出的目录打成发布包 + 校验和。

    cd desktop
    "C:/Users/Yhwhy/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
        -m PyInstaller MoJi.spec --noconfirm --distpath "../outputs/Windows" --workpath build
    "C:/Users/Yhwhy/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
        make_release.py

产物（都落在 outputs/Windows/）：
    MoJi/                       目录模式的程序本体（MoJi.exe + _internal/）
    MoJi-<版本>-win64.zip       发布包：MoJi/ + 使用说明.md
    SHA256SUMS.txt              exe 与 zip 的 SHA256

为什么是目录而不是单文件：
    单文件 EXE 每次启动都要把自己解压到临时目录，冷启动要好几秒，
    也更容易被杀软误报。目录模式启动快，代价是分发的东西从"一个 exe"
    变成"一个文件夹"—— 压缩之后大小其实差不多。

为什么把"使用说明.md"放在 zip 的顶层：
    用户解压后第一眼就能看到它；放进程序目录里反而容易被忽略。

为什么版本号从 app.py 读：
    版本号写死两处，改一处忘一处就会出不匹配的文件名。
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "outputs", "Windows")
APP_DIR = os.path.join(OUT_DIR, "MoJi")
EXE = os.path.join(APP_DIR, "MoJi.exe")
README = os.path.join(HERE, "使用说明.md")


def app_version() -> str:
    with open(os.path.join(HERE, "app.py"), encoding="utf-8") as handle:
        match = re.search(r'^VERSION\s*=\s*"([^"]+)"', handle.read(), re.MULTILINE)
    if not match:
        raise SystemExit("app.py 里找不到 VERSION")
    return match.group(1)


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dir_size(path: str) -> int:
    total = 0
    for base, _dirs, names in os.walk(path):
        for name in names:
            total += os.path.getsize(os.path.join(base, name))
    return total


def main() -> int:
    version = app_version()
    zip_path = os.path.join(OUT_DIR, f"MoJi-{version}-win64.zip")

    for path in (EXE, README):
        if not os.path.exists(path):
            raise SystemExit(f"缺文件：{path}（先按本文件顶部的命令跑一次 PyInstaller）")

    # zip 布局：说明书放最外层（解压就看得到），程序本体整个放进 MoJi/
    count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.write(README, "使用说明.md")
        for base, _dirs, names in os.walk(APP_DIR):
            for name in names:
                full = os.path.join(base, name)
                archive.write(full, os.path.join("MoJi", os.path.relpath(full, APP_DIR)))
                count += 1

    sums = "\n".join([
        f"{sha256(EXE)}  MoJi/MoJi.exe",
        f"{sha256(zip_path)}  {os.path.basename(zip_path)}",
    ]) + "\n"
    with open(os.path.join(OUT_DIR, "SHA256SUMS.txt"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(sums)

    print(f"版本      : {version}")
    print(f"程序目录  : {APP_DIR}  ({dir_size(APP_DIR):,} 字节 / {count} 个文件)")
    print(f"exe       : {EXE}  ({os.path.getsize(EXE):,} 字节)")
    print(f"zip       : {zip_path}  ({os.path.getsize(zip_path):,} 字节)")
    print(sums)
    return 0


if __name__ == "__main__":
    sys.exit(main())
