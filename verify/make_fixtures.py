"""生成真实的编码夹具（真二进制文件，不是字符串常量）。

关键点：复现"纯中文 UTF-8 被误判成 GBK"那个缺陷，需要让旧的
`probe.slice(0, len - 4)` 切口正好落在一个多字节字符内部。
探针取前 4096 字节，切口在 4092；只要字节 4092 是"连续字节"（10xxxxxx），
回退 4 字节就会切断前一个完整字符 → UTF-8 严格解码失败 → 误判 GBK。

这里据此反推第一段的长度，把夹具调到必定触发旧缺陷，然后再写盘。
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")

PARAGRAPHS = [
    "六月初一，长安城里已经热得像一只蒸笼。",
    "天宝十四载，杨国忠权势熏天，满朝文武都在揣摩他的心思。",
    "荔枝使却只是个不起眼的小吏，李善德站在街角，手里攥着一纸公文。",
    "那公文只有短短一行字：务必将岭南新鲜荔枝，送至长安。",
    "他抬头望向宫城的方向，朱红色的城墙在日光下沉默着。",
]

PROBE = 4096
CUT = PROBE - 4          # 旧算法 slice(0, 4092)


def build_text(filler_len):
    """第一段插入 filler_len 个填充字，用来把 4092 的落点挪进一个多字节字符里。"""
    filler = "。" * filler_len
    body = (PARAGRAPHS[0] + filler) + "\n" + "\n".join(PARAGRAPHS[1:])
    # 补足长度，保证文件 > 探针长度
    repeated = (body + "\n") * 60
    return body + "\n" + repeated


def old_detect(probe_bytes):
    """复刻旧算法，用来证明夹具确实能打中它。"""
    if probe_bytes[:3] == b"\xef\xbb\xbf":
        return "utf-8"
    if probe_bytes[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return "utf-16"
    try:
        probe_bytes[: max(0, len(probe_bytes) - 4)].decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "gb18030"


def main():
    os.makedirs(FIXTURES, exist_ok=True)

    # 找一个 filler_len，让旧算法必然翻车
    chosen = None
    for filler_len in range(0, 40):
        text = build_text(filler_len)
        raw = text.encode("utf-8")
        if len(raw) <= PROBE:
            continue
        probe = raw[:PROBE]
        if len(probe) < 3:
            continue
        if (probe[CUT] & 0xC0) == 0x80 and old_detect(probe) != "utf-8":
            chosen = (filler_len, text, raw)
            break

    if chosen is None:
        raise SystemExit("没能构造出能打中旧算法的夹具，需要调整段落长度")

    filler_len, text, utf8_bytes = chosen
    print(f"命中：filler_len={filler_len}，字节 {CUT}（0x{utf8_bytes[CUT]:02x}）是连续字节")
    print(f"旧算法判定 → {old_detect(utf8_bytes[:PROBE])}（应为 gb18030，即误判）")

    files = {
        "utf8-cn.txt": utf8_bytes,
        "utf8-bom.txt": b"\xef\xbb\xbf" + utf8_bytes,
        "gbk-cn.txt": text.encode("gb18030"),
        "utf16le.txt": text.encode("utf-16-le"),
        "utf16be.txt": text.encode("utf-16-be"),
    }
    # 中文 + ASCII 混排（章节标题里带数字）
    mixed = "第一章 Chapter 1 序章\n" + text
    files["utf8-mixed.txt"] = mixed.encode("utf-8")
    files["gbk-mixed.txt"] = mixed.encode("gb18030")

    expected = {
        "utf8-cn.txt": {"encoding": "utf-8", "sha_len": len(utf8_bytes)},
        "utf8-bom.txt": {"encoding": "utf-8", "sha_len": len(utf8_bytes) + 3},
        "gbk-cn.txt": {"encoding": "gb18030", "sha_len": len(text.encode("gb18030"))},
        "utf16le.txt": {"encoding": "utf-16le", "sha_len": len(text.encode("utf-16-le"))},
        "utf16be.txt": {"encoding": "utf-16be", "sha_len": len(text.encode("utf-16-be"))},
        "utf8-mixed.txt": {"encoding": "utf-8", "sha_len": len(mixed.encode("utf-8"))},
        "gbk-mixed.txt": {"encoding": "gb18030", "sha_len": len(mixed.encode("gb18030"))},
    }

    for name, payload in files.items():
        with open(os.path.join(FIXTURES, name), "wb") as handle:
            handle.write(payload)
        print(f"  {name:<18} {len(payload):>8} bytes")

    # 期望解出的原文，供往返比对（BOM 用 utf-8-sig 去掉）
    with open(os.path.join(FIXTURES, "expected.txt"), "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    with open(os.path.join(FIXTURES, "expected-mixed.txt"), "w", encoding="utf-8", newline="") as handle:
        handle.write(mixed)
    with open(os.path.join(FIXTURES, "expect.json"), "w", encoding="utf-8") as handle:
        json.dump(expected, handle, ensure_ascii=False, indent=2)

    print("\n夹具已写入", FIXTURES)


if __name__ == "__main__":
    main()
