/**
 * 纯计算层的统一入口。
 *
 * `stats.js` 与 `encoding.js` 是 UMD（挂到 globalThis），这样同一份文件既能被
 * 浏览器/Vite 加载，也能被 Node 的回归测试直接 require —— 那 80 多项测试是
 * 这个项目里最值钱的东西之一，不能因为换了前端框架就丢掉。
 */
import './stats.js';
import './encoding.js';

export const MojiStats = globalThis.MojiStats;
export const MojiEncoding = globalThis.MojiEncoding;

/* 最常用的几个直接转出去：组件里不必每次都写 MojiStats.xxx */
export const {
  dateKey, shiftKey, summarize, finalizeSummary, emptyBucket,
  activeDays, currentStreak, longestStreak, recentDays, comparePeriods,
  formatNumber, formatDuration, formatClock, formatPercent, formatRelativeDay,
} = globalThis.MojiStats;
