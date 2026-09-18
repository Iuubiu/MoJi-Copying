/**
 * 全局状态：书架、当前书 / 章节、设置、每日汇总、练习会话。
 *
 * 没上 Pinia：这个应用的状态是一棵小树，一个 reactive 对象 + 一组导出函数
 * 就够了，少一层概念对以后看代码的人更友好。
 *
 * 数据流与旧版一致，只是把存储换成了 Rust 后端（Tauri）或 Python 后端（浏览器）：
 *
 *   snapshot（后端镜像）──读──▶ 界面
 *        ▲                     │
 *        └────写回（api）───────┘
 *
 * 三条踩过坑的规矩（都有回归检查盯着，别改回去）：
 *   1. 速度的分子分母同口径 —— 会话中只用本次会话的字数 ÷ 本次时长；
 *   2. 退出前把未结算的会话同步写进 localStorage，下次启动补记；
 *   3. 结算只能发生一次（切后台 + 关窗口会连着触发）。
 */

import { computed, reactive } from 'vue';

import { api } from '../api/index.js';
import { MojiStats, MojiEncoding } from '../core/index.js';
import { compareWriting, normalizeBook, createBookId, hasWrittenText } from '../core/text.js';

const { dateKey, rollupDaily, finalizeSummary, emptyBucket, activeDays, currentStreak,
  longestStreak, recentDays, comparePeriods } = MojiStats;

export { MojiEncoding, hasWrittenText, createBookId };

/* ── 后端 ─────────────────────────────────────────────────────────────── */

/** 后端可用吗？连不上时界面照样能开，但要如实说明"这次的不会保存"。 */
export const backend = reactive({
  ready: false,
  host: api.host,          // 'tauri' | 'http'
  version: '',
  dbPath: '',
  empty: true,
  error: null,
  notice: '',              // 顶部的提示条文案（空则隐藏）
});

const snapshot = reactive({ books: [], progress: [], sessions: [], daily: [], settings: [] });

export const DEFAULT_SETTINGS = {
  nickname: '',
  dailyGoal: 800,
  punctLenient: true,
  /* 抄写区形态：split = 左原文右抄写；single = 只留抄写栏，原文铺成灰底稿 */
  columnMode: 'split',
};

/* ── 界面状态 ─────────────────────────────────────────────────────────── */

export const state = reactive({
  library: [],
  bookId: localStorage.getItem('ink-current-book-id') || 'default',
  chapterIndex: Number(localStorage.getItem('ink-chapter-index') || 0),
  fontSize: Number(localStorage.getItem('ink-font-size') || 18),
  view: 'workspace',
  focusMode: false,
  sepia: false,
  encoding: localStorage.getItem('ink-encoding') || 'auto',
  settings: { ...DEFAULT_SETTINGS },
  daily: {},                // date → 汇总（后端算好的物化视图）
  sessions: [],
  toast: '',
  /* 工作台的刷新信号：章节列表里重置/删除章节之后，内存里的正文已经变了，
     但抄写区是命令式写入的（不参与响应式渲染），得有人请它重读一次。
     章节列表与工作台是两个组件，中间就靠这个计数器通个气。 */
  refreshToken: 0,
});

let toastTimer = null;
export function showToast(message) {
  state.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = ''; }, 2300);
}

/** 请工作台重读当前章节（章节列表里重置/删除后必须调用，否则抄写区留着旧内容）。 */
export function requestWorkbenchRefresh() {
  state.refreshToken += 1;
}

export const currentBook = computed(() => state.library.find(entry => entry.id === state.bookId)?.book || null);
export const currentChapter = computed(() => {
  const book = currentBook.value;
  return book ? book.chapters[state.chapterIndex] || null : null;
});

export function getWritten(chapter) {
  return (chapter && chapter.written) || '';
}

/* ── 读取 ─────────────────────────────────────────────────────────────── */

export async function loadSnapshot() {
  const data = await api.bootstrap();
  snapshot.books = data.books || [];
  snapshot.progress = data.progress || [];
  snapshot.sessions = data.sessions || [];
  snapshot.daily = data.daily || [];
  snapshot.settings = data.settings || [];
}

