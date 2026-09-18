<script setup>
/**
 * 侧栏：书架、今日目标、当前用户。
 *
 * 书架管理（改信息 / 删书 / 排序）都收在这一层：卡片悬浮出「⋯」，
 * 菜单里两个动作；排序在「我的书架」右边切换。改信息用弹窗，
 * 挂在组件末尾 —— .modal-backdrop 是 position: fixed，不会掺进外壳的 flex 布局。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  bookTotals, removeBook, settleSession, showToast, state, stats, todaySummary, updateBookInfo,
} from '../composables/useStore.js';
import { MojiStats } from '../core/index.js';
import BookInfoModal from './BookInfoModal.vue';

const { formatNumber } = MojiStats;

const props = defineProps({
  onImport: { type: Function, required: true },
  onSettings: { type: Function, required: true },
});

const goal = computed(() => Number(state.settings.dailyGoal) || 800);
const today = computed(() => todaySummary());
const goalPercent = computed(() => Math.min(100, Math.round((today.value.words / goal.value) * 100)));
const nickname = computed(() => state.settings.nickname || '抄书人');

/* ── 书架管理 ─────────────────────────────────────────────────────────── */

/* 排序方式记在本地：书架是每天第一眼看到的地方，不该每次打开都重置 */
const sortMode = ref(localStorage.getItem('ink-shelf-sort') || 'recent');
const menuFor = ref('');          // 打开菜单的那本书
const editing = ref(null);        // 正在改信息的书（null = 弹窗关着）

/** 「最近」沿用后端给的顺序（按 updated_at 排）；「书名」按中文习惯比。 */
const shelf = computed(() => {
  const list = [...state.library];
  if (sortMode.value === 'title') {
    list.sort((a, b) => String(a.book.title).localeCompare(String(b.book.title), 'zh-Hans-CN'));
  }
  return list;
});

function toggleSort() {
  sortMode.value = sortMode.value === 'recent' ? 'title' : 'recent';
  localStorage.setItem('ink-shelf-sort', sortMode.value);
}

function toggleMenu(bookId, event) {
  event.stopPropagation();
  menuFor.value = menuFor.value === bookId ? '' : bookId;
}

function startEdit(bookId) {
  menuFor.value = '';
  editing.value = state.library.find(item => item.id === bookId) || null;
}

async function saveInfo(values) {
  const target = editing.value;
  editing.value = null;
  if (!target) return;
  await updateBookInfo(target.id, values);
  showToast('书籍信息已更新');
}

async function confirmDelete(bookId) {
  menuFor.value = '';
  const entry = state.library.find(item => item.id === bookId);
  if (!entry) return;
  if (!window.confirm(`从书架删除《${entry.book.title}》？\n该书的章节与抄写进度会一起移除，练习记录会保留。`)) return;
  if (entry.id === state.bookId) settleSession();
  await removeBook(entry.id);
  const next = state.library[0];
  if (next) {
    state.bookId = next.id;
    state.chapterIndex = 0;
    localStorage.setItem('ink-current-book-id', next.id);
  }
  showToast('已从书架删除');
}

/* 点到别处就收起菜单 */
function closeMenu() { menuFor.value = ''; }
onMounted(() => document.addEventListener('click', closeMenu));
onBeforeUnmount(() => document.removeEventListener('click', closeMenu));

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
      <span class="label-text">我的书架</span>
      <span class="label-count">{{ String(state.library.length).padStart(2, '0') }}</span>
      <button class="shelf-sort" type="button" @click="toggleSort"
              :title="sortMode === 'recent' ? '现在是按最近练习排序，点一下改成按书名' : '现在是按书名排序，点一下改成按最近练习'">
        {{ sortMode === 'recent' ? '按最近' : '按书名' }}
      </button>
    </div>

    <div class="shelf-list">
      <div v-for="entry in shelf" :key="entry.id" class="book-card"
           :class="{ active: entry.id === state.bookId }" role="button" tabindex="0"
           @click="selectBook(entry.id)" @keydown.enter="selectBook(entry.id)">
        <span class="book-title">{{ entry.book.title }}</span>
        <span class="book-author">{{ entry.book.author }}</span>
        <small>{{ entry.book.chapters.length }} 章 · {{ progressOf(entry.book) }}</small>

        <span class="book-more" role="button" tabindex="0" aria-label="书籍管理" title="书籍管理"
              @click="toggleMenu(entry.id, $event)" @keydown.enter.stop="toggleMenu(entry.id, $event)">⋯</span>
        <div v-if="menuFor === entry.id" class="book-menu">
          <button type="button" @click.stop="startEdit(entry.id)">改名 / 改信息</button>
          <button type="button" class="danger" @click.stop="confirmDelete(entry.id)">从书架删除</button>
        </div>
      </div>
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

  <BookInfoModal v-if="editing" :book="editing.book" @save="saveInfo" @close="editing = null" />
</template>
