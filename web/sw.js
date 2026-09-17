/* 墨迹 · Service Worker —— 只为了让浏览器允许"安装为应用"。
 *
 * 什么都不缓存，也刻意不拦截请求：这个前端由本地服务实时提供，
 * 缓存只会带来"改了代码却看到旧页面"这类幽灵问题。
 * 安装与激活都立刻接管，不留后台等待。
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* 什么都不做：请求照常走网络 */ });