/** 后端镜像 → 界面状态（书架拼装：书 + 进度）。 */
export function loadLibraryFromSnapshot() {
  const library = snapshot.books.map(record => {
    const book = normalizeBook(record.book, record.id);
    snapshot.progress.forEach(item => {
      if (item.bookId !== record.id) return;
      const chapter = book.chapters[item.index];
      if (!chapter) return;
      chapter.written = item.written || '';
      chapter.timeSpentMs = Math.max(chapter.timeSpentMs || 0, Number(item.elapsedMs || 0));
    });
    return { id: record.id, book };
  });

  if (!library.length) {
    // 空库：给一本内置样章，让用户一进来就有东西可抄（也会写进库）
    const seed = normalizeBook(structuredClone(DEFAULT_BOOK), 'default');
    library.push({ id: 'default', book: seed });
  }
  state.library = library;
  const selected = library.find(entry => entry.id === state.bookId) || library[0];
  state.bookId = selected.id;
  state.chapterIndex = Math.min(state.chapterIndex, Math.max(0, (selected.book.chapters.length || 1) - 1));
  localStorage.setItem('ink-current-book-id', state.bookId);
}

export function loadDailyAndSessions() {
  state.daily = {};
  snapshot.daily.forEach(record => { state.daily[record.date] = record; });
  state.sessions = [...snapshot.sessions].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  state.settings = { ...DEFAULT_SETTINGS };
  snapshot.settings.forEach(record => { state.settings[record.key] = record.value; });
}

const DEFAULT_BOOK = {
  id: 'default',
  title: '长安的荔枝',
  author: '马伯庸',
  chapters: [
    { title: '第一章 · 春风得意', content: '六月初一，长安城里已经热得像一只蒸笼。\n\n天宝十四载，杨国忠权势熏天，满朝文武都在揣摩他的心思。荔枝使却只是个不起眼的小吏，李善德站在街角，手里攥着一纸公文，额头上的汗顺着鬓角滑下来。\n\n那公文只有短短一行字：务必将岭南新鲜荔枝，送至长安。\n\n他抬头望向宫城的方向。朱红色的城墙在日光下沉默着，像一头睡着的巨兽。李善德忽然意识到，这趟差事不是送荔枝那么简单。' },
    { title: '第二章 · 驿路迢迢', content: '从长安到岭南，足有五千里。\n\n李善德翻遍了旧档，终于找到了那张驿站图。纸页已经发黄，边角还留着前人的批注。山川、河流、驿站，被细细地画在一方窄纸上。\n\n他用手指沿着路线一点点往南移，指尖停在一个叫零陵的地方。那里的荔枝，或许正红得像一盏盏小灯。' },
    { title: '第三章 · 一骑红尘', content: '快马离开驿站时，天刚蒙蒙亮。\n\n晨雾贴着地面流动，马蹄声在石板路上敲出急促的节拍。每经过一道关隘，便换一匹马；每换一次马，便要重新计算时间。\n\n李善德没有回头。他知道身后的长安正在等一只荔枝，而他要和这只荔枝一起，跑过整个盛夏。' },
  ],
};

/* ── 写入 ─────────────────────────────────────────────────────────────── */

function upsert(list, record, key = 'id') {
  const at = list.findIndex(item => item && item[key] === record[key]);
  if (at >= 0) list[at] = { ...list[at], ...record };
  else list.push(record);
}

function applyDailyRecord(record) {
  if (!record || !record.date) return;
  const hasData = Number(record.words || 0) || Number(record.durationMs || 0) || Number(record.count || 0);
  if (!hasData) {
    delete state.daily[record.date];
    snapshot.daily = snapshot.daily.filter(item => item.date !== record.date);
    return;
  }
  state.daily[record.date] = record;
  upsert(snapshot.daily, record, 'date');
}

/** 整本写入：书的元信息 + 章节正文 + 每章进度（后端在同一个事务里重排）。 */
export async function persistBook(bookId, book) {
  await api.putBook({
    id: bookId,
    book: { title: book.title, author: book.author, chapters: book.chapters },
    updatedAt: Date.now(),
  });
  upsert(snapshot.books, {
    id: bookId,
    book: { title: book.title, author: book.author, chapters: book.chapters },
    updatedAt: Date.now(),
  });
}

export async function writeProgress(bookId, index) {
  const book = state.library.find(entry => entry.id === bookId)?.book;
  const chapter = book && book.chapters[index];
  if (!chapter) return;
  const record = await api.putProgress(bookId, index, {
    written: chapter.written || '',
    elapsedMs: Number(chapter.timeSpentMs || 0),
  });
  upsert(snapshot.progress, record.progress || {
    id: `${bookId}-${index}`, bookId, index,
    written: chapter.written || '', elapsedMs: Number(chapter.timeSpentMs || 0),
  });
}

export async function saveSetting(key, value) {
  state.settings[key] = value;
  if (backend.ready) await api.putSetting(key, value);
  upsert(snapshot.settings, { key, value }, 'key');
}

