#!/usr/bin/env node
/* 统计层回归测试。期望值全部手算，不调用被测函数生成。
   练习统计的典型错误（跨月跨年补记、今天还没练就算断、正确率分母用错）
   在界面上只表现为"数字不太对"，必须靠这里的断言兜住。

   用法: node verify/test-stats.js
*/
const path = require('path');
/* stats.js 是 UMD：加载它就会把 API 挂到 globalThis.MojiStats。
   不从 require 的返回值取，是因为 src/ 在 ESM 作用域下（项目根的 package.json
   是 type:module），require 拿到的是 module namespace 而不是那个对象。 */
require(path.join(__dirname, '..', 'src', 'core', 'stats.js'));
const S = globalThis.MojiStats;

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail });
const eq = (name, actual, expected) => record(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

/* ── 日期工具 ── */
eq('dateKey 按本地时间取年月日', S.dateKey(new Date(2026, 8, 15)), '2026-09-15');
/* new Date(undefined) 是 Invalid Date，不是"现在" —— 不传参数时曾经返回空串，
   导致最近 7 天序列整条崩掉。这一条专门守住默认参数。 */
record('dateKey 不传参数 = 当前日期（不是空串）', /^\d{4}-\d{2}-\d{2}$/.test(S.dateKey()), { actual: S.dateKey() });
eq('dateKey 传入 undefined 等价于当前日期', S.dateKey(undefined), S.dateKey());
eq('dateKey 传入 null 等价于当前日期', S.dateKey(null), S.dateKey());
eq('dateKey 接受时间戳', S.dateKey(new Date(2026, 8, 15, 23, 59).getTime()), '2026-09-15');
eq('dateKey 对非法输入返回空串', S.dateKey('不是日期'), '');
record('recentDays 用当前日期当右端点不抛错', S.recentDays(new Map(), S.dateKey(), 7).length === 7, { actual: (() => { try { return S.recentDays(new Map(), S.dateKey(), 7).length; } catch (e) { return String(e); } })() });
eq('shiftKey 跨月', S.shiftKey('2026-08-31', 1), '2026-09-01');
eq('shiftKey 跨年', S.shiftKey('2026-12-31', 1), '2027-01-01');
eq('shiftKey 跨年回退', S.shiftKey('2027-01-01', -1), '2026-12-31');
eq('shiftKey 闰年 2 月', S.shiftKey('2024-02-28', 1), '2024-02-29');
eq('shiftKey 平年 2 月', S.shiftKey('2026-02-28', 1), '2026-03-01');
eq('keyRange 含两端', S.keyRange('2026-09-13', '2026-09-15'), ['2026-09-13', '2026-09-14', '2026-09-15']);
eq('keyRange 跨月', S.keyRange('2026-08-30', '2026-09-02'), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);

/* ── 每日聚合 ── */
const sessions = [
  // 9/13 两次
  { date: '2026-09-13', at: Date.parse('2026-09-13T10:00:00'), words: 300, durationMs: 300000, correct: 295, incorrect: 5, bookId: 'b1', chapterIndex: 0 },
  { date: '2026-09-13', at: Date.parse('2026-09-13T20:00:00'), words: 200, durationMs: 200000, correct: 198, incorrect: 2, bookId: 'b1', chapterIndex: 1 },
  // 9/14 一次
  { date: '2026-09-14', at: Date.parse('2026-09-14T09:00:00'), words: 800, durationMs: 600000, correct: 790, incorrect: 10, bookId: 'b1', chapterIndex: 0 },
  // 9/15 一次
  { date: '2026-09-15', at: Date.parse('2026-09-15T09:00:00'), words: 400, durationMs: 240000, correct: 398, incorrect: 2, bookId: 'b2', chapterIndex: 3 }
];
const daily = S.rollupDaily(sessions);

eq('聚合：9/13 字数 = 300+200', daily.get('2026-09-13').words, 500);
eq('聚合：9/13 时长 = 300s+200s', daily.get('2026-09-13').durationMs, 500000);
eq('聚合：9/13 次数 = 2', daily.get('2026-09-13').count, 2);
eq('聚合：9/14 错误数 = 10', daily.get('2026-09-14').incorrect, 10);
eq('聚合：9/15 正确数 = 398', daily.get('2026-09-15').correct, 398);
eq('聚合：未出现的日期不在表里', daily.has('2026-09-12'), false);

/* 章节维度 */
const chapters = daily.get('2026-09-13').chapters;
eq('章节维度键 b1#0 字数', chapters['b1#0'].words, 300);
eq('章节维度键 b1#1 字数', chapters['b1#1'].words, 200);
eq('章节维度键 b1#0 次数', chapters['b1#0'].count, 1);

/* ── 区间汇总：速度与正确率 ── */
const week = S.summarize(daily, '2026-09-13', '2026-09-15');
eq('区间字数 = 500+800+400', week.words, 1700);
eq('区间时长 = 500000+600000+240000', week.durationMs, 1340000);
eq('区间次数 = 2+1+1', week.count, 4);
eq('区间错误 = 5+2+10+2', week.incorrect, 19);
eq('区间正确 = 295+198+790+398', week.correct, 1681);
/* 1340000ms = 22.3333 分钟；1700 / 22.3333 = 76.119… → 76 */
eq('区间速度 = round(1700 / (1340000/60000))', week.speed, 76);
/* 1681 / (1681+19) = 0.98882… */
record('区间正确率 = 1681/(1681+19)', Math.abs(week.accuracy - 1681 / 1700) < 1e-12, { actual: week.accuracy, expected: 1681 / 1700 });

/* 没有任何练习时：速度与正确率必须是"无"而不是 0，否则界面会显示"0% 正确率" */
const emptyWeek = S.summarize(daily, '2026-01-01', '2026-01-07');
eq('空区间字数 = 0', emptyWeek.words, 0);
eq('空区间速度 = 0（界面显示 —）', emptyWeek.speed, 0);
eq('空区间正确率 = null（界面显示 —）', emptyWeek.accuracy, null);

/* ── 连续天数 ── */
const days = S.activeDays(daily);
record('活跃日集合 = {13,14,15}', days.size === 3 && days.has('2026-09-13') && days.has('2026-09-15'), { days: [...days].sort() });
eq('今天练过 → 连续 3 天', S.currentStreak(days, '2026-09-15'), 3);
/* 今天还没练时从昨天起算，所以 13/14/15 连成的一段仍然是 3 天，不是"昨天算断" */
eq('今天还没练 → 从昨天起算，仍是 3 天（不算断）', S.currentStreak(days, '2026-09-16'), 3);
eq('只有昨天和前天练过 → 2 天', S.currentStreak(new Set(['2026-09-14', '2026-09-15']), '2026-09-16'), 2);
eq('连续两天没练 → 断（0 天）', S.currentStreak(days, '2026-09-17'), 0);
eq('只练过今天 → 1 天', S.currentStreak(new Set(['2026-09-16']), '2026-09-16'), 1);
eq('空集合 → 0 天', S.currentStreak(new Set(), '2026-09-15'), 0);

eq('最长连续 = 3', S.longestStreak(days), 3);
eq('最长连续：中间有断档取最大段', S.longestStreak(['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07']), 3);
eq('最长连续：单日', S.longestStreak(['2026-01-01']), 1);
eq('最长连续：跨月连续', S.longestStreak(['2026-08-30', '2026-08-31', '2026-09-01']), 3);
eq('最长连续：空', S.longestStreak([]), 0);

/* ── 最近 7 天序列 ── */
const series = S.recentDays(daily, '2026-09-15', 7);
eq('最近 7 天长度 = 7', series.length, 7);
eq('最近 7 天首日 = 09-09', series[0].key, '2026-09-09');
eq('最近 7 天末日 = 今天', series[6].key, '2026-09-15');
eq('末项标记为今天', series[6].label, '今天');
eq('09-13 落在倒数第 3 项', series[4].words, 500);
eq('09-14 的时长', series[5].durationMs, 600000);
eq('空白日字数为 0', series[0].words, 0);
/* 2026-09-13 是周日 */
eq('周日标签', series[4].label, '周日');

/* ── 周期对比 ── */
const cmp = S.comparePeriods(daily, '2026-09-15', 7);
eq('本周期范围', [cmp.currentStart, cmp.currentEnd], ['2026-09-09', '2026-09-15']);
eq('上一周期范围', [cmp.previousStart, cmp.previousEnd], ['2026-09-02', '2026-09-08']);
eq('本周期字数 = 1700', cmp.current.words, 1700);
eq('上一周期字数 = 0', cmp.previous.words, 0);
/* 上一周期为 0 而本周期有数据 → 增长无从计算，返回 null（界面显示"新增"） */
eq('上期为 0 时增长率 = null', cmp.change.words, null);

/* 窗口右移一天，边界就完全不同 —— 这类"差一天"的错最容易悄悄溜过去 */
const cmp2 = S.comparePeriods(daily, '2026-09-20', 7);
eq('end=09-20 时本周期起点 = 09-14', cmp2.currentStart, '2026-09-14');
/* 09-13 的 500 字被挤出了本周期 */
eq('end=09-20 时本周期 = 09-14..09-20（800+400）', cmp2.current.words, 1200);
eq('end=09-20 时上周期 = 09-07..09-13', [cmp2.previousStart, cmp2.previousEnd], ['2026-09-07', '2026-09-13']);
eq('09-13 的字数落进了上周期（500）', cmp2.previous.words, 500);
record('本周期涨幅 = (1200-500)/500 = 1.4', Math.abs(cmp2.change.words - 1.4) < 1e-12, { actual: cmp2.change.words });

/* 构造一个上期有数据的场景，验证涨幅计算 */
const daily2 = S.rollupDaily([
  { date: '2026-09-01', words: 100, durationMs: 100000, correct: 100, incorrect: 0 },
  { date: '2026-09-10', words: 300, durationMs: 300000, correct: 300, incorrect: 0 }
]);
const cmp3 = S.comparePeriods(daily2, '2026-09-10', 7);
eq('上期字数 = 100', cmp3.previous.words, 100);
eq('本期字数 = 300', cmp3.current.words, 300);
record('涨幅 = (300-100)/100 = 2.0', Math.abs(cmp3.change.words - 2) < 1e-12, { actual: cmp3.change.words });

/* ── 负数防护（导入重叠数据时不能让累计值变成负的） ── */
const bucket = S.emptyBucket();
S.addToBucket(bucket, { words: 100, durationMs: 1000, count: 1 }, 1);
S.addToBucket(bucket, { words: 400, durationMs: 5000, count: 2 }, -1);
eq('减法回退后字数不为负', bucket.words, 0);
eq('减法回退后次数不为负', bucket.count, 0);

/* ── 格式化 ── */
eq('formatDuration 0', S.formatDuration(0), '0 分钟');
eq('formatDuration 59 秒 → 0 分钟', S.formatDuration(59000), '0 分钟');
eq('formatDuration 90 分钟', S.formatDuration(90 * 60000), '1 小时 30 分');
eq('formatDuration 120 分钟', S.formatDuration(120 * 60000), '2 小时 00 分');
eq('formatDuration 45 分钟', S.formatDuration(45 * 60000), '45 分钟');
eq('formatClock 65 秒', S.formatClock(65000), '01:05');
eq('formatClock 0', S.formatClock(0), '00:00');
eq('formatPercent null → 破折号', S.formatPercent(null), '—');
eq('formatPercent 0.9888 → 99%', S.formatPercent(0.9888), '99%');
eq('formatRelativeDay 今天', S.formatRelativeDay('2026-09-15', '2026-09-15'), '今天练习');
eq('formatRelativeDay 昨天', S.formatRelativeDay('2026-09-14', '2026-09-15'), '昨天练习');
eq('formatRelativeDay 3 天前', S.formatRelativeDay('2026-09-12', '2026-09-15'), '3 天前练习');
eq('formatRelativeDay 40 天前落到具体日期', S.formatRelativeDay('2026-08-06', '2026-09-15'), '8 月 6 日练习');
eq('formatRelativeDay 空 → 尚未练习', S.formatRelativeDay('', '2026-09-15'), '尚未练习');

const failed = checks.filter(c => !c.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  passed: checks.length - failed.length,
  total: checks.length,
  failed: failed.map(f => `${f.name} → 实际 ${JSON.stringify(f.detail.actual)} / 期望 ${JSON.stringify(f.detail.expected)}`),
  checks
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
