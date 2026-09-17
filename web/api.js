/* 墨迹 · 后端 REST 客户端
 *
 * 前后端分离之后，前端不再直接碰浏览器数据库：所有数据都经过这里的几个
 * 函数走后端（server/），后端再落进 SQLite。前端的渲染与交互代码只认
 * 内存里的 state，读写数据的细节全部收在这一层。
 *
 * 三条约定：
 *   1. 每个请求都有超时。本地服务正常时都是毫秒级响应，卡住通常意味着
 *      后端没起来 —— 宁可早点报错，也不要让页面停在"保存中"。
 *   2. 失败一律抛 Error，并把 HTTP 状态与后端给的错误文案带上，
 *      调用方只需要一个 try/catch。
 *   3. 后端地址默认与页面同源（桌面版、python -m server 都是同源）。
 *      想把前端单独部署（前端 5173 / 后端 8000）就在 index.html 里写：
 *      <meta name="moji-api" content="http://127.0.0.1:8000">
 */
(function (global) {
  'use strict';

  const DEFAULT_TIMEOUT = 8000;
  const BOOTSTRAP_TIMEOUT = 20000;      // 全量拉取：书多的用户会大一些

  const base = (function () {
    const meta = document.querySelector('meta[name="moji-api"]');
    const value = meta && meta.content ? meta.content.trim() : '';
    return value.replace(/\/+$/, '');
  })();

  class ApiError extends Error {
    constructor(message, { status = 0, payload = null } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;             // 0 表示压根没连上（超时 / 网络错误）
      this.payload = payload;
    }
  }

  async function request(method, path, body, { timeout = DEFAULT_TIMEOUT } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (error) {
      const aborted = error && error.name === 'AbortError';
      throw new ApiError(aborted ? `请求超时（${timeout}ms）：${path}` : `连不上后端：${path}`, {
        status: 0
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 200) }; }
    }
    if (!response.ok) {
      const message = (payload && payload.error) || `后端返回 ${response.status}`;
      throw new ApiError(message, { status: response.status, payload });
    }
    return payload;
  }

  const api = {
    base,
    ApiError,
    request,

    /* 后端在不在？返回 { ok, version, dbPath, storage, empty }。
       empty=true 说明这是个空库，前端据此决定要不要做旧数据迁移。 */
    health: () => request('GET', '/api/health'),

    /* 一次取全量：books / progress / sessions / daily / settings。 */
    bootstrap: () => request('GET', '/api/bootstrap', undefined, { timeout: BOOTSTRAP_TIMEOUT }),

    /* 整本书写入（元信息 + 章节正文 + 每章进度）。
       章节增删后也走它：后端会在同一个事务里按新序号整体重写进度。 */
    putBook: record => request('PUT', `/api/books/${encodeURIComponent(record.id)}`, record),

    deleteBook: bookId => request('DELETE', `/api/books/${encodeURIComponent(bookId)}`),

    /* 单章进度：打字时高频调用，只更新一行。 */
    putProgress: (bookId, index, record) =>
      request('PUT', `/api/books/${encodeURIComponent(bookId)}/progress/${index}`, record),

    /* 写入（或覆盖）一次练习会话；响应里带回重算后的当日汇总。 */
    putSession: record => request('PUT', `/api/sessions/${encodeURIComponent(record.id)}`, record),

    deleteSession: sessionId => request('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`),

    clearSessions: () => request('DELETE', '/api/sessions'),

    putSetting: (key, value) => request('PUT', `/api/settings/${encodeURIComponent(key)}`, { value }),

    exportBackup: () => request('GET', '/api/export', undefined, { timeout: BOOTSTRAP_TIMEOUT }),

    importBackup: (payload, mode = 'merge') =>
      request('POST', `/api/import?mode=${encodeURIComponent(mode)}`, payload, { timeout: BOOTSTRAP_TIMEOUT }),

    rebuildDaily: () => request('POST', '/api/rebuild')
  };

  global.MojiApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
