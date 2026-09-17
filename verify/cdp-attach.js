#!/usr/bin/env node
/* 附着到"已经在跑的"浏览器 / WebView2 上执行一段表达式。
   和 cdp-run.js 的区别：cdp-run.js 自己拉起一个无头浏览器，这个只连现成的。

   用途：测量桌面版（pywebview + WebView2）里的真实渲染 —— 那才是用户看到的画面。

   桌面版启动方式：
     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 ./MoJi.exe
   WebView2 会把这个参数原样透传给内核，于是 DevTools 端口就开出来了。

   用法: node cdp-attach.js <debugPort> <检查脚本文件> */
const fs = require('fs');

const port = Number(process.argv[2]);
const scriptPath = process.argv[3];
if (!port || !scriptPath) {
  console.error('用法: node cdp-attach.js <debugPort> <检查脚本文件>');
  process.exit(2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const expression = fs.readFileSync(scriptPath, 'utf8');

async function findTarget() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pages = list.filter(item => item.type === 'page' && item.webSocketDebuggerUrl && !item.url.startsWith('devtools'));
      /* 优先挑真正的 http(s) 页面：Edge/Chrome 首次运行会带一个
         edge://sync-confirmation-dialog/ 之类的内置页，谁先到就挑谁的话，
         检查会被跑到那个空页面上（表现为一堆 null）。 */
      const page = pages.find(item => /^https?:/i.test(item.url)) || pages[0];
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error(`连不上 127.0.0.1:${port} 的 DevTools，或没有可调试页面`);
}

async function main() {
  const page = await findTarget();
  console.error(`附着到: ${page.title || '(无标题)'}  ${page.url}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  await new Promise(resolve => ws.addEventListener('open', resolve));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = id += 1;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });

  const result = await send('Runtime.evaluate', {
    expression: `(async () => { return await (${expression}); })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    console.error('页面内脚本抛错:', JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails, null, 2));
    ws.close();
    process.exit(1);
  }
  console.log(typeof result.result.value === 'string' ? result.result.value : JSON.stringify(result.result.value, null, 2));
  ws.close();
}

main().then(() => process.exit(0)).catch(error => { console.error('FAILED', error); process.exit(1); });
