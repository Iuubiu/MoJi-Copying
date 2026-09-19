<script setup>
/**
 * 抄写工作台：左原文、右抄写，逐字校对。
 *
 * 这里刻意保留了几处"命令式"写法（直接操作 DOM、监听滚动、手工同步两栏），
 * 而不是全用 Vue 的响应式：
 *   - 抄写区每次按键都要重算整篇的校对与对齐，用响应式模板渲染会把
 *     "逐字 span"重建一遍，长章节下会明显掉帧；
 *   - 两栏滚动同步需要对 scrollTop 做像素级判断，本来就是命令式的活儿。
 * 数据与状态仍然走 useStore，所以加功能时不用担心状态散落。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  beginSession, chapterMetrics, currentBook, currentChapter, flushSession, getWritten,
  hasWrittenText, practice, saveSetting, scheduleIdleFlush, showToast, state, writeProgress,
} from '../composables/useStore.js';
import { charsMatch, differenceList, getSourceIndent, sentenceAt } from '../core/text.js';
import { MojiStats } from '../core/index.js';

const { formatNumber, formatClock, formatDuration, dateKey } = MojiStats;

const writingArea = ref(null);
const sourcePane = ref(null);
const sourceTrack = ref(null);
const writingPaper = ref(null);
const ghostLayer = ref(null);     // 灰底稿：整章原文，固定不动
const typedLayer = ref(null);     // 你写的字：盖在底稿上面
const caretGuide = ref(null);

const chapter = computed(() => currentChapter.value);
const sentence = ref({ text: '', meta: '' });
const proofOpen = ref(false);

/* ── 校对清单 ─────────────────────────────────────────────────────────── */

/** 每一处偏差：你写的字 vs 原文该有的字。点击跳到那个字上。 */
const diffs = computed(() => {
  void practice.tick;
  if (!chapter.value) return [];
  return differenceList(
    chapter.value.content,
    getWritten(chapter.value),
    state.settings.punctLenient,
  );
});

function jumpTo(index) {
  const area = writingArea.value;
  if (!area) return;
  area.focus();
  area.setSelectionRange(index, index + 1);
  keepCaretVisible();
  updateSentence();
}

/* ── 原文高亮 ─────────────────────────────────────────────────────────── */

/** 搜索命中或校对跳转时，把命中的那几个字在原文里标出来（其余原样）。 */
const sourceHtml = computed(() => {
  const text = chapter.value ? chapter.value.content : '';
  const mark = state.sourceHighlight;
  if (!mark || mark.at == null || mark.at < 0) return escapeHtml(text);
  const from = Math.max(0, Math.min(mark.at, text.length));
  const to = Math.min(text.length, from + (mark.len || 0));
  return `${escapeHtml(text.slice(0, from))}<mark class="source-mark">${escapeHtml(text.slice(from, to))}</mark>${escapeHtml(text.slice(to))}`;
});

/* ── 校对显示层 ───────────────────────────────────────────────────────── */

/**
 * 灰底稿：整章原文，铺在抄写区最底下。
 *
 * 只在单栏模式、且只在换章 / 换模式时画一次 —— 它不参与逐字校对那一层，
 * 所以你无论写、删、跳着写，底稿都钉在原地不动。双栏模式不铺（左边就是原文）。
 */
function renderGhost() {
  const ghost = ghostLayer.value;
  if (!ghost) return;
  const source = chapter.value ? chapter.value.content : '';
  const next = state.settings.columnMode === 'single' ? source : '';
  if (ghost.textContent !== next) ghost.textContent = next;
}

/* ── 渲染：增量更新 ─────────────────────────────────────────────────────
 *
 * 以前是每次按键把整段 innerHTML 重写一遍。两千字的章节就是两千个节点，
 * 每按一下全部重建 —— JS 只花两三毫秒，但后面跟着的样式重算和布局才是
 * 真正让手感觉涩的地方。
 *
 * 现在：先找出"从哪个字开始不一样"，只动那之后的 span；节点多了删、少了补，
 * 前面的一个字都不碰。在末尾打字时，这个位置就是末尾 —— 一次只改一个 span。
 */
