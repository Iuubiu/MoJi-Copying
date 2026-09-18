<script setup>
/**
 * 应用外壳：书架侧栏 + 顶栏 + 三个视图 + 弹窗 + 提示条。
 *
 * 启动顺序与旧版一致（也很重要）：先把界面画出来，再去连后端 ——
 * 用户看到窗口的瞬间就该有内容，而不是先盯着一片空白等数据库。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import AppSidebar from './components/AppSidebar.vue';
import LibraryView from './components/LibraryView.vue';
import SettingsModal from './components/SettingsModal.vue';
import StatsView from './components/StatsView.vue';
import WorkbenchView from './components/WorkbenchView.vue';
import { api } from './api/index.js';
import {
  backend, loadDailyAndSessions, loadLibraryFromSnapshot, loadSnapshot,
  persistBook, practice, recoverPendingSession, settleSession, showToast,
  snapshotPendingSession, state,
} from './composables/useStore.js';
import { MojiEncoding } from './core/index.js';
import { createBookId, normalizeBook, readFileAsChapters } from './core/text.js';

const workbench = ref(null);
const settingsOpen = ref(false);
const helpOpen = ref(false);
const fileInput = ref(null);
const importing = ref(false);

/* ── 启动 ─────────────────────────────────────────────────────────────── */

async function connect() {
  try {
    const info = await api.health();
    backend.ready = true;
    backend.version = info.version || '';
    backend.dbPath = info.dbPath || '';
    backend.empty = Boolean(info.empty);
    backend.error = null;
    backend.notice = '';

    await loadSnapshot();
    loadLibraryFromSnapshot();
    loadDailyAndSessions();
    await recoverPendingSession();
    workbench.value?.refreshAll();
  } catch (error) {
    /* 后端连不上不是致命错误：界面照常能开，但要如实说明这次的存不下来 */
    backend.ready = false;
    backend.error = error;
    backend.notice = `连不上本地数据库：${error.message || error}`;
    loadLibraryFromSnapshot();
    loadDailyAndSessions();
    console.warn('[墨迹] 后端连接失败：', error);
  }
}

/* ── 退出兜底 ─────────────────────────────────────────────────────────── */

function handleHidden() {
  if (document.hidden) { settleSession(); snapshotPendingSession(); }
}

function handlePageHide() {
  settleSession();
  snapshotPendingSession();
}

onMounted(() => {
  /* 先把第一屏画出来（内置样章），再去连后端 —— 顺序不能反 */
  loadLibraryFromSnapshot();
  loadDailyAndSessions();
  connect();

  document.addEventListener('visibilitychange', handleHidden);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('beforeunload', snapshotPendingSession);

  window.addEventListener('keydown', handleShortcuts);
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleHidden);
  window.removeEventListener('pagehide', handlePageHide);
  window.removeEventListener('beforeunload', snapshotPendingSession);
  window.removeEventListener('keydown', handleShortcuts);
});

function toggleSepia() {
  state.sepia = !state.sepia;
  showToast(state.sepia ? '已切换护眼色' : '已恢复默认色');
}

/* ── 快捷键 ───────────────────────────────────────────────────────────── */

function handleShortcuts(event) {
  if (event.key === 'Escape') {
    const modal = document.querySelector('.modal-backdrop:not([hidden])');
    if (modal) { modal.hidden = true; settingsOpen.value = false; helpOpen.value = false; return; }
    state.focusMode = false;
    return;
  }
  if (event.key === 'Tab' && state.view === 'workspace') {
    event.preventDefault();
    const book = state.library.find(entry => entry.id === state.bookId);
    if (book) state.chapterIndex = (state.chapterIndex + 1) % book.chapters.length;
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    /* 书架条目的形状是 { id, book } —— 少写一层 .book，这里就会在 chapters
       上崩掉，快捷键整个失效（外观上只是"按了没反应"，很难查，所以有回归检查）。 */
    const book = state.library.find(entry => entry.id === state.bookId)?.book;
    const chapter = book && book.chapters[state.chapterIndex];
    if (!chapter) return;
    event.preventDefault();
    chapter.written = chapter.content;
    chapter.timeSpentMs = Number(chapter.timeSpentMs || 0);
    settleSession();
    workbench.value?.refreshAll();
    showToast('本章已标记完成');
  }
}

/* ── 导入 ─────────────────────────────────────────────────────────────── */

