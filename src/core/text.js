/**
 * 文本处理：导入切章、首行缩进、逐字校对、句子定位。
 *
 * 这些逻辑是从旧版 app.js 里原样搬过来的 —— 它们被反复调试过
 * （缩进的边界、标点宽松的等价类、超长章节的切法），重写只会引入新 bug。
 * 唯一的改动：不再依赖全局 state，需要什么参数就传什么。
 */

import { MojiEncoding } from './index.js';

/** 一章最多这么多字；超过就再切成几段，免得一次要抄半天。 */
export const MAX_CHAPTER_CHARS = 18000;

const CHAPTER_HEADING = /^\s*(第\s*[零一二三四五六七八九十百千万\d]+\s*章|Chapter\s+\d+|序章|楔子|尾声)/i;

export function isChapterHeading(line) {
  return CHAPTER_HEADING.test(line);
}

export function createBookId() {
  return `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 有正文吗？（纯空白不算 —— 首行自动补的两个全角空格不该被当成"写过了"） */
export function hasWrittenText(written) {
  return /[^\s]/.test(String(written || ''));
}

/**
 * 给每一段补上两个全角空格缩进；空行、已有缩进的行、章节标题行都跳过。
 * 原稿本身没有缩进，所以不补的话每章第一行看起来是"顶格"的。
 */
export function indentContent(text) {
  return String(text || '')
    .split('\n')
    .map(line => {
      if (!line.trim()) return line;
      if (/^[ \t\u3000]/.test(line)) return line;
      if (isChapterHeading(line)) return line;
      return `\u3000\u3000${line}`;
    })
    .join('\n');
}

export function normalizeBook(book, id) {
  const chapters = (book.chapters || []).map(chapter => {
    const raw = String(chapter.content || '');
    const written = chapter.written || '';
    return {
      title: chapter.title || '未命名章节',
      /* 首行缩进：只改「还没开始抄」的章节。
         已经抄了一部分的章节一动内容，用户已写的字就会整体错位 —— 宁可留着。 */
      content: written ? raw : indentContent(raw),
      written,
      timeSpentMs: Number(chapter.timeSpentMs || 0),
    };
  });
  return {
    id,
    title: book.title || '未命名书籍',
    author: book.author || '本地文本',
    chapters,
  };
}

/** 超长章节：先按空行分段，段太长再按字数硬切。 */
export function finalizeChapters(rawChapters) {
  const chapters = rawChapters
    .map(chapter => {
      const content = chapter.parts.join('\n').trim();
      return { title: chapter.title, content: content || chapter.title, written: '' };
    })
    .filter(chapter => chapter.title || chapter.content);
  if (!chapters.length) return [];

  const result = [];
  chapters.forEach(chapter => {
    if (chapter.content.length <= MAX_CHAPTER_CHARS) {
      result.push(chapter);
      return;
    }
    let part = '';
    let partIndex = 1;
    const flush = () => {
      if (!part) return;
      result.push({
        title: `${chapter.title} · ${String(partIndex).padStart(2, '0')}`,
        content: part,
        written: '',
      });
      part = '';
      partIndex += 1;
    };
    chapter.content.split(/\n{2,}/).forEach(paragraph => {
      const candidate = part ? `${part}\n\n${paragraph}` : paragraph;
      if (candidate.length > MAX_CHAPTER_CHARS && part) flush();
      if (paragraph.length > MAX_CHAPTER_CHARS) {
        for (let start = 0; start < paragraph.length; start += MAX_CHAPTER_CHARS) {
          part = paragraph.slice(start, start + MAX_CHAPTER_CHARS);
          flush();
        }
      } else {
        part = part ? `${part}\n\n${paragraph}` : paragraph;
      }
    });
    flush();
  });
  return result;
}

/**
 * 读一个文本文件 → 章节数组。编码探测在这层完成：
 * 识别不准时（左侧下拉框）会走 encodingMode 指定的编码。
 */
export async function readFileAsChapters(file, encodingMode = 'auto') {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoding = MojiEncoding.detectEncoding(bytes, encodingMode);
  const text = MojiEncoding.decodeBytes(bytes, encoding);

  const rawChapters = [];
  let current = null;
  text.split('\n').forEach(rawLine => {
    const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
    if (isChapterHeading(line)) {
      if (current) rawChapters.push(current);
      current = { title: line.trim(), parts: [] };
    } else {
      if (!current) current = { title: '全文', parts: [] };
      current.parts.push(line);
    }
  });
  if (current) rawChapters.push(current);

  /* 先定稿再补缩进：缩进要在"内容已经定稿"之后做，免得影响切分长度的判断 */
  const chapters = finalizeChapters(rawChapters).map(chapter => ({
    ...chapter,
    content: indentContent(chapter.content),
  }));
  return { chapters, encoding };
}

/* ── 逐字校对 ────────────────────────────────────────────────────────── */

const PUNCT_CANON = {
  '。': '.', '、': ',', '“': '"', '”': '"', '‘': "'", '’': "'",
  '《': '<', '》': '>', '【': '[', '】': ']', '「': '"', '」': '"',
  '『': '"', '』': '"', '—': '-', '－': '-', '～': '~', '·': '.', '…': '.',
};

/** 把全角/半角、中英文引号统一到同一个形式，供「标点宽松」比对用。 */
export function canonicalChar(char) {
  if (!char) return '';
  const code = char.codePointAt(0);
  if (code === 0x3000) return ' '; // 全角空格 → 空格
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0); // 全角 ASCII
  return PUNCT_CANON[char] || char;
}

export function charsMatch(source, typed, lenient) {
  if (source === typed) return true;
  if (!lenient) return false;
  return canonicalChar(source) === canonicalChar(typed);
}

export function compareWriting(source, written, lenient = false) {
  let correct = 0;
  let incorrect = 0;
  const text = source || '';
  for (let index = 0; index < written.length; index += 1) {
    if (charsMatch(text[index], written[index], lenient)) correct += 1;
    else incorrect += 1;
  }
  return { correct, incorrect, total: written.length };
}

/** 校对清单：每一处偏差（你写的字 → 原文该有的字）。 */
export function differenceList(source, written, lenient = false, limit = 300) {
  const text = source || '';
  const items = [];
  for (let index = 0; index < written.length && items.length < limit; index += 1) {
    const typed = written[index];
    const expected = text[index];
    if (charsMatch(expected, typed, lenient)) continue;
    items.push({
      index,
      typed,
      expected: expected === undefined ? '' : expected,
      extra: expected === undefined,
      line: lineColumnOf(text, index).line,
    });
  }
  return items;
}

export function lineColumnOf(text, index) {
  let line = 0;
  let column = 0;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      column = 0;
    } else column += 1;
  }
  return { line, column };
}

const SENTENCE_END = new Set(['。', '！', '？', '；', '…', '\n', '!', '?', ';']);

/** 光标所在句子的起止位置（按原文切句）。 */
export function sentenceAt(text, index) {
  const content = text || '';
  let start = Math.min(index, content.length);
  while (start > 0 && !SENTENCE_END.has(content[start - 1])) start -= 1;
  let end = Math.min(index, content.length);
  while (end < content.length && !SENTENCE_END.has(content[end])) end += 1;
  return { start, end, text: content.slice(start, end + 1) };
}

/** 原文某一行的缩进（回车时带进抄写区，行首退格时整段删掉）。 */
export function getSourceIndent(source, index) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const match = source.slice(lineStart).match(/^[ \t\u3000]*/);
  return match ? match[0] : '';
}
