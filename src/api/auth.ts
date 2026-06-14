import request from '@/utils/request';
import type { AuthResponse, UserInfo } from '@/types/api';

/**
 * 注册（需邀请码，自动登录，返回 accessToken + userInfo）
 */
export async function registerApi(username: string, password: string, inviteCode: string): Promise<AuthResponse> {
  const res = await request.post<{ code: number; message: string; data: AuthResponse }>(
    '/auth/register',
    { username, password, inviteCode },
  );
  return res.data.data;
}

/**
 * 登录
 */
export async function loginApi(username: string, password: string): Promise<AuthResponse> {
  const res = await request.post<{ code: number; message: string; data: AuthResponse }>(
    '/auth/login',
    { username, password },
  );
  return res.data.data;
}

/**
 * 获取当前用户信息（用于页面刷新后恢复登录态）
 */
export async function getProfileApi(): Promise<UserInfo> {
  const res = await request.get<{ code: number; message: string; data: { userInfo: UserInfo } }>(
    '/auth/profile',
  );
  return res.data.data.userInfo;
}

/**
 * 退出登录（清除后端 HttpOnly Cookie）
 */
export async function logoutApi(): Promise<void> {
  await request.post('/auth/logout');
}
