/* 墨迹 · 小说抄写工作台 —— 前端主程序
 *
 * 前后端分离：数据存在服务端（server/ + SQLite），这一层只通过 api.js
 * 读写 REST 接口，并在内存里维护一份镜像（snapshot）—— 渲染函数同步读它，
 * 不必为了画一行字去等网络。
 *
 * 分四块：
 *   1. 数据层   REST + 内存镜像（books / progress / sessions / daily / settings）
 *   2. 合成层   「已入库数据 + 实时增量」→ 界面上看到的每一个数字
 *   3. 渲染层   书架 / 正文两栏 / 校对 / 书库 / 统计 / 设置
 *   4. 交互层   键盘、滚动、会话计时与落库
 *
 * 依赖：api.js（后端客户端）、stats.js（纯计算，Node 侧有回归测试）、
 *      encoding.js（编码探测，同）
 */
const { dateKey, shiftKey, summarize, finalizeSummary, emptyBucket,
  activeDays, currentStreak, longestStreak, recentDays, comparePeriods,
  formatNumber, formatDuration, formatClock, formatPercent, formatRelativeDay } = MojiStats;

/* 旧版本把书架、进度与练习记录存在浏览器的 IndexedDB 里（v3，六个 store）。
   新版存在后端 —— 首次启动时如果后端还是空库、而旧库里还有数据，
   就整个搬过去（见下面"旧数据迁移"一节）。这几个常量只在那时用到。 */
const LEGACY_DB_NAME = 'moji-copying-db';
const LEGACY_STORES = ['books', 'progress', 'sessions', 'daily', 'settings'];
const MIGRATED_FLAG = 'moji-migrated-to-server';

const FLUSH_INTERVAL = 5000;      // 练习中每 5 秒静默落库（窗口被强杀时最多丢 5 秒）
const FLUSH_IDLE_DELAY = 2000;    // 停笔 2 秒后再落一次，把刚写的尽早写进库
const MIN_SPEED_SAMPLE_MS = 5000; // 时长样本不足 5 秒不显示速度，避免"几千字/分"的假读数
/* 退出兜底：pagehide / beforeunload 之后页面随时会被销毁，异步请求会被掐断。
   localStorage 是同步写，能在这两个事件里真正落地，所以退出前把
   "未结算的会话"整个存一份，下次启动时补进后端。 */
const PENDING_SESSION_KEY = 'moji-pending-session';
const CHAPTER_PAGE = 60;          // 章节目录一次先渲染这么多
const PROOF_LIMIT = 300;          // 校对清单最多列这么多条
const SESSION_LIST_LIMIT = 8;     // 统计页「最近 N 次练习」
const MAX_CHAPTER_CHARS = 18000;
const DEFAULT_SETTINGS = { nickname: '', dailyGoal: 800, punctLenient: true };

const defaultBook = {
  id: 'default',
  title: '长安的荔枝',
  author: '马伯庸',
  chapters: [
    { title: '第一章 · 春风得意', content: '六月初一，长安城里已经热得像一只蒸笼。\n\n天宝十四载，杨国忠权势熏天，满朝文武都在揣摩他的心思。荔枝使却只是个不起眼的小吏，李善德站在街角，手里攥着一纸公文，额头上的汗顺着鬓角滑下来。\n\n那公文只有短短一行字：务必将岭南新鲜荔枝，送至长安。\n\n他抬头望向宫城的方向。朱红色的城墙在日光下沉默着，像一头睡着的巨兽。李善德忽然意识到，这趟差事不是送荔枝那么简单。' },
    { title: '第二章 · 驿路迢迢', content: '从长安到岭南，足有五千里。\n\n李善德翻遍了旧档，终于找到了那张驿站图。纸页已经发黄，边角还留着前人的批注。山川、河流、驿站，被细细地画在一方窄纸上。\n\n他用手指沿着路线一点点往南移，指尖停在一个叫零陵的地方。那里的荔枝，或许正红得像一盏盏小灯。' },
    { title: '第三章 · 一骑红尘', content: '快马离开驿站时，天刚蒙蒙亮。\n\n晨雾贴着地面流动，马蹄声在石板路上敲出急促的节拍。每经过一道关隘，便换一匹马；每换一次马，便要重新计算时间。\n\n李善德没有回头。他知道身后的长安正在等一只荔枝，而他要和这只荔枝一起，跑过整个盛夏。' }
  ]
};

const state = {
  library: [],
  bookId: localStorage.getItem('ink-current-book-id') || 'default',
  book: null,
  chapterIndex: Number(localStorage.getItem('ink-chapter-index') || 0),
  fontSize: Number(localStorage.getItem('ink-font-size') || 18),
  view: 'workspace',
  focusMode: false,
  encoding: localStorage.getItem('ink-encoding') || 'auto',
  storageError: null,          // 后端连不上时记下原因，界面要如实说明
  settings: { ...DEFAULT_SETTINGS },
  daily: new Map(),            // 物化的每日汇总（来自 sessions）
  sessions: [],                // 最近若干次会话，统计页用
  wordsSinceFlush: 0,
  chapterRenderLimit: CHAPTER_PAGE,
  searchQuery: '',
  searchResults: null,
  sourceHighlight: null,
  proofOpen: false,
  statsMetric: 'words'
};

/* 练习会话。
   base* 一律在"写入内容之前"捕获 —— 原先把基准建在写入之后，
   第一段的字数就被当成"本来就有"，永远不会计入。
   落库路径只读这些字段，绝不回写 —— 原先进度写库会顺带重置会话起点。 */
const practice = {
  active: false,
  recordId: null,
  bookId: '', chapterIndex: 0,
  startedAt: 0,
  dateKey: '',
  baseWords: 0, baseCorrect: 0, baseIncorrect: 0,
  /* 已入库的部分：上次落库时的会话字数 / 会话总时长。
     startedAt 在整段会话里不动，所以 durationMs 一直是"本次会话总时长"，
     合成层只要减掉已入库的那部分即可，不会把同一段时长算两遍。 */
  storedMs: 0,
  storedWords: 0,
  /* 本次会话的时长是否已经加进 chapter.timeSpentMs。
     退出快照靠它算"结算前的累计值"，避免下次启动重复补时长。 */
  chapterTimeApplied: false,
  chapterMsBefore: 0,
  timer: null
};
/* 进行中的结算。visibilitychange / pagehide / 切章节可能在同一瞬间都触发一次，
   复用同一个 Promise，避免同一段时长被重复加进 chapter.timeSpentMs。 */
let settleTask = null;

function $(id) { return document.getElementById(id); }
function currentChapter() { return state.book ? state.book.chapters[state.chapterIndex] : null; }
function getWritten(chapter) { return (chapter && chapter.written) || ''; }
/* written 里除了正文还有缩进 —— 回车自动带入的、以及首行补的那两个全角空格。
   判断"用户到底写没写正文"必须把纯空白排除掉，否则刚打开章节就会显示成"正在校对"，
   caretGuide 的"从这里开始"提示也会被顶掉。 */
function hasWrittenText(written) { return /[^\s]/.test(String(written || '')); }
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function showToast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.classList.remove('show'), 2300); }

/* ========================================================================== 1. 数据层

   数据在后端（server/ + SQLite），前端只保留一份内存镜像：

     snapshot   后端全量数据的本地副本。所有渲染函数都同步读它 ——
                画一行字不该等一次网络请求。
     写路径     走 REST（api.js），成功后就地更新 snapshot；失败就把错误
                抛给调用方，由它决定是提示还是重试。

   于是前端的业务代码（渲染 / 校对 / 统计 / 快捷键）几乎不用改：
   变的是"数据放在哪"，不是"界面怎么算"。
*/
const snapshot = { books: [], progress: [], sessions: [], daily: [], settings: [] };
const backend = { ready: false, version: '', dbPath: '', empty: true };

function getAll(name) { return Promise.resolve(snapshot[name] || []); }

/* 索引查询：全量数据已经在内存里，过滤比再走一趟网络快得多。
   调用方沿用旧签名（name / index / query），不必知道底下换了实现。 */
function getAllByIndex(name, index, query) {
  return Promise.resolve((snapshot[name] || []).filter(record => record && record[index] === query));
}

function replaceSnapshot(name, records) {
  snapshot[name] = Array.isArray(records) ? records : [];
}

function upsertSnapshot(name, record, keyField = 'id') {
  const list = snapshot[name];
  if (!list || !record) return;
  const at = list.findIndex(item => item && item[keyField] === record[keyField]);
  if (at >= 0) list[at] = { ...list[at], ...record };
  else list.push(record);
}

function removeFromSnapshot(name, key, keyField = 'id') {
  const list = snapshot[name];
  if (!list) return;
  const at = list.findIndex(item => item && item[keyField] === key);
  if (at >= 0) list.splice(at, 1);
}

/* 每日汇总是 sessions 的物化视图，由后端在写入会话时同步重算、随响应带回。
   这里只负责把它同步进 state.daily —— 渲染层读的一直是那一份。 */
function applyDailyRecord(record) {
  if (!record || !record.date) return;
  const hasData = Number(record.words || 0) || Number(record.durationMs || 0) || Number(record.count || 0);
  if (!hasData) {
    removeFromSnapshot('daily', record.date, 'date');
    state.daily.delete(record.date);
    return;
  }
  upsertSnapshot('daily', record, 'date');
  state.daily.set(record.date, record);
}

/* 写记录：按存储名分发到对应的后端端点。 */
async function putRecord(name, value) {
  if (!backend.ready) throw new Error('后端未连接，数据暂时无法保存');
  if (name === 'books') {
    await MojiApi.putBook(value);
    upsertSnapshot('books', value);
    return;
  }
  if (name === 'progress') {
    const saved = await MojiApi.putProgress(value.bookId, value.index,
      { written: value.written, elapsedMs: value.elapsedMs });
    upsertSnapshot('progress', saved.progress || value);
    return;
  }
  if (name === 'sessions') {
    const result = await MojiApi.putSession(value);
    upsertSnapshot('sessions', value);
    applyDailyRecord(result && result.daily);
    return;
  }
  if (name === 'settings') {
    await MojiApi.putSetting(value.key, value.value);
    upsertSnapshot('settings', value, 'key');
    return;
  }
  throw new Error(`后端不认识这种记录：${name}`);
}

async function deleteRecord(name, key) {
  if (!backend.ready) throw new Error('后端未连接');
  if (name === 'sessions') {
    const result = await MojiApi.deleteSession(key);
    removeFromSnapshot('sessions', key);
    applyDailyRecord(result && result.daily);
    return;
  }
  if (name === 'books') {
    await MojiApi.deleteBook(key);
    removeFromSnapshot('books', key);
    for (const item of [...(snapshot.progress || [])]) {
      if (item.bookId === key) removeFromSnapshot('progress', item.id);
    }
    return;
  }
  throw new Error(`后端不支持按 id 删除：${name}`);
}

/* 清空练习记录：sessions 与 daily 一起清（后端在同一个事务里做）。 */
async function clearStore(name) {
  if (!backend.ready) throw new Error('后端未连接');
  if (name === 'sessions' || name === 'daily') {
    await MojiApi.clearSessions();
    replaceSnapshot('sessions', []);
    replaceSnapshot('daily', []);
    state.daily = new Map();
    return;
  }
  throw new Error(`后端不支持整体清空：${name}`);
}

/* 让 state.daily 与后端算好的那一份对齐。正常路径（写会话）已经由
   applyDailyRecord 同步过了，这里兜住"这天还没有任何记录"的情况。 */
async function refreshDaily(dateKeyValue) {
  const record = snapshot.daily.find(item => item.date === dateKeyValue);
  if (record) state.daily.set(dateKeyValue, record);
  else state.daily.delete(dateKeyValue);
}

/* 从后端拉全量数据填进镜像。启动时、导入备份后调用。 */
async function loadSnapshot() {
  const data = await MojiApi.bootstrap();
  replaceSnapshot('books', data.books);
  replaceSnapshot('progress', data.progress);
  replaceSnapshot('sessions', data.sessions);
  replaceSnapshot('daily', data.daily);
  replaceSnapshot('settings', data.settings);
}

function storageReady() { return backend.ready; }

/* —— 旧数据迁移 ——
   旧版本把书架、进度、练习记录存在浏览器的 IndexedDB 里，新版存在后端。
   升级后第一次打开时，如果后端还是空库、而旧库里还有内容，就整个搬过去 ——
   用户的抄写进度不该因为一次升级消失。搬完打一个 localStorage 标记，不重复搬。 */
