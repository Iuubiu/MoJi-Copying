<script setup>
/** 侧栏：书架、今日目标、当前用户。 */
import { computed } from 'vue';

import { bookTotals, currentBook, settleSession, state, stats, todaySummary } from '../composables/useStore.js';
import { MojiStats } from '../core/index.js';

const { formatNumber } = MojiStats;

const props = defineProps({
  onImport: { type: Function, required: true },
  onSettings: { type: Function, required: true },
});

const goal = computed(() => Number(state.settings.dailyGoal) || 800);
const today = computed(() => todaySummary());
const goalPercent = computed(() => Math.min(100, Math.round((today.value.words / goal.value) * 100)));
const nickname = computed(() => state.settings.nickname || '抄书人');

function selectBook(bookId) {
  state.view = 'workspace';
  if (bookId === state.bookId) return;
  settleSession();
  state.bookId = bookId;
  state.chapterIndex = 0;
  localStorage.setItem('ink-current-book-id', bookId);
  localStorage.setItem('ink-chapter-index', '0');
}

function progressOf(book) {
  const totals = bookTotals(book);
  return totals.total ? `${totals.percent}%` : '—';
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">墨</div>
      <div>
        <div class="brand-name">墨迹</div>
        <div class="brand-subtitle">小说抄写工作台</div>
      </div>
    </div>

    <div class="side-section-label">
      我的书架 <span>{{ String(state.library.length).padStart(2, '0') }}</span>
    </div>
    <div class="shelf-list">
      <button v-for="entry in state.library" :key="entry.id" class="book-card"
              :class="{ active: entry.id === state.bookId }" type="button" @click="selectBook(entry.id)">
        <span class="book-title">{{ entry.book.title }}</span>
        <span class="book-author">{{ entry.book.author }}</span>
        <small>{{ entry.book.chapters.length }} 章 · {{ progressOf(entry.book) }}</small>
      </button>
    </div>
    <button class="add-book-button" type="button" @click="props.onImport()"><span>＋</span> 导入新小说</button>

    <label class="encoding-picker">
      <span>TXT 编码</span>
      <select v-model="state.encoding" aria-label="TXT 编码"
              @change="localStorage.setItem('ink-encoding', state.encoding)">
        <option value="auto">自动识别</option>
        <option value="utf-8">UTF-8</option>
        <option value="gb18030">GBK / GB18030</option>
        <option value="utf-16le">UTF-16 LE</option>
        <option value="utf-16be">UTF-16 BE</option>
      </select>
    </label>

    <nav class="main-nav" aria-label="主导航">
      <button class="nav-item" :class="{ active: state.view === 'workspace' }" type="button" @click="state.view = 'workspace'">
        <span class="nav-icon">▧</span> 抄写工作台
      </button>
      <button class="nav-item" :class="{ active: state.view === 'library' }" type="button" @click="state.view = 'library'">
        <span class="nav-icon">▤</span> 章节目录
      </button>
      <button class="nav-item" :class="{ active: state.view === 'stats' }" type="button" @click="state.view = 'stats'">
        <span class="nav-icon">↗</span> 练习统计
      </button>
    </nav>

    <div class="sidebar-bottom">
      <div class="tip-card">
        <div class="tip-icon">✦</div>
        <div>
          <strong>今日小目标</strong>
          <p>今天已抄 {{ formatNumber(today.words) }} / {{ formatNumber(goal) }} 字</p>
          <div class="tip-progress"><span :style="{ width: goalPercent + '%' }"></span></div>
        </div>
      </div>
      <div class="profile">
        <span class="avatar">{{ Array.from(nickname)[0] || '墨' }}</span>
        <span>
          <strong>{{ nickname }}</strong>
          <small>连续练习 {{ stats.streak }} 天</small>
        </span>
        <button class="profile-more" type="button" aria-label="设置" title="设置" @click="props.onSettings()">⚙</button>
      </div>
    </div>
  </aside>
</template>
