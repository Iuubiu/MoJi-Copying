<script setup>
/** 章节目录：整本进度、逐章进度、重置与删除。 */
import { computed, ref } from 'vue';

import {
  bookTotals, currentBook, persistBook, practice, removeBook, settleSession,
  showToast, state, writeProgress,
} from '../composables/useStore.js';
import { MojiStats } from '../core/index.js';

const { formatNumber, formatDuration } = MojiStats;
const CHAPTER_PAGE = 60;

const limit = ref(CHAPTER_PAGE);
const book = computed(() => currentBook.value);
const totals = computed(() => bookTotals(book.value));
const rows = computed(() => {
  if (!book.value) return [];
  return book.value.chapters.slice(0, limit.value).map((chapter, index) => {
    const length = chapter.content.length;
    const count = (chapter.written || '').length;
    return {
      chapter,
      index,
      length,
      percent: length ? Math.min(100, Math.round((count / length) * 100)) : 0,
    };
  });
});

async function resetChapter(index) {
  const chapter = book.value && book.value.chapters[index];
  if (!chapter) return;
  if (!window.confirm(`重置「${chapter.title}」的抄写进度？已抄内容会被清空，本章累计时长也会归零。`)) return;
  if (practice.active && practice.chapterIndex === index) await settleSession();
  chapter.written = '';
  chapter.timeSpentMs = 0;
  await persistBook(state.bookId, book.value);
  await writeProgress(state.bookId, index);
  showToast('已重置本章进度');
}

async function deleteChapter(index) {
  const target = book.value && book.value.chapters[index];
  if (!target) return;
  if (book.value.chapters.length <= 1) { showToast('至少要保留一章'); return; }
  if (!window.confirm(`删除「${target.title}」？该章正文与进度都会移除。`)) return;
  if (practice.active && practice.chapterIndex === index) await settleSession();
  book.value.chapters.splice(index, 1);
  state.chapterIndex = Math.min(state.chapterIndex, book.value.chapters.length - 1);
  /* 序号整体前移，必须整本重写（后端在同一个事务里按新序号重排进度） */
  await persistBook(state.bookId, book.value);
  showToast('章节已删除');
}

async function deleteBook() {
  if (!book.value) return;
  if (!window.confirm(`从书架删除《${book.value.title}》？该书的章节与进度都会一起移除，练习记录保留。`)) return;
  if (practice.active && practice.bookId === state.bookId) await settleSession();
  await removeBook(state.bookId);
  const next = state.library[0];
  if (next) {
    state.bookId = next.id;
    state.chapterIndex = 0;
    localStorage.setItem('ink-current-book-id', next.id);
  }
  showToast('已从书架删除');
}
</script>

<template>
  <section class="library-view view active">
    <div class="page-heading compact">
      <div>
        <p class="eyebrow">内容管理</p>
        <h1>章节目录</h1>
        <p class="heading-meta">
          <span>{{ book ? `${book.title} · ${book.chapters.length} 章` : '尚未导入文本' }}</span><i>·</i>
          <span>已存入本地数据库</span>
        </p>
      </div>
      <button v-if="book" class="secondary-button" type="button" @click="deleteBook">从书架删除</button>
    </div>

    <div class="library-progress">
      <span class="library-progress-label">
        {{ book ? `${formatNumber(totals.written)} / ${formatNumber(totals.total)} 字 · ${totals.percent}%（完成 ${totals.chaptersDone} 章）` : '—' }}
      </span>
      <div class="library-progress-track"><span :style="{ width: totals.percent + '%' }"></span></div>
    </div>

    <div class="library-card">
      <div v-for="row in rows" :key="row.index" class="chapter-row"
           :class="{ active: row.index === state.chapterIndex }"
           @click="state.chapterIndex = row.index; state.view = 'workspace'">
        <span class="chapter-index">{{ String(row.index + 1).padStart(2, '0') }}</span>
        <div class="chapter-main">
          <strong>{{ row.chapter.title }}</strong>
          <small>
            {{ formatNumber(row.length) }} 字 · {{ row.percent ? `已抄写 ${row.percent}%` : '尚未开始' }}
            <template v-if="row.chapter.timeSpentMs"> · {{ formatDuration(row.chapter.timeSpentMs) }}</template>
          </small>
        </div>
        <div class="chapter-progress"><span :style="{ width: row.percent + '%' }"></span></div>
        <span class="chapter-percent">{{ row.percent }}%</span>
        <div class="chapter-actions">
          <button class="chapter-action" type="button" title="重置本章进度" @click.stop="resetChapter(row.index)">重置</button>
          <button class="chapter-action danger" type="button" title="删除本章" @click.stop="deleteChapter(row.index)">删除</button>
        </div>
      </div>

      <button v-if="book && book.chapters.length > limit" class="load-more" type="button" @click="limit += CHAPTER_PAGE">
        还有 {{ formatNumber(book.chapters.length - limit) }} 章，点击加载
      </button>
    </div>
  </section>
</template>
