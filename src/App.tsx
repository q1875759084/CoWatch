import { RouterProvider } from 'react-router-dom';
import { UserProvider } from '@/context/UserContext';
import router from '@/router';
import '@/styles/index.scss';

/**
 * App.tsx — 业务根组件
 *
 * 职责：组装业务 Provider 洋葱 + 路由。
 *
 * Provider 层次（由外到内）：
 *   UserProvider         → 用户身份，应用级生命周期
 *   RouterProvider       → 路由
 *     RoomGuard          → 路由守卫，含房间级 Provider（key={roomId}）
 *       RoomMetaProvider → 房间元信息，房间级生命周期
 *       RoomProvider     → 房间业务状态，房间级生命周期
 */

export default function App() {
  return (
    <UserProvider>
      <RouterProvider router={router} />
    </UserProvider>
  );
}
