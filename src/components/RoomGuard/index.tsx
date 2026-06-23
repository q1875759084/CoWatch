import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useUser } from '@/context/UserContext';
import { RoomProvider } from '@/context/RoomContext';

/**
 * RoomGuard — 路由守卫 + 房间级 Provider 容器
 *
 * 职责：
 *   1. 用户身份 + roomId 有效性校验（轻守卫，不调业务接口）
 *   2. 以 key={roomId} 渲染 RoomProvider，确保每次切换房间时
 *      RoomProvider 完全卸载重建，roomState 自动清零。
 *      这是 React 官方"用 key 重置状态"的标准模式，
 *      无需在 Context 内部手动维护重置逻辑。
 *
 * planLevel 等房间层面的逻辑由 Lobby 内部处理。
 */
export default function RoomGuard({ children }: { children: ReactNode }) {
  const { userInfo, isAuthLoading } = useUser();
  const { roomId } = useParams<{ roomId: string }>();

  if (isAuthLoading) return null;
  if (!userInfo) return <Navigate to="/auth" replace />;
  if (!roomId) return <Navigate to="/" replace />;

  return (
    <RoomProvider key={roomId}>
      {children}
    </RoomProvider>
  );
}
