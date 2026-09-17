/* 旧数据迁移回归检查（在真实页面里跑）。

   背景：旧版本把书架、进度、练习记录存在浏览器的 IndexedDB 里，
   重构后存在后端 SQLite。升级不能把用户攒下的抄写进度抹掉，
   所以 app.js 里有一条"后端是空库时把旧库整个搬过去"的路径。
   这一条最容易在重构里被漏掉，也最难靠肉眼发现（老用户才会触发）。

   用法（先起后端，再用无头浏览器附着）：
     python -m server --port 41777
     node verify/cdp-attach.js <debugPort> verify/checks-migration.js
*/
(async () => {
  const q = id => document.getElementById(id);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  const started = Date.now();
  while ((!q('sourceTrack') || q('sourceTrack').textContent.length === 0) && Date.now() - started < 15000) {
    await wait(50);
  }
  await wait(400);

  const LEGACY_DB = 'moji-copying-db';

  /* ── 1. 造一份"旧版本"的 IndexedDB（结构同 v3：六个 store 齐全） ── */
  const legacy = {
    books: [{
      id: 'legacy-book',
      book: {
        title: '旧数据样书', author: '旧版本',
        chapters: [
          { title: '旧章一', content: '旧正文一', written: '旧正' },
          { title: '旧章二', content: '旧正文二', written: '' },
        ],
      },
      updatedAt: 1700000000000,
    }],
    progress: [
      { id: 'legacy-book-0', bookId: 'legacy-book', index: 0, written: '旧正', elapsedMs: 120000, updatedAt: 1700000000000 },
    ],
    sessions: [
      { id: 'legacy-s1', at: 1700000000000, date: '2026-01-02', bookId: 'legacy-book',
        bookTitle: '旧数据样书', chapterIndex: 0, chapterTitle: '旧章一',
        words: 88, durationMs: 600000, correct: 80, incorrect: 8, final: true },
    ],
    settings: [{ key: 'nickname', value: '旧用户' }],
  };

  const seeded = await new Promise(resolve => {
    const request = indexedDB.open(LEGACY_DB, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const store = db.createObjectStore('sessions', { keyPath: 'id' });
        store.createIndex('date', 'date');
        store.createIndex('at', 'at');
        store.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('daily')) db.createObjectStore('daily', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    request.onerror = () => resolve(false);
    request.onblocked = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['books', 'progress', 'sessions', 'settings'], 'readwrite');
      legacy.books.forEach(item => tx.objectStore('books').put(item));
      legacy.progress.forEach(item => tx.objectStore('progress').put(item));
      legacy.sessions.forEach(item => tx.objectStore('sessions').put(item));
      legacy.settings.forEach(item => tx.objectStore('settings').put(item));
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
    };
  });
  record('旧版本的 IndexedDB 已就位（模拟老用户）', seeded === true, { db: LEGACY_DB });

  /* ── 2. 把后端清成空库，并清掉迁移标记：制造"第一次打开新版本"的现场 ── */
  await MojiApi.importBackup({ app: 'MoJi' }, 'overwrite');
  localStorage.removeItem('moji-migrated-to-server');
  backend.empty = true;

  const beforeHealth = await MojiApi.health();
  record('迁移前后端确实是空库', beforeHealth.empty === true, { empty: beforeHealth.empty });

  /* ── 3. 迁移 ── */
  const migrated = await migrateLegacyData();
  await wait(300);
  const afterBoot = await MojiApi.bootstrap();
  const bookIds = afterBoot.books.map(item => item.id);
  record('迁移执行成功', migrated === true, { migrated });

  const legacyBook = afterBoot.books.find(item => item.id === 'legacy-book');
  record('旧书进了后端（标题与章节都在）',
    Boolean(legacyBook) && legacyBook.book.title === '旧数据样书' && legacyBook.book.chapters.length === 2,
    legacyBook ? { title: legacyBook.book.title, chapters: legacyBook.book.chapters.length } : null);
  record('旧的抄写进度进了后端',
    afterBoot.progress.some(item => item.id === 'legacy-book-0' && item.written === '旧正'),
    { progress: afterBoot.progress.map(item => item.id) });
  record('旧的练习记录进了后端',
    afterBoot.sessions.some(item => item.id === 'legacy-s1' && item.words === 88),
    { sessions: afterBoot.sessions.map(item => item.id) });
  record('旧的设置进了后端',
    afterBoot.settings.some(item => item.key === 'nickname' && item.value === '旧用户'),
    { settings: afterBoot.settings });
  record('旧记录对应的每日汇总被后端算了出来',
    afterBoot.daily.some(item => item.date === '2026-01-02' && item.words === 88),
    { daily: afterBoot.daily });
  record('迁移后本地镜像同步更新（书架里能看到旧书）',
    snapshot.books.some(item => item.id === 'legacy-book'), { mirrorBooks: snapshot.books.length });

  /* ── 4. 幂等：再调一次不该重复搬 ── */
  const again = await migrateLegacyData();
  record('迁移只做一次（第二次直接跳过）', again === false, { again });

  /* 清场：删掉模拟出来的旧库与数据，别留给下一次检查 */
  await new Promise(resolve => {
    const request = indexedDB.deleteDatabase(LEGACY_DB);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
  await MojiApi.importBackup({ app: 'MoJi' }, 'overwrite');
  await loadSnapshot();
  localStorage.removeItem('moji-migrated-to-server');
  await loadDailyAndSessions();

  const failed = checks.filter(item => !item.ok);
  return {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map(item => item.name),
    checks,
  };
})()