async function migrateLegacyData() {
  if (localStorage.getItem(MIGRATED_FLAG) === '1') return false;
  if (!backend.ready) return false;
  if (!backend.empty) { localStorage.setItem(MIGRATED_FLAG, '1'); return false; }
  const legacy = await readLegacyDatabase();
  if (!legacy) return false;
  try {
    await MojiApi.importBackup({ app: 'MoJi', ...legacy }, 'overwrite');
    localStorage.setItem(MIGRATED_FLAG, '1');
    backend.empty = false;
    await loadSnapshot();
    showToast(`已把浏览器里的旧数据搬到本地数据库（${legacy.books.length} 本书）`);
    return true;
  } catch (error) {
    console.warn('[MoJi] 旧数据迁移失败，下次启动会再试：', error);
    return false;
  }
}

/* 读旧库。三种"读不到"都当没有旧数据：浏览器不支持、库不存在、
   打开卡住（本机 WebView2 上出现过 open() 一个回调都不来的情况）。 */
async function readLegacyDatabase() {
  if (!window.indexedDB) return null;
  if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases();
      if (!list.some(item => item.name === LEGACY_DB_NAME)) return null;
    } catch { /* 问不到就直接尝试打开 */ }
  }
  return new Promise(resolve => {
    let request = null;
    let timer = null;
    const finish = (value) => {
      clearTimeout(timer);
      try { if (request && request.result) request.result.close(); } catch { /* 忽略 */ }
      resolve(value);
    };
    try { request = indexedDB.open(LEGACY_DB_NAME); } catch { resolve(null); return; }
    timer = setTimeout(() => finish(null), 3000);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
    request.onsuccess = () => {
      const db = request.result;
      const names = LEGACY_STORES.filter(name => db.objectStoreNames.contains(name));
      if (!names.length) { finish(null); return; }
      const out = {};
      let left = names.length;
      const done = () => {
        if (left > 0) return;
        const hasData = (out.books || []).length > 0 || (out.sessions || []).length > 0;
        finish(hasData ? out : null);
      };
      names.forEach(name => {
        const getAllRequest = db.transaction(name, 'readonly').objectStore(name).getAll();
        getAllRequest.onsuccess = () => { out[name] = getAllRequest.result || []; left -= 1; done(); };
        getAllRequest.onerror = () => { left -= 1; done(); };
      });
    };
  });
}

/* —— 书籍 —— */
function normalizeBook(book, id) {
  const chapters = (book.chapters || []).map(chapter => {
    const raw = String(chapter.content || '');
    const written = chapter.written || '';
    return {
      title: chapter.title || '未命名章节',
      /* 首行缩进：只改「还没开始抄」的章节。
         已经抄了一部分的章节一动内容，用户已写的字就会整体错位 —— 宁可留着。 */
      content: written ? raw : indentContent(raw),
      written,
      timeSpentMs: Number(chapter.timeSpentMs || 0)
    };
  });
  return { id, title: book.title || '未命名书籍', author: book.author || '本地文本', chapters };
}

/* 给每一段补上两个全角空格缩进；空行、已有缩进的行、章节标题行都跳过。
   原稿本身没有缩进，所以每章第一行看起来是"顶格"的。 */
function indentContent(text) {
  return String(text || '').split('\n').map(line => {
    if (!line.trim()) return line;
    if (/^[ \t\u3000]/.test(line)) return line;
    if (isChapterHeading(line)) return line;
    return `\u3000\u3000${line}`;
  }).join('\n');
}

