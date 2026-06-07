import { Navigate } from 'react-router-dom';
import { useUser } from '@/context/UserContext';
import type { ReactNode } from 'react';

interface AuthGuardProps {
  children: ReactNode;
}

/**
 * 未登录时跳转到 /auth 的路由守卫
 *
 * isAuthLoading 期间渲染 null（避免闪烁跳转），等 token 验证完成后再决策。
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const { userInfo, isAuthLoading } = useUser();

  if (isAuthLoading) return null;

  if (!userInfo) {
    return <Navigate to="/auth" replace />;
  }

  return <>{children}</>;
}
