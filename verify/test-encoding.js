#!/usr/bin/env node
/* 编码探测回归测试。
   夹具是真实二进制文件（verify/fixtures/），不是内存里拼出来的字符串 ——
   缺陷恰恰出在"探针被截断"这种只在真实字节长度下才成立的条件上。

   用法: node verify/test-encoding.js
*/
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const FIXTURES = path.join(HERE, 'fixtures');
const { detectEncoding, decodeBytes, encodingLabel, utf8SafePrefix } = require(path.join(HERE, '..', 'web', 'encoding.js'));

const checks = [];
const record = (name, ok, detail) => { checks.push({ name, ok, detail }); };

/* 旧算法（有缺陷的那版），保留下来是为了证明夹具真的打中了它 */
function legacyDetect(bytes) {
  const probe = Uint8Array.from(bytes.slice(0, 4096));
  if (probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf) return 'utf-8';
  if (probe[0] === 0xff && probe[1] === 0xfe) return 'utf-16le';
  if (probe[0] === 0xfe && probe[1] === 0xff) return 'utf-16be';
  const zeroCount = probe.reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
  if (probe.length > 16 && zeroCount / probe.length > 0.2) return probe[1] === 0 ? 'utf-16le' : 'utf-16be';
  const safe = probe.slice(0, Math.max(0, probe.length - 4));
  try { new TextDecoder('utf-8', { fatal: true }).decode(safe); return 'utf-8'; } catch { return 'gb18030'; }
}

const expect = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expect.json'), 'utf8'));

function readFixture(name) { return fs.readFileSync(path.join(FIXTURES, name)); }

/* GB18030 需要 Node 带完整 ICU；缺了就明确报出来，而不是静默跳过 */
const hasGb18030 = (() => { try { new TextDecoder('gb18030'); return true; } catch { return false; } })();
record('运行环境支持 GB18030 解码（完整 ICU）', hasGb18030, { node: process.version });

const utf8ProbeBytes = (() => {
  const raw = readFixture('utf8-cn.txt');
  const cut = 4096 - 4;
  return { byte: raw[cut], isContinuation: (raw[cut] & 0xc0) === 0x80, length: raw.length };
})();
/* 夹具必须真的能打中旧算法，否则这个回归测试是空的 */
record('夹具确实切在多字节字符内部（字节 4092 是连续字节）', utf8ProbeBytes.isContinuation, utf8ProbeBytes);
record('旧算法在纯中文 UTF-8 上误判为 GBK（已复现的原缺陷）',
  legacyDetect(readFixture('utf8-cn.txt')) === 'gb18030',
  { legacy: legacyDetect(readFixture('utf8-cn.txt')) });

/* ── 逐个夹具：编码判定 + 解码往返 ── */
for (const [name, meta] of Object.entries(expect)) {
  const bytes = readFixture(name);
  const detected = detectEncoding(bytes, 'auto');
  record(`${name} → 判定为 ${meta.encoding}`, detected === meta.encoding, { detected, expected: meta.encoding, label: encodingLabel(detected) });
  if (!hasGb18030 && detected === 'gb18030') continue;

  const decoded = decodeBytes(bytes, detected);
  const expectedText = fs.readFileSync(
    path.join(FIXTURES, name.includes('mixed') ? 'expected-mixed.txt' : 'expected.txt'),
    'utf8'
  );
  record(`${name} → 解出的正文与原文逐字符一致`, decoded === expectedText, {
    decodedLength: decoded.length,
    expectedLength: expectedText.length,
    head: decoded.slice(0, 24)
  });
}

/* ── 强制指定编码时必须照办 ── */
record('显式指定 gb18030 时不走自动探测', detectEncoding(readFixture('utf8-cn.txt'), 'gb18030') === 'gb18030', {});
record('显式指定 utf-8 时不走自动探测', detectEncoding(readFixture('gbk-cn.txt'), 'utf-8') === 'utf-8', {});

/* ── 边界：空字节 / 极短输入不应抛错 ── */
try {
  detectEncoding(new Uint8Array(0), 'auto');
  record('空字节不抛错', true, { result: detectEncoding(new Uint8Array(0), 'auto') });
} catch (error) { record('空字节不抛错', false, String(error)); }

/* ── 边界回退函数本身：对 UTF-8 夹具必须产出合法 UTF-8 ──
   （只对 UTF-8 夹具成立 —— 对 UTF-16/GBK 字节谈"UTF-8 字符边界"没有意义） */
let prefixOk = true;
let prefixDetail = {};
for (const name of ['utf8-cn.txt', 'utf8-bom.txt', 'utf8-mixed.txt']) {
  const bytes = readFixture(name);
  const probe = utf8SafePrefix(Uint8Array.from(bytes.slice(0, 4096)));
  try { new TextDecoder('utf-8', { fatal: true }).decode(probe); }
  catch (error) { prefixOk = false; prefixDetail = { name, error: String(error) }; break; }
}
record('utf8SafePrefix 对截断的 UTF-8 探针始终产出合法字节', prefixOk, prefixDetail);

const failed = checks.filter(c => !c.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  passed: checks.length - failed.length,
  total: checks.length,
  failed: failed.map(f => f.name),
  checks
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