function createBookId() { return `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

async function loadLibrary() {
  const records = await getAll('books');
  if (records.length) {
    const progress = await getAll('progress');
    const library = records.map(record => {
      const book = normalizeBook(record.book, record.id);
      progress.forEach(item => {
        const matches = item.bookId === record.id
          || (!item.bookId && record.id === 'default' && String(item.id || '').startsWith('default-'));
        const chapter = matches ? book.chapters[item.index] : null;
        if (!chapter) return;
        chapter.written = item.written || '';
        chapter.timeSpentMs = Math.max(chapter.timeSpentMs || 0, Number(item.elapsedMs || 0));
      });
      return { id: record.id, book };
    });
    const selected = library.find(entry => entry.id === state.bookId) || library[0];
    return { library, currentId: selected.id };
  }

  /* 没有 books 记录：尝试从旧版 localStorage 迁移 */
  try {
    const stored = JSON.parse(localStorage.getItem('ink-library'));
    if (Array.isArray(stored) && stored.length) {
      const library = stored.map(entry => {
        const id = entry.id || createBookId();
        return { id, book: normalizeBook(entry.book || entry, id) };
      });
      await Promise.all(library.map(entry => putRecord('books', { id: entry.id, book: entry.book, updatedAt: Date.now() })));
      return { library, currentId: (library.find(e => e.id === state.bookId) || library[0]).id };
    }
    const legacy = JSON.parse(localStorage.getItem('ink-book'));
    if (legacy) {
      const id = legacy.id || 'default';
      const book = normalizeBook(legacy, id);
      await putRecord('books', { id, book, updatedAt: Date.now() });
      return { library: [{ id, book }], currentId: id };
    }
  } catch { /* 落到内置样章 */ }

  const book = normalizeBook(structuredClone(defaultBook), 'default');
  await putRecord('books', { id: 'default', book, updatedAt: Date.now() });
  return { library: [{ id: 'default', book }], currentId: 'default' };
}

async function persistBooks(bookId, book) {
  await putRecord('books', { id: bookId, book: { title: book.title, author: book.author, chapters: book.chapters }, updatedAt: Date.now() });
}

function writeProgress(bookId, index) {
  const book = state.library.find(entry => entry.id === bookId)?.book;
  const chapter = book && book.chapters[index];
  if (!chapter) return Promise.resolve();
  return putRecord('progress', {
    id: `${bookId}-${index}`, bookId, index,
    written: chapter.written || '', elapsedMs: Number(chapter.timeSpentMs || 0), updatedAt: Date.now()
  });
}

/* 章节增删会让后续章节的序号整体前移，progress 是按序号做 key 的，
   必须整本重写一遍，否则进度会错位到别的章节上。
   后端在 PUT /api/books/{id} 的同一个事务里就会"先清后写"，所以这里
   直接整本提交即可，不用再逐章删改。 */
async function rewriteProgressForBook(bookId) {
  const book = state.library.find(entry => entry.id === bookId)?.book;
  if (!book) return;
  await putRecord('books', { id: bookId, book, updatedAt: Date.now() });
}

async function deleteBookEverywhere(bookId) {
  /* 书的章节与进度由后端一并清掉（见 store.delete_book），前端只需要
     把内存镜像里的痕迹擦干净。 */
  await deleteRecord('books', bookId);
}

/* —— 会话与每日汇总 ——
   daily 是 sessions 的物化视图，由后端在写入会话的同一个事务里重算。
   前端不再自己算一遍：两处口径迟早会飘。 */
async function loadDailyAndSessions() {
  const [dailyRecords, sessionRecords, settingRecords] = await Promise.all([
    getAll('daily'), getAll('sessions'), getAll('settings')
  ]);
  state.daily = new Map();
  dailyRecords.forEach(record => state.daily.set(record.date, record));
  state.sessions = sessionRecords.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  state.settings = { ...DEFAULT_SETTINGS };
  settingRecords.forEach(record => { state.settings[record.key] = record.value; });
}

async function saveSetting(key, value) {
  state.settings[key] = value;
  if (storageReady()) await putRecord('settings', { key, value });
}

/* 界面上"存到哪儿了"的说法跟着后端状态走，不写死"本地数据库"。 */
function storageLabel() {
  return backend.ready ? '本地数据库' : '内存';
}

async function saveBook() {
  if (!state.book) return;
  const indicator = $('saveState');
  indicator.innerHTML = '<span class="save-dot saving"></span> 保存中';
  try {
    await persistBooks(state.bookId, state.book);
    indicator.innerHTML = storageReady()
      ? `<span class="save-dot"></span> 已存入${storageLabel()}`
      : '<span class="save-dot warning"></span> 已暂存';
  } catch { indicator.innerHTML = '<span class="save-dot warning"></span> 已暂存'; }
}

/* 只管写正文，不碰任何会话状态 */
async function saveChapterProgress() {
  try {
    if (storageReady()) await writeProgress(state.bookId, state.chapterIndex);
    $('saveState').innerHTML = storageReady()
      ? `<span class="save-dot"></span> 已存入${storageLabel()}`
      : '<span class="save-dot warning"></span> 已暂存';
  } catch { $('saveState').innerHTML = '<span class="save-dot warning"></span> 已暂存'; }
}
function scheduleChapterProgressSave() { clearTimeout(scheduleChapterProgressSave.timer); scheduleChapterProgressSave.timer = setTimeout(saveChapterProgress, 500); }
/* 停笔一会儿就落一次库：只靠定时器的 5 秒间隔，被强杀时仍可能丢掉刚写的字。
   连续打字时它一直被重置，不会比定时器更频繁。 */
function scheduleIdleFlush() {
  clearTimeout(scheduleIdleFlush.timer);
  scheduleIdleFlush.timer = setTimeout(() => { flushSession(); }, FLUSH_IDLE_DELAY);
}

/* ========================================================================== 2. 会话计时 */

/* 本次会话所属的章节。不能用 currentChapter()：切换章节/切换书籍是
   "先触发结算、再改 state"，而结算落库是异步的，这中间 currentChapter()
   已经漂到新章节上，会把新章节的 written 长度算成本次会话的字数。 */
function practiceChapter() {
  const book = state.library.find(entry => entry.id === practice.bookId)?.book;
  return book ? book.chapters[practice.chapterIndex] : null;
}

function sessionTotals() {
  if (!practice.active) return { words: 0, durationMs: 0, correct: 0, incorrect: 0 };
  const chapter = practiceChapter();
  if (!chapter) return { words: 0, durationMs: 0, correct: 0, incorrect: 0 };
  const written = getWritten(chapter);
  const result = compareWriting(chapter.content, written, state.settings.punctLenient);
  return {
    words: Math.max(0, written.length - practice.baseWords),
    durationMs: Math.max(0, Date.now() - practice.startedAt),
    correct: Math.max(0, result.correct - practice.baseCorrect),
    incorrect: Math.max(0, result.incorrect - practice.baseIncorrect)
  };
}

/* 本次会话"还没入库"的那部分增量由 todaySummary()/composedDaily() 直接合成，
   界面上所有数字 = 已入库的 daily + 这份增量，所以打字时数字是即时真实的。 */

function beginSession(baseWords) {
  if (practice.active) return;
  const chapter = currentChapter();
  if (!chapter) return;
  const result = compareWriting(chapter.content, getWritten(chapter), state.settings.punctLenient);
  const index = state.chapterIndex;
  practice.active = true;
  practice.recordId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  practice.bookId = state.bookId;
  practice.chapterIndex = index;
  practice.startedAt = Date.now();
  practice.dateKey = dateKey();
  practice.baseWords = baseWords;                 // 已在 handleTyping 里"写入之前"取好
  practice.baseCorrect = result.correct;
  practice.baseIncorrect = result.incorrect;
  practice.storedMs = 0;
  practice.storedWords = 0;
  practice.chapterTimeApplied = false;
  practice.chapterMsBefore = 0;
  clearInterval(practice.timer);
  practice.timer = setInterval(() => { updateMetrics(); }, 1000);
}

/* —— 退出兜底快照 ——
   pagehide / beforeunload 之后页面随时会被销毁，正在飞的 fetch 会被掐断。
   把"未结算的会话"同步写进 localStorage，下次启动时由 recoverPendingSession()
   补进后端：否则重新打开后"写了很多字、时长却几乎没涨"，统计就失真了。 */
function snapshotPendingSession() {
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
    bookTitle: (state.library.find(e => e.id === practice.bookId)?.book.title) || '',
    chapterIndex: practice.chapterIndex,
    chapterTitle: chapter.title,
    words: totals.words,
    durationMs: totals.durationMs,
    correct: totals.correct,
    incorrect: totals.incorrect,
    final: false,
    /* 这段时长"结算前"的本章累计值。下次启动用它判断这一段有没有
       已经算进 chapter.timeSpentMs —— 算过就别再补一遍。 */
    chapterMsBefore: practice.chapterTimeApplied ? practice.chapterMsBefore : Number(chapter.timeSpentMs || 0)
  };
  try { localStorage.setItem(PENDING_SESSION_KEY, JSON.stringify(record)); return record; } catch { return null; }
}

function readPendingSession() {
  try { return JSON.parse(localStorage.getItem(PENDING_SESSION_KEY) || 'null'); } catch { return null; }
}

/* 只清掉"这一次会话"的快照；期间用户已经开了新会话时不能误删 */
function clearPendingSession(recordId) {
  try {
    if (recordId) {
      const pending = readPendingSession();
      if (pending && pending.id !== recordId) return;
    }
    localStorage.removeItem(PENDING_SESSION_KEY);
  } catch { /* 忽略 */ }
}

/* 上次退出（或页面被强杀）没来得及落库的会话：补进 sessions，并把
   没算进章节累计时长的部分补上。写入用的是同一条 id，天然幂等。 */
async function recoverPendingSession() {
  const pending = readPendingSession();
  if (!pending || !pending.id) { clearPendingSession(); return false; }
  if (!storageReady()) return false;      // 存储还没就绪就先留着，下次启动再补
  const record = { ...pending };
  delete record.chapterMsBefore;
  try {
    await putRecord('sessions', record);
    await refreshDaily(record.date);
    const existing = state.sessions.find(item => item.id === record.id);
    if (existing) Object.assign(existing, record);
    else state.sessions.push(record);
    state.sessions.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
    const expectedMs = Number(pending.chapterMsBefore || 0) + Number(pending.durationMs || 0);
    const entry = state.library.find(item => item.id === pending.bookId);
    const chapter = entry && entry.book.chapters[pending.chapterIndex];
    if (chapter && Number(chapter.timeSpentMs || 0) < expectedMs - 1) {
      chapter.timeSpentMs = expectedMs;
      await persistBooks(pending.bookId, entry.book);
      await writeProgress(pending.bookId, pending.chapterIndex);
    }
    clearPendingSession();
    return true;
  } catch { return false; }   /* 写失败就留着快照，下次启动再试 */
}

/* 落库：只读会话状态，不回写。空会话（一个字没写、时长也是 0）不占一条记录。 */
async function flushSession({ final = false } = {}) {
  if (!practice.active || !storageReady()) return;
  const chapter = practiceChapter();
  if (!chapter) return;
  const totals = sessionTotals();
  if (!totals.words && !totals.durationMs) return;
  const record = {
    id: practice.recordId,
    at: Date.now(),
    date: practice.dateKey,
    bookId: practice.bookId,
    bookTitle: (state.library.find(e => e.id === practice.bookId)?.book.title) || '',
    chapterIndex: practice.chapterIndex,
    chapterTitle: chapter.title,
    words: totals.words,
    durationMs: totals.durationMs,
    correct: totals.correct,
    incorrect: totals.incorrect,
    final: Boolean(final)
  };
  try {
    snapshotPendingSession();          // 先留好退出兜底，再写库
    await putRecord('sessions', record);
    await refreshDaily(record.date);
    /* 落库期间用户可能已经开了新会话，这时不能把旧会话的进度写回 practice */
    if (practice.recordId === record.id) {
      practice.storedWords = totals.words;
      practice.storedMs = totals.durationMs;    // 已入库的时长要扣掉，否则今日时长会算两遍
    }
    const existing = state.sessions.find(item => item.id === record.id);
    if (existing) Object.assign(existing, record);
    else state.sessions.unshift(record);
    state.sessions.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
    $('saveState').innerHTML = '<span class="save-dot"></span> 已存入本地数据库';
  } catch { $('saveState').innerHTML = '<span class="save-dot warning"></span> 已暂存'; }
}

/* 结算：把本次会话的时长写进本章累计时长，落库并结束会话。
   切标签页、关窗口、切章节可能在同一瞬间各触发一次，所以复用同一个
   settleTask —— 否则同一段时长会被重复加进 chapter.timeSpentMs。
   时长的累加与退出快照都在**同步阶段**完成：pagehide 之后没机会等 await。 */
function settleSession() {
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
    clearInterval(practice.timer);
    practice.timer = null;
    if (chapter) await persistBooks(bookId, book);
  })();
  settleTask = run
    .then(() => { clearPendingSession(recordId); })
    .catch(error => { console.warn('[MoJi] 结算未完成：', error); })
    .finally(() => { settleTask = null; });
  return settleTask;
}

/* ========================================================================== 3. 合成层：界面上的数字 */

function dailyFor(key) { return state.daily.get(key) || emptyBucket(); }

function todaySummary() {
  const key = dateKey();
  const record = state.daily.get(key) || emptyBucket();
  const bucket = { ...record, chapters: record.chapters ? { ...record.chapters } : undefined };
  if (practice.active && practice.dateKey === key) {
    const totals = sessionTotals();
    bucket.words = (bucket.words || 0) + Math.max(0, totals.words - practice.storedWords);
    bucket.durationMs = (bucket.durationMs || 0) + Math.max(0, totals.durationMs - practice.storedMs);
  }
  return finalizeSummary(bucket);
}

/* 把「已入库 daily」与「进行中的会话增量」合成一张完整的每日表，
   统计页、连续天数、目标进度全部读它，保证处处一致。 */
function composedDaily() {
  const map = new Map();
  state.daily.forEach((record, key) => map.set(key, { ...record }));
  if (practice.active) {
    const key = practice.dateKey;
    const totals = sessionTotals();
    const record = map.get(key) || emptyBucket();
    const merged = { ...record };
    merged.words = (merged.words || 0) + Math.max(0, totals.words - practice.storedWords);
    merged.durationMs = (merged.durationMs || 0) + Math.max(0, totals.durationMs - practice.storedMs);
    map.set(key, merged);
  }
  return map;
}

function bookTotals(book) {
  if (!book) return { written: 0, total: 0, percent: 0, chaptersStarted: 0, chaptersDone: 0 };
  let written = 0; let total = 0; let started = 0; let done = 0;
  book.chapters.forEach(chapter => {
    const length = chapter.content.length;
    const count = getWritten(chapter).length;
    written += Math.min(count, length);
    total += length;
    if (count > 0) started += 1;
    if (length > 0 && count >= length) done += 1;
  });
  return { written, total, percent: total ? Math.round((written / total) * 100) : 0, chaptersStarted: started, chaptersDone: done };
}

function lastPracticeOfChapter(index) {
  const record = state.sessions.find(item => item.bookId === state.bookId && item.chapterIndex === index);
  return record ? record.date : '';
}

/* ========================================================================== 4. 校对 */

const PUNCT_CANON = {
  '。': '.', '、': ',', '“': '"', '”': '"', '‘': "'", '’': "'",
  '《': '<', '》': '>', '【': '[', '】': ']', '「': '"', '」': '"',
  '『': '"', '』': '"', '—': '-', '－': '-', '～': '~', '·': '.', '…': '.'
};

/* 把全角/半角、中英文引号统一到一个canonical形式，供「标点宽松」比对用 */
function canonicalChar(char) {
  if (!char) return '';
  const code = char.codePointAt(0);
  if (code === 0x3000) return ' ';                       // 全角空格 → 空格
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);  // 全角 ASCII
  return PUNCT_CANON[char] || char;
}

function charsMatch(source, typed, lenient) {
  if (source === typed) return true;
  if (!lenient) return false;
  return canonicalChar(source) === canonicalChar(typed);
}

function compareWriting(source, written, lenient = false) {
  let correct = 0; let incorrect = 0;
  const text = source || '';
  for (let index = 0; index < written.length; index += 1) {
    if (charsMatch(text[index], written[index], lenient)) correct += 1; else incorrect += 1;
  }
  return { correct, incorrect, total: written.length };
}

/* 校对清单：每一处偏差（你的字 → 原文的字） */
function differenceList(source, written, lenient = false, limit = PROOF_LIMIT) {
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
      line: lineColumnOf(text, index).line
    });
  }
  return items;
}

function lineColumnOf(text, index) {
  let line = 0; let column = 0;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') { line += 1; column = 0; } else column += 1;
  }
  return { line, column };
}

const SENTENCE_END = new Set(['。', '！', '？', '；', '…', '\n', '!', '?', ';']);

/* 光标所在句子的起止位置（按原文切句） */
function sentenceAt(text, index) {
  const content = text || '';
  let start = Math.min(index, content.length);
  while (start > 0 && !SENTENCE_END.has(content[start - 1])) start -= 1;
  let end = Math.min(index, content.length);
  while (end < content.length && !SENTENCE_END.has(content[end])) end += 1;
  if (end < content.length) end += 1;
  return { start, end, text: content.slice(start, end).trim() };
}

/* ========================================================================== 5. 排版同步（两栏对齐） */

let paneScrollTop = 0;
const paneMetrics = { lineHeight: 36, total: 0, viewHeight: 0 };
let paneCaretTarget = null;

function paneRefs() {
  const writing = $('writingArea');
  const display = $('typingDisplay');
  return {
    source: $('sourceText'), track: $('sourceTrack'), writing, display,
    stage: $('writingStage'), paper: $('writingPaper'),
    content: display ? display.querySelector('.typing-content') : null,
    guide: $('caretGuide')
  };
}
function getLineHeight() {
  const writing = $('writingArea');
  const value = writing ? parseFloat(window.getComputedStyle(writing).lineHeight) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 36;
}
function measureContentHeight(element) {
  const saved = { flex: element.style.flex, height: element.style.height, padding: element.style.paddingBottom, scroll: element.scrollTop };
  element.style.flex = '0 0 1px';
  element.style.height = '1px';
  element.style.paddingBottom = '0px';
  const measured = element.scrollHeight;
  element.style.flex = saved.flex;
  element.style.height = saved.height;
  element.style.paddingBottom = saved.padding;
  element.scrollTop = saved.scroll;
  return measured;
}
function trueContentHeight(element) {
  return element.scrollHeight > element.clientHeight ? element.scrollHeight : measureContentHeight(element);
}

function syncPaneLayout() {
  const { source, track, stage, paper, content, guide, writing } = paneRefs();
  if (!source || !stage || !paper || !content) return;
  if (!stage.clientHeight || !source.clientWidth) return;
  const lineHeight = getLineHeight();
  /* 末行留白垫在内层轨道上：flex 项无法收缩 padding，垫在 scroll 容器自己身上会把它撑开 */
  if (track) track.style.paddingBottom = '0px';
  const sourceNatural = trueContentHeight(source);
  /* 文末换行时光标落在内容盒再低一行，内容侧要跟着多算一行 */
  const tailLine = writing && writing.value.endsWith('\n') ? lineHeight : 0;
  const displayNatural = content.offsetHeight + tailLine;
  const total = Math.max(sourceNatural, displayNatural) + lineHeight;
  paper.style.width = `${source.clientWidth}px`;
  paper.style.height = `${total}px`;
  if (track) track.style.paddingBottom = `${Math.max(0, total - sourceNatural)}px`;
  paneMetrics.lineHeight = lineHeight;
  paneMetrics.total = total;
  paneMetrics.viewHeight = stage.clientHeight;
  if (guide) guide.style.width = `${source.clientWidth}px`;
}
function maxPaneScrollTop() { return Math.max(0, Math.round(paneMetrics.total - paneMetrics.viewHeight)); }
function applyPaneScroll(top) {
  const { source, stage } = paneRefs();
  if (!source || !stage) return;
  const next = Math.max(0, Math.min(Math.round(top), maxPaneScrollTop()));
  paneScrollTop = next;
  [source, stage].forEach(element => { if (Math.abs(element.scrollTop - next) >= 0.5) element.scrollTop = next; });
}
function handlePaneScroll(event) {
  const element = event.currentTarget;
  if (Math.abs(element.scrollTop - paneScrollTop) < 1) return;
  applyPaneScroll(element.scrollTop);
}
function caretContentTop(lineHeight) {
  const { content, writing } = paneRefs();
  if (!content) return 0;
  const atEnd = writing.selectionStart === writing.value.length && writing.selectionEnd === writing.value.length;
  if (atEnd) return Math.max(0, content.offsetHeight + (writing.value.endsWith('\n') ? lineHeight : 0) - lineHeight);
  const spans = content.children;
  if (!spans.length) return 0;
  const lineTop = element => Math.round(element.offsetTop / lineHeight) * lineHeight;
  const index = Math.min(writing.selectionStart, spans.length);
  if (index < spans.length) return lineTop(spans[index]);
  const last = spans[spans.length - 1];
  return lineTop(last) + (last.textContent === '\n' ? lineHeight : 0);
}
function keepCaretVisible() {
  const { writing } = paneRefs();
  if (!writing) return;
  const lineHeight = getLineHeight();
  const caretTop = caretContentTop(lineHeight);
  const needed = caretTop + lineHeight * 2 - paneMetrics.viewHeight;
  applyPaneScroll(caretTop < paneScrollTop ? caretTop : Math.max(paneScrollTop, needed));
  paneCaretTarget = paneScrollTop;
}
function settlePaneScroll() {
  const { writing, stage } = paneRefs();
  if (!writing || !stage || paneCaretTarget === null) return;
  const mark = `${writing.value.length}:${writing.selectionStart}`;
  window.requestAnimationFrame(() => {
    if (mark !== `${writing.value.length}:${writing.selectionStart}`) return;
    if (Math.abs(paneScrollTop - paneCaretTarget) >= 1 && Math.abs(paneScrollTop - paneCaretTarget) <= getLineHeight()) applyPaneScroll(paneCaretTarget);
  });
}
function refreshPaneLayout() { syncPaneLayout(); keepCaretVisible(); settlePaneScroll(); }

let lastCaretMark = '';
function syncCaretOnSelection() {
  const writing = $('writingArea');
  if (!writing) return;
  const mark = `${writing.selectionStart}:${writing.selectionEnd}`;
  if (mark === lastCaretMark) return;
  lastCaretMark = mark;
  keepCaretVisible();
  settlePaneScroll();
  renderSentenceBar();
  if (state.proofOpen) renderProofreadList();
}

/* ========================================================================== 6. 渲染 */

function renderTypedDisplay(source, written) {
  const display = $('typingDisplay');
  display.replaceChildren();
  const textarea = $('writingArea');
  const start = textarea ? textarea.selectionStart : -1;
  const end = textarea ? textarea.selectionEnd : -1;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < written.length; index += 1) {
    const char = written[index];
    const span = document.createElement('span');
    span.className = charsMatch(source[index], char, state.settings.punctLenient)
      ? 'correct' : 'incorrect';
    if (index >= start && index < end) span.className += ' selected';
    span.textContent = char;
    fragment.appendChild(span);
  }
  const content = document.createElement('div');
  content.className = 'typing-content';
  content.appendChild(fragment);
  display.append(content);
}
function refreshTypingSelection() {
  const textarea = $('writingArea');
  const display = $('typingDisplay');
  if (!textarea || !display || document.activeElement !== textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  /* 逐字 span 在 .typing-content 里面，不在 #typingDisplay 的直接子节点上 ——
     原来写成 display.children，等于只拿到那个包裹层，选中高亮从来没生效过。 */
  const spans = display.querySelector('.typing-content');
  if (!spans) return;
  Array.from(spans.children).forEach((span, index) => span.classList.toggle('selected', index >= start && index < end));
}
function updateCaretGuide() {
  const writing = $('writingArea');
  /* 只看"有没有写正文"：首行补进来的缩进不该把"从这里开始"的提示顶掉 */
  $('caretGuide').classList.toggle('hidden', hasWrittenText(writing.value) || document.activeElement === writing);
}

/* 「当前句」提示条：显示光标所在的那一句原文 */
function renderSentenceBar() {
  const chapter = currentChapter();
  const bar = $('sentenceBar');
  if (!chapter || !bar) return;
  const writing = $('writingArea');
  const caret = writing ? Math.min(writing.selectionStart, chapter.content.length) : 0;
  const sentence = sentenceAt(chapter.content, caret);
  if (!sentence.text) { bar.classList.add('empty'); $('sentenceText').textContent = '把光标放进正文，这里会显示你正在抄的那一句。'; $('sentenceMeta').textContent = ''; return; }
  bar.classList.remove('empty');
  $('sentenceText').textContent = sentence.text;
  const { line } = lineColumnOf(chapter.content, sentence.start);
  $('sentenceMeta').textContent = `第 ${line + 1} 行 · ${sentence.end - sentence.start} 字`;
}

/* 校对清单 */
function renderProofreadList() {
  const chapter = currentChapter();
  if (!chapter) return;
  const items = differenceList(chapter.content, getWritten(chapter), state.settings.punctLenient);
  const total = compareWriting(chapter.content, getWritten(chapter), state.settings.punctLenient).incorrect;
  $('proofCount').textContent = total ? `${formatNumber(total)} 处偏差` : '全部一致';
  $('proofPanel').classList.toggle('empty', items.length === 0);
  if (!items.length) {
    $('proofList').innerHTML = '<p class="proof-empty">目前没有偏差，继续保持。</p>';
    return;
  }
  const rows = items.map(item => {
    const typed = item.typed === '\n' ? '⏎' : item.typed === ' ' ? '␣' : escapeHtml(item.typed);
    const expected = item.extra ? '(多写)' : item.expected === '\n' ? '⏎' : item.expected === ' ' ? '␣' : escapeHtml(item.expected);
    return `<button class="proof-row" type="button" data-proof-index="${item.index}">
      <span class="proof-line">第 ${item.line + 1} 行</span>
      <span class="proof-typed">${typed || '(空)'}</span>
      <span class="proof-arrow">→</span>
      <span class="proof-expected ${item.extra ? 'extra' : ''}">${expected}</span>
    </button>`;
  }).join('');
  const more = total > items.length ? `<p class="proof-empty">另有 ${formatNumber(total - items.length)} 处未列出。</p>` : '';
  $('proofList').innerHTML = rows + more;
  $('proofList').querySelectorAll('[data-proof-index]').forEach(button => {
    button.addEventListener('click', () => focusWritingAt(Number(button.dataset.proofIndex)));
  });
}

/* 把光标移到指定字符位置并高亮 —— 校对清单与搜索跳转共用 */
function focusWritingAt(index) {
  const writing = $('writingArea');
  if (!writing) return;
  writing.focus();
  const at = Math.max(0, Math.min(index, writing.value.length));
  writing.setSelectionRange(at, Math.min(at + 1, writing.value.length));
  lastCaretMark = '';
  refreshTypingSelection();
  keepCaretVisible();
  syncCaretOnSelection();
  scrollSourceToChar(at);
}

/* 原文栏滚到某个字符所在行（搜索跳转要"把原文滚到对应位置"） */
function scrollSourceToChar(index) {
  const chapter = currentChapter();
  const lineHeight = getLineHeight();
  if (!chapter) return;
  const { line } = lineColumnOf(chapter.content, index);
  applyPaneScroll(line * lineHeight);
  /* 告诉 settlePaneScroll「这是我要的位置」，否则下一帧它会把光标那行再拉回来 */
  paneCaretTarget = paneScrollTop;
}

/* 原文栏的高亮标记：只包一层 <mark>，不改字号字距，两栏对齐不受影响 */
function renderSourceHighlight() {
  const chapter = currentChapter();
  const track = $('sourceTrack');
  if (!track) return;
  if (!chapter) { track.textContent = ''; return; }
  const mark = state.sourceHighlight;
  if (!mark || mark.end <= mark.start) { track.textContent = chapter.content; return; }
  const start = Math.max(0, Math.min(mark.start, chapter.content.length));
  const end = Math.max(start, Math.min(mark.end, chapter.content.length));
  track.innerHTML = `${escapeHtml(chapter.content.slice(0, start))}<mark class="source-mark">${escapeHtml(chapter.content.slice(start, end))}</mark>${escapeHtml(chapter.content.slice(end))}`;
}

/* 搜索跳转的真正落点：高亮命中片段 + 把原文栏滚到那一行。
   注意不要动输入框光标 —— 命中位置常常还没抄到，光标到不了那里，
   硬移只会被 clamp 到已写长度上，看起来"跳了个寂寞"。 */
function locateInSource(index, matchLength = 0) {
  const chapter = currentChapter();
  if (!chapter) return;
  const start = Math.max(0, Math.min(index, chapter.content.length));
  /* 高亮长度优先用调用方给的（搜索命中的关键词长度），
     拿不到才退回 state.searchResults，最后兜底一个字。 */
  const fallback = state.searchResults && state.searchResults.keyword ? state.searchResults.keyword.length : 1;
  const span = Math.max(1, Number(matchLength) || fallback);
  const end = Math.min(chapter.content.length, start + span);
  state.sourceHighlight = { start, end };
  renderSourceHighlight();
  refreshPaneLayout();
  scrollSourceToChar(start);
}

function renderBookShelf() {
  $('shelfList').innerHTML = state.library.map(entry => {
    const book = entry.book;
    const totals = bookTotals(book);
    const initials = escapeHtml(Array.from(book.title || '书').slice(0, 2).join('\n')).replace(/\n/g, '<br />');
    return `<div class="book-card ${entry.id === state.bookId ? 'active' : ''}" data-book-id="${escapeHtml(entry.id)}">
      <span class="book-cover">${initials}</span>
      <span class="book-info"><strong>${escapeHtml(book.title)}</strong><small>${escapeHtml(book.author || '本地文本')} · ${totals.percent}%</small></span>
      <button class="book-more" data-edit-book="${escapeHtml(entry.id)}" aria-label="编辑 ${escapeHtml(book.title)}" type="button">⋮</button>
    </div>`;
  }).join('');
  document.querySelectorAll('.book-card').forEach(card => card.addEventListener('click', () => selectBook(card.dataset.bookId)));
  document.querySelectorAll('[data-edit-book]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    openBookEditor(button.dataset.editBook);
  }));
  $('bookCount').textContent = String(state.library.length).padStart(2, '0');
}

function renderBookMeta() {
  const book = state.book;
  const nickname = state.settings.nickname || '抄书人';
  $('profileName').textContent = nickname;
  $('avatarInitial').textContent = Array.from(nickname)[0] || '墨';
  const goal = Number(state.settings.dailyGoal) || DEFAULT_SETTINGS.dailyGoal;
  const today = todaySummary();
  const percent = Math.min(100, Math.round((today.words / goal) * 100));
  $('goalProgress').style.width = `${percent}%`;
  $('goalText').textContent = `今天已抄 ${formatNumber(today.words)} / ${formatNumber(goal)} 字`;
  const days = activeDays(composedDaily());
  const streak = currentStreak(days, dateKey());
  $('profileStreak').textContent = `连续练习 ${streak} 天`;

  if (!book) {
    $('breadcrumbTitle').textContent = '书架为空';
    $('breadcrumbChapter').textContent = '尚未选择章节';
    $('libraryBookMeta').textContent = '还没有导入任何文本';
    return;
  }
  $('breadcrumbTitle').textContent = book.title;
  $('libraryBookMeta').textContent = `${book.title} · ${book.chapters.length} 章`;
}

function renderChapterSelect() {
  const select = $('chapterSelect');
  if (!state.book) { select.innerHTML = ''; return; }
  select.innerHTML = state.book.chapters.map((chapter, index) => `<option value="${index}">${escapeHtml(chapter.title)}</option>`).join('');
  select.value = state.chapterIndex;
}

function renderChapter() {
  const chapter = currentChapter();
  const empty = $('emptyState');
  if (!chapter) {
    $('workspaceMain').hidden = true;
    empty.hidden = false;
    return;
  }
  $('workspaceMain').hidden = false;
  empty.hidden = true;

  const written = getWritten(chapter);
  const total = chapter.content.length;
  $('breadcrumbChapter').textContent = chapter.title;
  $('pageTitle').innerHTML = escapeHtml(chapter.title).replace(' · ', ' <em>·</em> ');
  $('headingWordCount').textContent = `${formatNumber(total)} 字`;
  $('headingEstimate').textContent = `预计 ${Math.max(1, Math.ceil(total / 220))} 分钟`;
  $('lastPracticeLabel').textContent = formatRelativeDay(lastPracticeOfChapter(state.chapterIndex), dateKey());
  renderSourceHighlight();
  const writing = $('writingArea');
  writing.value = written;
  /* 首行缩进也要落进抄写栏。
     回车会自动带入下一行的缩进（见 handleWritingEnter），可**第一行前面没有回车**，
     于是原文栏顶着两个全角空格、抄写栏却从第 0 列起笔，两栏第一行对不齐，
     用户还得自己敲那两个空格。这里把原文首行的缩进直接补进抄写栏，与回车行为对齐。
     只在"正文还一个字都没写"时补：已写过内容再改会让已写的字整体错位。 */
  const lead = hasWrittenText(written) ? '' : getSourceIndent(chapter.content, 0);
  if (lead) {
    writing.value = lead;
    chapter.written = lead;
  }
  [writing, $('sourceText'), $('typingDisplay'), $('caretGuide')].forEach(el => el.style.setProperty('--copy-font-size', `${state.fontSize}px`));
  renderTypedDisplay(chapter.content, writing.value);
  refreshPaneLayout();
  updateCaretGuide();
  $('writingHint').textContent = hasWrittenText(writing.value) ? '正在校对' : '点击右侧开始输入';
  $('fontSizeLabel').textContent = state.fontSize;
  $('nextChapterName').textContent = state.book.chapters[(state.chapterIndex + 1) % state.book.chapters.length].title;
  renderSentenceBar();
  renderProofreadList();
  updateMetrics();
}

function updateMetrics() {
  const chapter = currentChapter();
  if (!chapter) return;
  const written = getWritten(chapter);
  const total = chapter.content.length;
  /* 抄写栏会自动补上首行缩进（见 renderChapter）。那两个全角空格是"替你省下的按键"，
     不是你已经写下的字 —— 正文一个字没写时各项计数按 0 走，
     否则刚打开章节就会冒出"已抄写 2 字"。
     写完时 written.length 仍等于 total，完成度照样能走到 100%。 */
  const started = hasWrittenText(written);
  const writtenLength = started ? written.length : 0;
  const percent = total ? Math.min(100, Math.round((writtenLength / total) * 100)) : 0;
  const result = compareWriting(chapter.content, written, state.settings.punctLenient);

  /* charCount 原来只在 renderChapter 里更新，而打字走的是 handleTyping，
     于是它永远停在上一次切章节时的数字。放到这里，每次打字都会重算。 */
  $('charCount').textContent = `${formatNumber(writtenLength)} / ${formatNumber(total)} 字`;

  $('progressPercent').textContent = `${percent}%`;
  $('progressRing').style.background = `conic-gradient(var(--sage) ${percent * 3.6}deg, #e9e7df 0deg)`;
  $('progressLabel').textContent = !started ? '准备开始' : percent >= 100 ? '本章完成' : `${formatNumber(writtenLength)} 字已写下`;
  $('progressSubLabel').textContent = !started ? '写下第一个字，旅程就开始了。' : percent >= 100 ? '很好，逐字校对完成。' : '黑字为正确抄写，红字提醒你回看原文。';
  $('writtenMetric').innerHTML = `${formatNumber(writtenLength)} <small>字</small>`;
  const elapsed = practice.active ? sessionTotals().durationMs : Number(chapter.timeSpentMs || 0);
  $('durationMetric').textContent = formatClock(elapsed);
  /* 速度的分子必须与分母同口径：上面显示的是"本次时长"，速度就只能算
     "本次会话写下的字 ÷ 本次会话时长"。原先进度用整章累计字数，
     重新打开软件后接着写几个字，就会拿几百上千字除以几秒钟，
     算出"几千字/分"这种假读数。样本不足 5 秒时干脆不显示。 */
  const speedWords = practice.active
    ? Math.max(0, (started ? written.length : 0) - practice.baseWords)
    : writtenLength;
  const speed = elapsed >= MIN_SPEED_SAMPLE_MS && speedWords
    ? Math.round(speedWords / (elapsed / 60000))
    : 0;
  $('speedMetric').innerHTML = speed ? `${formatNumber(speed)} <small>字/分</small>` : '— <small>字/分</small>';
  $('errorMetric').innerHTML = `${formatNumber(result.incorrect)} <small>字</small>`;
  $('modeText').textContent = practice.active ? '抄写中' : percent >= 100 ? '本章完成' : '准备就绪';
  document.querySelector('.mode-dot').classList.toggle('live', practice.active);
  renderBookMeta();
  if (state.view === 'stats') renderStats();
}

/* —— 书库 —— */
function renderLibrary() {
  const book = state.book;
  const card = $('libraryCard');
  if (!book) { card.innerHTML = '<p class="proof-empty">书架还是空的，先导入一个 .txt / .md 文件。</p>'; $('libraryProgressText').textContent = '—'; $('libraryProgressBar').style.width = '0%'; return; }

  const totals = bookTotals(book);
  $('libraryProgressText').textContent = `${formatNumber(totals.written)} / ${formatNumber(totals.total)} 字 · ${totals.percent}%（完成 ${totals.chaptersDone} 章）`;
  $('libraryProgressBar').style.width = `${totals.percent}%`;
  card.hidden = Boolean(state.searchResults);

  const limit = Math.min(state.chapterRenderLimit, book.chapters.length);
  const rows = book.chapters.slice(0, limit).map((chapter, index) => {
    const length = chapter.content.length;
    const count = getWritten(chapter).length;
    const percent = length ? Math.min(100, Math.round((count / length) * 100)) : 0;
    const time = formatDuration(chapter.timeSpentMs || 0);
    return `<div class="chapter-row ${index === state.chapterIndex ? 'active' : ''}" data-index="${index}">
      <span class="chapter-index">${String(index + 1).padStart(2, '0')}</span>
      <div class="chapter-main"><strong>${escapeHtml(chapter.title)}</strong><small>${formatNumber(length)} 字 · ${percent ? `已抄写 ${percent}%` : '尚未开始'}${chapter.timeSpentMs ? ` · ${time}` : ''}</small></div>
      <div class="chapter-progress"><span style="width:${percent}%"></span></div>
      <span class="chapter-percent">${percent}%</span>
      <div class="chapter-actions">
        <button class="chapter-action" data-reset-chapter="${index}" type="button" title="重置本章进度">重置</button>
        <button class="chapter-action danger" data-delete-chapter="${index}" type="button" title="删除本章">删除</button>
      </div>
    </div>`;
  }).join('');
  const remaining = book.chapters.length - limit;
  card.innerHTML = rows + (remaining > 0
    ? `<button class="load-more" id="loadMoreChapters" type="button">还有 ${formatNumber(remaining)} 章，点击加载</button>`
    : '');

  document.querySelectorAll('.chapter-row').forEach(row => row.addEventListener('click', () => {
    selectChapter(Number(row.dataset.index));
    switchView('workspace');
  }));
  document.querySelectorAll('[data-reset-chapter]').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    await resetChapter(Number(button.dataset.resetChapter));
  }));
  document.querySelectorAll('[data-delete-chapter]').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    await removeChapter(Number(button.dataset.deleteChapter));
  }));
  const more = $('loadMoreChapters');
  if (more) more.addEventListener('click', event => {
    event.stopPropagation();
    state.chapterRenderLimit += CHAPTER_PAGE;
    renderLibrary();
  });
}

