/* 会话持久化与统计口径回归检查（在真实页面里跑）。
   覆盖四件事：
     1. 平均速度的分子分母同口径 —— 重进软件后接着写，不能再出现"几千字/分"
     2. settleSession 幂等 —— 切后台 + 关窗口连着触发，时长只能加一次
     3. 落库后今日时长不重复计算（已入库时长扣减生效）
     4. 退出快照：页面被销毁时没落库的会话，下次启动要补回来（且幂等）

   用法：
     node verify/cdp-attach.js <debugPort> verify/checks-session-persistence.js
*/
(async () => {
  const q = id => document.getElementById(id);
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  const started = Date.now();
  const track = q('sourceTrack');
  if (!track) return { ok: false, failed: ['附着到的不是墨迹页面'], checks: [] };
  while (track.textContent.length === 0 && Date.now() - started < 15000) await wait(50);
  await wait(500);                                  // 让 boot 里剩下的异步链走完

  const chapter = currentChapter();
  const writing = q('writingArea');
  const setText = text => { writing.value = text; writing.dispatchEvent(new Event('input', { bubbles: true })); };
  const speedNumber = () => {
    const hit = q('speedMetric').textContent.match(/[\d,]+/);
    return hit ? Number(hit[0].replace(/,/g, '')) : 0;
  };

  /* ── 1. 速度口径：时长数据丢了以后接着写，不能拿整章字数除以本次时长 ── */
  await settleSession();
  await wait(100);
  /* 现场：整章已经写了 500 字，但本章累计时长为 0（模拟退出时时长没保存下来） */
  chapter.written = '字'.repeat(500);
  writing.value = chapter.written;
  chapter.timeSpentMs = 0;
  practice.active = false;
  updateMetrics();
  /* 接着写 10 个字 → 开一段新会话 */
  setText(`${chapter.written}一二三四五六七八九十`);
  await frame();
  practice.startedAt = Date.now() - 60000;          // 这段会话已经练了 1 分钟
  updateMetrics();
  const sessionWords = sessionTotals().words;
  record('重进后继续写：速度 = 本次会话字数 ÷ 本次时长（≈10 字/分，不是整章 510）',
    sessionWords === 10 && speedNumber() === 10,
    { sessionWords, speedText: q('speedMetric').textContent, baseWords: practice.baseWords, chapterWords: chapter.written.length });

  practice.startedAt = Date.now() - 1000;           // 样本不足 5 秒
  updateMetrics();
  record('时长样本不足 5 秒时不显示速度（杜绝刚开写就冒出的天文数字）',
    q('speedMetric').textContent.trim().startsWith('—'),
    { speedText: q('speedMetric').textContent });
  await settleSession();
  await wait(100);

  /* ── 2. 结算幂等：visibilitychange 与 pagehide 连着来，时长只能加一次 ── */
  chapter.written = '';
  setText('');
  await frame();
  chapter.timeSpentMs = 1000;
  setText('六月初一，');
  await frame();
  practice.startedAt = Date.now() - 30000;          // 这段会话 30 秒
  const pendingTotals = sessionTotals();
  const msBefore = chapter.timeSpentMs;
  await Promise.all([settleSession(), settleSession()]);
  await wait(150);
  const applied = chapter.timeSpentMs - msBefore;
  record('连续两次结算只把时长累加一次',
    Math.abs(applied - pendingTotals.durationMs) < 1500,
    { applied, expected: pendingTotals.durationMs });

  /* ── 3. 落库不把今日时长算两遍 ── */
  chapter.written = '';
  setText('');
  await frame();
  setText('六月初一，长安');
  await frame();
  practice.startedAt = Date.now() - 40000;          // 放大误差：这段会话 40 秒
  const liveBefore = todaySummary().durationMs;
  await flushSession();
  await wait(150);
  const liveAfter = todaySummary().durationMs;
  record('落库后今日时长不翻倍（已入库时长扣减生效）',
    Math.abs(liveAfter - liveBefore) < 1500,
    { beforeFlush: liveBefore, afterFlush: liveAfter });
  await settleSession();
  await wait(150);

  /* ── 4. 退出快照：没落库的会话要在下次启动补回来 ── */
  const stamp = Date.now();
  const pending = {
    id: `verify-pending-${stamp}`,
    at: stamp,
    date: dateKey(),
    bookId: state.bookId,
    bookTitle: state.book ? state.book.title : '',
    chapterIndex: state.chapterIndex,
    chapterTitle: chapter.title,
    words: 321, durationMs: 600000, correct: 300, incorrect: 21, final: false,
    chapterMsBefore: 0
  };
  chapter.timeSpentMs = 0;
  localStorage.setItem('moji-pending-session', JSON.stringify(pending));
  const recovered = await recoverPendingSession();
  await wait(150);
  const stored = state.sessions.find(item => item.id === pending.id);
  const daily = state.daily.get(dateKey()) || {};
  record('退出快照补进 sessions', recovered === true && Boolean(stored) && stored.words === 321,
    stored ? { words: stored.words, durationMs: stored.durationMs } : null);
  record('退出快照补进每日汇总', Number(daily.words || 0) >= 321, { words: daily.words, durationMs: daily.durationMs });
  record('退出快照补齐本章累计时长', Number(chapter.timeSpentMs || 0) === 600000, { timeSpentMs: chapter.timeSpentMs });

  /* 幂等：同一份快照再补一次，章节时长不能翻倍 */
  localStorage.setItem('moji-pending-session', JSON.stringify(pending));
  await recoverPendingSession();
  await wait(150);
  record('重复补偿不会把本章时长加两遍', Number(chapter.timeSpentMs || 0) === 600000, { timeSpentMs: chapter.timeSpentMs });
  record('补偿成功后快照被清空', localStorage.getItem('moji-pending-session') === null,
    { raw: localStorage.getItem('moji-pending-session') });

  /* 清掉验证用的记录，别把测试数据留在库里 */
  await deleteRecord('sessions', pending.id);
  await refreshDaily(pending.date);
  chapter.timeSpentMs = 0;
  renderChapter();
  renderStats();

  const failed = checks.filter(item => !item.ok);
  return {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map(item => item.name),
    checks
  };
})()