let renderedWritten = '';        // 上次渲染的内容，用来定位差异
let renderedSource = '';         // 上次渲染的原文（换章就整体重来）
let renderedLenient = null;      // 标点宽严变了，之前的颜色不算数
let selectedRange = [0, 0];      // 上一次的高亮范围，用来擦干净
let renderScheduled = false;

function firstDiff(a, b) {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/** 只更新"选中高亮"：拖选、点选都走这里，不必重建整段文字。 */
function renderSelection() {
  const element = typedLayer.value;
  const area = writingArea.value;
  if (!element || !area) return;
  const spans = element.children;

  const [prevFrom, prevTo] = selectedRange;
  for (let index = prevFrom; index < prevTo && index < spans.length; index += 1) {
    spans[index].classList.remove('selected');
  }

  const [from, to] = area.selectionStart !== area.selectionEnd
    ? [area.selectionStart, area.selectionEnd].sort((a, b) => a - b)
    : [0, 0];
  for (let index = from; index < to && index < spans.length; index += 1) {
    spans[index].classList.add('selected');
  }
  selectedRange = [from, to];
}

/** 你写的那一层：逐字铺成彩色文字 —— 对的黑色、错的红色，写得比原文长也照样显示。 */
function renderTypedDisplay() {
  const element = typedLayer.value;
  const area = writingArea.value;
  if (!element || !area || !chapter.value) return;
  const source = chapter.value.content;
  const written = area.value;
  const lenient = state.settings.punctLenient;

  /* 换过章节、或者改过标点宽严：之前算好的颜色不作数，整体重来一次 */
  if (lenient !== renderedLenient || source !== renderedSource) {
    element.replaceChildren();
    renderedWritten = '';
    renderedLenient = lenient;
    renderedSource = source;
    selectedRange = [0, 0];
  }

  const from = firstDiff(renderedWritten, written);
  const spans = element.children;

  /* 多退少补。注意是逐个增删而不是重写 innerHTML —— 已有节点全留着 */
  while (spans.length > written.length) spans[spans.length - 1].remove();
  while (spans.length < written.length) element.appendChild(document.createElement('span'));

  for (let index = from; index < written.length; index += 1) {
    const span = spans[index];
    const typed = written[index];
    if (span.textContent !== typed) span.textContent = typed;
    /* 写到原文以外的地方算"多写的"，一样标红 */
    const ok = index < source.length && charsMatch(source[index], typed, lenient);
    const want = ok ? 'ok' : 'bad';
    if (span.className !== want) span.className = want;
  }
  renderedWritten = written;
  selectedRange = [0, 0];          // span 刚动过，旧的高亮痕迹不作数了
  renderSelection();
}

/** 校对层 / 提示条 / 纸面高度：一帧只做一次，连打时不会被每一下都触发。 */
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderTypedDisplay();
    refreshCaretGuide();
    syncPaneLayout();
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ── 两栏对齐 ─────────────────────────────────────────────────────────── */

function lineHeight() {
  const area = writingArea.value;
  return area ? parseFloat(getComputedStyle(area).lineHeight) || 28 : 28;
}

/** 纸面高度 = max(原文高, 抄写高) + 一整行 —— 抄写区底部常年空一行，方便对照。 */
function syncPaneLayout() {
  const paper = writingPaper.value;
  const area = writingArea.value;
  if (!paper || !area) return;

  /* 单栏模式：纸面高度由灰底稿自己撑开（CSS 里那三层的位置也跟着换），
     这里一概不插手 —— 否则每打一个字高度就变一次，整层底稿跟着上下跳。 */
  if (state.settings.columnMode === 'single') {
    paper.style.height = '';
    area.style.height = '';
    return;
  }

  const sourceHeight = sourceTrack.value ? sourceTrack.value.offsetHeight : 0;
  area.style.height = 'auto';
  const writingHeight = area.scrollHeight;
  const height = Math.max(sourceHeight, writingHeight) + lineHeight();
  paper.style.height = `${height}px`;
  area.style.height = `${Math.max(height, writingHeight)}px`;
}

/** 抄写区滚动时，原文栏按行对齐地跟着走。 */
function handleWritingScroll() {
  const area = writingArea.value;
  const pane = sourcePane.value;
  const track = sourceTrack.value;
  if (!area || !pane || !track) return;
  const target = area.scrollTop;
  if (Math.abs(pane.scrollTop - target) >= 1) pane.scrollTop = target;
  const maxScroll = track.scrollHeight - pane.clientHeight;
  if (target > maxScroll) pane.scrollTop = maxScroll;
}

/** 光标移到最后一行时，把抄写区滚一点，保持"正在写的那行"在视野里。 */
function keepCaretVisible() {
  const area = writingArea.value;
  if (!area) return;
  const line = lineHeight();
  const row = Math.floor(area.value.slice(0, area.selectionStart).split('\n').length - 1);
  const caretTop = row * line;
  const viewTop = area.scrollTop;
  const viewBottom = viewTop + area.clientHeight - line;
  if (caretTop < viewTop + line * 2) area.scrollTop = Math.max(0, caretTop - line * 2);
  else if (caretTop > viewBottom) area.scrollTop = caretTop - area.clientHeight + line * 2;
}

/* ── 输入 ─────────────────────────────────────────────────────────────── */

let composing = false;        // 输入法正在组字

function handleInput() {
  const area = writingArea.value;
  if (!area || !chapter.value) return;
  /* 中文输入法组字时 value 每按一下都在变，这时候重画底稿会抖成一团，
     等 compositionend 定了再算。 */
  if (composing) return;

  /* 自动补的首行缩进被删光之后，下一句仍要从那个位置起笔 ——
     否则两栏第一行对不齐，用户还得自己敲两个全角空格。 */
  if (!hasWrittenText(area.value)) {
    const lead = getSourceIndent(chapter.value.content, 0);
    if (lead && area.value !== lead) {
      area.value = lead;
      area.setSelectionRange(lead.length, lead.length);
    }
  }

  const next = area.value;
  const previousLength = getWritten(chapter.value).length;
  if (!practice.active && next.length) beginSession(previousLength);

  chapter.value.written = next;
  scheduleRender();              // 校对层 + 提示条 + 纸面高度：一帧只做一次
  updateSentence();              // 当前句和高亮很便宜，同步更新更跟手
  scheduleIdleFlush();
  scheduleProgressSave();
}

function handleCompositionStart() {
  composing = true;
}

function handleCompositionEnd() {
  composing = false;
  handleInput();
}

let progressTimer = null;
function scheduleProgressSave() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    writeProgress(state.bookId, state.chapterIndex).catch(() => {});
  }, 500);
}