async function resetChapter(index) {
  const chapter = state.book && state.book.chapters[index];
  if (!chapter) return;
  if (!window.confirm(`重置「${chapter.title}」的抄写进度？已抄内容会被清空，本章累计时长也会归零。`)) return;
  if (practice.active && practice.chapterIndex === index) await settleSession();
  chapter.written = '';
  chapter.timeSpentMs = 0;
  await persistBooks(state.bookId, state.book);
  await writeProgress(state.bookId, index);
  if (index === state.chapterIndex) renderChapter();
  renderLibrary(); renderStats();
  showToast('已重置本章进度');
}

async function removeChapter(index) {
  const chapter = state.book && state.book.chapters[index];
  if (!chapter) return;
  if (state.book.chapters.length <= 1) { showToast('至少要保留一章'); return; }
  if (!window.confirm(`删除「${chapter.title}」？该章正文与进度都会移除。`)) return;
  if (practice.active && practice.chapterIndex === index) await settleSession();
  state.book.chapters.splice(index, 1);
  state.chapterIndex = Math.min(state.chapterIndex, state.book.chapters.length - 1);
  localStorage.setItem('ink-chapter-index', state.chapterIndex);
  await persistBooks(state.bookId, state.book);
  await rewriteProgressForBook(state.bookId);   // 序号整体前移，必须整本重写
  renderChapterSelect(); renderChapter(); renderLibrary(); renderStats();
  showToast('章节已删除');
}

