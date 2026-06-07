/**
 * AccessToken 存储工具
 *
 * 安全设计：
 * - AccessToken：内存 + localStorage 双存储（内存优先，刷新页面从 LS 恢复）
 * - RefreshToken：仅存 HttpOnly Cookie（后端 Set-Cookie，前端不可读）
 */

const ACCESS_TOKEN_KEY = 'cowatch_access_token';

// 内存缓存（页面不刷新时永久有效，避免频繁读 LS）
let memoryToken: string | null = null;

export function setAccessToken(token: string): void {
  memoryToken = token;
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function getAccessToken(): string | null {
  if (memoryToken) return memoryToken;
  const local = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (local) memoryToken = local;
  return local;
}

export function clearAccessToken(): void {
  memoryToken = null;
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  // RefreshToken 由后端 clearCookie 清除，前端无法操作 HttpOnly Cookie
}

export function hasAccessToken(): boolean {
  return !!getAccessToken();
}
