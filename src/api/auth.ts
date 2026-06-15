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

/**
 * 修改昵称（最多 20 个字符）
 */
export async function updateNicknameApi(nickname: string): Promise<string> {
  const res = await request.put<{ code: number; message: string; data: { nickname: string } }>(
    '/auth/nickname',
    { nickname },
  );
  return res.data.data.nickname;
}

/**
 * 上传用户头像
 *
 * @param file  用户选择的图片文件（jpg / png / webp，≤ 2MB）
 * @returns     新头像的 CDN URL
 */
export async function uploadAvatarApi(file: File): Promise<string> {
  const form = new FormData();
  form.append('avatar', file);
  const res = await request.post<{ code: number; message: string; data: { avatarUrl: string } }>(
    '/auth/avatar',
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  );
  return res.data.data.avatarUrl;
}