/* —— 全文搜索 —— */
function snippetAround(text, at, length) {
  const from = Math.max(0, at - 16);
  const to = Math.min(text.length, at + length + 16);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\n/g, ' ')}${to < text.length ? '…' : ''}`;
}

function searchLibrary(query) {
  const keyword = String(query || '').trim();
  if (!keyword) return null;
  const results = [];
  let total = 0;
  state.library.forEach(entry => {
    const chapters = [];
    entry.book.chapters.forEach((chapter, index) => {
      const hits = [];
      let count = 0;
      let from = 0;
      while (true) {
        const at = chapter.content.indexOf(keyword, from);
        if (at < 0) break;
        count += 1;
        if (hits.length < 3) hits.push({ at, snippet: snippetAround(chapter.content, at, keyword.length) });
        from = at + keyword.length;
      }
      if (chapter.title.includes(keyword)) { count += 1; hits.unshift({ at: -1, snippet: chapter.title, title: true }); }
      if (count) { total += count; chapters.push({ index, chapter, hits, count }); }
    });
    if (chapters.length) results.push({ bookId: entry.id, book: entry.book, chapters });
  });
  return { keyword, total, results };
}

function renderSearchResults() {
  const panel = $('searchResults');
  const data = state.searchResults;
  if (!data) { panel.hidden = true; $('libraryCard').hidden = false; return; }
  panel.hidden = false;
  $('libraryCard').hidden = true;
  if (!data.total) {
    $('searchSummary').textContent = `没有找到「${data.keyword}」`;
    panel.innerHTML = '<p class="proof-empty">换个词试试，搜索会同时匹配章节标题与正文。</p>';
    return;
  }
  $('searchSummary').textContent = `找到 ${formatNumber(data.total)} 处，分布在 ${data.results.length} 本书`;
  panel.innerHTML = data.results.map(group => `
    <div class="search-book">
      <div class="search-book-title">${escapeHtml(group.book.title)}</div>
      ${group.chapters.map(item => `
        <div class="search-chapter">
          <button class="search-chapter-head" type="button" data-search-book="${escapeHtml(group.bookId)}" data-search-chapter="${item.index}" data-search-at="-1">
            <span>${escapeHtml(item.chapter.title)}</span><em>${formatNumber(item.count)} 处</em>
          </button>
          ${item.hits.filter(hit => !hit.title).map(hit => `
            <button class="search-hit" type="button" data-search-book="${escapeHtml(group.bookId)}" data-search-chapter="${item.index}" data-search-at="${hit.at}" data-search-len="${data.keyword.length}">
              ${escapeHtml(hit.snippet)}
            </button>`).join('')}
        </div>`).join('')}
    </div>`).join('');
  panel.querySelectorAll('[data-search-at]').forEach(button => button.addEventListener('click', () => {
    jumpToSearchHit(button.dataset.searchBook, Number(button.dataset.searchChapter), Number(button.dataset.searchAt), Number(button.dataset.searchLen));
  }));
}

function jumpToSearchHit(bookId, chapterIndex, at, matchLength = 0) {
  if (state.library.find(entry => entry.id === bookId)) selectBook(bookId, { silent: true });
  selectChapter(chapterIndex, { silent: true });
  switchView('workspace');
  updateCaretGuide();
  /* at < 0 是章节标题那一行命中，正文里没有落点，只跳到该章即可 */
  if (at < 0) {
    state.sourceHighlight = null;
    inputSearchJump = null;
    renderSourceHighlight();
  } else {
    /* 等排版稳定后再定位，避免被 resize / 重新渲染覆盖 */
    inputSearchJump = { at, len: Math.max(0, Number(matchLength) || 0) };
  }
}

let inputSearchJump = null;

/* —— 统计 —— */
function renderStats() {
  const map = composedDaily();
  const today = dateKey();
  const allDays = activeDays(map);
  const streak = currentStreak(allDays, today);

  /* 累计口径 = 全部历史 */
  const firstKey = [...allDays].sort()[0] || today;
  const lifetime = summarize(map, firstKey, today);
  $('totalWordsStat').textContent = formatNumber(lifetime.words);
  const todaySummaryValue = todaySummary();
  $('totalWordsMeta').textContent = todaySummaryValue.words ? `今天 ${formatNumber(todaySummaryValue.words)} 字` : '今天尚未开始';
  $('totalTimeStat').textContent = formatDuration(lifetime.durationMs);
  $('totalTimeMeta').textContent = `共 ${formatNumber(lifetime.count)} 次练习`;
  $('avgSpeedStat').textContent = lifetime.speed ? formatNumber(lifetime.speed) : '—';
  $('avgSpeedMeta').textContent = lifetime.speed ? '按累计练习计算' : '完成一段练习后显示';
  $('streakStat').textContent = `${streak} 天`;
  $('longestStreakStat').textContent = `${longestStreak(allDays)} 天`;

  /* 最近 7 天 + 上一周期对比 */
  const week = comparePeriods(map, today, 7);
  $('statWords7').textContent = formatNumber(week.current.words);
  $('statTime7').textContent = formatDuration(week.current.durationMs);
  $('statSpeed7').textContent = week.current.speed ? `${formatNumber(week.current.speed)} 字/分` : '—';
  $('statAccuracy7').textContent = formatPercent(week.current.accuracy, 1);
  const renderChange = (elementId, change, unit = '') => {
    const element = $(elementId);
    element.classList.remove('up', 'down', 'flat');
    if (change === null) {
      element.textContent = week.current.words || week.current.durationMs ? '较上周期新增' : '与上周期持平';
      element.classList.add('flat');
      return;
    }
    if (!change) { element.textContent = '与上周期持平'; element.classList.add('flat'); return; }
    const up = change > 0;
    element.textContent = `${up ? '↑' : '↓'} ${formatPercent(Math.abs(change))} 较上周期${unit}`;
    element.classList.add(up ? 'up' : 'down');
  };
  renderChange('compareWords', week.change.words);
  renderChange('compareTime', week.change.durationMs);
  renderChange('compareSpeed', week.change.speed);
  const accuracyElement = $('compareAccuracy');
  accuracyElement.classList.remove('up', 'down', 'flat');
  if (week.change.accuracy === null) { accuracyElement.textContent = '上周期无数据'; accuracyElement.classList.add('flat'); }
  else if (!week.change.accuracy) { accuracyElement.textContent = '与上周期持平'; accuracyElement.classList.add('flat'); }
  else {
    const up = week.change.accuracy > 0;
    accuracyElement.textContent = `${up ? '↑' : '↓'} ${formatPercent(Math.abs(week.change.accuracy), 1)} 较上周期`;
    accuracyElement.classList.add(up ? 'up' : 'down');
  }
  $('weekRangeLabel').textContent = `${week.currentStart.slice(5)} ~ ${week.currentEnd.slice(5)} · 对比 ${week.previousStart.slice(5)} ~ ${week.previousEnd.slice(5)}`;

  /* 柱状图：字数 / 时长 可切换 */
  const series = recentDays(map, today, 7);
  const metric = state.statsMetric;
  const values = series.map(point => metric === 'words' ? point.words : point.durationMs);
  const unit = metric === 'words' ? '字' : '分钟';
  const shown = values.map(value => metric === 'words' ? value : Math.round(value / 60000));
  const goal = Number(state.settings.dailyGoal) || DEFAULT_SETTINGS.dailyGoal;
  const max = Math.max(...shown, metric === 'words' ? goal : 10, 1);
  $('barChart').innerHTML = shown.map((value, index) => {
    const height = value ? Math.max(20, Math.round((value / max) * 145)) : 10;
    const label = metric === 'words' ? `${formatNumber(value)} 字` : `${value} 分钟`;
    return `<div class="bar ${series[index].isToday ? 'active' : ''} ${value ? '' : 'empty'}" style="--height:${height}px" data-label="${label}"></div>`;
  }).join('');
  $('chartDays').innerHTML = series.map(point => `<span>${point.label}</span>`).join('');
  $('chartLegendLabel').textContent = metric === 'words' ? `每日抄写字数（目标 ${formatNumber(goal)}）` : '每日练习时长';

  /* 最近 N 次练习明细 */
  const liveId = practice.active ? practice.recordId : null;
  const list = [...state.sessions]
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, SESSION_LIST_LIMIT);
  if (!list.length) {
    $('sessionList').innerHTML = '<p class="proof-empty">还没有练习记录。开始抄写，这里就会出现明细。</p>';
  } else {
    const accuracyOf = record => {
      const typed = Number(record.correct || 0) + Number(record.incorrect || 0);
      return typed ? formatPercent(Number(record.correct || 0) / typed, 1) : '—';
    };
    $('sessionList').innerHTML = list.map(record => `
      <div class="session-row ${record.id === liveId ? 'live' : ''}">
        <span class="session-when">${record.id === liveId ? '进行中' : formatRelativeDay(record.date, today)}</span>
        <span class="session-book">${escapeHtml(record.bookTitle || '')} · ${escapeHtml(record.chapterTitle || '')}</span>
        <span class="session-words">${formatNumber(record.words)} 字</span>
        <span class="session-time">${formatDuration(record.durationMs)}</span>
        <span class="session-accuracy">${accuracyOf(record)}</span>
      </div>`).join('');
  }
}

/* —— 设置 —— */
function renderSettings() {
  $('nicknameInput').value = state.settings.nickname || '';
  $('goalInput').value = Number(state.settings.dailyGoal) || DEFAULT_SETTINGS.dailyGoal;
  $('punctToggle').checked = Boolean(state.settings.punctLenient);
  $('punctButton').classList.toggle('active', Boolean(state.settings.punctLenient));
  $('punctButton').textContent = state.settings.punctLenient ? '± 标点宽松' : '± 标点严格';
}

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

/* ========================================================================== 7. 操作 */

function selectBook(bookId, { silent = false } = {}) {
  const entry = state.library.find(item => item.id === bookId);
  if (!entry || entry.id === state.bookId) return;
  settleSession();
  state.bookId = entry.id;
  state.book = entry.book;
  state.chapterIndex = 0;
  state.chapterRenderLimit = CHAPTER_PAGE;
  state.sourceHighlight = null;
  localStorage.setItem('ink-current-book-id', state.bookId);
  localStorage.setItem('ink-chapter-index', '0');
  renderBookShelf(); renderBookMeta(); renderChapterSelect(); renderLibrary(); renderStats();
  if (!silent) switchView('workspace');
  else renderChapter();
}

function selectChapter(index, { silent = false } = {}) {
  if (!state.book) return;
  settleSession();
  state.chapterIndex = Math.max(0, Math.min(index, state.book.chapters.length - 1));
  state.sourceHighlight = null;
  localStorage.setItem('ink-chapter-index', state.chapterIndex);
  renderChapterSelect(); renderChapter(); renderLibrary();
  if (!silent) window.requestAnimationFrame(refreshPaneLayout);
}

let editingBookId = null;
function openBookEditor(bookId) {
  const entry = state.library.find(item => item.id === bookId);
  if (!entry) return;
  editingBookId = bookId;
  $('editBookTitle').value = entry.book.title || '';
  $('editBookAuthor').value = entry.book.author || '';
  openModal('bookEditModal');
  $('editBookTitle').focus();
}
async function saveBookMetadata() {
  if (!editingBookId) return;
  const entry = state.library.find(item => item.id === editingBookId);
  if (!entry) return;
  entry.book.title = $('editBookTitle').value.trim() || '未命名书籍';
  entry.book.author = $('editBookAuthor').value.trim() || '本地文本';
  if (editingBookId === state.bookId) state.book = entry.book;
  try {
    await persistBooks(editingBookId, entry.book);
    renderBookShelf(); renderBookMeta(); renderLibrary();
    closeModal('bookEditModal');
    editingBookId = null;
    showToast('书籍信息已保存');
  } catch { showToast('保存失败，请稍后重试'); }
}

async function deleteCurrentBook() {
  if (!editingBookId) return;
  const entry = state.library.find(item => item.id === editingBookId);
  if (!entry) return;
  if (!window.confirm(`从书架删除《${entry.book.title}》？该书的章节与进度都会一起移除，练习记录保留。`)) return;
  if (practice.active && practice.bookId === editingBookId) await settleSession();
  await deleteBookEverywhere(editingBookId);
  state.library = state.library.filter(item => item.id !== editingBookId);
  closeModal('bookEditModal');
  editingBookId = null;
  const next = state.library[0] || null;
  state.book = next ? next.book : null;
  state.bookId = next ? next.id : '';
  state.chapterIndex = 0;
  state.chapterRenderLimit = CHAPTER_PAGE;
  if (next) localStorage.setItem('ink-current-book-id', next.id); else localStorage.removeItem('ink-current-book-id');
  renderBookShelf(); renderBookMeta(); renderChapterSelect(); renderChapter(); renderLibrary(); renderStats();
  showToast('已从书架删除');
}

/* 打字：基准必须在"写入内容之前"取。
   原来先写 chapter.written 再 startTimer()，基准里已经含了刚敲的字，
   于是第一段字数永远不会被统计。 */
function handleTyping() {
  const chapter = currentChapter();
  if (!chapter) return;
  const textarea = $('writingArea');
  const next = textarea.value;
  const previousLength = getWritten(chapter).length;
  if (!practice.active && next.length) beginSession(previousLength);
  chapter.written = next;
  updateCaretGuide();
  renderTypedDisplay(chapter.content, next);
  refreshPaneLayout();
  updateMetrics();
  if (state.proofOpen) renderProofreadList();
  renderSentenceBar();
  scheduleChapterProgressSave();
  scheduleIdleFlush();
  if (state.view === 'library') renderLibrary();
}

/* —— 搜索 —— */
function runSearch() {
  const query = $('searchInput').value;
  state.searchQuery = query;
  state.searchResults = searchLibrary(query);
  renderSearchResults();
  renderLibrary();
}
function clearSearch() {
  $('searchInput').value = '';
  state.searchQuery = '';
  state.searchResults = null;
  renderSearchResults();
  renderLibrary();
}

/* —— 设置与备份 —— */
async function saveSettingsFromForm() {
  await saveSetting('nickname', $('nicknameInput').value.trim());
  const goal = Math.max(50, Math.min(100000, Number($('goalInput').value) || DEFAULT_SETTINGS.dailyGoal));
  await saveSetting('dailyGoal', goal);
  await saveSetting('punctLenient', $('punctToggle').checked);
  renderSettings(); renderBookMeta(); renderStats();
  if (state.book) { renderTypedDisplay(currentChapter().content, getWritten(currentChapter())); renderProofreadList(); updateMetrics(); }
  closeModal('settingsModal');
  showToast('设置已保存');
}

/* 导出：让后端直接给一份完整 JSON —— 它才是全量数据的事实来源。 */
async function exportBackup() {
  let payload;
  try {
    payload = await MojiApi.exportBackup();
  } catch (error) {
    showToast(`导出失败：${error.message}`);
    return;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `moji-backup-${dateKey()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast('备份已导出');
}