/** 回车：原文这一行有缩进就一起带过去（否则每次都要自己敲空格）。 */
function handleKeydown(event) {
  const area = event.currentTarget;
  if (event.key === 'Enter' && !event.isComposing) {
    const { selectionStart: start, selectionEnd: end } = area;
    if (start === end && chapter.value && chapter.value.content[start] === '\n') {
      const indent = getSourceIndent(chapter.value.content, start + 1);
      if (indent) {
        event.preventDefault();
        area.setRangeText(`\n${indent}`, start, end, 'end');
        handleInput();
        return;
      }
    }
  }
  if (event.key === 'Backspace' && !event.isComposing) {
    const { selectionStart: start, selectionEnd: end } = area;
    if (start === end && start > 0) {
      const lineStart = area.value.lastIndexOf('\n', start - 1) + 1;
      const indent = area.value.slice(lineStart, start);
      if (indent && /^[ \t\u3000]+$/.test(indent)
        && chapter.value && indent === getSourceIndent(chapter.value.content, start)) {
        event.preventDefault();
        area.setRangeText('', lineStart > 0 ? lineStart - 1 : lineStart, start, 'start');
        handleInput();
      }
    }
  }
}

function refreshCaretGuide() {
  const guide = caretGuide.value;
  const area = writingArea.value;
  if (!guide || !area) return;
  /* 单栏模式下整章原文就铺在底下，提示条压上去会和底稿糊成一团 —— 不显示 */
  const show = !hasWrittenText(area.value) && state.settings.columnMode !== 'single';
  guide.classList.toggle('hidden', !show);
}

