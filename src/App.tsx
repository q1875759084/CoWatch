import { RouterProvider } from 'react-router-dom';
import { UserProvider } from '@/context/UserContext';
import { RoomProvider } from '@/context/RoomContext';
import router from '@/router';

/**
 * App.tsx — 业务根组件
 *
 * 职责：组装业务 Provider 洋葱 + 路由。
 * 参考 mini-qnh 分层规范：
 *   - index.tsx 负责监控初始化 + createRoot（UI 框架层）
 *   - App.tsx 负责业务 Provider + RouterProvider（业务层）
 *
 * Provider 层次（由外到内）：
 *   UserProvider  → 用户身份（userId、昵称、roomId、isAdmin）
 *   RoomProvider  → 房间状态（成员、控制权、播放状态）
 *   RouterProvider → 路由
 */

const GlobalStyle = () => (
  <style>{`
    *, *::before, *::after {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    html, body, #root {
      height: 100%;
      background: #0f172a;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
        'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
      line-height: 1.6;
      font-size: 14px;
    }
    a { color: inherit; }
    button, input, select, textarea {
      font-family: inherit;
      font-size: inherit;
      color: inherit;
    }
  `}</style>
);

export default function App() {
  return (
    <UserProvider>
      <RoomProvider>
        <GlobalStyle />
        <RouterProvider router={router} />
      </RoomProvider>
    </UserProvider>
  );
}
