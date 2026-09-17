"""把构建好的 MoJi.exe 打成发布包 + 校验和。

    "C:/Users/Yhwhy/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
        desktop/make_release.py

产物（都落在 outputs/Windows/）：
    MoJi.exe                    单文件免安装程序（PyInstaller 出）
    MoJi-<版本>-win64.zip       发布包：exe + 使用说明.md
    SHA256SUMS.txt              exe 与 zip 的 SHA256

为什么把"使用说明.md"放进 zip 而不是 exe：
    单文件 EXE 的 datas 会被解压到临时目录，用户看不到。
    说明书必须放在 exe **旁边**，用户解压后一眼就能看到。

为什么版本号从 app.py 读：
    以前版本号写死在两处，改一处忘一处就会出不匹配的文件名。
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
EXE = os.path.join(OUT_DIR, "MoJi.exe")
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


def main() -> int:
    version = app_version()
    zip_path = os.path.join(OUT_DIR, f"MoJi-{version}-win64.zip")

    for path in (EXE, README):
        if not os.path.exists(path):
            raise SystemExit(f"缺文件：{path}")

    # zip 内容固定：exe + 说明书，两者同级
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.write(EXE, "MoJi.exe")
        archive.write(README, "使用说明.md")

    sums = "\n".join([
        f"{sha256(EXE)}  MoJi.exe",
        f"{sha256(zip_path)}  {os.path.basename(zip_path)}",
    ]) + "\n"
    with open(os.path.join(OUT_DIR, "SHA256SUMS.txt"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(sums)

    print(f"版本      : {version}")
    print(f"exe       : {EXE}  ({os.path.getsize(EXE):,} 字节)")
    print(f"zip       : {zip_path}  ({os.path.getsize(zip_path):,} 字节)")
    print(sums)
    return 0


if __name__ == "__main__":
    sys.exit(main())