/* 导入：merge 按 id 合并（同 id 覆盖、新 id 追加），overwrite 先清空再写入。
   章节内容在前端统一规范化（补齐首行缩进等）之后整体交给后端 ——
   一次性迁移用的也是这条路径。daily 由后端按 sessions 重算，
   不会和备份里的旧汇总叠加。 */
async function importBackup(text, mode) {
  let payload;
  try { payload = JSON.parse(text); } catch { showToast('文件不是合法的 JSON'); return false; }
  if (!payload || payload.app !== 'MoJi' || !Array.isArray(payload.books)) { showToast('这不是墨迹的备份文件'); return false; }

  const normalized = {
    app: 'MoJi',
    books: payload.books.map(record => {
      const id = record.id || createBookId();
      return { id, book: normalizeBook(record.book || record, id), updatedAt: Date.now() };
    }),
    progress: payload.progress || [],
    sessions: payload.sessions || [],
    settings: payload.settings || []
  };
  try {
    await MojiApi.importBackup(normalized, mode);
  } catch (error) {
    showToast(`导入失败：${error.message}`);
    return false;
  }
  await loadSnapshot();

  /* 退出快照属于"当前还没结算的这一次会话"，别让它下次启动时又补一条旧记录 */
  clearPendingSession();

  return true;
}

async function clearPracticeRecords() {
  if (!window.confirm('清空全部练习记录？书架里的书与抄写进度都会保留，但统计、连续天数与每日目标进度会归零。')) return;
  try {
    await clearStore('sessions');       // sessions 与 daily 由后端一起清
  } catch (error) {
    showToast(`清空失败：${error.message}`);
    return;
  }
  clearPendingSession();
  state.sessions = [];
  state.daily = new Map();
  renderStats(); renderBookMeta();
  showToast('练习记录已清空');
}

/* —— 章节导入 —— */
const CHAPTER_HEADING = /^\s*(第\s*[零一二三四五六七八九十百千万\d]+\s*章|Chapter\s+\d+|序章|楔子|尾声)/i;
function isChapterHeading(line) { return CHAPTER_HEADING.test(line); }

function finalizeChapters(rawChapters) {
  const chapters = rawChapters.map(chapter => {
    const content = chapter.parts.join('\n').trim();
    return { title: chapter.title, content: content || chapter.title, written: '' };
  }).filter(chapter => chapter.title || chapter.content);
  if (!chapters.length) return [];
  const result = [];
  chapters.forEach(chapter => {
    if (chapter.content.length <= MAX_CHAPTER_CHARS) { result.push(chapter); return; }
    let part = ''; let partIndex = 1;
    const paragraphs = chapter.content.split(/\n{2,}/);
    const flush = () => {
      if (!part) return;
      result.push({ title: `${chapter.title} · ${String(partIndex).padStart(2, '0')}`, content: part, written: '' });
      part = ''; partIndex += 1;
    };
    paragraphs.forEach(paragraph => {
      const candidate = part ? `${part}\n\n${paragraph}` : paragraph;
      if (candidate.length > MAX_CHAPTER_CHARS && part) flush();
      if (paragraph.length > MAX_CHAPTER_CHARS) {
        for (let start = 0; start < paragraph.length; start += MAX_CHAPTER_CHARS) {
          part = paragraph.slice(start, start + MAX_CHAPTER_CHARS);
          flush();
        }
      } else part = part ? `${part}\n\n${paragraph}` : paragraph;
    });
    flush();
  });
  return result;
}

async function readFileAsChapters(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoding = MojiEncoding.detectEncoding(bytes, state.encoding);
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
  /* finalize 之后再补缩进：缩进要在"内容已经定稿"之后做，避免影响切分长度判断 */
  const chapters = finalizeChapters(rawChapters).map(chapter => ({ ...chapter, content: indentContent(chapter.content) }));
  return { chapters, encoding };
}