/** 改书名 / 作者 / 简介：整本写回（后端在同一个事务里更新元信息与章节）。 */
export async function updateBookInfo(bookId, patch) {
  const entry = state.library.find(item => item.id === bookId);
  if (!entry) return null;
  if (patch.title !== undefined) {
    const title = String(patch.title).trim();
    if (title) entry.book.title = title;      // 空书名不接受：卡片上会变成一片空白
  }
  if (patch.author !== undefined) {
    entry.book.author = String(patch.author).trim() || '本地文本';
  }
  if (patch.summary !== undefined) {
    entry.book.summary = String(patch.summary);
  }
  await persistBook(bookId, entry.book);
  return entry.book;
}

export async function removeBook(bookId) {
  await api.deleteBook(bookId);
  snapshot.books = snapshot.books.filter(item => item.id !== bookId);
  snapshot.progress = snapshot.progress.filter(item => item.bookId !== bookId);
  state.library = state.library.filter(item => item.id !== bookId);
}

export async function clearPracticeRecords() {
  await api.clearSessions();
  snapshot.sessions = [];
  snapshot.daily = [];
  state.sessions = [];
  state.daily = {};
}

/* ── 练习会话 ─────────────────────────────────────────────────────────── */

const FLUSH_INTERVAL = 5000;      // 练习中每 5 秒静默落库
const FLUSH_IDLE_DELAY = 2000;    // 停笔 2 秒再补一次
const MIN_SPEED_SAMPLE_MS = 5000; // 样本不足 5 秒不显示速度
const PENDING_SESSION_KEY = 'moji-pending-session';

export const practice = reactive({
  active: false,
  recordId: null,
  bookId: '',
  chapterIndex: 0,
  startedAt: 0,
  dateKey: '',
  baseWords: 0,
  baseCorrect: 0,
  baseIncorrect: 0,
  storedMs: 0,        // 已入库的时长（上次落库时的会话总时长）
  storedWords: 0,     // 已入库的字数
  chapterTimeApplied: false,
  chapterMsBefore: 0,
  tick: 0,            // 每秒 +1，用来驱动"本次时长"的刷新
});

let settleTask = null;
let flushTimer = null;
let idleTimer = null;

/** 会话所属的章节：不能用 currentChapter（切章时 state 先动、落库是异步的）。 */
function practiceChapter() {
  const book = state.library.find(entry => entry.id === practice.bookId)?.book;
  return book ? book.chapters[practice.chapterIndex] : null;
}

export function sessionTotals() {
  if (!practice.active) return { words: 0, durationMs: 0, correct: 0, incorrect: 0 };
  const chapter = practiceChapter();
  if (!chapter) return { words: 0, durationMs: 0, correct: 0, incorrect: 0 };
  const written = getWritten(chapter);
  const result = compareWriting(chapter.content, written, state.settings.punctLenient);
  return {
    words: Math.max(0, written.length - practice.baseWords),
    durationMs: Math.max(0, Date.now() - practice.startedAt),
    correct: Math.max(0, result.correct - practice.baseCorrect),
    incorrect: Math.max(0, result.incorrect - practice.baseIncorrect),
  };
}

export function beginSession(baseWords) {
  if (practice.active) return;
  const chapter = currentChapter.value;
  if (!chapter) return;
  const result = compareWriting(chapter.content, getWritten(chapter), state.settings.punctLenient);
  practice.active = true;
  practice.recordId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  practice.bookId = state.bookId;
  practice.chapterIndex = state.chapterIndex;
  practice.startedAt = Date.now();
  practice.dateKey = dateKey();
  practice.baseWords = baseWords;
  practice.baseCorrect = result.correct;
  practice.baseIncorrect = result.incorrect;
  practice.storedMs = 0;
  practice.storedWords = 0;
  practice.chapterTimeApplied = false;
  practice.chapterMsBefore = 0;

  clearInterval(flushTimer);
  flushTimer = setInterval(() => { practice.tick += 1; flushSession(); }, FLUSH_INTERVAL);
  practice.tick += 1;
}

