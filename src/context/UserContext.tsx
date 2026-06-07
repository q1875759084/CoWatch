import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { setAccessToken, clearAccessToken, getAccessToken } from '@/utils/token';
import { saveUserInfo, loadUserInfo, clearUserInfo, type StoredUserInfo } from '@/utils/storage';
import { getProfileApi, logoutApi } from '@/api/auth';

export type { StoredUserInfo as UserInfo };

interface UserContextValue {
  userInfo: StoredUserInfo | null;
  isAuthLoading: boolean;
  login: (accessToken: string, info: StoredUserInfo) => void;
  logout: () => Promise<void>;
}

const UserContext = createContext<UserContextValue>({
  userInfo: null,
  isAuthLoading: true,
  login: () => {},
  logout: async () => {},
});

export function UserProvider({ children }: { children: ReactNode }) {
  const [userInfo, setUserInfo] = useState<StoredUserInfo | null>(null);
  // isAuthLoading：页面刷新时验证 token 期间为 true，避免路由守卫过早跳转
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  // 页面刷新后：若本地有 token，调接口验证并恢复用户信息
  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      setIsAuthLoading(false);
      return;
    }
    // 先从 LS 恢复（快速渲染），同时异步验证 token 有效性
    const cached = loadUserInfo();
    if (cached) setUserInfo(cached);

    getProfileApi()
      .then((info) => {
        const fresh: StoredUserInfo = { userId: info.userId, username: info.username, nickname: info.nickname };
        setUserInfo(fresh);
        saveUserInfo(fresh);
      })
      .catch(() => {
        // token 已失效，清除本地数据（无感刷新失败后会跳到 /auth）
        clearAccessToken();
        clearUserInfo();
        setUserInfo(null);
      })
      .finally(() => setIsAuthLoading(false));
  }, []);

  const login = useCallback((accessToken: string, info: StoredUserInfo) => {
    setAccessToken(accessToken);
    saveUserInfo(info);
    setUserInfo(info);
  }, []);

  const logout = useCallback(async () => {
    try { await logoutApi(); } catch { /* 网络异常也要能退出 */ }
    clearAccessToken();
    clearUserInfo();
    setUserInfo(null);
  }, []);

  return (
    <UserContext.Provider value={{ userInfo, isAuthLoading, login, logout }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  return useContext(UserContext);
}
