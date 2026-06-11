import { createRoot } from 'react-dom/client';
import Hls from 'hls.js';
import App from './App';
import { initMonitor } from '@/utils/monitor';

// ── 浏览器兼容性检测 ──────────────────────────────────────────────────────────
// HLS 架构要求浏览器支持 hls.js（Media Source Extensions API）。
// 目标用户群为 Windows 游戏玩家，Chrome / Edge / 360浏览器（Chromium 内核）均支持。
// 在应用入口统一拦截，VideoPlayer 组件内部无需任何分支判断，保持组件纯粹。
if (!Hls.isSupported()) {
  document.body.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #333;
      background: #f5f5f5;
      text-align: center;
      padding: 24px;
    ">
      <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
      <h2 style="margin: 0 0 12px; font-size: 20px;">浏览器不兼容</h2>
      <p style="margin: 0; color: #666; line-height: 1.6;">
        CoWatch 需要使用 Chrome 或 Edge 浏览器才能正常播放视频。<br/>
        请更换浏览器后重新访问。
      </p>
    </div>
  `;
  // 终止 React 渲染
  // eslint-disable-next-line no-throw-literal
  throw new Error('[index.tsx] 浏览器不支持 HLS（MSE），已终止渲染');
}

// 监控 SDK 在 React 渲染前初始化，确保能捕获到完整的性能指标和早期错误
// 参考 video-to-audio/src/index.tsx 分层规范
initMonitor();

// 注册 Service Worker（HLS .ts 片段 cache-first 缓存，第二次播放 0 流量）
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
