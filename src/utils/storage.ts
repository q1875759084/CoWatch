/**
 * 用户基本信息本地持久化（不含 roomId，登录态信息）
 *
 * roomId 属于当前会话状态，由 RoomContext 在内存中管理，不需要持久化。
 */

const USER_INFO_KEY = 'cowatch_user_info';

export interface StoredUserInfo {
  userId: string;
  username: string;
  nickname: string;
  /** 当前用户有效的权益 plan 列表，普通成员为 [] */
  plans: string[];
  /** 用户头像 URL，始终非空（后端 DB 为 null 时返回默认头像地址） */
  avatarUrl: string;
}

export function saveUserInfo(info: StoredUserInfo): void {
  localStorage.setItem(USER_INFO_KEY, JSON.stringify(info));
}

export function loadUserInfo(): StoredUserInfo | null {
  try {
    const raw = localStorage.getItem(USER_INFO_KEY);
    return raw ? (JSON.parse(raw) as StoredUserInfo) : null;
  } catch {
    return null;
  }
}

export function clearUserInfo(): void {
  localStorage.removeItem(USER_INFO_KEY);
}
