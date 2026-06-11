import axios, {
  type AxiosInstance,
  type InternalAxiosRequestConfig,
  type AxiosResponse,
  type AxiosError,
} from 'axios';
import { getAccessToken, setAccessToken, clearAccessToken, hasAccessToken } from './token';

/**
 * 业务层错误（后端返回 code !== 200）
 */
export class ApiError extends Error {
  response: AxiosResponse;
  constructor(message: string, response: AxiosResponse) {
    super(message);
    this.name = 'ApiError';
    this.response = response;
  }
}

const request: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true, // 携带 HttpOnly Cookie（RefreshToken 用）
});

// ─── 无感刷新全局状态 ──────────────────────────────────────────────────────────
let isRefreshing = false;
let pendingQueue: Array<{ resolve: (token: string) => void; reject: (err: AxiosError) => void }> = [];

async function refreshTokenRequest(): Promise<string> {
  const res = await axios.post('/api/auth/refresh', {}, { withCredentials: true, timeout: 5000 });
  if (res.data.code !== 200) throw new Error('刷新 Token 失败');
  return res.data.data.accessToken as string;
}

// ─── 请求拦截：自动注入 Bearer Token ──────────────────────────────────────────
request.interceptors.request.use(
  (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
    const token = getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error),
);

// ─── 响应拦截：统一处理 code 非 200 及 401 无感刷新 ──────────────────────────
request.interceptors.response.use(
  (response: AxiosResponse) => {
    const { data } = response;
    // 非 JSON 响应（如 m3u8 纯文本）或无 code 字段时直接放行，不做业务 code 校验
    if (typeof data !== 'object' || data === null || !('code' in data)) {
      return response;
    }
    if (data.code !== 200) {
      return Promise.reject(new ApiError(data.message || '请求失败', response));
    }
    return response;
  },
  async (error: AxiosError): Promise<never> => {
    if (!error.response) return Promise.reject(error);

    const { response, config } = error;

    if (response?.status === 401 && config) {
      if (!hasAccessToken()) {
        clearAccessToken();
        window.location.href = '/auth';
        return Promise.reject(error);
      }

      if (!isRefreshing) {
        isRefreshing = true;
        try {
          const newToken = await refreshTokenRequest();
          setAccessToken(newToken);
          pendingQueue.forEach(({ resolve }) => resolve(newToken));
          pendingQueue = [];
          isRefreshing = false;
          config.headers = config.headers ?? {};
          config.headers.Authorization = `Bearer ${newToken}`;
          return request(config) as never;
        } catch (refreshErr) {
          clearAccessToken();
          pendingQueue.forEach(({ reject }) => reject(refreshErr as AxiosError));
          pendingQueue = [];
          isRefreshing = false;
          window.location.href = '/auth';
          return Promise.reject(refreshErr);
        }
      }

      return new Promise((resolve, reject) => {
        pendingQueue.push({
          resolve: (token) => {
            config.headers = config.headers ?? {};
            config.headers.Authorization = `Bearer ${token}`;
            resolve(request(config) as never);
          },
          reject,
        });
      }) as never;
    }

    return Promise.reject(error);
  },
);

export default request;
