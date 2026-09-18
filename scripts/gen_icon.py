"""生成应用图标：桌面版（Tauri）与浏览器版（PWA）共用同一张脸。

深墨色圆角方块 + 纸色「墨」字，与应用内配色一致（--ink #262726 / --paper #fbfaf7 / --rust #c3483e）。
只依赖 Pillow，属于构建期脚本，运行时不加载。

    python scripts/gen_icon.py

产出：
    src-tauri/icons/icon.ico    桌面版打包用（多尺寸）
    src-tauri/icons/icon.png    桌面版打包用（Tauri 要求有 PNG）
    public/icon-192.png         浏览器"安装为应用"的图标（192 是安装门槛）
    public/icon-512.png         同上，高分屏
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICON_DIR = os.path.join(ROOT, "src-tauri", "icons")
PUBLIC_DIR = os.path.join(ROOT, "public")

INK = (38, 39, 38, 255)          # --ink
PAPER = (251, 250, 247, 255)     # --paper
RUST = (195, 72, 62, 255)        # --rust

FONT_CANDIDATES = (
    r"C:\Windows\Fonts\simsun.ttc",   # 宋体，衬线感最接近品牌字
    r"C:\Windows\Fonts\simkai.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
)

ICO_SIZES = (256, 128, 64, 48, 32, 24, 16)
PNG_SIZES = (192, 512)          # PWA 图标：192 是安装门槛，512 给高分屏


def load_font(size: int):
    for path in FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None


def draw_icon(size: int = 1024) -> Image.Image:
    """先画一张大图再缩，边缘更干净。"""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    margin = int(size * 0.06)
    radius = int(size * 0.22)
    draw.rounded_rectangle((margin, margin, size - margin, size - margin), radius=radius, fill=INK)

    # 纸色「墨」字
    font = load_font(int(size * 0.56))
    if font is not None:
        text = "墨"
        box = draw.textbbox((0, 0), text, font=font)
        x = (size - (box[2] - box[0])) / 2 - box[0]
        y = (size - (box[3] - box[1])) / 2 - box[1] - int(size * 0.01)
        draw.text((x, y), text, font=font, fill=PAPER)
    else:
        # 没有中文字体时退化成一条笔痕，至少不至于空图
        draw.rounded_rectangle((int(size * 0.3), int(size * 0.38), int(size * 0.7), int(size * 0.46)),
                               radius=int(size * 0.04), fill=PAPER)

    # 右下角一点朱砂，呼应界面里的强调色
    dot = int(size * 0.085)
    cx, cy = int(size * 0.74), int(size * 0.74)
    draw.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=RUST)

    return image


def main() -> int:
    os.makedirs(ICON_DIR, exist_ok=True)
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    base = draw_icon(1024)

    ico_path = os.path.join(ICON_DIR, "icon.ico")
    base.save(ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"已生成 {ico_path}（{os.path.getsize(ico_path)} 字节，尺寸 {', '.join(str(s) for s in ICO_SIZES)}）")

    # Tauri 打包要求有一张 PNG 图标；浏览器"安装为应用"要 manifest 里的 192 / 512。
    for size in PNG_SIZES:
        image = base.resize((size, size), Image.LANCZOS)
        targets = [os.path.join(PUBLIC_DIR, f"icon-{size}.png")]
        if size == 512:
            targets.append(os.path.join(ICON_DIR, "icon.png"))
        for path in targets:
            image.save(path, format="PNG")
            print(f"已生成 {path}（{os.path.getsize(path)} 字节）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
