import { createBrowserRouter, Navigate } from 'react-router-dom';
import AuthPage from '@/pages/Auth';
import Dashboard from '@/pages/Dashboard';
import LobbyPage from '@/pages/Lobby';
import WatchRoomPage from '@/pages/WatchRoom';
import { AuthGuard } from '@/components/AuthGuard';
import RoomGuard from '@/components/RoomGuard';

/**
 * 路由结构
 *
 * /auth                     → 注册/登录页（未登录时默认落地）
 * /                         → Dashboard（三栏布局，需登录）
 * /room/:roomId/lobby       → Lobby（渲染在 Dashboard 的 Outlet）
 * /room/:roomId/watch       → WatchRoom（渲染在 Dashboard 的 Outlet）
 * *                         → 重定向到 /
 */
const router = createBrowserRouter([
  {
    path: '/auth',
    element: <AuthPage />,
  },
  {
    path: '/',
    element: (
      <AuthGuard>
        <Dashboard />
      </AuthGuard>
    ),
    children: [
      {
        path: 'room/:roomId/lobby',
        element: (
          <RoomGuard>
            <LobbyPage />
          </RoomGuard>
        ),
      },
      {
        path: 'room/:roomId/watch',
        element: (
          <RoomGuard>
            <WatchRoomPage />
          </RoomGuard>
        ),
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
]);

export default router;
