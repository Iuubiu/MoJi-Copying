/* 功能与缺陷回归检查（在真实页面里跑）。
   覆盖：启动无错、四个界面缺陷、校对增强、当前句、全文搜索、章节增量渲染、
   会话基准（首段不漏统计）、标点宽松、后端数据层。

   用法（先起后端，再用无头浏览器附着）：
    python -m server --port 41777
    node verify/cdp-attach.js <debugPort> verify/checks-features.js
*/
(async () => {
  const q = id => document.getElementById(id);
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });
  const round = v => Math.round(v * 100) / 100;
  /* 核对"数据真的落到服务端了"用：直接问后端，不问内存镜像 ——
     否则测的只是"前端自己以为写好了"。 */
  const apiGet = path => fetch(path, { cache: 'no-store' }).then(response => response.json());

  const started = Date.now();
  while (q('sourceTrack').textContent.length === 0 && Date.now() - started < 15000) await wait(50);
  await wait(400);                                  // 让 boot 里剩下的异步链走完
  const bootMs = Date.now() - started;

  /* ── A. 启动 ── */
  record('启动期没有未捕获的 JS 错误', (window.__mojiErrors || []).length === 0, window.__mojiErrors || []);

  const shelfCount = document.querySelectorAll('.book-card').length;
  record('书架渲染出书籍卡片', shelfCount >= 1, { shelfCount, bookCount: q('bookCount').textContent });
  record('侧栏连续天数已由数据填充（不再是写死的 0）', /连续练习 \d+ 天/.test(q('profileStreak').textContent), { text: q('profileStreak').textContent });
  record('今日目标进度条由数据驱动', /今天(已抄|还没有)/.test(q('goalText').textContent), { text: q('goalText').textContent });

  /* ── B. 后端数据层：健康检查 + 全量接口 + 前端镜像一致 ── */
  const health = await MojiApi.health();
  record('后端连上了（GET /api/health）', Boolean(health && health.ok), health);
  record('后端用 SQLite 落盘（不是浏览器存储）',
    Boolean(health && health.storage === 'sqlite' && health.dbPath), { storage: health && health.storage, dbPath: health && health.dbPath });
  const bootstrapData = await MojiApi.bootstrap();
  const collections = ['books', 'progress', 'sessions', 'daily', 'settings'];
  record('全量接口给出五个集合', collections.every(name => Array.isArray(bootstrapData[name])), Object.keys(bootstrapData));
  record('前端镜像与后端一致（books / sessions 条数对得上）',
    snapshot.books.length === bootstrapData.books.length && snapshot.sessions.length === bootstrapData.sessions.length,
    { mirrorBooks: snapshot.books.length, serverBooks: bootstrapData.books.length,
      mirrorSessions: snapshot.sessions.length, serverSessions: bootstrapData.sessions.length });

  /* ── C. 缺陷①：每章第一行必须有全角缩进 ── */
  const noIndentChapters = state.book.chapters
    .map((chapter, index) => ({ index, title: chapter.title, first: chapter.content.split('\n')[0] }))
    .filter(item => item.first.trim() && !/^[\u3000 \t]/.test(item.first));
  record('每个章节的第一行都有缩进', noIndentChapters.length === 0, { offenders: noIndentChapters.slice(0, 3) });

  /* ── D. 缺陷②：charCount 随码字变化 ── */
  const chapter = currentChapter();
  const writing = q('writingArea');
  const setText = text => { writing.value = text; writing.dispatchEvent(new Event('input', { bubbles: true })); };
  q('sourceText').dispatchEvent(new Event('scroll'));
  setText('');
  await frame();
  const countBefore = q('charCount').textContent;
  setText(chapter.content.slice(0, 20));
  await frame();
  const countAfter = q('charCount').textContent;
  record('charCount 随码字变化', countBefore !== countAfter && countAfter.startsWith('20 /'), { countBefore, countAfter });

  /* ── N. 缺陷⑤：抄写栏第一行也要跟上原文的首行缩进 ──
     回车会自动带入下一行的缩进（handleWritingEnter），但**第一行前面没有回车**，
     结果原文栏顶着两个全角空格、抄写栏却从第 0 列起笔，两栏第一行对不齐，
     用户还得自己敲那两个空格。紧跟在 D 之后跑，是因为这里章节状态最干净。 */
  chapter.written = '';
  setText('');
  await frame();
  selectChapter(state.chapterIndex);
  await frame();
  const leadIndent = (chapter.content.split('\n')[0].match(/^[\u3000 \t]*/) || [''])[0];
  const seeded = writing.value;
  record('新章节：抄写栏自动补上原文首行缩进',
    leadIndent.length > 0 && seeded === leadIndent,
    { lead: JSON.stringify(leadIndent), seeded: JSON.stringify(seeded) });
  record('新章节：补上的缩进进了校对显示层（看得见，不只是 textarea 里）',
    q('typingDisplay').textContent === seeded,
    { display: JSON.stringify(q('typingDisplay').textContent) });
  record('只补了缩进时不算"已抄写"（计数归零）',
    q('charCount').textContent.startsWith('0 /') && q('writtenMetric').textContent.trim() === '0 字',
    { charCount: q('charCount').textContent, writtenMetric: q('writtenMetric').textContent.trim() });
  record('只补了缩进时仍提示"从这里开始"',
    q('writingHint').textContent === '点击右侧开始输入' && !q('caretGuide').classList.contains('hidden'),
    { hint: q('writingHint').textContent, guideHidden: q('caretGuide').classList.contains('hidden') });
  record('只补了缩进时不会误报错字', q('errorMetric').textContent.trim() === '0 字',
    { errorMetric: q('errorMetric').textContent.trim() });

  /* ── E. 缺陷④：两栏逐字对齐（字形盒 + 换行位置） ── */
  setText(chapter.content);
  await frame();
  const charRects = root => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let i = 0; i < node.nodeValue.length; i += 1) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0];
        if (rect) out.push({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
      }
    }
    return out;
  };
  const lineHeight = parseFloat(getComputedStyle(writing).lineHeight);
  const sourceRects = charRects(q('sourceTrack'));
  const writeRects = charRects(q('typingDisplay'));
  let lineMismatch = 0;
  for (let i = 0; i < Math.min(sourceRects.length, writeRects.length); i += 1) {
    if (Math.round(sourceRects[i].top / lineHeight) !== Math.round(writeRects[i].top / lineHeight)) lineMismatch += 1;
  }
  record('两栏字形盒高度一致', sourceRects[0] && writeRects[0] && sourceRects[0].height === writeRects[0].height,
    { srcH: round(sourceRects[0] ? sourceRects[0].height : 0), wriH: round(writeRects[0] ? writeRects[0].height : 0) });
  record('两栏字形盒宽度一致', sourceRects[0] && writeRects[0] && sourceRects[0].width === writeRects[0].width,
    { srcW: round(sourceRects[0] ? sourceRects[0].width : 0), wriW: round(writeRects[0] ? writeRects[0].width : 0) });
  record('两栏逐字换行位置一致', lineMismatch === 0, { lineMismatch, compared: Math.min(sourceRects.length, writeRects.length) });
  /* 空稿提示条曾经漏掉 letter-spacing，与正文错开字距 */
  const guideFont = getComputedStyle(q('caretGuide'));
  const bodyFont = getComputedStyle(q('typingDisplay'));
  record('空稿提示条与正文字体声明完全一致',
    guideFont.letterSpacing === bodyFont.letterSpacing && guideFont.fontFamily === bodyFont.fontFamily
    && guideFont.fontSize === bodyFont.fontSize && guideFont.lineHeight === bodyFont.lineHeight,
    { guide: { ls: guideFont.letterSpacing, ff: guideFont.fontFamily }, body: { ls: bodyFont.letterSpacing, ff: bodyFont.fontFamily } });
  record('纸面宽度 = 原文栏文字宽度', Math.round(parseFloat(q('writingPaper').style.width)) === q('sourceText').clientWidth,
    { paper: q('writingPaper').style.width, source: q('sourceText').clientWidth });

  /* ── F. 会话基准：首段不能漏统计 ── */
  settleSession();
  await wait(60);
  chapter.written = '';
  setText('');
  await frame();
  const chapterBefore = state.daily.size;
  setText('六月初一，');
  await frame();
  const firstTotals = sessionTotals();
  record('第一次输入就建立了会话', practice.active === true, { active: practice.active });
  record('会话基准在写入之前捕获（首段 5 字全计入）', firstTotals.words === 5, { words: firstTotals.words, base: practice.baseWords });
  const todayWordsAfterTyping = todaySummary().words;
  record('侧栏/统计的今日字数即时反映实时增量', todayWordsAfterTyping >= 5, { todayWords: todayWordsAfterTyping, chapterBefore });

  /* 落库后再看，数字不能因为入库而回退或重置会话 */
  const baseBeforeFlush = practice.baseWords;
  await flushSession();
  await wait(120);
  record('落库不触碰会话状态（基准未变）', practice.baseWords === baseBeforeFlush && practice.active === true,
    { baseBefore: baseBeforeFlush, baseAfter: practice.baseWords, active: practice.active });
  const stored = state.sessions.find(item => item.id === practice.recordId);
  record('会话已写入 sessions 存储', Boolean(stored && stored.words >= 5), stored ? { words: stored.words, durationMs: stored.durationMs } : null);
  record('daily 已随会话更新', (state.daily.get(dateKey()) || {}).words >= 5, state.daily.get(dateKey()) || null);

  /* ── G. 校对增强：标点宽松 ── */
  const strictPunct = compareWriting('，。！？', ',.!?', false);
  const lenientPunct = compareWriting('，。！？', ',.!?', true);
  record('严格模式：全角标点写成半角算错', strictPunct.incorrect === 4, strictPunct);
  record('宽松模式：全角/半角标点不再算错', lenientPunct.incorrect === 0 && lenientPunct.correct === 4, lenientPunct);
  const quoteStrict = compareWriting('“引号”', '"引号"', false);
  const quoteLenient = compareWriting('“引号”', '"引号"', true);
  record('宽松模式：中英文引号差异不再算错', quoteStrict.incorrect === 2 && quoteLenient.incorrect === 0, { strict: quoteStrict, lenient: quoteLenient });
  const hanStrict = compareWriting('中国', '中囯', true);
  record('宽松模式不会把真正的错字放过（汉字仍严格）', hanStrict.incorrect === 1, hanStrict);

  /* ── H. 校对清单与跳转 ── */
  const wrongIndex = 2;
  const typed = chapter.content.slice(0, 12).split('');
  typed[wrongIndex] = typed[wrongIndex] === '月' ? '日' : '月';
  state.settings.punctLenient = false;
  setText(typed.join(''));
  await frame();
  const differences = differenceList(chapter.content, getWritten(chapter), false);
  record('校对清单能列出偏差', differences.length >= 1 && differences[0].index === wrongIndex, { differences: differences.slice(0, 3) });
  state.proofOpen = true;
  q('proofPanel').hidden = false;
  renderProofreadList();
  await frame();
  const rows = document.querySelectorAll('#proofList .proof-row');
  record('校对清单渲染出可点击条目', rows.length >= 1, { rows: rows.length, count: q('proofCount').textContent });
  if (rows.length) rows[0].click();
  await frame();
  record('点击清单条目把光标定位到该字', writing.selectionStart === wrongIndex, { selectionStart: writing.selectionStart, expected: wrongIndex });
  record('点击后该字在抄写区高亮', Boolean(q('typingDisplay').querySelectorAll('span')[wrongIndex]?.classList.contains('selected')), {});
  state.settings.punctLenient = true;
  state.proofOpen = false;
  q('proofPanel').hidden = true;

  /* ── I. 当前句提示条 ── */
  writing.setSelectionRange(4, 4);
  lastCaretMark = '';
  syncCaretOnSelection();
  await frame();
  const sentenceText = q('sentenceText').textContent;
  record('当前句提示条显示光标所在句子', sentenceText.length > 0 && chapter.content.includes(sentenceText.replace(/^…|…$/g, '').slice(0, 6)),
    { sentenceText, meta: q('sentenceMeta').textContent });

  /* ── J. 全文搜索 ── */
  const hits = searchLibrary('荔枝');
  record('全文搜索能命中正文', hits && hits.total >= 1, hits ? { total: hits.total, books: hits.results.length } : null);
  const titleHits = searchLibrary('第一章');
  record('全文搜索能命中章节标题', titleHits && titleHits.total >= 1, titleHits ? { total: titleHits.total } : null);
  const emptyHits = searchLibrary('这个词肯定不存在xyzzy');
  record('搜索无结果时返回 0', emptyHits && emptyHits.total === 0, emptyHits ? { total: emptyHits.total } : null);
  if (hits && hits.total) {
    /* 「跳转并定位」= 切到那一章 + 高亮命中片段 + 把原文栏滚到那一行。
       光标不跟着走：命中位置往往还没抄到，输入框里根本没有那个位置。
       特意挑正文最靠后的一处命中，这样"有没有真的滚动"才检得出来。 */
    let target = null;
    hits.results.forEach(group => group.chapters.forEach(item => item.hits.forEach(hit => {
      if (hit.title || hit.at < 0) return;
      if (!target || hit.at > target.at) target = { bookId: group.bookId, index: item.index, at: hit.at };
    })));
    if (target) {
      jumpToSearchHit(target.bookId, target.index, target.at, hits.keyword.length);
      await wait(80);
      await frame();
      await frame();
      const mark = q('sourceTrack').querySelector('mark.source-mark');
      const sourceBox = q('sourceText').getBoundingClientRect();
      const markBox = mark ? mark.getBoundingClientRect() : null;
      const inView = Boolean(markBox && markBox.top >= sourceBox.top - 2 && markBox.bottom <= sourceBox.bottom + 2);
      const correctSpan = Boolean(mark) && state.sourceHighlight
        && state.sourceHighlight.start === target.at
        && mark.textContent === hits.keyword
        && currentChapter().content.slice(target.at, target.at + hits.keyword.length) === hits.keyword;
      record('点击搜索结果能跳到对应章节', state.view === 'workspace' && state.chapterIndex === target.index,
        { view: state.view, chapterIndex: state.chapterIndex, expectedIndex: target.index });
      record('点击搜索结果会在原文里高亮命中片段', correctSpan,
        { highlight: state.sourceHighlight, expectedAt: target.at, mark: mark ? mark.textContent : null });
      record('点击搜索结果会把原文栏滚到命中位置', inView && q('sourceText').scrollTop > 0,
        { inView, scrollTop: q('sourceText').scrollTop, markTop: markBox && Math.round(markBox.top), sourceTop: Math.round(sourceBox.top) });
      /* <mark> 只该上底色，不能推动任何一行、也不能改变任何一字的宽高。
         直接拿"有高亮"和"没高亮"两次的原文栏逐字矩形对比。 */
      const srcWithMark = charRects(q('sourceTrack'));
      const savedHighlight = state.sourceHighlight;
      state.sourceHighlight = null;
      renderSourceHighlight();
      const srcPlain = charRects(q('sourceTrack'));
      state.sourceHighlight = savedHighlight;
      renderSourceHighlight();
      await frame();
      const sameGeometry = srcWithMark.length === srcPlain.length && srcWithMark.every((rect, i) =>
        Math.round(rect.top) === Math.round(srcPlain[i].top)
        && Math.round(rect.left) === Math.round(srcPlain[i].left)
        && Math.round(rect.width) === Math.round(srcPlain[i].width)
        && Math.round(rect.height) === Math.round(srcPlain[i].height));
      record('高亮命中片段不改变原文的任何一行一字（两栏对齐不受影响）', sameGeometry,
        { marked: srcWithMark.length, plain: srcPlain.length,
          firstWithMark: srcWithMark[0] && { top: round(srcWithMark[0].top), w: round(srcWithMark[0].width) },
          firstPlain: srcPlain[0] && { top: round(srcPlain[0].top), w: round(srcPlain[0].width) } });
    }
  }

  /* ── K. 章节增量渲染 + 每章重置/删除 + 书库整体进度 ── */
  const originalChapters = state.book.chapters;
  state.book.chapters = Array.from({ length: 75 }, (_, index) => ({
    title: `测试章节 ${index + 1}`, content: `${index + 1} 号测试正文。`, written: '', timeSpentMs: 0
  }));
  state.chapterRenderLimit = 60;
  renderLibrary();
  await frame();
  let rowCount = document.querySelectorAll('#libraryCard .chapter-row').length;
  const moreButton = q('loadMoreChapters');
  record('章节增量渲染：先只渲染 60 章', rowCount === 60, { rowCount });
  record('出现「加载更多」并显示剩余数量', Boolean(moreButton && /15/.test(moreButton.textContent)), { text: moreButton ? moreButton.textContent : null });
  if (moreButton) {
    moreButton.click();
    await wait(30);
    rowCount = document.querySelectorAll('#libraryCard .chapter-row').length;
    record('点击加载更多后补足全部章节', rowCount === 75, { rowCount });
  }
  record('书库整体进度已计算', /\d+ \/ \d+ 字 · \d+%/.test(q('libraryProgressText').textContent), { text: q('libraryProgressText').textContent });
  record('每章都有「重置」与「删除」按钮',
    document.querySelectorAll('#libraryCard [data-reset-chapter]').length === 75
    && document.querySelectorAll('#libraryCard [data-delete-chapter]').length === 75, {});

  const originalConfirm = window.confirm;
  window.confirm = () => true;
  const beforeDelete = state.book.chapters.length;
  await removeChapter(3);
  await frame();
  record('删除章节后章节数 -1', state.book.chapters.length === beforeDelete - 1, { before: beforeDelete, after: state.book.chapters.length });
  const progressAfterDelete = state.book.chapters.map((_, index) => `${state.bookId}-${index}`);
  /* 问后端要一份全量来核对进度序号：删章节之后序号整体前移，
     进度必须跟着新序号走（这一步在前端只是"整本重写"，真伪要看服务端）。 */
  const storedProgress = (await apiGet('/api/bootstrap')).progress
    .map(item => item.id).filter(id => id.startsWith(`${state.bookId}-`));
  record('删除章节后进度记录已整本重写（序号不错位）',
    storedProgress.length === progressAfterDelete.length, { stored: storedProgress.length, chapters: progressAfterDelete.length });

  /* 重置某章进度 */
  state.book.chapters[1].written = '##占位##';
  await resetChapter(1);
  await frame();
  record('重置章节清空了该章正文与时长',
    state.book.chapters[1].written === '' && state.book.chapters[1].timeSpentMs === 0, {
      written: state.book.chapters[1].written, timeMs: state.book.chapters[1].timeSpentMs
    });

  /* ── L. 缺陷③：删除书籍 ──
     内置库只有一本书，先按应用自己的写入路径落一本"待删样书"，
     否则这条断言只会以"没得删"跳过，等于没测。 */
  const victimId = 'verify-victim-book';
  const victimBook = {
    title: '待删除的样书',
    author: '回归测试',
    chapters: [{ title: '唯一一章', content: '　　这是一本用来验证删除功能的样书。', written: '　　这是一', timeSpentMs: 60000 }]
  };
  if (!state.library.find(entry => entry.id === victimId)) {
    state.library.push({ id: victimId, book: victimBook });
    await persistBooks(victimId, victimBook);
    await writeProgress(victimId, 0);
  }
  renderBookShelf();
  await frame();
  const booksBefore = state.library.length;
  const shelfBefore = document.querySelectorAll('.book-card').length;
  editingBookId = victimId;
  await deleteCurrentBook();
  await wait(80);
  await frame();
  record('删除书籍后书架数量 -1',
    state.library.length === booksBefore - 1 && document.querySelectorAll('.book-card').length === shelfBefore - 1,
    { before: booksBefore, after: state.library.length, shelfBefore, shelfAfter: document.querySelectorAll('.book-card').length });

  /* 删除要落到后端：直接问服务端要一份全量来核对 */
  const afterDelete = await apiGet('/api/bootstrap');
  const gone = !afterDelete.books.some(item => item.id === victimId);
  record('被删除书籍的 books 记录已从后端移除', gone, { books: afterDelete.books.map(item => item.id) });
  const leftoverProgress = afterDelete.progress.filter(item => item.bookId === victimId);
  record('被删除书籍的章节进度一并清除', leftoverProgress.length === 0, { leftover: leftoverProgress.length });

  /* ── M. 统计页渲染出真实数字 ── */
  renderStats();
  await frame();
  const statsText = ['totalWordsStat', 'totalTimeStat', 'streakStat', 'longestStreakStat', 'statWords7', 'statAccuracy7']
    .map(id => q(id).textContent);
  record('统计页六项数字均已填充', statsText.every(text => text && text !== '0 天' || /\d/.test(text)), { statsText });
  record('最近练习明细有内容', q('sessionList').children.length > 0 || /还没有练习/.test(q('sessionList').textContent), { rows: q('sessionList').children.length });
  record('7 天区间标签已生成', /\d\d-\d\d ~ \d\d-\d\d/.test(q('weekRangeLabel').textContent), { text: q('weekRangeLabel').textContent });

  window.confirm = originalConfirm;
  state.book.chapters = originalChapters;

  /* ── P. 后端不可用：写入必须明确报错，界面也要如实说明 ──
     把"连不上后端"伪装成一次真实故障，验证三件事：写入不会静默丢、
     状态判断跟着走、界面文案说的是实话。 */
  const savedReady = backend.ready;
  const savedError = state.storageError;
  const savedNoticeHidden = q('storageNotice').hidden;
  try {
    backend.ready = false;
    state.storageError = new Error('（自检模拟）后端不可用');
    record('后端断开时 storageReady() 为假', storageReady() === false, {});
    let writeError = null;
    try { await putRecord('settings', { key: 'verify-probe', value: 1 }); } catch (error) { writeError = error; }
    record('后端断开时写入会明确报错（不静默丢数据）',
      Boolean(writeError) && /后端未连接/.test(String(writeError.message)), { message: writeError && writeError.message });
    record('界面上的存储说法跟着后端状态走', storageLabel() === '内存', { label: storageLabel() });
    notifyBackendDown();
    await frame();
    record('后端断开时给出可见提示',
      q('storageNotice').hidden === false && /连不上本地数据库服务/.test(q('storageNotice').textContent),
      { text: (q('storageNotice').textContent || '').slice(0, 50) });
  } finally {
    backend.ready = savedReady;
    state.storageError = savedError;
    q('storageNotice').hidden = savedNoticeHidden;
  }

  /* 连通性恢复后写入要立刻能工作：模拟故障不能留下后遗症 */
  await putRecord('settings', { key: 'verify-recover', value: 1 });
  const recovered = (await MojiApi.bootstrap()).settings.some(item => item.key === 'verify-recover');
  record('后端恢复后写入立刻可用', recovered, {});

  /* ── Q. 后端错误要能被前端读懂：404 / 不支持的方法 / 非法请求体 ── */
  let notFound = null;
  try { await MojiApi.request('GET', '/api/definitely-not-here'); } catch (error) { notFound = error; }
  record('不存在的接口会抛出带状态码的错误', Boolean(notFound) && notFound.status === 404,
    { status: notFound && notFound.status, message: notFound && notFound.message });

  let badMethod = null;
  try {
    await MojiApi.request('PATCH', '/api/health');
  } catch (error) { badMethod = error; }
  record('不被支持的方法返回 405（而不是 HTML 错误页）', Boolean(badMethod) && badMethod.status === 405,
    { status: badMethod && badMethod.status, message: badMethod && badMethod.message });

  let badBody = null;
  try {
    const response = await fetch('/api/sessions/verify-bad-body', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{not json'
    });
    badBody = { status: response.status, payload: await response.json() };
  } catch (error) { badBody = { error: String(error) }; }
  record('非法 JSON 请求体会被明确拒绝（400）', Boolean(badBody && badBody.status === 400), badBody);

  const failed = checks.filter(c => !c.ok);
  return {
    ok: failed.length === 0,
    bootMs,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map(c => c.name),
    checks
  };
})()
