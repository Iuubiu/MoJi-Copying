/**
 * 数据层：同一份前端，两种宿主。
 *
 *   Tauri 桌面版  → invoke('bootstrap')，走 IPC（没有端口、没有 HTTP、不触发防火墙）
 *   浏览器         → fetch('/api/bootstrap')，走 Python 后端（server/）
 *
 * 两边的方法名与返回形状一一对应（见 src-tauri/src/commands.rs 与 server/api.py），
 * 所以上层组件不需要知道自己在哪个宿主里跑。
 * 以后加功能：Rust 与 Python 各加一个端点，再往这里加一个方法。
 */

/** Tauri 2 会往页面注入这个对象；浏览器里没有。 */
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let invokeImpl = null;
async function invoke(name, args) {
  // 动态导入：浏览器模式下不会去加载 Tauri 的 JS
  if (!invokeImpl) {
    ({ invoke: invokeImpl } = await import('@tauri-apps/api/core'));
  }
  return invokeImpl(name, args);
}

const TIMEOUT = 8000;
const TIMEOUT_BIG = 20000; // 全量拉取 / 导入导出：书多的用户会大一些

/** 浏览器模式下后端地址：默认同源，可用 <meta name="moji-api"> 指到别的端口。 */
function apiBase() {
  const meta = document.querySelector('meta[name="moji-api"]');
  const value = meta && meta.content ? meta.content.trim() : '';
  return value.replace(/\/+$/, '');
}

export class ApiError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 表示压根没连上（超时 / 网络错误）
    this.payload = payload;
  }
}

async function http(method, path, body, timeout = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    throw new ApiError(aborted ? `请求超时（${timeout}ms）：${path}` : `连不上后端：${path}`, { status: 0 });
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

/** 把两种宿主的差异收在这一个对象里。 */
export const api = {
  host: inTauri ? 'tauri' : 'http',
  isDesktop: inTauri,

  health: () => (inTauri ? invoke('health') : http('GET', '/api/health')),

  bootstrap: () =>
    (inTauri ? invoke('bootstrap') : http('GET', '/api/bootstrap', undefined, TIMEOUT_BIG)),

  putBook: (record) =>
    (inTauri
      ? invoke('put_book', { record })
      : http('PUT', `/api/books/${encodeURIComponent(record.id)}`, record)),

  deleteBook: (bookId) =>
    (inTauri
      ? invoke('delete_book', { bookId })
      : http('DELETE', `/api/books/${encodeURIComponent(bookId)}`)),

  putProgress: (bookId, index, record) =>
    (inTauri
      ? invoke('put_progress', {
          bookId,
          index,
          written: record.written || '',
          elapsedMs: Number(record.elapsedMs || 0),
        })
      : http('PUT', `/api/books/${encodeURIComponent(bookId)}/progress/${index}`, record)),

  putSession: (record) =>
    (inTauri
      ? invoke('put_session', { record })
      : http('PUT', `/api/sessions/${encodeURIComponent(record.id)}`, record)),

  deleteSession: (sessionId) =>
    (inTauri
      ? invoke('delete_session', { sessionId })
      : http('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`)),

  clearSessions: () => (inTauri ? invoke('clear_sessions') : http('DELETE', '/api/sessions')),

  putSetting: (key, value) =>
    (inTauri
      ? invoke('put_setting', { key, value })
      : http('PUT', `/api/settings/${encodeURIComponent(key)}`, { value })),

  exportPayload: () =>
    (inTauri ? invoke('export_payload') : http('GET', '/api/export', undefined, TIMEOUT_BIG)),

  importPayload: (payload, mode = 'merge') =>
    (inTauri
      ? invoke('import_payload', { payload, mode })
      : http('POST', `/api/import?mode=${encodeURIComponent(mode)}`, payload, TIMEOUT_BIG)),
};
