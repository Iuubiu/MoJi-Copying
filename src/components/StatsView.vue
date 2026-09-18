<script setup>
/** 练习统计：累计、连续天数、最近 7 天与明细。 */
import { computed, ref } from 'vue';

import { state, stats } from '../composables/useStore.js';
import { MojiStats } from '../core/index.js';

const { formatNumber, formatDuration, formatPercent, formatRelativeDay, dateKey } = MojiStats;

const metric = ref('words');

const series = computed(() => stats.value.recent);
const maxValue = computed(() => {
  const goal = Number(state.settings.dailyGoal) || 800;
  const values = series.value.map(point => (metric.value === 'words' ? point.words : Math.round(point.durationMs / 60000)));
  return Math.max(...values, metric.value === 'words' ? goal : 10, 1);
});

function barHeight(point) {
  const value = metric.value === 'words' ? point.words : Math.round(point.durationMs / 60000);
  return value ? `${Math.max(20, Math.round((value / maxValue.value) * 145))}px` : '10px';
}

function barLabel(point) {
  const value = metric.value === 'words' ? `${formatNumber(point.words)} 字` : `${Math.round(point.durationMs / 60000)} 分钟`;
  return value;
}

const recentSessions = computed(() => state.sessions.slice(0, 8));

function accuracyOf(record) {
  const typed = Number(record.correct || 0) + Number(record.incorrect || 0);
  return typed ? formatPercent(Number(record.correct || 0) / typed, 1) : '—';
}

function changeLabel(change, unit) {
  if (change === null || change === undefined) return '与上周期持平';
  if (!change) return '与上周期持平';
  return `${change > 0 ? '↑' : '↓'} ${formatPercent(Math.abs(change))} 较上周期${unit}`;
}

function changeClass(change) {
  if (!change) return 'flat';
  return change > 0 ? 'up' : 'down';
}

const week = computed(() => stats.value.week);
const lifetime = computed(() => stats.value.lifetime);
</script>

<template>
  <section class="stats-view view active">
    <div class="page-heading compact">
      <div>
        <p class="eyebrow">练习记录</p>
        <h1>练习统计</h1>
        <p class="heading-meta"><span>全部数字来自本地练习记录，实时更新</span></p>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-summary-card">
        <span>累计抄写字数</span><strong>{{ formatNumber(lifetime.words) }}</strong>
        <small>{{ stats.today.words ? `今天 ${formatNumber(stats.today.words)} 字` : '今天尚未开始' }}</small>
      </div>
      <div class="stat-summary-card">
        <span>累计练习时长</span><strong>{{ formatDuration(lifetime.durationMs) }}</strong>
        <small>共 {{ formatNumber(lifetime.count) }} 次练习</small>
      </div>
      <div class="stat-summary-card">
        <span>平均速度</span><strong>{{ lifetime.speed ? formatNumber(lifetime.speed) : '—' }}</strong>
        <small>{{ lifetime.speed ? '按累计练习计算' : '完成一段练习后显示' }}</small>
      </div>
    </div>

    <div class="streak-row">
      <div class="streak-badge"><span>♨</span><strong>{{ stats.streak }} 天</strong><small>连续练习</small></div>
      <div class="streak-badge ghost"><span>❋</span><strong>{{ stats.longest }} 天</strong><small>最长连续</small></div>
    </div>

    <div class="chart-card">
      <div class="section-heading">
        <div><h2>最近 7 天</h2><p>{{ week.currentStart }} ~ {{ week.currentEnd }}</p></div>
      </div>
      <div class="week-metrics">
        <div class="week-metric">
          <span>抄写字数</span><strong>{{ formatNumber(week.current.words) }}</strong>
          <small class="change" :class="changeClass(week.change.words)">{{ changeLabel(week.change.words) }}</small>
        </div>
        <div class="week-metric">
          <span>练习时长</span><strong>{{ formatDuration(week.current.durationMs) }}</strong>
          <small class="change" :class="changeClass(week.change.durationMs)">{{ changeLabel(week.change.durationMs) }}</small>
        </div>
        <div class="week-metric">
          <span>平均速度</span><strong>{{ week.current.speed ? `${formatNumber(week.current.speed)} 字/分` : '—' }}</strong>
          <small class="change" :class="changeClass(week.change.speed)">{{ changeLabel(week.change.speed) }}</small>
        </div>
        <div class="week-metric">
          <span>正确率</span><strong>{{ formatPercent(week.current.accuracy, 1) }}</strong>
          <small class="change flat">按逐字比对</small>
        </div>
      </div>
    </div>

    <div class="chart-card">
      <div class="section-heading">
        <div><h2>每日趋势</h2><p>最近 7 天</p></div>
        <div class="metric-switch">
          <button :class="{ active: metric === 'words' }" type="button" @click="metric = 'words'">字数</button>
          <button :class="{ active: metric === 'durationMs' }" type="button" @click="metric = 'durationMs'">时长</button>
        </div>
      </div>
      <div class="bar-chart">
        <div v-for="point in series" :key="point.key" class="bar"
             :class="{ active: point.isToday, empty: !point.words }"
             :style="{ '--height': barHeight(point) }" :data-label="barLabel(point)"></div>
      </div>
      <div class="chart-days"><span v-for="point in series" :key="point.key">{{ point.label }}</span></div>
    </div>

    <div class="chart-card">
      <div class="section-heading"><div><h2>最近练习</h2><p>最近 8 次明细</p></div></div>
      <div class="session-list">
        <p v-if="!recentSessions.length" class="proof-empty">还没有练习记录。开始抄写，这里就会出现明细。</p>
        <div v-for="record in recentSessions" :key="record.id" class="session-row">
          <span class="session-when">{{ formatRelativeDay(record.date, dateKey()) }}</span>
          <span class="session-book">{{ record.bookTitle }} · {{ record.chapterTitle }}</span>
          <span class="session-words">{{ formatNumber(record.words) }} 字</span>
          <span class="session-time">{{ formatDuration(record.durationMs) }}</span>
          <span class="session-accuracy">{{ accuracyOf(record) }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
