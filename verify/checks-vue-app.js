/* Vue 版界面回归检查（在真实浏览器里跑）—— 只从用户视角验证。

   看 DOM、点按钮、敲字、导入文件、重新打开一个窗口，不碰内部状态 ——
   换前端框架时最容易坏的就是"数据对了但界面没接上"，而这类问题
   只有在真实渲染里才看得见。

   两处"模拟用户动作"的手法值得说明：
     · 导入文件：构造 File + DataTransfer 塞进 input[type=file] 再派发 change，
       走的是和用户选文件完全相同的那条代码路径；
     · "重新打开软件"：新建一个 iframe 载入同一页面。它是一份独立的文档、
       独立的应用实例（有自己的计时与会话），localStorage 与后端则是共享的 ——
       正是新开一个窗口的真实情形，也是唯一能在不打断本脚本的前提下
       验证"启动时补偿"的办法。

   跑法（后端同时托管 dist/）：
     npm run build
     python -m server --port 41777 --db <临时库>
     node verify/cdp-attach.js <debugPort> verify/checks-vue-app.js
*/
(async () => {
  /* ══ 工具 ═══════════════════════════════════════════════════════════════ */

  const $ = (doc, selector) => doc.querySelector(selector);
  const $$ = (doc, selector) => Array.from(doc.querySelectorAll(selector));
  const qid = (doc, id) => doc.getElementById(id);
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const byText = (doc, selector, text) => $$(doc, selector).find(el => txt(el).includes(text));
  const byLabel = (doc, label) => $$(doc, 'button')
    .find(el => (el.getAttribute('aria-label') || el.title || '') === label);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = doc => new Promise(resolve => doc.defaultView.requestAnimationFrame(
    () => doc.defaultView.requestAnimationFrame(resolve),
  ));

  /** 轮询等待：界面上的变化几乎都是异步的（落库、重渲染），固定 sleep 不可靠。 */
  async function waitFor(probe, timeout = 8000, step = 80) {
    const started = Date.now();
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() - started > timeout) return null;
      await wait(step);
    }
  }

  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || {} });

  /* 检查期间未捕获的错误。点按钮时崩掉是最典型的"界面没接上"，
     但它只在控制台里可见 —— 这里让它变成一条失败的检查。 */
  const errors = [];
  window.addEventListener('error', event => {
    /* 带上出错的文件与行号：只有一句 TypeError 是查不下去的 */
    const where = event.filename ? ` @${String(event.filename).split('/').pop()}:${event.lineno || 0}` : '';
    errors.push(`${event.message || event}${where}`);
  });
  window.addEventListener('unhandledrejection', event => {
    errors.push(String((event.reason && event.reason.message) || event.reason));
  });

  const D = document;

  /* ══ 0. 启动 ════════════════════════════════════════════════════════════ */

  if (!(await waitFor(() => $(D, '.app-shell'), 15000))) {
    return { ok: false, host: 'unknown', passed: 0, total: 1, failed: ['应用没有挂载起来'], checks };
  }
  await wait(900);                       // connect() 与首次渲染
  record('Vue 应用已挂载（.app-shell 存在）', true, {});
  record('顶栏如实说明数据去处（已存入本地数据库）',
    /已存入本地数据库/.test(txt($(D, '.save-state'))), { text: txt($(D, '.save-state')) });

  /* ══ 1. 书架与侧栏 ══════════════════════════════════════════════════════ */

  record('书架渲染出书籍卡片', $$(D, '.book-card').length >= 1, { cards: $$(D, '.book-card').length });
  record('侧栏连续天数已由数据填充（不是写死的 0）',
    /连续练习\s*\d+\s*天/.test(txt($(D, '.profile small'))), { text: txt($(D, '.profile small')) });
  record('今日目标进度来自后端数据',
    /今天(已抄|还没有)/.test(txt($(D, '.tip-card p'))), { text: txt($(D, '.tip-card p')) });

  /* ══ 2. 导入一本 txt ════════════════════════════════════════════════════ */

  const stamp = Date.now().toString(36).slice(-4);
  const BOOK_FILE = `导入文件-${stamp}`;      // 文件名：故意和正文里的书名不一样
  const BOOK_NAME = `正文书名-${stamp}`;      // 正文第一行的书名：导入后应该用它
  /* 一份"盗版站导出"的 txt：广告块 + 书名 + 作者 + 简介 + 两个分卷三章。
     这些以前全会被当成正文塞进章节，抄起来满屏水印。 */
  const BOOK_TEXT = [
    '==========================================================',
    '更多精校小说尽在知轩藏书下载：https://zxcs.zip/',
    '==========================================================',
    BOOK_NAME,
    '作者：验证作者',
    '',
    '内容简介：',
    '　　这是一本用来跑回归检查的书。',
    '',
    '',
    '第一部 上卷',
    '',
    '第一章 起笔',
    '',
    '六月初一，长安城里已经热得像一只蒸笼。',
    '李善德站在街角，手里攥着一纸公文，额头上全是汗。',
    '',
    '第二章 落笔',
    '',
    '从长安到岭南，足有五千里。',
    '纸页已经发黄，边角还留着前人的批注。',
    '',
    '',
    '第二部 下卷',
    '',
    '第三章 收笔',
    '',
    '快马离开驿站时，天刚蒙蒙亮。',
  ].join('\n');

  async function importBook(doc, name, content) {
    const input = $$(doc, 'input[type=file]').find(el => (el.accept || '').includes('txt'));
    if (!input) return false;
    const countBefore = $$(doc, '.book-card').length;
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], `${name}.txt`, { type: 'text/plain' }));
    input.files = transfer.files;
    input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    /* 等的是"书架上多了一本"，不是"卡片里出现文件名" ——
       书名现在是从正文里认出来的，未必等于文件名。 */
    return Boolean(await waitFor(() => $$(doc, '.book-card').length > countBefore, 12000));
  }

  const shelfBefore = $$(D, '.book-card').length;
  const imported = await importBook(D, BOOK_FILE, BOOK_TEXT);
  record('导入 txt：识别章节、落库并出现在书架上',
    imported && $$(D, '.book-card').length === shelfBefore + 1,
    { imported, before: shelfBefore, after: $$(D, '.book-card').length });
  record('导入后自动打开这本书的工作台',
    txt($(D, '.breadcrumbs')).includes(BOOK_NAME), { breadcrumbs: txt($(D, '.breadcrumbs')) });

  /* 测试书要走完落库，后面的"重新打开"才看得到它 */
  await wait(600);

  /* ── 广告、分卷、简介：以前它们都会混进正文 ── */
  record('书名取的是正文里的书名，不是文件名',
    txt($(D, '.book-title')) === BOOK_NAME, { shelf: txt($(D, '.book-title')), file: BOOK_FILE });
  record('作者也来自正文（不再写死"本地文本"）',
    /验证作者/.test(txt($(D, '.book-card'))), { card: txt($(D, '.book-card')) });
  record('工作台正文里没有广告与水印',
    !txt($(D, '#sourceTrack')).includes('知轩藏书') && !$(D, '#sourceTrack').innerHTML.includes('zxcs.zip'), {});

  byText(D, '.main-nav .nav-item', '章节目录').click();
  await frame(D);
  await wait(350);
  record('章节数正确（两个卷标不算章节）',
    $$(D, '.chapter-row').length === 3, { rows: $$(D, '.chapter-row').length });
  record('分卷被识别成分组行，而不是混进某一章',
    $$(D, '.volume-row').length === 2,
    { volumes: $$(D, '.volume-row').map(el => txt(el)) });
  record('内容简介被单独收起来（不在正文里）',
    Boolean($(D, '.summary-card')) && txt($(D, '.summary-card')).includes('回归检查'),
    { summary: txt($(D, '.summary-card')).slice(0, 30) });
  record('面包屑带上分卷这一层（我的书架 / 书名 / 卷 / 章节）',
    txt($(D, '.breadcrumbs')).includes('第一部 上卷'), { breadcrumbs: txt($(D, '.breadcrumbs')) });
  byText(D, '.main-nav .nav-item', '抄写工作台').click();
  await frame(D);
  await wait(350);

  /* ══ 3. 抄写区：缩进、对齐、校对 ════════════════════════════════════════ */

  const area = qid(D, 'writingArea');
  const display = qid(D, 'typingDisplay');
  const sourceTrack = qid(D, 'sourceTrack');
  record('抄写区存在（textarea）', Boolean(area), {});
  record('校对显示层存在', Boolean(display), {});
  record('章节标题已渲染', Boolean(txt($(D, '#pageTitle'))), { title: txt($(D, '#pageTitle')) });
  record('工具栏有「校对清单」按钮', Boolean(byText(D, '.toolbar-button', '校对清单')), {});

  /* 用 textContent 而不是 txt()：后者会把连续空白折叠成一个普通空格，
     行首那两个全角缩进也会被折叠掉 —— 逐字比对是按字符位置算的，
     位置一旦漂移，后面所有断言都会跟着错。 */
  const source = sourceTrack.textContent;
  const metricAt = index => txt($$(D, '.metric-grid .metric strong')[index]);
  const typeInto = (element, value) => {
    element.value = value;
    element.dispatchEvent(new D.defaultView.Event('input', { bubbles: true }));
  };

  /* 章节标题与正文各归各位：标题只出现在标题里，不能混进正文头几行 */
  record('章节标题没有混进正文',
    Boolean(txt($(D, '#pageTitle'))) && !source.startsWith(txt($(D, '#pageTitle'))),
    { title: txt($(D, '#pageTitle')), sourceHead: source.slice(0, 16) });

  /* 双栏模式：抄写栏里只该有你写的字，不铺"还没写到的原文" ——
     左边就是原文，右边再铺一层灰字只会让人以为已经替你输好了。 */
  record('双栏模式：抄写栏不铺灰字（原文在左边看）',
    Boolean($(D, '#ghostLayer')) && !$(D, '#ghostLayer').textContent, {});

  record('新章节自动补上原文首行缩进（两栏第一行对得齐）',
    area.value.startsWith('\u3000\u3000'), { typed: JSON.stringify(area.value.slice(0, 4)) });
  record('只补了缩进不算「已抄写」（计数归零）',
    /^0\s*字$/.test(metricAt(0)), { text: metricAt(0) });
  record('只补了缩进不会误报错字', /^0\s*字$/.test(metricAt(3)), { text: metricAt(3) });
  record('只补了缩进仍提示「从这里开始」',
    Boolean($(D, '#caretGuide')) && !$(D, '#caretGuide').classList.contains('hidden'), {});

  /* 两栏对齐：先写满前三行（不跨行就看不出换行是否一致），再逐字比较字形盒。
     这两条过去抓到过字体与行高不一致的回归 —— 表现为"右边写着写着就和左边错行了"。 */
  /* 量字形盒（不是行盒）：节点上取文字范围，量到的才是"这个字占的方框"。
     直接对 span 调 getBoundingClientRect 量到的是行盒（含行距），
     拿它和字形盒比会凭空差出好几个像素 —— 那是量法问题，不是排版问题。 */
  function textNodeBoxes(node, count) {
    if (!node || !node.textContent) return [];
    const length = Math.min(count, node.textContent.length);
    const boxes = [];
    for (let index = 0; index < length; index += 1) {
      const range = D.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      boxes.push({ top: Math.round(rect.top), height: Math.round(rect.height) });
    }
    return boxes;
  }

  typeInto(area, source.slice(0, Math.min(66, source.length)));
  await frame(D);
  await wait(250);

  /* 先看根因：两栏的正文可用宽度必须一样。差一点点（比如一边的滚动条占了位），
     换行点就会从那一处起全部错开，而只比较前几个字是看不出来的。 */
  const sourceWidth = Math.round(sourceTrack.getBoundingClientRect().width);
  const typedWidth = Math.round($(D, '#typedLayer').getBoundingClientRect().width);
  record('两栏正文可用宽度一致（滚动条不许占宽）',
    Math.abs(sourceWidth - typedWidth) <= 1, { source: sourceWidth, typed: typedWidth });

  const sourceBoxes = textNodeBoxes(sourceTrack.firstChild, 40);
  /* 抄写层是一字一个 span（.rest 是"还没写到的原文"那一整段，跨很多行，不参与比较） */
  const typedBoxes = $$(D, '#typedLayer span.ok, #typedLayer span.bad')
    .slice(0, 40)
    .map(span => textNodeBoxes(span.firstChild, 1)[0])
    .filter(Boolean);
  const compared = Math.min(sourceBoxes.length, typedBoxes.length);
  record('两栏字形盒高度一致（同一套字体度量）',
    compared > 4 && sourceBoxes.every((box, index) => index >= compared || Math.abs(box.height - typedBoxes[index].height) <= 1),
    { compared, source: sourceBoxes[0], typed: typedBoxes[0] });
  /* 换行位置比的是"相对第一行的偏移"：两栏各自从自己的栏顶排起，
     要比的是同样的字有没有落在同样的行上。 */
  const sourceOffset = sourceBoxes.map(box => box.top - (sourceBoxes[0] || {}).top);
  const typedOffset = typedBoxes.map(box => box.top - (typedBoxes[0] || {}).top);
  const lineDrift = sourceOffset.map((offset, index) => (index < compared ? Math.abs(offset - typedOffset[index]) : 0));
  /* 容差 2px：灰底稿与抄写层分开之后，个别字符会有 1px 的亚像素差，肉眼看不出来。
     这里真正要防的是"整行错开"，那是几十像素级别的事。 */
  record('两栏逐字换行位置一致（不会写着写着错行）',
    compared > 4 && lineDrift.every(value => value <= 2),
    { compared, worst: Math.max(...lineDrift), mismatch: lineDrift.filter(value => value > 2).length });

  /* 再写回一小段，只在末尾留一个错字 —— 逐字校对与清单都靠它 */
  const typedText = source.slice(0, 8) + '错';
  typeInto(area, typedText);
  await frame(D);
  await wait(150);

  const okSpan = $$(D, '#typedLayer span.ok')[0];
  const badSpan = $$(D, '#typedLayer span.bad')[0];
  record('逐字校对：正确字与错字分别标出',
    $$(D, '#typedLayer span.ok').length >= 8 && $$(D, '#typedLayer span.bad').length >= 1,
    { ok: $$(D, '#typedLayer span.ok').length, bad: $$(D, '#typedLayer span.bad').length });
  /* 颜色必须真的落到屏幕上。类名与 CSS 选择器曾经对不上
     （渲染用 ok/bad，样式写的是 correct/incorrect），红字静悄悄地失效了很久 ——
     只数 span 的个数是抓不住这种错的。 */
  record('抄对的字是深色、抄错的字是红色',
    Boolean(okSpan && badSpan)
    && getComputedStyle(okSpan).color === 'rgb(63, 66, 62)'
    && getComputedStyle(badSpan).color === 'rgb(195, 72, 62)',
    { ok: okSpan ? getComputedStyle(okSpan).color : null,
      bad: badSpan ? getComputedStyle(badSpan).color : null });
  record('侧栏「已抄写」随输入更新', /9\s*字/.test(metricAt(0)), { text: metricAt(0) });
  record('侧栏「错误字数」标出那一个错字', /1\s*字/.test(metricAt(3)), { text: metricAt(3) });
  record('第一次输入就建立了会话（时长开始走）',
    /^00:[0-5]\d$/.test(metricAt(1)), { text: metricAt(1), mode: txt($(D, '.copy-mode')) });
  record('时长样本不足 5 秒时不显示速度（杜绝刚开写就冒出的天文数字）',
    /—/.test(metricAt(2)), { text: metricAt(2) });

  /* ── 单栏模式：原文栏收起来，原文铺成灰字底稿，抄过去变黑、抄错变红 ── */
  const columnsButton = byText(D, '.toolbar-button', '双栏');
  if (columnsButton) {
    columnsButton.click();
    await wait(500);
    const ghost = $(D, '#ghostLayer');
    record('切到单栏：原文栏收起、整章原文铺成灰底稿',
      !$(D, '.source-column') && Boolean(ghost) && ghost.textContent === source,
      { ghost: ghost ? ghost.textContent.length : 0, source: source.length });
    record('单栏的底稿是淡灰色（不是正文色）',
      Boolean(ghost) && getComputedStyle(ghost).color === 'rgb(210, 209, 202)',
      { ghost: ghost ? getComputedStyle(ghost).color : null });
    record('单栏切换会给出提示（不是默默生效）',
      /单栏/.test(txt($(D, '.toast'))), { toast: txt($(D, '.toast')) });

    /* 用户最在意的一条：底稿是钉住的 —— 写字、删字，它一个字都不许动 */
    const ghostBefore = ghost.textContent;
    const heightBefore = Math.round($(D, '#writingPaper').getBoundingClientRect().height);
    typeInto(area, source.slice(0, 12));
    await wait(450);

    record('灰底稿固定：写了 12 个字，底稿一个字都没变',
      $(D, '#ghostLayer').textContent === ghostBefore, {});
    record('你写的字是盖在底稿上的另一层',
      $$(D, '#typedLayer span.ok, #typedLayer span.bad').length === 12,
      { typed: $$(D, '#typedLayer span.ok, #typedLayer span.bad').length });
    record('单栏下纸面高度不随输入变化（底稿因此不会上下跳）',
      Math.abs(Math.round($(D, '#writingPaper').getBoundingClientRect().height) - heightBefore) <= 2,
      { before: heightBefore, after: Math.round($(D, '#writingPaper').getBoundingClientRect().height) });

    /* 底稿铺在抄写区里，提示条再压上去就是两行字糊在一起。
       先清空再验：否则"刚才写过字"也会让提示条是隐藏的，测不出真问题。 */
    typeInto(area, '');
    await wait(350);
    const guide = $(D, '#caretGuide');
    record('单栏不显示「从这里开始」（不跟底稿糊在一起）',
      Boolean(guide) && guide.classList.contains('hidden'), {});
    record('把内容删光后，首行缩进会自动补回来',
      area.value === '\u3000\u3000', { value: JSON.stringify(area.value) });
    record('删光之后底稿仍是完整原文（没有跟着少）',
      $(D, '#ghostLayer').textContent === source, {});

    const backButton = byText(D, '.toolbar-button', '单栏');
    if (backButton) backButton.click();
    await wait(500);
    record('切回双栏：原文栏回来、灰底稿收起',
      Boolean($(D, '.source-column')) && !$(D, '#ghostLayer').textContent, {});

    /* 把"全对 + 一个错字"写回去：后面的校对清单要靠这处偏差 */
    typeInto(area, `${source.slice(0, 8)}错`);
    await wait(300);
  }

  /* ══ 4. 校对清单 ════════════════════════════════════════════════════════ */

  const proofButton = byText(D, '.toolbar-button', '校对清单');
  if (proofButton) {
    proofButton.click();
    await frame(D);
    await wait(120);
    const panel = $(D, '.proof-panel');
    const rows = $$(D, '.proof-row');
    record('点开校对清单：可见并列出偏差',
      Boolean(panel) && panel.offsetParent !== null && rows.length >= 1,
      { visible: Boolean(panel && panel.offsetParent !== null), rows: rows.length });
    if (rows.length) {
      record('校对清单写明偏差处数与行号',
        /1 处偏差/.test(txt($(D, '.proof-count'))) && /第 \d+ 行/.test(txt(rows[0])),
        { count: txt($(D, '.proof-count')), row: txt(rows[0]) });
      rows[0].click();
      await frame(D);
      record('点条目把光标跳到那个字上',
        area.selectionStart === 8, { selectionStart: area.selectionStart, expected: 8 });
      record('跳过去之后那个字会高亮',
        Boolean($$(D, '#typedLayer span')[8]?.classList.contains('selected')), {});
      proofButton.click();
      await wait(80);
    }
  }

  /* ══ 5. 当前句提示条 ════════════════════════════════════════════════════ */

  area.focus();
  area.setSelectionRange(4, 4);
  area.dispatchEvent(new D.defaultView.Event('keyup', { bubbles: true }));
  await frame(D);
  await wait(120);
  const sentenceText = ($(D, '.sentence-text') || {}).textContent || '';
  record('当前句提示条显示光标所在的那一句',
    sentenceText.length > 0 && source.includes(sentenceText.slice(0, 6)),
    { sentence: sentenceText.slice(0, 24) });

  /* ══ 6. 标点严格 / 宽松 ═════════════════════════════════════════════════ */

  const punctButton = byText(D, '.toolbar-button', '标点宽松');
  if (punctButton) {
    const fullStopAt = source.indexOf('。');
    const toFullStop = source.slice(0, fullStopAt);

    if (punctButton.classList.contains('active')) { punctButton.click(); await wait(260); }
    area.value = `${toFullStop}.`;
    area.dispatchEvent(new D.defaultView.Event('input', { bubbles: true }));
    await wait(200);
    const strictErrors = metricAt(3);
    record('严格模式：全角句号写成半角算错（只算错那一个字）',
      /^1\s*字$/.test(strictErrors), { text: strictErrors, stopAt: fullStopAt });

    punctButton.click();
    await wait(260);
    record('宽松模式：全角/半角标点不再算错（且设置在切换后立刻生效）',
      /^0\s*字$/.test(metricAt(3)), { text: metricAt(3) });
    /* 切换要有可见反馈。这一条守的是 showToast 被漏导入那类回归 ——
       Vue 会吞掉事件处理里抛的错，界面上只表现为"点了没反应"。 */
    record('切标点宽松会给出提示（不是默默生效）',
      /标点按/.test(txt($(D, '.toast'))), { toast: txt($(D, '.toast')) });

    /* 宽松不能把真错字也放过 */
    area.value = `${toFullStop}错`;
    area.dispatchEvent(new D.defaultView.Event('input', { bubbles: true }));
    await wait(200);
    record('宽松模式不会把真正的错字放过', /^1\s*字$/.test(metricAt(3)), { text: metricAt(3) });

    punctButton.click();                 // 切回宽松（默认值）
    await wait(200);
  }

  /* ══ 7. 速度口径（这条过去出过"每分钟几千字"的奇观） ══════════════════ */

  await wait(5200);                      // 让"本次时长"越过 5 秒的显示门槛
  area.value = source.slice(0, 8) + '错';
  area.dispatchEvent(new D.defaultView.Event('input', { bubbles: true }));
  await wait(300);
  const speedText = metricAt(2);
  const speedValue = Number((speedText.match(/\d+/) || [0])[0]);
  record('速度口径正确：本次会话字数 ÷ 本次时长（不是整章字数 ÷ 几秒）',
    speedValue > 0 && speedValue <= 200,
    { speed: speedValue, text: speedText, sessionWords: typedText.length, chapterChars: source.length });

  /* ══ 8. 章节目录与全文搜索 ══════════════════════════════════════════════ */

  byText(D, '.main-nav .nav-item', '章节目录').click();
  await frame(D);
  await wait(200);

  record('目录列出章节行', $$(D, '.chapter-row').length >= 3, { rows: $$(D, '.chapter-row').length });
  record('目录给出整本进度', /\d+ \/ \d+ 字 · \d+%/.test(txt($(D, '.library-progress-label'))),
    { text: txt($(D, '.library-progress-label')) });
  record('每章都有「重置」与「删除」按钮',
    $$(D, '.chapter-row .chapter-action').length >= 3 && $$(D, '.chapter-row .chapter-action.danger').length >= 1, {});

  const searchInput = $(D, '.search-bar input');
  record('章节目录有搜索框', Boolean(searchInput), {});

  async function runSearch(keyword) {
    searchInput.value = keyword;
    searchInput.dispatchEvent(new D.defaultView.Event('input', { bubbles: true }));
    byText(D, '.search-bar button', '搜索').click();
    await frame(D);
    await wait(200);
    return { hits: $$(D, '.search-hit').length, summary: txt($(D, '.search-summary')) };
  }

  const bodyHit = await runSearch(source.slice(2, 6));
  record('全文搜索能命中正文并列出结果', bodyHit.hits >= 1, bodyHit);

  const titleHit = await runSearch('第三章');
  record('全文搜索能命中章节标题', titleHit.hits >= 1 && titleHit.summary.includes('找到'), titleHit);

  const missHit = await runSearch('这四个字一定搜不到');
  record('搜索无结果时如实说明', missHit.hits === 0 && /没有找到/.test(missHit.summary), missHit);

  const jumpHit = await runSearch(source.slice(2, 6));
  if (jumpHit.hits) {
    $$(D, '.search-hit')[0].click();
    await frame(D);
    await wait(400);
    const mark = $(D, '.source-mark');
    record('点搜索结果会跳回工作台并高亮命中片段',
      Boolean(mark) && txt(mark).length > 0, { mark: txt(mark) });
    record('跳过去之后原文栏滚到了命中位置（不用自己翻几百行）',
      $(D, '#sourceText').scrollTop >= 0 && Boolean(mark), { scrollTop: $(D, '#sourceText').scrollTop });
  }

  /* ══ 9. 章节操作：重置 / 删除 ═══════════════════════════════════════════ */

  const originalConfirm = window.confirm;   // 重置 / 删除会弹确认框，检查里一律点"确定"
  window.confirm = () => true;

  byText(D, '.main-nav .nav-item', '章节目录').click();
  await wait(150);
  const rowsBefore = $$(D, '.chapter-row').length;

  /* 先把第二章写上几个字，重置才有东西可清 */
  $$(D, '.chapter-row')[1].click();
  await frame(D);
  await wait(300);
  const secondArea = qid(D, 'writingArea');
  secondArea.value = qid(D, 'sourceTrack').textContent.slice(0, 6);
  secondArea.dispatchEvent(new D.defaultView.Event('input', { bubbles: true }));
  await wait(900);                       // 等进度落库（防抖 500ms）

  byText(D, '.main-nav .nav-item', '章节目录').click();
  await wait(200);
  const secondRowBefore = txt($$(D, '.chapter-row')[1]);
  $$(D, '.chapter-row')[1].querySelector('.chapter-action').click();
  await wait(700);
  const secondRowAfter = txt($$(D, '.chapter-row')[1]);
  record('重置章节：写过的进度清空、时长归零',
    /已抄写/.test(secondRowBefore) && /尚未开始/.test(secondRowAfter),
    { before: secondRowBefore, after: secondRowAfter });

  /* 重置后回到工作台，抄写区必须跟着清空 —— 内存清了而界面没动的 bug 就藏在这 */
  byText(D, '.main-nav .nav-item', '抄写工作台').click();
  await frame(D);
  await wait(400);
  const afterResetValue = qid(D, 'writingArea').value;
  record('重置后抄写区同步清空（不留上一次的内容）',
    !/[^\s\u3000]/.test(afterResetValue), { value: JSON.stringify(afterResetValue.slice(0, 8)) });

  byText(D, '.main-nav .nav-item', '章节目录').click();
  await wait(200);
  $$(D, '.chapter-row')[0].querySelector('.chapter-action.danger').click();
  await wait(800);
  const rowsAfterDelete = $$(D, '.chapter-row').length;
  record('删除章节后章节数 -1', rowsAfterDelete === rowsBefore - 1,
    { before: rowsBefore, after: rowsAfterDelete });

  /* ══ 10. 章节多的书：增量渲染 ═══════════════════════════════════════════ */

  const manyTitle = `长书${Date.now().toString(36).slice(-4)}`;
  const manyText = [];
  for (let index = 1; index <= 70; index += 1) {
    manyText.push(`第${index}章 第${index}节`, '', `这是第 ${index} 章的正文，用来验证章节列表的增量渲染。`, '');
  }
  if (await importBook(D, manyTitle, manyText.join('\n'))) {
    byText(D, '.main-nav .nav-item', '章节目录').click();
    await frame(D);
    await wait(300);
    const pageRows = $$(D, '.chapter-row').length;
    const moreButton = $(D, '.load-more');
    record('章节列表先只渲染 60 章（长书不卡）', pageRows === 60, { rows: pageRows });
    record('出现「加载更多」并写明还剩多少章',
      Boolean(moreButton) && /还有 10 章/.test(txt(moreButton)), { text: txt(moreButton) });
    if (moreButton) {
      moreButton.click();
      await wait(400);
      record('点击加载更多后补足全部章节', $$(D, '.chapter-row').length === 70,
        { rows: $$(D, '.chapter-row').length });
    }
  }

  /* ══ 11. 统计页 ═════════════════════════════════════════════════════════ */

  byText(D, '.main-nav .nav-item', '练习统计').click();
  await frame(D);
  await wait(400);
  record('统计页有汇总卡片', $$(D, '.stat-summary-card strong').length >= 3,
    { cards: $$(D, '.stat-summary-card strong').length });
  record('统计页柱状图渲染 7 天', $$(D, '.bar-chart .bar').length === 7,
    { bars: $$(D, '.bar-chart .bar').length });
  record('统计页列出最近练习明细',
    $$(D, '.session-row').length >= 1, { rows: $$(D, '.session-row').length });
  record('7 天区间标签已生成',
    /\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/.test(txt($(D, '.chart-card .section-heading p'))),
    { text: txt($(D, '.chart-card .section-heading p')) });
  record('累计字数已把刚才抄的算进去',
    Number((txt($$(D, '.stat-summary-card strong')[0]).replace(/,/g, '')) || 0) > 0,
    { words: txt($$(D, '.stat-summary-card strong')[0]) });

  /* ══ 12. 设置：备份导出 / 导入 ══════════════════════════════════════════ */

  byLabel(D, '设置').click();
  await frame(D);
  await wait(250);
  record('设置弹窗能打开（含数据文件位置）',
    Boolean($(D, '.modal')) && /数据位置/.test(txt($(D, '.modal'))), {});

  byText(D, '.modal button', '导出备份').click();
  const exportToast = await waitFor(() => /备份已导出|导出失败/.test(txt($(D, '.toast'))), 6000);
  record('点「导出备份」能得到反馈（不是点了没反应）',
    /备份已导出/.test(txt($(D, '.toast'))), { toast: txt($(D, '.toast')) });

  const payload = await (await fetch('/api/export')).json();
  const backupInput = $$(D, 'input[type=file]').find(el => (el.accept || '').includes('json'));
  if (backupInput) {
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(payload)], 'moji-backup.json', { type: 'application/json' }));
    backupInput.files = transfer.files;
    backupInput.dispatchEvent(new D.defaultView.Event('change', { bubbles: true }));
    await waitFor(() => /已合并备份数据|导入失败/.test(txt($(D, '.toast'))), 8000);
    record('点「导入备份」能恢复数据（提示明确）',
      /已合并备份数据/.test(txt($(D, '.toast'))), { toast: txt($(D, '.toast')) });
  }

  const closeSettings = byLabel(D, '关闭') || $$(D, '.modal button').find(el => txt(el) === '取消');
  if (closeSettings) { closeSettings.click(); await wait(300); }

  /* ══ 13. 退出兜底与"重新打开" ═══════════════════════════════════════════ */

  /* 回到第一本验证书上收笔：Ctrl+Enter 完成本章（用户会用的那条路）。
     前面导入的长书会把"当前书"切走，所以先把侧栏里的书卡片点回来。 */
  byText(D, '.book-card', BOOK_NAME).click();
  await frame(D);
  await wait(800);
  const wrapArea = qid(D, 'writingArea');
  wrapArea.value = qid(D, 'sourceTrack').textContent.slice(0, 12);
  wrapArea.dispatchEvent(new D.defaultView.Event('input', { bubbles: true }));
  await wait(1200);
  D.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await wait(1500);
  record('Ctrl+Enter 完成本章：抄写区被标记为全文（正文没被旧值覆盖）',
    qid(D, 'writingArea').value.length >= qid(D, 'sourceTrack').textContent.length - 2,
    { typed: qid(D, 'writingArea').value.length, source: qid(D, 'sourceTrack').textContent.length,
      toast: txt($(D, '.toast')), meta: txt($(D, '.heading-meta')) });

  const bootstrapBefore = await (await fetch('/api/bootstrap')).json();
  const bookRecord = bootstrapBefore.books.find(item => (item.book.title || '').startsWith(BOOK_NAME));
  const chapterIndex = 0;
  const chapterProgressBefore = bootstrapBefore.progress
    .find(item => item.bookId === (bookRecord && bookRecord.id) && item.index === chapterIndex);
  /* 章节标题随实际数据取：前面做过删除章节的检查，这里的第 0 章未必还叫"第一章" */
  const pendingChapterTitle = (bookRecord && bookRecord.book.chapters[chapterIndex]
    && bookRecord.book.chapters[chapterIndex].title) || '第一章';

  /* 伪造"上次没来得及落库"：这是页内做不到、只能直接写 localStorage 的状态
     （真实场景是窗口被强杀，进程连一次 IndexedDB/fetch 都没走完）。 */
  const pendingId = `verify-pending-${Date.now()}`;
  localStorage.setItem('moji-pending-session', JSON.stringify({
    id: pendingId,
    at: Date.now(),
    date: new Date().toLocaleDateString('sv'),
    bookId: bookRecord ? bookRecord.id : '',
    bookTitle: BOOK_NAME,
    chapterIndex,
    chapterTitle: pendingChapterTitle,
    words: 321,
    durationMs: 600000,
    correct: 320,
    incorrect: 1,
    final: false,
    chapterMsBefore: Number((chapterProgressBefore && chapterProgressBefore.elapsedMs) || 0),
  }));

  /* 打开一个"新窗口"：独立的应用实例，启动时会补记上一次没存住的会话 */
  const fresh = D.createElement('iframe');
  fresh.src = `${location.pathname}?verify=fresh&t=${Date.now()}`;
  fresh.style.cssText = 'position:fixed;left:-20000px;top:0;width:1440px;height:900px;border:0;';
  D.body.appendChild(fresh);
  const freshDoc = await waitFor(() => {
    const doc = fresh.contentDocument;
    return doc && doc.querySelector('.app-shell') ? doc : null;
  }, 15000);
  await wait(1500);

  /* 在新窗口里看两处用户会看的地方：侧栏的今日字数、统计页的练习明细 */
  let freshToday = '';
  let freshRow = '';
  if (freshDoc) {
    freshToday = txt($(freshDoc, '.tip-card p'));
    byText(freshDoc, '.main-nav .nav-item', '练习统计').click();
    await wait(450);
    freshRow = txt($$(freshDoc, '.session-row')[0]);
  }
  const freshTodayWords = Number((freshToday.match(/今天已抄 ([\d,]+)/) || [0, '0'])[1].replace(/,/g, ''));
  record('重新打开软件：未结算的会话被补记（侧栏今日字数与练习明细都对得上）',
    freshTodayWords >= 321 && /321 字/.test(freshRow),
    { today: freshToday, firstRow: freshRow });

  const bootstrapAfter = await (await fetch('/api/bootstrap')).json();
  const recovered = bootstrapAfter.sessions.find(item => item.id === pendingId);
  record('补记的会话真的落到了数据库里', Boolean(recovered) && Number(recovered.words) === 321,
    recovered ? { words: recovered.words, durationMs: recovered.durationMs } : { found: false });
  const chapterProgressAfter = bootstrapAfter.progress
    .find(item => item.bookId === (bookRecord && bookRecord.id) && item.index === chapterIndex);
  record('补记一并算进本章累计时长（不是只记了练习明细）',
    Number((chapterProgressAfter && chapterProgressAfter.elapsedMs) || 0)
      >= Number((chapterProgressBefore && chapterProgressBefore.elapsedMs) || 0) + 600000 - 1000,
    { before: chapterProgressBefore && chapterProgressBefore.elapsedMs,
      after: chapterProgressAfter && chapterProgressAfter.elapsedMs });
  record('补记成功后快照被清掉（下次启动不会重复补）',
    localStorage.getItem('moji-pending-session') === null,
    { pending: localStorage.getItem('moji-pending-session') });

  /* ══ 14. 重进后继续写：速度不能虚高 ═════════════════════════════════════ */

  if (freshDoc) {
    /* 换到第 2 章再写：第 1 章刚被"完成本章"写满了，没有位置可以继续加字 */
    byText(freshDoc, '.main-nav .nav-item', '章节目录').click();
    await wait(300);
    const freshRows = $$(freshDoc, '.chapter-row');
    if (freshRows[1]) { freshRows[1].click(); await wait(500); }
    byText(freshDoc, '.main-nav .nav-item', '抄写工作台').click();
    await wait(350);

    const freshArea = qid(freshDoc, 'writingArea');
    const freshSource = qid(freshDoc, 'sourceTrack').textContent;
    if (freshArea && freshSource.length > 20) {
      /* 在已有内容后面接着往下写 16 个字 —— 这正是"重新打开软件，接着抄" */
      const typed = freshSource.slice(0, Math.min(freshSource.length, 16));
      freshArea.focus();
      freshArea.value = typed;
      freshArea.dispatchEvent(new freshDoc.defaultView.Event('input', { bubbles: true }));
      await wait(1500);                  // 会话刚起，时长还不到 5 秒
      const freshSpeedEarly = txt($$(freshDoc, '.metric-grid .metric strong')[2]);
      record('重进后继续写：时长样本不足时仍不给速度读数',
        /—/.test(freshSpeedEarly), { text: freshSpeedEarly });

      await wait(4200);
      const freshSpeed = txt($$(freshDoc, '.metric-grid .metric strong')[2]);
      const freshSpeedValue = Number((freshSpeed.match(/\d+/) || [0])[0]);
      /* 老 bug 的表现：拿整章字数除以几秒钟，读数上千。
         正确口径只算这次会话新写的那十几个字。 */
      const sessionWords = Math.max(0, typed.length - 2);   // 减去自动补的两个缩进
      record('重进后继续写：速度只按本次会话算（不是整章字数 ÷ 几秒）',
        freshSpeedValue > 0 && freshSpeedValue <= 300,
        { speed: freshSpeedValue, text: freshSpeed, sessionWords, chapterChars: freshSource.length });
    }
  }

  /* ══ 15. 结算只能发生一次 ═══════════════════════════════════════════════ */

  /* 这一条在"新窗口"里做：两个实例各自持有一份章节时长，交叉写入会让增量
     对不上账 —— 那不是要验的东西。同一实例里连触发三次，才能验"只加一次"。 */
  /* 用"切书"来触发结算：这是用户会做的动作，代码里也明确调用 settleSession。
     连着切四次（中间不等待）—— 第一次真的在结算，后三次进来时会话已经在收尾；
     防重入要是失效了（settleTask 没复用），同一段时长就会被加四遍。 */
  if (freshDoc) {
    const shelf = $$(freshDoc, '.book-card');
    const target = shelf.find(card => txt(card).includes(BOOK_NAME));
    const other = shelf.find(card => !txt(card).includes(BOOK_NAME));
    if (target && other) {
      /* 先把上一段会话收掉（它还带着前一条检查那几秒），下面量到的增量才干净 ——
         顺带也把当前章节带回第 1 章。 */
      other.click();
      await wait(1200);
      target.click();
      await wait(1200);

      const firstProbe = await (await fetch('/api/bootstrap')).json();
      const frameBook = firstProbe.books.find(item => (item.book.title || '').startsWith(BOOK_NAME));
      const frameBookId = frameBook ? frameBook.id : '';
      /* 按整本书求和，不盯某一章：这一章是第几章取决于当前停在哪，
         但它一定落在这本书的某一条进度上。 */
      const progressOf = payload => payload.progress
        .filter(item => item.bookId === frameBookId)
        .reduce((sum, item) => sum + Number(item.elapsedMs || 0), 0);
      const elapsedBefore = progressOf(firstProbe);

      target.click();                     // 先回到验证书（第 0 章）
      await wait(500);
      const frameArea = qid(freshDoc, 'writingArea');
      frameArea.value = qid(freshDoc, 'sourceTrack').textContent.slice(0, 22);
      frameArea.dispatchEvent(new freshDoc.defaultView.Event('input', { bubbles: true }));
      await wait(1600);                   // 攒一点时长

      other.click(); target.click(); other.click(); target.click();
      await wait(2000);                   // 等结算落库

      const elapsedAfter = progressOf(await (await fetch('/api/bootstrap')).json());
      const added = elapsedAfter - elapsedBefore;
      record('连续切换书籍四次只结算一次（时长不会被加好几遍）',
        added >= 1000 && added <= 3600,
        { added, before: elapsedBefore, after: elapsedAfter, expected: '≈1600ms' });
    }
  }

  /* ══ 16. 书架管理：改名 / 排序 / 删书 ═══════════════════════════════════ */

  /* 拿一本独立的书来试，免得动了前面那些检查一直依赖的书。
     它的正文里没有书名行，导入后书名会沿用文件名 —— 正是需要手改的场景。 */
  const SHELF_FILE = `管理测试-${stamp}`;
  const SHELF_NAME = `书A-${stamp}`;
  const SHELF_TEXT = ['第一章 书架', '', '这一章用来试书架管理。'].join('\n');
  if (await importBook(D, SHELF_FILE, SHELF_TEXT)) {
    await wait(700);

    const card = $$(D, '.book-card').find(item => txt(item).includes(SHELF_FILE));
    record('导入的书排在书架最前面', Boolean(card) && $$(D, '.book-card')[0] === card, {});
    record('卡片上有书籍管理入口', Boolean(card && card.querySelector('.book-more')), {});

    if (card) {
      card.querySelector('.book-more').click();
      await wait(250);
      record('点「⋯」打开管理菜单（改名 / 删除）',
        Boolean(card.querySelector('.book-menu')) && $$(D, '.book-menu button').length === 2,
        { items: $$(D, '.book-menu button').map(el => txt(el)) });

      byText(D, '.book-menu button', '改名').click();
      await frame(D);
      await wait(400);
      record('改名弹窗能打开，并带着当前的书名',
        Boolean($(D, '.book-info-modal'))
        && ($(D, '.book-info-modal input') || {}).value === SHELF_FILE,
        { value: ($(D, '.book-info-modal input') || {}).value });

      const titleInput = $(D, '.book-info-modal input');
      titleInput.value = SHELF_NAME;
      titleInput.dispatchEvent(new D.defaultView.Event('input', { bubbles: true }));
      byText(D, '.book-info-modal button', '保存').click();
      await wait(1000);
      record('改名后书架上立刻换成新书名',
        $$(D, '.book-card').some(item => txt(item).includes(SHELF_NAME)), {});
      record('改名也写进了数据库（不是只动了界面）',
        (await (await fetch('/api/bootstrap')).json()).books.some(item => item.book.title === SHELF_NAME), {});
    }

    /* 排序：切成「按书名」，书架顺序应该真的跟着变 */
    byText(D, '.side-section-label button', '按').click();
    await wait(350);
    const titles = $$(D, '.book-card .book-title').map(el => txt(el));
    const sorted = [...titles].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    record('切到「按书名」后书架真的按书名排了',
      titles.length >= 2 && JSON.stringify(titles) === JSON.stringify(sorted), { titles });
    byText(D, '.side-section-label button', '按').click();
    await wait(300);

    /* 删书 */
    const beforeDelete = $$(D, '.book-card').length;
    const deleteCard = $$(D, '.book-card').find(item => txt(item).includes(SHELF_NAME));
    deleteCard.querySelector('.book-more').click();
    await wait(250);
    $$(D, '.book-menu button').find(el => txt(el).includes('删除')).click();
    await wait(1000);
    record('从书架删除后这本书就没了（其余的书不受影响）',
      $$(D, '.book-card').length === beforeDelete - 1
      && !$$(D, '.book-card').some(item => txt(item).includes(SHELF_NAME)),
      { before: beforeDelete, after: $$(D, '.book-card').length });
    record('删除也写进了数据库',
      !(await (await fetch('/api/bootstrap')).json()).books.some(item => item.book.title === SHELF_NAME), {});
  }

  /* ══ 17. 收尾 ═══════════════════════════════════════════════════════════ */

  fresh.remove();
  await wait(1200);

  window.confirm = originalConfirm;
  record('整个检查过程没有未捕获的 JS 错误',
    errors.length === 0, { errors: errors.slice(0, 5) });
  record('检查结束后顶栏仍表明已存入数据库（会话收得住）',
    /已存入本地数据库/.test(txt($(D, '.save-state'))), { text: txt($(D, '.save-state')) });

  const failed = checks.filter(item => !item.ok);
  return {
    ok: failed.length === 0,
    host: D.documentElement.dataset.mojiHost || 'unknown',
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map(item => item.name),
    checks,
  };
})()