/* ── 当前句 ───────────────────────────────────────────────────────────── */

function updateSentence() {
  const area = writingArea.value;
  if (!area || !chapter.value) return;
  const start = area.selectionStart;
  const info = sentenceAt(chapter.value.content, start);
  sentence.value = {
    text: info.text || '把光标放进正文，这里会显示你正在抄的那一句。',
    meta: `${MojiStats.formatNumber(info.start)} – ${MojiStats.formatNumber(info.end)} 字 · 第 ${Math.max(1, (chapter.value.content.slice(0, start).split('\n').length))} 行`,
  };
  /* 这里只要刷新高亮，不能重建整段 —— 以前它又调了一次全量渲染，
     等于每按一下键把整章铺了两遍。 */
  renderSelection();
}

/* ── 指标 ─────────────────────────────────────────────────────────────── */

const metrics = computed(() => {
  /* practice.tick 每秒变一次，用它把"本次时长/速度"顶着重算 */
  void practice.tick;
  return chapterMetrics(chapter.value);
});

const percentLabel = computed(() => {
  const value = metrics.value;
  if (!value || !value.started) return '准备开始';
  return value.percent >= 100 ? '本章完成' : `${formatNumber(value.writtenLength)} 字已写下`;
});

function startTyping() {
  writingArea.value?.focus();
  if (!practice.active && chapter.value) beginSession(getWritten(chapter.value).length);
}

/** 标点宽松开关：改完立刻重算校对显示，不用重开章节。 */
async function togglePunct() {
  await saveSetting('punctLenient', !state.settings.punctLenient);
  renderTypedDisplay();
  showToast(state.settings.punctLenient
    ? '标点按宽松比对：全角/半角、中英文引号不算错'
    : '标点按严格比对');
}

/**
 * 抄写区形态：双栏（左原文右抄写）/ 单栏（只留抄写栏，原文铺灰字当底稿）。
 * 只影响这一屏怎么摆，不碰任何数据。
 */
async function toggleColumnMode() {
  await saveSetting('columnMode', state.settings.columnMode === 'single' ? 'split' : 'single');
  await nextTick();
  renderGhost();                // 单栏才有灰底稿，切换时要铺上 / 收起
  renderTypedDisplay();
  refreshCaretGuide();          // 单栏里这条提示要立刻收起来，不能等用户打完第一个字
  syncPaneLayout();
  showToast(state.settings.columnMode === 'single'
    ? '单栏模式：原文铺成灰字，抄过去变黑，抄错变红'
    : '双栏模式：左原文、右抄写');
}

/* ── 生命周期 ─────────────────────────────────────────────────────────── */

function refreshAll() {
  nextTick(() => {
    if (writingArea.value && chapter.value) {
      writingArea.value.value = getWritten(chapter.value);
      /* 还没写正文时补上首行缩进：原文栏顶着两个全角空格、抄写栏却从第 0 列起笔，
         两栏第一行会对不齐，用户还得自己敲那两个空格。 */
      if (!hasWrittenText(writingArea.value.value)) {
        const lead = getSourceIndent(chapter.value.content, 0);
        if (lead) {
          writingArea.value.value = lead;
          chapter.value.written = lead;
        }
      }
    }
    renderGhost();
    renderTypedDisplay();
    refreshCaretGuide();
    syncPaneLayout();
    updateSentence();
  });
}

/* 从搜索结果跳过来时：把原文栏滚到命中处，抄写区跟着走 ——
   不然用户得自己在几百行里找那个词。 */
watch(() => state.sourceHighlight, mark => {
  if (!mark || mark.at == null || mark.at < 0) return;
  nextTick(() => {
    const pane = sourcePane.value;
    const track = sourceTrack.value;
    if (!pane || !track) return;
    const element = track.querySelector('.source-mark');
    if (!element) return;
    pane.scrollTop = Math.max(0, element.offsetTop - pane.clientHeight / 3);
    if (writingArea.value) writingArea.value.scrollTop = pane.scrollTop;
  });
});