async function importText(file) {
  showToast(`正在读取《${file.name}》…`);
  try {
    const parsed = await readFileAsChapters(file);
    if (!parsed.chapters.length || !parsed.chapters.some(chapter => chapter.content.trim())) throw new Error('empty');
    settleSession();
    const id = createBookId();
    const title = file.name.replace(/\.(txt|md|text)$/i, '').trim() || '未命名小说';
    const book = normalizeBook({ title, author: '本地文本', chapters: parsed.chapters }, id);
    state.library.push({ id, book });
    state.bookId = id;
    state.book = book;
    state.chapterIndex = 0;
    state.chapterRenderLimit = CHAPTER_PAGE;
    localStorage.setItem('ink-current-book-id', id);
    localStorage.setItem('ink-chapter-index', '0');
    await persistBooks(id, book);
    await writeProgress(id, 0);
    renderBookShelf(); renderBookMeta(); renderChapterSelect(); renderChapter(); renderLibrary(); renderStats();
    $('fileInput').value = '';
    switchView('workspace');
    showToast(`已导入《${book.title}》，${book.chapters.length} 个章节（${MojiEncoding.encodingLabel(parsed.encoding)}）`);
  } catch {
    $('fileInput').value = '';
    showToast('导入失败，请切换 TXT 编码后重试');
  }
}

/* —— 输入辅助：回车带缩进、退格删缩进 —— */
function getSourceIndent(source, index) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const match = source.slice(lineStart).match(/^[ \t\u3000]*/);
  return match ? match[0] : '';
}
function handleWritingEnter(event) {
  if (event.key !== 'Enter' || event.isComposing) return;
  const textarea = event.currentTarget;
  const { selectionStart: start, selectionEnd: end } = textarea;
  if (start !== end) return;
  const chapter = currentChapter();
  if (!chapter) return;
  if (chapter.content[start] !== '\n') return;
  const indent = getSourceIndent(chapter.content, start + 1);
  if (!indent) return;
  event.preventDefault();
  textarea.setRangeText(`\n${indent}`, start, end, 'end');
  handleTyping();
}
function handleWritingBackspace(event) {
  if (event.key !== 'Backspace' || event.isComposing) return;
  const textarea = event.currentTarget;
  const { selectionStart: start, selectionEnd: end } = textarea;
  if (start !== end || start === 0) return;
  const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
  const indent = textarea.value.slice(lineStart, start);
  if (!indent || !/^[ \t\u3000]+$/.test(indent)) return;
  const chapter = currentChapter();
  if (!chapter || indent !== getSourceIndent(chapter.content, start)) return;
  event.preventDefault();
  textarea.setRangeText('', lineStart > 0 ? lineStart - 1 : lineStart, start, 'start');
  handleTyping();
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  $(`${view}View`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  if (view === 'stats') renderStats();
  if (view === 'library') renderLibrary();
  if (view === 'workspace') window.requestAnimationFrame(() => {
    refreshPaneLayout();
    if (inputSearchJump) { locateInSource(inputSearchJump.at, inputSearchJump.len); inputSearchJump = null; }
  });
}

/* ========================================================================== 8. 绑定与启动 */

function bindEvents() {
  const noticeClose = $('storageNoticeClose');
  if (noticeClose) noticeClose.addEventListener('click', () => { $('storageNotice').hidden = true; });
  $('importButton').addEventListener('click', () => $('fileInput').click());
  $('libraryImportButton').addEventListener('click', () => $('fileInput').click());
  $('mobileImportButton').addEventListener('click', () => $('fileInput').click());
  $('emptyImportButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => { if (event.target.files[0]) importText(event.target.files[0]); });
  $('encodingSelect').value = state.encoding;
  $('encodingSelect').addEventListener('change', event => {
    state.encoding = event.target.value;
    localStorage.setItem('ink-encoding', state.encoding);
  });

  $('saveBookMeta').addEventListener('click', saveBookMetadata);
  $('deleteBookButton').addEventListener('click', deleteCurrentBook);
  $('chapterSelect').addEventListener('change', event => selectChapter(Number(event.target.value)));

  const writing = $('writingArea');
  writing.addEventListener('focus', () => { updateCaretGuide(); refreshTypingSelection(); });
  writing.addEventListener('blur', () => { updateCaretGuide(); scheduleChapterProgressSave(); });
  writing.addEventListener('keydown', handleWritingEnter);
  writing.addEventListener('keydown', handleWritingBackspace);
  writing.addEventListener('input', handleTyping);
  writing.addEventListener('select', () => { refreshTypingSelection(); syncCaretOnSelection(); });
  writing.addEventListener('keyup', () => { refreshTypingSelection(); syncCaretOnSelection(); });
  writing.addEventListener('click', () => { refreshTypingSelection(); syncCaretOnSelection(); });
  writing.addEventListener('scroll', handlePaneScroll);
  $('writingStage').addEventListener('scroll', handlePaneScroll);
  $('sourceText').addEventListener('scroll', handlePaneScroll);
  document.addEventListener('selectionchange', refreshTypingSelection);
  window.addEventListener('resize', () => { refreshPaneLayout(); window.requestAnimationFrame(refreshPaneLayout); });

  /* 切标签页 / 关页面 → 结算当前练习，避免时长与字数丢失。
     settleSession 是异步的，页面被销毁时可能只跑到一半，所以再同步写一份
     "未结算会话"快照（见 snapshotPendingSession）；progress 也直接写，
     500ms 的防抖在这里等不到。 */
  document.addEventListener('visibilitychange', () => { if (document.hidden) { settleSession(); snapshotPendingSession(); } });
  window.addEventListener('pagehide', () => { settleSession(); saveChapterProgress(); snapshotPendingSession(); });
  window.addEventListener('beforeunload', () => { snapshotPendingSession(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => refreshPaneLayout()).catch(() => {});

  $('startButton').addEventListener('click', () => {
    const chapter = currentChapter();
    if (!chapter) return;
    if (!practice.active) beginSession(getWritten(chapter).length);
    writing.focus();
    showToast('抄写开始，保持你的节奏');
  });
  $('nextButton').addEventListener('click', () => {
    if (state.book) selectChapter((state.chapterIndex + 1) % state.book.chapters.length);
  });

  $('fontDown').addEventListener('click', () => { state.fontSize = Math.max(15, state.fontSize - 1); localStorage.setItem('ink-font-size', state.fontSize); renderChapter(); });
  $('fontUp').addEventListener('click', () => { state.fontSize = Math.min(24, state.fontSize + 1); localStorage.setItem('ink-font-size', state.fontSize); renderChapter(); });
  $('zenButton').addEventListener('click', () => {
    document.body.classList.toggle('sepia-mode');
    showToast(document.body.classList.contains('sepia-mode') ? '已切换护眼色' : '已恢复默认色');
  });
  $('focusButton').addEventListener('click', () => {
    state.focusMode = !state.focusMode;
    document.body.classList.toggle('focus-mode', state.focusMode);
    window.requestAnimationFrame(refreshPaneLayout);
    showToast(state.focusMode ? '已进入专注模式' : '已退出专注模式');
  });

  /* 标点宽松开关 */
  $('punctButton').addEventListener('click', async () => {
    await saveSetting('punctLenient', !state.settings.punctLenient);
    renderSettings();
    const chapter = currentChapter();
    if (chapter) {
      renderTypedDisplay(chapter.content, getWritten(chapter));
      renderProofreadList();
      updateMetrics();
    }
    showToast(state.settings.punctLenient ? '标点按宽松比对：全角/半角、中英文引号不再算错' : '标点按严格比对');
  });

  /* 校对清单 */
  $('proofButton').addEventListener('click', () => {
    state.proofOpen = !state.proofOpen;
    $('proofPanel').hidden = !state.proofOpen;
    $('proofButton').classList.toggle('active', state.proofOpen);
    if (state.proofOpen) renderProofreadList();
    window.requestAnimationFrame(refreshPaneLayout);
  });
  $('proofClose').addEventListener('click', () => {
    state.proofOpen = false;
    $('proofPanel').hidden = true;
    $('proofButton').classList.remove('active');
    window.requestAnimationFrame(refreshPaneLayout);
  });

  /* 搜索 */
  $('searchButton').addEventListener('click', runSearch);
  $('searchClear').addEventListener('click', clearSearch);
  $('searchInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); runSearch(); }
    if (event.key === 'Escape') clearSearch();
  });
  $('toolbarSearchButton').addEventListener('click', () => {
    switchView('library');
    $('searchInput').focus();
    $('searchInput').select();
  });

  /* 统计图切换 */
  document.querySelectorAll('[data-stats-metric]').forEach(button => button.addEventListener('click', () => {
    state.statsMetric = button.dataset.statsMetric;
    document.querySelectorAll('[data-stats-metric]').forEach(el => el.classList.toggle('active', el === button));
    renderStats();
  }));

  /* 设置 */
  $('settingsButton').addEventListener('click', () => { renderSettings(); openModal('settingsModal'); });
  $('saveSettings').addEventListener('click', saveSettingsFromForm);
  $('exportButton').addEventListener('click', exportBackup);
  $('backupInput').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const mode = $('importModeOverwrite').checked ? 'overwrite' : 'merge';
    const ok = await importBackup(await file.text(), mode);
    event.target.value = '';
    if (!ok) return;
    const loaded = await loadLibrary();
    state.library = loaded.library;
    state.bookId = loaded.currentId;
    state.book = state.library.find(entry => entry.id === state.bookId)?.book || null;
    state.chapterIndex = Math.min(state.chapterIndex, Math.max(0, (state.book?.chapters.length || 1) - 1));
    await loadDailyAndSessions();
    renderBookShelf(); renderBookMeta(); renderChapterSelect(); renderChapter(); renderLibrary(); renderStats(); renderSettings();
    closeModal('settingsModal');
    showToast(mode === 'overwrite' ? '已用备份覆盖本地数据' : '已合并备份数据');
  });
  $('clearRecords').addEventListener('click', clearPracticeRecords);

  $('helpButton').addEventListener('click', () => openModal('helpModal'));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => {
    if (event.target === backdrop) backdrop.hidden = true;
  }));
  document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => switchView(item.dataset.view)));

  document.addEventListener('keydown', event => {
    if (event.key === 'Tab' && document.activeElement === writing && state.book) {
      event.preventDefault();
      selectChapter((state.chapterIndex + 1) % state.book.chapters.length);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && state.book) {
      event.preventDefault();
      const chapter = currentChapter();
      chapter.written = chapter.content;
      /* textarea 要一起同步：handleTyping 读的是 textarea.value，
         不同步的话刚设好的完整正文会被旧值覆盖回去，"完成本章"就白点了。 */
      writing.value = chapter.content;
      handleTyping();
      settleSession();
      saveChapterProgress();
      renderChapter(); renderLibrary(); renderStats();
      showToast('本章已标记完成');
    }
    if (event.key === 'Escape') {
      const open = document.querySelector('.modal-backdrop:not([hidden])');
      if (open) { open.hidden = true; return; }
      if (state.proofOpen) { $('proofClose').click(); return; }
      if (state.focusMode) {
        state.focusMode = false;
        document.body.classList.remove('focus-mode');
        window.requestAnimationFrame(refreshPaneLayout);
        showToast('已退出专注模式');
      }
    }
  });
}

/* 把旧版 localStorage 里的 practiceLog 迁进 sessions（只迁一次）。
   老记录没有正确/错误字数，导入时以 0 计，这样它们只影响字数与时长，
   不会把正确率算歪。 */
async function migrateLegacyPracticeLog() {
  if (state.settings.migratedPracticeLog) return;
  const existing = await getAll('sessions');
  if (existing.length) { await saveSetting('migratedPracticeLog', true); return; }
  const migrated = [];
  state.library.forEach(entry => {
    const log = entry.book && entry.book.practiceLog;
    if (!Array.isArray(log) || !log.length) return;
    log.forEach((record, index) => {
      if (!record || !record.date) return;
      migrated.push({
        id: `legacy-${entry.id}-${record.at || record.date}-${index}`,
        at: Number(record.at) || Date.parse(`${record.date}T12:00:00`),
        date: record.date,
        bookId: entry.id,
        bookTitle: entry.book.title,
        chapterIndex: Number(record.chapterIndex || 0),
        chapterTitle: (entry.book.chapters[record.chapterIndex] || {}).title || '',
        words: Number(record.words || 0),
        durationMs: Number(record.durationMs || 0),
        correct: 0, incorrect: 0, final: true, legacy: true
      });
    });
    delete entry.book.practiceLog;
  });
  if (migrated.length) {
    /* 逐条写入（daily 由后端随每条会话重算）。顺序写而不是并发：
       这一段只在首次升级时跑一次，稳比快重要。 */
    for (const record of migrated) await putRecord('sessions', record);
    await Promise.all(state.library.map(entry => persistBooks(entry.id, entry.book)));
  }
  await saveSetting('migratedPracticeLog', true);
}

