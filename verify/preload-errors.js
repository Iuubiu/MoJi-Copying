/* 在页面自身脚本之前注入的错误收集器。
   页面脚本一跑就可能抛错，而 CDP 要等标签出现才连得上 —— 抓启动期错误只能这样。
   用法：cdp-run.js ... --preload=verify/preload-errors.js  然后在检查脚本里读 window.__mojiErrors */
window.__mojiErrors = [];
window.addEventListener('error', event => {
  window.__mojiErrors.push({
    kind: 'error',
    message: String((event && (event.message || event.error)) || 'unknown'),
    source: event && event.filename,
    line: event && event.lineno
  });
});
window.addEventListener('unhandledrejection', event => {
  const reason = event && event.reason;
  window.__mojiErrors.push({
    kind: 'rejection',
    message: String((reason && (reason.stack || reason.message)) || reason || 'unknown')
  });
});