watch(() => [state.bookId, state.chapterIndex], refreshAll);
/* 章节列表里重置/删除章节后，正文在内存里变了，这里要跟着重读 */
watch(() => state.refreshToken, refreshAll);
watch(() => state.fontSize, () => {
  if (writingArea.value) writingArea.value.style.fontSize = `${state.fontSize}px`;
  nextTick(syncPaneLayout);
});

onMounted(() => {
  refreshAll();
  window.addEventListener('resize', syncPaneLayout);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncPaneLayout);
  flushSession();
});

function focusWriting() { writingArea.value?.focus(); }
defineExpose({ focusWriting, refreshAll });
</script>

<template>
  <section class="workspace-view view active">
    <div v-if="chapter" id="workspaceMain">
      <div class="page-heading">
        <div>
          <p class="eyebrow">正在抄写</p>
          <h1 id="pageTitle">{{ chapter.title }}</h1>
          <p class="heading-meta">
            <span>{{ formatNumber(chapter.content.length) }} 字</span><i>·</i>
            <span>预计 {{ Math.max(1, Math.ceil(chapter.content.length / 220)) }} 分钟</span><i>·</i>
            <span>{{ chapter.timeSpentMs ? formatDuration(chapter.timeSpentMs) : '尚未练习' }}</span>
          </p>
        </div>
        <div class="heading-actions">
          <button class="primary-button" type="button" @click="startTyping"><span>▶</span> 开始抄写</button>
        </div>
      </div>

      <div class="workspace-grid">
        <div class="copy-card">
          <div class="copy-toolbar">
            <div class="chapter-select-wrap">
              <span class="toolbar-label">章节</span>
              <select :value="state.chapterIndex" aria-label="选择章节"
                      @change="state.chapterIndex = Number($event.target.value)">
                <option v-for="(item, index) in (currentBook ? currentBook.chapters : [])"
                        :key="index" :value="index">{{ item.title }}</option>
              </select>
            </div>
            <div class="toolbar-divider"></div>
            <div class="toolbar-group">
              <button class="toolbar-button" type="button" @click="state.fontSize = Math.max(15, state.fontSize - 1)">A−</button>
              <span class="font-size-label">{{ state.fontSize }}</span>
              <button class="toolbar-button" type="button" @click="state.fontSize = Math.min(24, state.fontSize + 1)">A＋</button>
            </div>
            <div class="toolbar-divider"></div>
            <button class="toolbar-button" :class="{ active: state.settings.columnMode === 'single' }" type="button"
                    title="双栏：左原文右抄写；单栏：原文铺成灰字当底稿"
                    @click="toggleColumnMode">{{ state.settings.columnMode === 'single' ? '单栏' : '双栏' }}</button>
            <button class="toolbar-button" :class="{ active: state.settings.punctLenient }" type="button"
                    @click="togglePunct">± 标点宽松</button>
            <button class="toolbar-button" :class="{ active: proofOpen }" type="button"
                    @click="proofOpen = !proofOpen">✓ <span>校对清单</span></button>
            <div class="toolbar-spacer"></div>
            <span class="copy-mode">
              <span class="mode-dot" :class="{ live: practice.active }"></span>
              <span>{{ practice.active ? '抄写中' : metrics && metrics.percent >= 100 ? '本章完成' : '准备就绪' }}</span>
            </span>
          </div>

          <div class="sentence-bar">
            <span class="sentence-label">当前句</span>
            <span class="sentence-text">{{ sentence.text }}</span>
            <span class="sentence-meta">{{ sentence.meta }}</span>
          </div>

          <div v-show="proofOpen" class="proof-panel">
            <div class="proof-head">
              <span>校对清单</span>
              <span class="proof-count">{{ diffs.length ? `${diffs.length} 处偏差` : '没有偏差' }}</span>
              <button class="close-button" type="button" aria-label="收起校对清单" @click="proofOpen = false">×</button>
            </div>
            <div class="proof-list">
              <p v-if="!diffs.length" class="proof-empty">这一段没发现偏差。</p>
              <button v-for="item in diffs" :key="item.index" class="proof-row" type="button" @click="jumpTo(item.index)">
                <span class="proof-line">第 {{ item.line + 1 }} 行</span>
                <span class="proof-expected">{{ item.expected || '（多写的）' }}</span>
                <span class="proof-arrow">←</span>
                <span class="proof-typed">{{ item.typed }}</span>
              </button>
            </div>
          </div>

          <div class="copy-body" :class="{ 'single-column': state.settings.columnMode === 'single' }">
            <div v-if="state.settings.columnMode !== 'single'" class="source-column">
              <div class="column-label"><span>原文</span></div>
              <div id="sourceText" ref="sourcePane" class="source-text" :style="{ fontSize: state.fontSize + 'px' }">
                <pre id="sourceTrack" ref="sourceTrack" class="source-track" v-html="sourceHtml"></pre>
              </div>
            </div>
            <div class="writing-column">
              <div class="column-label"><span>你的抄写</span><small>{{ hasWrittenText(getWritten(chapter)) ? '正在校对' : '点击右侧开始输入' }}</small></div>
              <div class="writing-stage" :style="{ fontSize: state.fontSize + 'px' }">
                <div id="writingPaper" ref="writingPaper" class="writing-paper">
                  <!-- 两层：灰底稿固定不动，你写的字盖在上面。
                       灰字之所以能"钉住"，就是因为它根本不参与逐字校对那一层。 -->
                  <div id="typingDisplay" class="typing-display" aria-hidden="true">
                    <div id="ghostLayer" ref="ghostLayer" class="ghost-layer"></div>
                    <div id="typedLayer" ref="typedLayer" class="typed-layer"></div>
                  </div>
                  <textarea id="writingArea" ref="writingArea" spellcheck="false" aria-label="抄写输入区"
                            @input="handleInput" @keydown="handleKeydown"
                            @compositionstart="handleCompositionStart" @compositionend="handleCompositionEnd"
                            @scroll="handleWritingScroll" @click="updateSentence"
                            @keyup="updateSentence" @select="updateSentence"></textarea>
                  <div id="caretGuide" ref="caretGuide" class="caret-guide">从这里开始，把文字写进时间里。</div>
                </div>
              </div>
            </div>
          </div>
          <div class="copy-footer">
            <span><kbd>Tab</kbd> 下一章</span>
            <span><kbd>⌘</kbd>＋<kbd>Enter</kbd> 完成章节</span>
            <span class="footer-spacer"></span>
            <span>{{ formatNumber(metrics ? metrics.writtenLength : 0) }} / {{ formatNumber(metrics ? metrics.total : 0) }} 字</span>
          </div>
        </div>

        <aside class="insight-panel">
          <div class="panel-title-row"><h2>本章进度</h2><span class="quiet-status"><span></span> 数据库保存</span></div>
          <div class="progress-hero">
            <div class="ring" :style="{ background: `conic-gradient(var(--sage) ${(metrics ? metrics.percent : 0) * 3.6}deg, #e9e7df 0deg)` }">
              <div><strong>{{ metrics ? metrics.percent : 0 }}%</strong><small>完成度</small></div>
            </div>
            <div>
              <div class="progress-big-label">{{ percentLabel }}</div>
              <p class="progress-sub-label">黑字为正确抄写，红字提醒你回看原文。</p>
            </div>
          </div>
          <div class="metric-grid">
            <div class="metric"><span>已抄写</span><strong>{{ formatNumber(metrics ? metrics.writtenLength : 0) }} <small>字</small></strong></div>
            <div class="metric"><span>本次时长</span><strong>{{ formatClock(metrics ? metrics.elapsed : 0) }}</strong></div>
            <div class="metric"><span>平均速度</span><strong>{{ metrics && metrics.speed ? formatNumber(metrics.speed) : '—' }} <small>字/分</small></strong></div>
            <div class="metric"><span>错误字数</span><strong>{{ formatNumber(metrics ? metrics.incorrect : 0) }} <small>字</small></strong></div>
          </div>
        </aside>
      </div>
    </div>

    <div v-else class="empty-state">
      <div class="empty-mark">墨</div>
      <h2>书架还是空的</h2>
      <p>导入一个 .txt / .md 文件，应用会自动识别编码、切分章节，并在这里显示原文与抄写区。</p>
    </div>
  </section>
</template>