/* 启动报告：把"我从页面里看到的初始化结果"如实报给外壳。

   外壳的自检要靠它判断"页面是不是真的在 WebView2 里跑到底了"，
   所以报告里带的都是能被外部核对的硬事实（脚本是否挂上、正文有没有渲染、
   纸面高度有没有守住末行留白不变量），不是一句"我好了"。

   通道有两条，都试：
     1) 桌面外壳注入的 window.pywebview.api（有就用，纯锦上添花）
     2) 往本机静态服务 POST /__boot-report —— 这条不依赖外壳的注入，
        是本机 http 页面自己就能做到的事，所以稳定得多。
        网页版（非本机 http）不会发，服务端也没有这个端点，天然不影响。
*/
/* 启动走到哪一步了。外壳的自检靠它区分"还没跑完""跑到底了""哪一步炸了"，
   否则启动失败在外壳看来只是"窗口开着、什么都没发生"。 */
let bootStage = 'idle';
let bootError = null;
const bootStages = [];            // 走过的全部阶段，供外壳核对（最新一节可能丢包）
const REPORT_BURST_MS = 600;      // 补报间隔
const REPORT_BURST_COUNT = 20;    // 补报拍数 ≈ 12 秒，够外壳收下任意一拍
const REPORT_READY_REPEAT = 6;    // 终态那一拍多发几遍（解析期是唯一可靠窗口）

/* 后端连不上时的提示。界面照常能打开（静态资源是同一个服务给的），
   但数据存不下来 —— 用户有权知道，而不是以为一切如常。 */
function notifyBackendDown() {
  const notice = $('storageNotice');
  const detail = state.storageError ? String(state.storageError.message || state.storageError) : '';
  showToast('连不上本地数据库服务，本次抄写不会被保存');
  if (notice) {
    notice.hidden = false;
    notice.dataset.level = 'warn';
    notice.querySelector('[data-notice-text]').textContent =
      `连不上本地数据库服务，抄写记录不会保存。请用「python -m server」启动后端，或使用桌面版。${detail ? `（${detail}）` : ''}`;
  }
  if (detail) console.warn('[MoJi] 后端不可用：', detail);
}

function buildBootReport() {
  const stage = $('writingStage');
  const writing = $('writingArea');
  const track = $('sourceTrack');
  const paper = $('writingPaper');
  const content = document.querySelector('.typing-content');
  const lineHeight = writing ? parseFloat(getComputedStyle(writing).lineHeight) : 0;
  const sourceHeight = track ? track.offsetHeight - (parseFloat(track.style.paddingBottom) || 0) : 0;
  const paperHeight = paper ? parseFloat(paper.style.height) || 0 : 0;
  return {
    stage: bootStage,
    /* 走过的阶段清单 + 是否已经完成 ready。
       外壳只靠"最新一拍"会误判：信标可能整批被丢，若收到的第一份
       已经是 storage 拍，只看 stage 就会以为没到过 ready。 */
    stages: bootStages.slice(),
    ready: bootStages.includes('ready'),
    loadFired: window.__mojiLoadFired === true,
    bootError: bootError ? String(bootError && bootError.stack || bootError) : null,
    origin: location.origin,
    readyState: document.readyState,
    renderChapter: typeof renderChapter === 'function',
    statsModule: typeof MojiStats === 'object' && typeof MojiStats.rollupDaily === 'function',
    encodingModule: typeof MojiEncoding === 'object' && typeof MojiEncoding.detectEncoding === 'function',
    apiModule: typeof MojiApi === 'object' && typeof MojiApi.bootstrap === 'function',
    indexedDb: typeof indexedDB === 'object',      // 环境事实：迁移旧数据时要用它
    fileInput: Boolean($('fileInput')),
    dbOpen: backend.ready,
    dbMode: backend.ready ? 'sqlite' : 'down',
    dbPath: backend.dbPath || '',
    backendVersion: backend.version || '',
    storageError: state.storageError ? String(state.storageError.message || state.storageError) : null,
    chapters: state.book ? state.book.chapters.length : 0,
    chapterTitle: currentChapter() ? currentChapter().title : '',
    view: state.view || 'workspace',
    sourceLength: track ? track.textContent.length : 0,
    stageHeight: stage ? stage.clientHeight : 0,
    paperHeight,
    /* 布局不变量：纸面高 = max(原文高, 已抄高) + 一整行（末行留白） */
    paperInvariant: Boolean(lineHeight && paper)
      && Math.abs(paperHeight - (Math.max(sourceHeight, content ? content.offsetHeight : 0) + lineHeight)) < 1,
    errors: window.__mojiErrors || []
  };
}

/* 每个阶段都发一次信标：启动万一卡住，外壳能直接看出卡在哪一段，
   而不是只看到"窗口开着、什么都没发生"。 */
function announceDesktopReady(stage) {
  if (stage) {
    bootStage = stage;
    if (!bootStages.includes(stage)) bootStages.push(stage);
  }
  const terminal = bootStage === 'ready' || bootStage === 'boot-error';
  /* 终态那一拍是外壳唯一必须收到的信号，而实测它能被送出去的窗口很短：
     页面大约在加载后 2.4 秒就不再推进 JS（用不加载应用代码的探针反复量过），
     解析期发出的请求才是稳的。所以终态刻意多发几遍（每遍一个独立 URL）；
     中间阶段发一遍就够，不白占调度。 */
  sendBootBeacon(terminal ? REPORT_READY_REPEAT : 1);
  if (!terminal) return;
  announceToShell(buildBootReport());
}

function sendBootBeacon(repeat = 1) {
  const report = buildBootReport();
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const encoded = encodeURIComponent(JSON.stringify(report));
  const stamp = Date.now();
  for (let index = 0; index < repeat; index += 1) {
    /* 每遍都要是**不同的 URL**：完全相同的图片 URL 会被合并/去重，
       那样"多发几遍"就等于只发了一遍。
       两条互相独立的通道各走一次：Image 信标最原始、最不容易被拦；
       fetch(keepalive) 是另一条路径。 */
    const url = `/__boot-report?d=${encoded}&n=${index}.${stamp}`;
    try {
      const beacon = new Image();
      beacon.src = url;
    } catch { /* 服务端没有这个端点时忽略 */ }
    if (index === 0) {
      try {
        fetch(url, { keepalive: true, mode: 'no-cors' }).catch(() => {});
      } catch { /* 同上 */ }
    }
  }
}

let shellAcked = false;
/* 顺手报给 pywebview 注入的桥（有则更好，没有也不影响信标）。
   不做内部重试 —— 外面有补报循环，这里再套一层定时器只会互相叠加。 */
function announceToShell(report) {
  if (shellAcked) return;
  const bridge = window.pywebview && window.pywebview.api;
  if (!bridge || typeof bridge.app_ready !== 'function') return;
  try {
    Promise.resolve(bridge.app_ready(report)).then(() => { shellAcked = true; }).catch(() => {});
  } catch { /* 外壳不在时忽略 */ }
}

/* 本机服务端到底有没有 /__boot-report 这个端点？
   只在"有"的时候才开补报循环，网页版不会白白刷一串 404。 */
async function reportChannelAvailable() {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
  try {
    const response = await fetch('/__boot-report?probe=1', { cache: 'no-store' });
    return response.ok;
  } catch { return false; }
}

/* 密集补报。
   页面没法知道"外壳收到没"，而实测这条通道会把请求攒批、延迟数秒、
   甚至整批丢掉 —— 只发一次就是把成败交给运气（窗口开着、页面跑得好好的，
   外壳却判成启动失败）。所以补报一段时间，外壳收下任意一拍就够；
   之后停掉，不长期刷日志。 */
async function startReportLoop() {
  if (!(await reportChannelAvailable())) return;
  let count = 0;
  const tick = () => {
    count += 1;
    sendBootBeacon();
    announceToShell(buildBootReport());
    if (count < REPORT_BURST_COUNT) setTimeout(tick, REPORT_BURST_MS);
  };
  setTimeout(tick, 0);
}

async function boot() {
  announceDesktopReady('boot-start');
  startReportLoop();
  /* load 之后再报一次，并在报告里留一个**粘性**标记：
     报告内容是在发送时刻现算的，而实测能送到的往往是解析期那一拍 ——
     那时 readyState 还是 loading。用一次性标记代替直接读 readyState，
     后续任何一拍被收到都能带出"页面确实加载完了"这个事实。 */
  window.addEventListener('load', () => {
    window.__mojiLoadFired = true;
    sendBootBeacon();
  });
  try {
    return await bootInner();
  } catch (error) {
    /* 启动失败不能悄悄咽掉：往外壳报一个 boot-error（带上堆栈），
       否则桌面端只表现为"窗口开着但一片空白"，无从下手。 */
    bootError = error;
    announceDesktopReady('boot-error');
    throw error;
  }
}

/* 第一屏所需的一切。**不含任何 await** ——
   用户看到窗口的瞬间就该有内容，而不是先盯着一片空白等数据库。
   本机 WebView2 上这条尤其重要：信标通道会随驻留时间变差，
   越早报"启动完成"，越可能被外壳收到。 */
function paintShell() {
  renderSettings();
  renderBookShelf();
  renderBookMeta();
  renderChapterSelect();
  renderChapter();
  renderLibrary();
  renderStats();
}

/* ── 第二拍：接上后端 ──
   拆成独立函数，是因为它整段失败都**不该**把"启动成功"改判成失败：
   第一屏已经画好了，界面本来就能用。 */
async function hydrateFromStorage() {
  announceDesktopReady('db-open');
  try {
    const info = await MojiApi.health();
    backend.ready = true;
    backend.version = info.version || '';
    backend.dbPath = info.dbPath || '';
    backend.empty = Boolean(info.empty);
  } catch (error) {
    /* 后端连不上（服务没起 / 端口不通）不是致命错误：界面照常打开，
       但要让用户看得见"这次的东西存不下来"，不能悄悄装作没事。 */
    backend.ready = false;
    state.storageError = error;
  }
  if (!backend.ready) {
    notifyBackendDown();
  } else {
    await loadSnapshot();
    announceDesktopReady('library');
    /* 老用户第一次打开新版本：后端还是空库时，把浏览器里的旧数据搬过来 */
    await migrateLegacyData();
  }
  announceDesktopReady('library');
  const loaded = await loadLibrary();
  state.library = loaded.library;
  state.bookId = loaded.currentId;
  state.book = state.library.find(entry => entry.id === state.bookId)?.book || state.library[0]?.book || null;
  if (state.book) localStorage.setItem('ink-current-book-id', state.bookId);
  state.chapterIndex = Math.min(state.chapterIndex, Math.max(0, (state.book?.chapters.length || 1) - 1));

  announceDesktopReady('history');
  await loadDailyAndSessions();
  await migrateLegacyPracticeLog();
  await loadDailyAndSessions();
  /* 上次退出（或页面被强杀）没来得及落库的会话在这里补上：
     sessions / daily / 章节累计时长一起补齐，统计口径才不会失真。 */
  await recoverPendingSession();

  announceDesktopReady('render');
  paintShell();
}

async function bootInner() {
  /* ── 第一拍：同步渲染，不等任何异步 ──
     用户看到窗口的瞬间就该有内容，而不是先盯着一片空白等数据库。
     本机 WebView2 上这条尤其重要：页面→外壳的信标通道会随驻留时间变差
     （实测上报会被攒批、延迟数秒），越早报"启动完成"越收得到。 */
  const seedBook = normalizeBook(structuredClone(defaultBook), 'default');
  state.library = [{ id: 'default', book: seedBook }];
  state.bookId = 'default';
  state.book = seedBook;
  state.chapterIndex = Math.min(state.chapterIndex, seedBook.chapters.length - 1);
  paintShell();
  bindEvents();
  /* 练习中每 5 秒静默落库（只写库，不碰会话状态）。
     必须只注册这一次 —— paintShell 会被调用两遍，事件绑定和定时器不能。 */
  setInterval(() => { if (practice.active) flushSession(); }, FLUSH_INTERVAL);
  announceDesktopReady('ready');

  /* ── 第二拍：后端。连不上只提示，不翻案 ── */
  try {
    await hydrateFromStorage();
  } catch (error) {
    state.storageError = state.storageError || error;
    backend.ready = false;
    console.warn('[MoJi] 后端初始化失败，界面继续可用：', error);
  }
  /* 存储这一拍单独报一次，外壳据此记录"实际用的是哪种后端"。
     它排在 ready 之后，所以即使这条信标丢了，也不影响"启动成功"的判定。 */
  announceDesktopReady('storage');
}

boot();
