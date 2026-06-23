import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useUser } from '@/context/UserContext';

/**
 * RoomGuard — 路由守卫
 *
 * 只负责用户身份 + roomId 有效性校验，不涉及房间业务状态。
 * planLevel 等房间层面的逻辑由 Lobby 内部处理。
 */
export default function RoomGuard({ children }: { children: ReactNode }) {
  const { userInfo, isAuthLoading } = useUser();
  const { roomId } = useParams<{ roomId: string }>();

  if (isAuthLoading) return null;
  if (!userInfo) return <Navigate to="/auth" replace />;
  if (!roomId) return <Navigate to="/" replace />;

  return <>{children}</>;
}
