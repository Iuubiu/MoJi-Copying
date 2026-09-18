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

/** 分卷标题：第X部 / 第X卷 / 第X篇 / 第X集 / 卷X / 上卷。跟"章"是两码事。 */
const VOLUME_HEADING = /^\s*(?:第\s*[零一二三四五六七八九十百千万两\d]+\s*[部卷篇集]|卷\s*[零一二三四五六七八九十百千万两\d]+|[上中下]卷)/;

export function isVolumeHeading(line) {
  return VOLUME_HEADING.test(line);
}

/* ── 广告与水印 ──────────────────────────────────────────────────────── */

/** 纯符号分隔线：一连串的 = - * # ~ _ 之类，正文里不会这样成行。 */
const AD_RULE = /^[\s=\-*#~_—－·•.]{6,}$/;
/** 强信号：站点名、网址、推广语。这些词在正文里几乎不会成行出现。 */
const AD_SIGNAL = /(?:知轩藏书|笔趣阁|请记住本站|请记住我们|精校|全集下载|电子书下载|txt下载|无弹窗|永久免费|手机阅读|手机版阅读|加入书架|首发于|首发自|书友群|求订阅|求月票|求推荐票|最新章节|www\.|https?:\/\/)/i;
/** 组合信号：推广动作 + 作品/站点，两个同时出现才算。 */
const AD_PROMO = /(?:下载|阅读|收藏|推荐|首发|更新|全集|免费|订阅|尽在|更多)/;
const AD_TARGET = /(?:小说|书籍|文学|电子书|网|站|txt)/i;

/**
 * 这一行是不是夹杂的广告 / 水印？
 *
 * 判定要保守：**宁可放过，不可误杀** —— 正文被当广告吃掉是不可逆的，
 * 而漏掉一行广告只是抄写时多打几个字。所以：
 *   · 长行一律不判（60 字以上基本是正文）；
 *   · 组合信号只认 30 字以内的短行，而且不能带句读 ——
 *     "他翻开那本从网上下载来的旧档案。"这种句子会同时命中"下载"和"网"，
 *     但它显然不是广告行。
 */
export function isAdLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (AD_RULE.test(text)) return true;
  if (text.length > 60) return false;
  if (AD_SIGNAL.test(text)) return true;
  if (text.length > 30) return false;
  if (/[。！？；]/.test(text)) return false;
  return AD_PROMO.test(text) && AD_TARGET.test(text);
}

/* ── 卷首元信息 ──────────────────────────────────────────────────────── */

const AUTHOR_LINE = /^\s*作\s*者\s*[:：]\s*(.+?)\s*$/;
const SUMMARY_LINE = /^\s*(?:内容简介|作品简介|书籍简介|小说简介|简\s*介|文案)\s*[:：]?\s*$/;

/**
 * 把整篇文本解析成「元信息 + 卷 + 章节」。
 *
 * 盗版站的 txt 通常长这样：广告块、书名、作者、内容简介，然后才是
 * 第X部 / 第X章。以前这些全被当成正文塞进章节，抄起来满屏是水印。
 *
 * 两条原则：
 *   1. 广告直接丢（见 isAdLine）；
 *   2. 卷首区里**没认出来**的行不丢 —— 万一那不是元信息而是正文，
 *      丢了就找不回来了。它们会组成一个「卷首」章节。
 */
export function parseNovel(text) {
  const cleaned = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => !isAdLine(line));

  const meta = { title: '', author: '', summary: '' };
  const intro = [];              // 卷首区里没认出来的行
  let index = 0;
  let inSummary = false;

  for (; index < cleaned.length; index += 1) {
    const line = cleaned[index];
    const trimmed = line.trim();
    if (isVolumeHeading(line) || isChapterHeading(line)) break;   // 正文开始了

    if (inSummary) {
      if (trimmed) meta.summary += (meta.summary ? '\n' : '') + trimmed;
      continue;
    }
    const author = trimmed.match(AUTHOR_LINE);
    if (author) { meta.author = author[1]; continue; }
    if (SUMMARY_LINE.test(trimmed)) { inSummary = true; continue; }
    if (!trimmed) continue;
    /* 书名：卷首第一个短行，且不像"键：值"、不像正文句子。
       带冒号的一律不当书名（"类型：玄幻"这种标签太多了）。 */
    if (!meta.title && trimmed.length <= 40 && !/[:：]/.test(trimmed) && !/[。！？，]$/.test(trimmed)) {
      meta.title = trimmed;
      continue;
    }
    intro.push(line);
  }

  /* 卷首区里剩下的行：有正文就留着，组成一个「卷首」章节（绝不丢内容） */
  const rest = intro.filter(line => line.trim());

  const chapters = [];
  let volume = '';
  let current = null;
  const flush = () => { if (current) chapters.push(current); current = null; };

  if (rest.length) {
    /* 后面还有章节 → 这些是卷首的零碎信息，单列一章；
       整篇就这些（没有章节标题）→ 它就是正文本身，一个字都不能丢。 */
    current = { title: index < cleaned.length ? '卷首' : '全文', volume: '', parts: rest };
  }

  for (; index < cleaned.length; index += 1) {
    const line = cleaned[index];
    if (isVolumeHeading(line)) {
      flush();
      volume = line.trim();
      continue;
    }
    if (isChapterHeading(line)) {
      flush();
      current = { title: line.trim(), volume, parts: [] };
      continue;
    }
    if (!current) {
      if (!line.trim()) continue;
      /* 卷标之后、第一章之前冒出来的内容：挂在这一卷名下，别丢 */
      current = { title: volume || '前言', volume, parts: [] };
    }
    current.parts.push(line);
  }
  flush();

  return { title: meta.title, author: meta.author, summary: meta.summary, chapters };
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
      volume: chapter.volume || '',
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
    summary: String(book.summary || ''),
    chapters,
  };
}

/** 超长章节：先按空行分段，段太长再按字数硬切。 */
export function finalizeChapters(rawChapters) {
  const chapters = rawChapters
    .map(chapter => {
      const content = chapter.parts.join('\n').trim();
      return {
        title: chapter.title,
        volume: chapter.volume || '',
        content: content || chapter.title,
        written: '',
      };
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
        volume: chapter.volume || '',
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
 * 读一个文本文件 → 元信息 + 章节数组。编码探测在这层完成：
 * 识别不准时（左侧下拉框）会走 encodingMode 指定的编码。
 *
 * 广告、书名、作者、简介、分卷的识别都在 parseNovel 里 —— 这里只负责
 * 解码、定稿、补缩进。缩进要放在"内容定稿"之后，免得影响切分长度的判断。
 */
export async function readFileAsChapters(file, encodingMode = 'auto') {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoding = MojiEncoding.detectEncoding(bytes, encodingMode);
  const text = MojiEncoding.decodeBytes(bytes, encoding);

  const parsed = parseNovel(text);
  const chapters = finalizeChapters(parsed.chapters).map(chapter => ({
    ...chapter,
    content: indentContent(chapter.content),
  }));
  return { ...parsed, chapters, encoding };
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
