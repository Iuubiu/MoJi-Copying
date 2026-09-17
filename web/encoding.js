/* encoding.js —— 文本文件编码探测（独立模块，可被 Node 直接 require 做回归测试）
 *
 * 为什么不用「TextDecoder(fatal) 试解码」这个老办法：
 *   探针只取文件开头若干字节，末尾几乎必然把一个多字节字符切成两半；
 *   若按固定字节数回退（比如 slice(0, len - 4)），回退本身又会切断前一个完整字符，
 *   于是"整段纯中文的 UTF-8 文件"被误判成 GBK —— 整本书瞬间变乱码。
 *
 * 现在的做法：
 *   1) 先把探针截到最后一个「完整 UTF-8 字符边界」（连续字节回退，不是固定回退）；
 *   2) 候选编码各自解码一遍，用「像不像正常中文文本」打分（替换字符、控制字符、
 *      私用区都要扣分），谁的分数高选谁。GBK 无法用 fatal 判断，但分数能区分。
 */
(function (global) {
  'use strict';

  /* 常见编码别名 → TextDecoder 认识的标签 */
  const LABELS = {
    'utf-8': 'UTF-8',
    utf8: 'UTF-8',
    gb18030: 'GBK / GB18030',
    gbk: 'GBK / GB18030',
    'utf-16le': 'UTF-16 LE',
    'utf-16be': 'UTF-16 BE'
  };

  function encodingLabel(encoding) {
    return LABELS[encoding] || encoding;
  }

  function hasBom(bytes, a, b, c) {
    return bytes.length >= 3 && bytes[0] === a && bytes[1] === b && bytes[2] === c;
  }

  /* BOM 与"规律性空字节"这类确定性信号先判，省得进打分流程出错 */
  function sniffBom(bytes) {
    if (hasBom(bytes, 0xef, 0xbb, 0xbf)) return 'utf-8';
    if (hasBom(bytes, 0xff, 0xfe, 0x00, 0x00)) return 'utf-16le';
    if (hasBom(bytes, 0x00, 0x00, 0xfe, 0xff)) return 'utf-16be';
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    return null;
  }

  /* UTF-16 无 BOM 的快速通道：正文里夹 ASCII 时高位字节为 0，会有大量 0x00。
     注意这一步对"整篇都是汉字"的 UTF-16 无效 —— 汉字高位字节非零，
     这种情况下要靠后面的打分环节去认（所以 UTF-16 也进了候选列表）。 */
  function sniffUtf16(bytes) {
    if (bytes.length < 32) return null;
    let zeroOdd = 0;
    let zeroEven = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] !== 0) continue;
      if (i % 2) zeroOdd += 1; else zeroEven += 1;
    }
    const half = bytes.length / 2;
    if (zeroOdd / half > 0.3 && zeroEven / half < 0.05) return 'utf-16le';
    if (zeroEven / half > 0.3 && zeroOdd / half < 0.05) return 'utf-16be';
    return null;
  }

  /* 把探针末尾回退到最后一个完整 UTF-8 字符的开头。
     从末尾往前最多看 4 个字节：第一个"非连续字节"就是最后一个字符的起始字节；
     再看它声明要几个字节——够，就整个保留；不够（说明被探针截断了），就切在它前面。
     注意这是"退到字符边界"，不是"固定切掉 4 个字节"：
     后者会连带切断前一个完整字符，正是原缺陷的成因。 */
  function utf8SafePrefix(bytes) {
    const length = bytes.length;
    for (let back = 1; back <= 4 && back <= length; back += 1) {
      const index = length - back;
      const byte = bytes[index];
      if ((byte & 0xc0) === 0x80) continue;          // 连续字节，不是字符起始
      let need;
      if ((byte & 0x80) === 0) need = 1;
      else if ((byte & 0xe0) === 0xc0) need = 2;
      else if ((byte & 0xf0) === 0xe0) need = 3;
      else if ((byte & 0xf8) === 0xf0) need = 4;
      else return bytes.subarray(0, index);          // 非法起始字节 → 切在它前面
      return index + need <= length ? bytes.subarray(0, length) : bytes.subarray(0, index);
    }
    return bytes.subarray(0, length);
  }

  /* 「这段文本像不像正常中文小说」的分数，0~1 */
  function scoreText(text) {
    let good = 0;
    let bad = 0;
    for (let i = 0; i < text.length; i += 1) {
      const cp = text.codePointAt(i);
      if (cp > 0xffff) i += 1;                       // 代理对，跳过低位
      if (cp === 0xfffd) { bad += 1; continue; }      // 替换字符 = 解码失败
      if (cp === 9 || cp === 10 || cp === 13) { good += 1; continue; }
      if (cp < 0x20) { bad += 1; continue; }          // 控制字符 = 乱码
      if (cp < 0x7f) { good += 1; continue; }         // ASCII 可打印
      if (cp >= 0x4e00 && cp <= 0x9fff) { good += 1; continue; }   // 汉字
      if (cp >= 0x3000 && cp <= 0x303f) { good += 1; continue; }   // CJK 标点
      if (cp >= 0xff00 && cp <= 0xffef) { good += 1; continue; }   // 全角字符
      if (cp >= 0x2000 && cp <= 0x206f) { good += 1; continue; }   // 通用标点
      if (cp >= 0xe000 && cp <= 0xf8ff) { bad += 1; continue; }    // 私用区 = 乱码
      if (cp >= 0x3040 && cp <= 0x30ff) { good += 1; continue; }   // 日文假名
      bad += 0.5;
    }
    return good / Math.max(1, good + bad);
  }

  function decodeWith(bytes, encoding, fatal) {
    try {
      return new TextDecoder(encoding, { fatal: Boolean(fatal) }).decode(bytes);
    } catch (error) {
      return null;
    }
  }

  /* 核心：给一段字节，返回最佳编码猜测 */
  function detectEncoding(bytes, requested) {
    if (requested && requested !== 'auto') return requested;
    if (!bytes || !bytes.length) return 'utf-8';

    const bom = sniffBom(bytes);
    if (bom) return bom;
    const utf16 = sniffUtf16(bytes);
    if (utf16) return utf16;

    if (typeof TextDecoder !== 'function') return 'utf-8';

    const probe = utf8SafePrefix(bytes);
    /* 边界回退之后仍能严格解码 → 基本可以确定是 UTF-8。
       这一步保留了 fatal 的确定性，同时不再被"截断"误伤。 */
    if (decodeWith(probe, 'utf-8', true) !== null) return 'utf-8';

    /* 不是严格 UTF-8，就在几个候选之间按"解出来像不像正常中文文本"打分选优。
       GBK 与 UTF-16 都没有可靠的 fatal 校验，只能靠分数区分：
       正则文本解出来几乎全是汉字 → 接近 1.0；解错会出现替换字符、控制字符、
       私用区，以及大量落在正常范围之外的字 → 分数明显掉下来。 */
    const candidates = ['gb18030', 'utf-8', 'utf-16le', 'utf-16be'];
    let best = 'gb18030';
    let bestScore = -1;
    candidates.forEach(encoding => {
      if (encoding.startsWith('utf-16') && bytes.length < 32) return;   // 太短，判不准
      const text = decodeWith(bytes, encoding);
      if (text === null) return;
      const score = scoreText(text);
      if (score > bestScore) { bestScore = score; best = encoding; }
    });
    return best;
  }

  /* 按编码解出整段文本；失败时退回 UTF-8 */
  function decodeBytes(bytes, encoding) {
    const text = decodeWith(bytes, encoding);
    if (text !== null) return text;
    return decodeWith(bytes, 'utf-8') || '';
  }

  const api = { detectEncoding, decodeBytes, encodingLabel, scoreText, utf8SafePrefix, sniffBom, sniffUtf16 };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MojiEncoding = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