/** 落库：只读会话状态，不回写。空会话不占一条记录。 */
export async function flushSession({ final = false } = {}) {
  if (!practice.active || !backend.ready) return;
  const chapter = practiceChapter();
  if (!chapter) return;
  const totals = sessionTotals();
  if (!totals.words && !totals.durationMs) return;

  const record = {
    id: practice.recordId,
    at: Date.now(),
    date: practice.dateKey,
    bookId: practice.bookId,
    bookTitle: state.library.find(entry => entry.id === practice.bookId)?.book.title || '',
    chapterIndex: practice.chapterIndex,
    chapterTitle: chapter.title,
    words: totals.words,
    durationMs: totals.durationMs,
    correct: totals.correct,
    incorrect: totals.incorrect,
    final: Boolean(final),
  };

  try {
    snapshotPendingSession();               // 先留好退出兜底，再写库
    const result = await api.putSession(record);
    /* 落库期间用户可能已经开了新会话，这时不能把旧会话的进度写回 practice */
    if (practice.recordId === record.id) {
      practice.storedWords = totals.words;
      practice.storedMs = totals.durationMs;
    }
    upsert(snapshot.sessions, record);
    applyDailyRecord(result && result.daily);
    state.sessions = [...snapshot.sessions].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  } catch (error) {
    console.warn('[墨迹] 落库失败，稍后会再试：', error);
  }
}

/**
 * 结算：把本次会话的时长写进章节累计时长，落库并结束会话。
 * 切后台、关窗口、切章节可能在同一瞬间各触发一次，所以复用同一个任务 ——
 * 否则同一段时长会被重复加进 chapter.timeSpentMs。
 */
export function settleSession() {
  if (settleTask) return settleTask;
  if (!practice.active) return Promise.resolve();

  const recordId = practice.recordId;
  const bookId = practice.bookId;
  const totals = sessionTotals();
  const book = state.library.find(entry => entry.id === bookId)?.book;
  const chapter = book && book.chapters[practice.chapterIndex];

  if (chapter && !practice.chapterTimeApplied) {
    practice.chapterMsBefore = Number(chapter.timeSpentMs || 0);
    chapter.timeSpentMs = practice.chapterMsBefore + totals.durationMs;
    practice.chapterTimeApplied = true;
  }
  snapshotPendingSession();

  const run = (async () => {
    await flushSession({ final: true });
    practice.active = false;
    practice.recordId = null;
    practice.storedMs = 0;
    practice.storedWords = 0;
    practice.chapterTimeApplied = false;
    practice.chapterMsBefore = 0;
    clearInterval(flushTimer);
    flushTimer = null;
    if (chapter) await persistBook(bookId, book);
  })();

  settleTask = run
    .then(() => { clearPendingSession(recordId); })
    .catch(error => { console.warn('[墨迹] 结算未完成：', error); })
    .finally(() => { settleTask = null; });
  return settleTask;
}

/** 停笔一会儿落一次库（只靠 5 秒定时器，被强杀时仍可能丢掉刚写的字）。 */
export function scheduleIdleFlush() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { flushSession(); }, FLUSH_IDLE_DELAY);
}

/* ── 退出兜底 ─────────────────────────────────────────────────────────── */

/** 页面随时可能被销毁，正在飞的 IPC / fetch 会被掐断 —— 同步写一份到 localStorage。 */
export function snapshotPendingSession() {
  if (!practice.active) return null;
  const chapter = practiceChapter();
  if (!chapter) return null;
  const totals = sessionTotals();
  if (!totals.words && !totals.durationMs) return null;
  const record = {
    id: practice.recordId,
    at: Date.now(),
    date: practice.dateKey,
    bookId: practice.bookId,
    bookTitle: state.library.find(entry => entry.id === practice.bookId)?.book.title || '',
    chapterIndex: practice.chapterIndex,
    chapterTitle: chapter.title,
    words: totals.words,
    durationMs: totals.durationMs,
    correct: totals.correct,
    incorrect: totals.incorrect,
    final: false,
    /* 这段时长"结算前"的本章累计值：下次启动靠它判断有没有重复补 */
    chapterMsBefore: practice.chapterTimeApplied ? practice.chapterMsBefore : Number(chapter.timeSpentMs || 0),
  };
  try {
    localStorage.setItem(PENDING_SESSION_KEY, JSON.stringify(record));
    return record;
  } catch { return null; }
}

function readPendingSession() {
  try { return JSON.parse(localStorage.getItem(PENDING_SESSION_KEY) || 'null'); } catch { return null; }
}

function clearPendingSession(recordId) {
  try {
    if (recordId) {
      const pending = readPendingSession();
      if (pending && pending.id !== recordId) return;
    }
    localStorage.removeItem(PENDING_SESSION_KEY);
  } catch { /* 忽略 */ }
}

