import { createRoot } from 'react-dom/client';
import App from './App';
import { initMonitor } from '@/utils/monitor';

// 监控 SDK 在 React 渲染前初始化，确保能捕获到完整的性能指标和早期错误
// 参考 video-to-audio/src/index.tsx 分层规范
initMonitor();

// 注册 Service Worker（视频缓存，减少重复 Range 请求的网络流量）
// SW 文件在根路径，作用域覆盖整个站点
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        console.log('[SW] 注册成功，scope:', reg.scope);
      })
      .catch((err) => {
        console.warn('[SW] 注册失败：', err);
      });
  });
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('[index.tsx] 挂载失败：未找到 #root 元素，请检查 public/index.html');
}

createRoot(container).render(<App />);
