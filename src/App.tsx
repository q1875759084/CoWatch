import { RouterProvider } from 'react-router-dom';
import { UserProvider } from '@/context/UserContext';
import { RoomProvider } from '@/context/RoomContext';
import router from '@/router';
import '@/styles/index.scss';

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

export default function App() {
  return (
    <UserProvider>
      <RoomProvider>
        <RouterProvider router={router} />
      </RoomProvider>
    </UserProvider>
  );
}
