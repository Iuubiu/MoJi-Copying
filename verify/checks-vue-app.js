/* Vue 版界面回归检查（在真实浏览器里跑）。

   这一份刻意只从**用户视角**验证：看 DOM、点按钮、敲字，不碰内部状态 ——
   换前端框架时最容易坏的就是"数据对了但界面没接上"。

   跑法（后端同时托管 dist/）：
     npm run build
     python -m server --port 41777 --db <临时库>
     node verify/cdp-attach.js <debugPort> verify/checks-vue-app.js
*/
(async () => {
  const q = id => document.getElementById(id);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  const started = Date.now();
  while (!document.querySelector('.app-shell') && Date.now() - started < 15000) await wait(50);
  await wait(800);

  record('Vue 应用已挂载（.app-shell 存在）', Boolean(document.querySelector('.app-shell')), {});

  /* ── 书架 ── */
  const shelfCount = document.querySelectorAll('.book-card').length;
  record('书架渲染出书籍卡片', shelfCount >= 1, { shelfCount });
  record('今日目标来自后端数据', /今天(已抄|还没有)/.test((q('goalText') || {}).textContent || document.querySelector('.tip-card p')?.textContent || ''),
    { text: (document.querySelector('.tip-card p') || {}).textContent });

  /* ── 抄写区 ── */
  const writing = q('writingArea');
  record('抄写区存在（textarea）', Boolean(writing), {});
  const display = q('typingDisplay');
  record('校对显示层存在', Boolean(display), {});

  if (writing) {
    const chapter = document.querySelector('#pageTitle') ? document.querySelector('#pageTitle').textContent : '';
    record('章节标题已渲染', Boolean(chapter && chapter.length), { chapter });

    /* 输入 5 个字，其中故意写错一个 —— 校对层应该出现红字 */
    const source = (document.querySelector('.source-track') || {}).textContent || '';
    const typed = source.slice(0, 4) + '错';
    writing.value = typed;
    writing.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
    await wait(120);

    const okSpans = display.querySelectorAll('span.ok').length;
    const badSpans = display.querySelectorAll('span.bad').length;
    record('逐字校对：正确字与错字分别标出', okSpans >= 4 && badSpans >= 1, { okSpans, badSpans });

    const writtenText = document.querySelector('.metric-grid .metric strong');
    record('侧栏「已抄写」随输入更新', Boolean(writtenText && /\d/.test(writtenText.textContent)), { text: writtenText && writtenText.textContent });

    /* ── 校对清单 ── */
    const proofButton = [...document.querySelectorAll('.toolbar-button')].find(el => el.textContent.includes('校对清单'));
    record('工具栏有「校对清单」按钮', Boolean(proofButton), {});
    if (proofButton) {
      proofButton.click();
      await frame();
      await wait(80);
      const panel = document.querySelector('.proof-panel');
      const rows = document.querySelectorAll('.proof-row').length;
      const visible = panel && panel.offsetParent !== null;
      record('点开后校对清单可见并列出偏差', Boolean(visible) && rows >= 1, { visible, rows });
      if (rows) {
        const before = (writing.selectionStart);
        document.querySelectorAll('.proof-row')[0].click();
        await frame();
        record('点条目把光标跳到那个字上', writing.selectionStart !== before || writing.selectionStart === 4,
          { selectionStart: writing.selectionStart, before });
      }
    }
  }

  /* ── 章节目录：搜索 ── */
  const navToLibrary = [...document.querySelectorAll('.nav-item')].find(el => el.textContent.includes('章节'));
  if (navToLibrary) {
    navToLibrary.click();
    await frame();
    await wait(120);
    const searchInput = document.querySelector('.search-bar input');
    record('章节目录有搜索框', Boolean(searchInput), {});
    if (searchInput) {
      const source = (document.querySelector('.source-track') || {}).textContent || '';
      /* 取两个非空白字符当关键词：原文开头是两个全角空格缩进，直接 slice 会拿到空白 */
      const keyword = (source.match(/[^\s\u3000]{2}/) || [''])[0];
      searchInput.value = keyword;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await frame();
      const searchButton = [...document.querySelectorAll('.search-bar button')].find(el => el.textContent.includes('搜索'));
      searchButton.click();
      await frame();
      await wait(150);
      const hits = document.querySelectorAll('.search-hit').length;
      const summary = (document.querySelector('.search-summary') || {}).textContent || '';
      record('搜索能命中正文并列出结果', hits >= 1, { keyword, hits, summary });
      if (hits) {
        document.querySelectorAll('.search-hit')[0].click();
        await frame();
        await wait(200);
        const mark = document.querySelector('.source-mark');
        record('点搜索结果会跳回工作台并高亮命中片段', Boolean(mark) && mark.textContent.length > 0,
          { mark: mark ? mark.textContent : null });
      }
    }
  }

  /* ── 统计页 ── */
  const navToStats = [...document.querySelectorAll('.nav-item')].find(el => el.textContent.includes('统计'));
  if (navToStats) {
    navToStats.click();
    await frame();
    await wait(150);
    const cards = document.querySelectorAll('.stat-summary-card strong').length;
    const bars = document.querySelectorAll('.bar-chart .bar').length;
    record('统计页有汇总卡片', cards >= 3, { cards });
    record('统计页柱状图渲染 7 天', bars === 7, { bars });
  }

  const failed = checks.filter(item => !item.ok);
  return {
    ok: failed.length === 0,
    host: document.documentElement.dataset.mojiHost || 'unknown',
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map(item => item.name),
    checks,
  };
})()
