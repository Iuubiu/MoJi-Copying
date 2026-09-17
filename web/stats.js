/* stats.js —— 纯计算层：日期、每日聚合、连续天数、周期对比、格式化。
 *
 * 这里不碰 DOM、不碰 IndexedDB，全部是"进数据出数据"的纯函数，
 * 因此可以在 Node 里直接 require 做回归测试（见 verify/test-stats.js）。
 * 练习统计最容易出错的地方（跨天、补记、连续天数的边界）都集中在这里，
 * 而它们的错误在界面上往往只表现为"数字不太对"，肉眼极难发现。
 */
(function (global) {
  'use strict';

  const DAY_MS = 86400000;

  /* ── 日期 ──
     一律按本地时间取年月日；构造日期时锚在正午，
     这样加减天数不会因为夏令时把 00:00 挪到前一天。 */
  /* 注意 new Date(undefined) 是 Invalid Date（不是"现在"），
     所以"不传参数 = 取当前时间"必须显式判断，不能只写 new Date(input)。 */
  function dateKey(input) {
    const date = input === undefined || input === null
      ? new Date()
      : (input instanceof Date ? input : new Date(input));
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseKey(key) {
    const parts = String(key || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  }

  function shiftKey(key, deltaDays) {
    const date = parseKey(key);
    if (!date) return '';
    date.setDate(date.getDate() + deltaDays);
    return dateKey(date);
  }

  /* 含两端的日期序列 */
  function keyRange(startKey, endKey) {
    const out = [];
    let cursor = startKey;
    let guard = 0;
    while (cursor && cursor <= endKey && guard < 4000) {
      out.push(cursor);
      cursor = shiftKey(cursor, 1);
      guard += 1;
    }
    return out;
  }

  function emptyBucket() {
    return { words: 0, durationMs: 0, count: 0, correct: 0, incorrect: 0 };
  }

  function addToBucket(bucket, entry, sign = 1) {
    bucket.words += sign * Number(entry.words || 0);
    bucket.durationMs += sign * Number(entry.durationMs || 0);
    bucket.count += sign * (entry.count === undefined ? 1 : Number(entry.count || 0));
    bucket.correct += sign * Number(entry.correct || 0);
    bucket.incorrect += sign * Number(entry.incorrect || 0);
    /* 减法回退时不允许出现负数（导入了重叠数据等异常情况下保持可用） */
    ['words', 'durationMs', 'count', 'correct', 'incorrect'].forEach(field => {
      if (bucket[field] < 0) bucket[field] = 0;
    });
    return bucket;
  }

  /* 把 sessions 汇总成 { date -> bucket }，供 daily 物化视图与统计页共用 */
  function rollupDaily(sessions) {
    const map = new Map();
    (sessions || []).forEach(session => {
      const key = session.date || dateKey(session.at || Date.now());
      if (!key) return;
      if (!map.has(key)) map.set(key, emptyBucket());
      const bucket = map.get(key);
      addToBucket(bucket, session, 1);
      /* 章节维度 */
      if (session.bookId !== undefined && session.chapterIndex !== undefined) {
        if (!bucket.chapters) bucket.chapters = {};
        const chapterKey = `${session.bookId}#${session.chapterIndex}`;
        if (!bucket.chapters[chapterKey]) bucket.chapters[chapterKey] = { words: 0, durationMs: 0, count: 0 };
        const chapter = bucket.chapters[chapterKey];
        chapter.words += Number(session.words || 0);
        chapter.durationMs += Number(session.durationMs || 0);
        chapter.count += 1;
      }
    });
    return map;
  }

  /* 区间汇总：字数、时长、次数、正确/错误、速度、正确率 */
  function summarize(dailyMap, startKey, endKey) {
    const bucket = emptyBucket();
    keyRange(startKey, endKey).forEach(key => {
      const record = dailyMap.get(key);
      if (record) addToBucket(bucket, record, 1);
    });
    return finalizeSummary(bucket);
  }

  function summarizeList(list) {
    const bucket = emptyBucket();
    (list || []).forEach(entry => addToBucket(bucket, entry, 1));
    return finalizeSummary(bucket);
  }

  function finalizeSummary(bucket) {
    const minutes = bucket.durationMs / 60000;
    const typed = bucket.correct + bucket.incorrect;
    return {
      words: bucket.words,
      durationMs: bucket.durationMs,
      count: bucket.count,
      correct: bucket.correct,
      incorrect: bucket.incorrect,
      speed: minutes > 0 && bucket.words ? Math.round(bucket.words / minutes) : 0,
      accuracy: typed > 0 ? bucket.correct / typed : null
    };
  }

  /* 有练习记录的所有日期（用于连续天数） */
  function activeDays(dailyMap) {
    const days = new Set();
    dailyMap.forEach((record, key) => { if (record.words > 0 || record.durationMs > 0) days.add(key); });
    return days;
  }

  /* 当前连续天数：从今天往回数；今天还没练就从昨天起算，这样白天不会突然断掉 */
  function currentStreak(days, todayKey) {
    const set = days instanceof Set ? days : new Set(days || []);
    let cursor = set.has(todayKey) ? todayKey : shiftKey(todayKey, -1);
    let streak = 0;
    let guard = 0;
    while (set.has(cursor) && guard < 4000) { streak += 1; cursor = shiftKey(cursor, -1); guard += 1; }
    return streak;
  }

  /* 历史最长连续天数 */
  function longestStreak(days) {
    const sorted = [...(days instanceof Set ? days : new Set(days || []))].filter(Boolean).sort();
    let best = 0;
    let run = 0;
    let previous = null;
    sorted.forEach(key => {
      run = previous && shiftKey(previous, 1) === key ? run + 1 : 1;
      if (run > best) best = run;
      previous = key;
    });
    return best;
  }

  /* 最近 N 天的逐日序列（含今天），供柱状图使用 */
  function recentDays(dailyMap, endKey, days) {
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const out = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const key = shiftKey(endKey, -offset);
      const record = dailyMap.get(key) || emptyBucket();
      const summary = finalizeSummary(record);
      const date = parseKey(key);
      out.push({
        key,
        words: summary.words,
        durationMs: summary.durationMs,
        count: summary.count,
        speed: summary.speed,
        accuracy: summary.accuracy,
        label: offset === 0 ? '今天' : `周${weekdays[date.getDay()]}`,
        isToday: offset === 0
      });
    }
    return out;
  }

  /* 本周期 vs 上一周期（默认各 7 天） */
  function comparePeriods(dailyMap, endKey, days) {
    const currentStart = shiftKey(endKey, -(days - 1));
    const previousEnd = shiftKey(currentStart, -1);
    const previousStart = shiftKey(previousEnd, -(days - 1));
    const current = summarize(dailyMap, currentStart, endKey);
    const previous = summarize(dailyMap, previousStart, previousEnd);
    const delta = (now, before) => {
      if (!before) return now ? null : 0;
      return (now - before) / before;
    };
    return {
      days,
      currentStart, currentEnd: endKey, current,
      previousStart, previousEnd, previous,
      change: {
        words: delta(current.words, previous.words),
        durationMs: delta(current.durationMs, previous.durationMs),
        speed: delta(current.speed, previous.speed),
        accuracy: current.accuracy === null || previous.accuracy === null ? null : current.accuracy - previous.accuracy
      }
    };
  }

  /* ── 格式化 ── */
  function formatNumber(value) {
    return Number(value || 0).toLocaleString('zh-CN');
  }

  function formatDuration(ms) {
    const totalMinutes = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
    if (!totalMinutes) return '0 分钟';
    const hours = Math.floor(totalMinutes / 60);
    return hours ? `${hours} 小时 ${String(totalMinutes % 60).padStart(2, '0')} 分` : `${totalMinutes} 分钟`;
  }

  function formatClock(ms) {
    const totalSeconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }

  function formatPercent(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return `${(value * 100).toFixed(digits)}%`;
  }

  function formatRelativeDay(key, todayKey) {
    if (!key) return '尚未练习';
    const day = Math.round((parseKey(todayKey) - parseKey(key)) / DAY_MS);
    if (day === 0) return '今天练习';
    if (day === 1) return '昨天练习';
    if (day < 0) return '刚刚练习';
    if (day < 30) return `${day} 天前练习`;
    const date = parseKey(key);
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日练习`;
  }

  const api = {
    DAY_MS, dateKey, parseKey, shiftKey, keyRange,
    emptyBucket, addToBucket, rollupDaily, summarize, summarizeList, finalizeSummary,
    activeDays, currentStreak, longestStreak, recentDays, comparePeriods,
    formatNumber, formatDuration, formatClock, formatPercent, formatRelativeDay
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MojiStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