async function handleFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  importing.value = true;
  showToast(`正在读取《${file.name}》…`);
  try {
    const parsed = await readFileAsChapters(file, state.encoding);
    if (!parsed.chapters.length) throw new Error('empty');

    settleSession();
    const id = createBookId();
    const title = file.name.replace(/\.(txt|md|text)$/i, '').trim() || '未命名小说';
    const book = normalizeBook({ title, author: '本地文本', chapters: parsed.chapters }, id);
    state.library.unshift({ id, book });
    state.bookId = id;
    state.chapterIndex = 0;
    localStorage.setItem('ink-current-book-id', id);
    await persistBook(id, book);
    state.view = 'workspace';
    workbench.value?.refreshAll();
    showToast(`已导入《${book.title}》，${book.chapters.length} 个章节（${MojiEncoding.encodingLabel(parsed.encoding)}）`);
  } catch (error) {
    console.warn('[墨迹] 导入失败：', error);
    showToast('导入失败，请切换 TXT 编码后重试');
  } finally {
    importing.value = false;
  }
}

const NAV = [
  { view: 'workspace', icon: '▧', label: '抄写工作台' },
  { view: 'library', icon: '▤', label: '章节目录' },
  { view: 'stats', icon: '↗', label: '练习统计' },
];
</script>

<template>
  <div class="app-shell" :class="{ 'focus-mode': state.focusMode, 'sepia-mode': state.sepia }">
    <AppSidebar :on-import="() => fileInput.click()" :on-settings="() => (settingsOpen = true)" />

    <main class="main-content">
      <header class="topbar">
        <div class="breadcrumbs">
          <span>我的书架</span><b>/</b>
          <span class="current">{{ state.library.find(e => e.id === state.bookId)?.book.title || '尚未选择书籍' }}</span>
          <b>/</b>
          <span class="current">{{ state.library.find(e => e.id === state.bookId)?.book.chapters[state.chapterIndex]?.title || '尚未选择章节' }}</span>
        </div>
        <div class="top-actions">
          <span class="save-state">
            <span class="save-dot" :class="{ warning: !backend.ready }"></span>
            {{ backend.ready ? `已存入本地数据库${practice.active ? ' · 抄写中' : ''}` : '未连接数据库' }}
          </span>
          <button class="icon-button" type="button" aria-label="导入新小说" title="导入新小说"
                  @click="fileInput.click()">＋</button>
          <button class="icon-button" type="button" aria-label="护眼色" title="护眼色" @click="toggleSepia">☼</button>
          <button class="icon-button" type="button" aria-label="专注模式" title="专注模式"
                  @click="state.focusMode = !state.focusMode">⛶</button>
          <button class="icon-button" type="button" aria-label="帮助" title="使用提示" @click="helpOpen = true">?</button>
        </div>
      </header>

      <div v-if="backend.notice" class="storage-notice" data-level="warn">
        <span class="storage-notice-dot" aria-hidden="true"></span>
        <span>{{ backend.notice }}</span>
        <button class="storage-notice-close" type="button" aria-label="关闭提示" @click="backend.notice = ''">×</button>
      </div>

      <WorkbenchView v-show="state.view === 'workspace'" ref="workbench" />
      <LibraryView v-if="state.view === 'library'" @open-book="state.view = 'workspace'" />
      <StatsView v-if="state.view === 'stats'" />
    </main>

    <nav class="mobile-nav" aria-label="主导航">
      <button v-for="item in NAV" :key="item.view" class="nav-item"
              :class="{ active: state.view === item.view }" type="button"
              @click="state.view = item.view">
        <span class="nav-icon">{{ item.icon }}</span><span>{{ item.label.slice(0, 2) }}</span>
      </button>
    </nav>

    <SettingsModal v-if="settingsOpen" @close="settingsOpen = false" />
    <div v-if="helpOpen" class="modal-backdrop">
      <div class="modal help-modal">
        <div class="modal-header">
          <div><p class="eyebrow">快速上手</p><h2>让抄写成为阅读</h2></div>
          <button class="close-button" type="button" @click="helpOpen = false">×</button>
        </div>
        <div class="help-grid">
          <div><span>01</span><strong>导入文本</strong><p>支持 .txt / .md，自动识别 UTF-8 / GBK / UTF-16 编码，并识别「第一章」「Chapter 1」等标题拆分章节。</p></div>
          <div><span>02</span><strong>对照抄写</strong><p>左侧原文作为参照，右侧输入会逐字校对：黑字正确、红字提醒回看。回车会自动带入原文下一行的缩进。</p></div>
          <div><span>03</span><strong>记录与备份</strong><p>练习中每 5 秒自动入库，切章节、切标签页、关窗口时自动结算。设置里可以导出/导入 JSON 备份。</p></div>
          <div><span>04</span><strong>快捷键</strong><p><kbd>Tab</kbd> 下一章 · <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> 完成本章 · <kbd>Esc</kbd> 退出专注模式。</p></div>
        </div>
      </div>
    </div>

    <div v-if="state.toast" class="toast show">{{ state.toast }}</div>
    <input ref="fileInput" type="file" accept=".txt,.md,.text" hidden @change="handleFile" />
  </div>
</template>
