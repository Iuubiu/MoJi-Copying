"""生成应用图标 MoJi.ico。

深墨色圆角方块 + 纸色「墨」字，与应用内配色一致（--ink #262726 / --paper #fbfaf7 / --rust #c3483e）。
只依赖 Pillow，属于构建期脚本，运行时不加载。

    python gen_icon.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(HERE, "MoJi.ico")

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
    base = draw_icon(1024)
    base.save(OUTPUT, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"已生成 {OUTPUT}（{os.path.getsize(OUTPUT)} 字节，尺寸 {', '.join(str(s) for s in ICO_SIZES)}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
