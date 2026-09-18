import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],

  // 相对路径：桌面版从 tauri://localhost 加载页面，绝对路径会 404；
  // 浏览器模式（Python 后端托管 dist/）下相对路径同样成立。
  base: './',

  server: {
    port: 5173,
    // Tauri 的 dev 配置里写死了这个地址，端口被占时宁可报错也不要偷偷换
    strictPort: true,
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 目标环境是固定的：Windows 上的 WebView2 / 现代浏览器，不用为老浏览器降级
    target: 'chrome110',
    chunkSizeWarningLimit: 800,
  },
});
