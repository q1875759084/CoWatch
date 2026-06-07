import { type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useUser } from '@/context/UserContext';

/**
 * RoomGuard — 路由守卫
 *
 * 校验用户是否已登录，且路由参数 :roomId 存在。
 * 未满足则重定向到 /auth（已登录但 roomId 非法则重定向到 /）。
 *
 * 注意：不再持久化 roomId，用户进入房间页面时由 RoomContext 负责验证 + 加载房间信息。
 */
export default function RoomGuard({ children }: { children: ReactNode }) {
  const { userInfo, isAuthLoading } = useUser();
  const { roomId } = useParams<{ roomId: string }>();

  if (isAuthLoading) return null;

  if (!userInfo) {
    return <Navigate to="/auth" replace />;
  }

  if (!roomId) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