/** 上次退出没来得及落库的会话：补进后端（同 id 覆盖，天然幂等）。 */
export async function recoverPendingSession() {
  const pending = readPendingSession();
  if (!pending || !pending.id) { clearPendingSession(); return false; }
  if (!backend.ready) return false;
  const record = { ...pending };
  delete record.chapterMsBefore;
  try {
    const result = await api.putSession(record);
    upsert(snapshot.sessions, record);
    applyDailyRecord(result && result.daily);
    state.sessions = [...snapshot.sessions].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));

    const expectedMs = Number(pending.chapterMsBefore || 0) + Number(pending.durationMs || 0);
    const entry = state.library.find(item => item.id === pending.bookId);
    const chapter = entry && entry.book.chapters[pending.chapterIndex];
    if (chapter && Number(chapter.timeSpentMs || 0) < expectedMs - 1) {
      chapter.timeSpentMs = expectedMs;
      await persistBook(pending.bookId, entry.book);
      await writeProgress(pending.bookId, pending.chapterIndex);
    }
    clearPendingSession();
    return true;
  } catch { return false; }
}

/* ── 统计（合成层：已入库 + 进行中的增量） ─────────────────────────────── */

export function todaySummary() {
  /* 读一下 tick：会话每秒 +1，让"本次时长/速度"这类派生数字能跟着刷新 */
  void practice.tick;
  const key = dateKey();
  const record = state.daily[key] || emptyBucket();
  const bucket = { ...record };
  if (practice.active && practice.dateKey === key) {
    const totals = sessionTotals();
    bucket.words = (bucket.words || 0) + Math.max(0, totals.words - practice.storedWords);
    bucket.durationMs = (bucket.durationMs || 0) + Math.max(0, totals.durationMs - practice.storedMs);
  }
  return finalizeSummary(bucket);
}

export function composedDaily() {
  void practice.tick;
  const map = new Map();
  Object.entries(state.daily).forEach(([key, record]) => map.set(key, { ...record }));
  if (practice.active) {
    const key = practice.dateKey;
    const totals = sessionTotals();
    const merged = map.get(key) || emptyBucket();
    merged.words = (merged.words || 0) + Math.max(0, totals.words - practice.storedWords);
    merged.durationMs = (merged.durationMs || 0) + Math.max(0, totals.durationMs - practice.storedMs);
    map.set(key, merged);
  }
  return map;
}

export const stats = computed(() => {
  const map = composedDaily();
  const today = dateKey();
  const days = activeDays(map);
  return {
    lifetime: (() => {
      const first = [...days].sort()[0] || today;
      return MojiStats.summarize(map, first, today);
    })(),
    week: comparePeriods(map, today, 7),
    recent: recentDays(map, today, 7),
    streak: currentStreak(days, today),
    longest: longestStreak(days),
    today: todaySummary(),
    allDays: days,
  };
});

/** 书库整体进度（完成度按"内容长度"算，不是按字符数 —— 缩进也算进去）。 */
export function bookTotals(book) {
  if (!book) return { written: 0, total: 0, percent: 0, chaptersStarted: 0, chaptersDone: 0 };
  let written = 0;
  let total = 0;
  let started = 0;
  let done = 0;
  book.chapters.forEach(chapter => {
    const length = chapter.content.length;
    const raw = getWritten(chapter);
    /* 纯缩进不算"抄过"：章节一进来就会自动补两个全角空格，按长度算的话
       每章开局就有进度、重置之后也归不了零。口径与 chapterMetrics 保持一致。 */
    const count = hasWrittenText(raw) ? Math.min(raw.length, length) : 0;
    written += count;
    total += length;
    if (count > 0) started += 1;
    if (length > 0 && count >= length) done += 1;
  });
  return {
    written, total,
    percent: total ? Math.round((written / total) * 100) : 0,
    chaptersStarted: started,
    chaptersDone: done,
  };
}

/** 本章的实时指标（侧栏用）。速度分子分母同口径 —— 这条有回归检查盯着。 */
export function chapterMetrics(chapter) {
  if (!chapter) return null;
  const written = getWritten(chapter);
  const started = hasWrittenText(written);
  const writtenLength = started ? written.length : 0;
  const total = chapter.content.length;
  const result = compareWriting(chapter.content, written, state.settings.punctLenient);
  const elapsed = practice.active ? sessionTotals().durationMs : Number(chapter.timeSpentMs || 0);

  const speedWords = practice.active
    ? Math.max(0, (started ? written.length : 0) - practice.baseWords)
    : writtenLength;
  const speed = elapsed >= MIN_SPEED_SAMPLE_MS && speedWords
    ? Math.round(speedWords / (elapsed / 60000))
    : 0;

  return {
    writtenLength,
    total,
    percent: total ? Math.min(100, Math.round((writtenLength / total) * 100)) : 0,
    started,
    correct: result.correct,
    incorrect: result.incorrect,
    elapsed,
    speed,
  };
}

export { rollupDaily };
