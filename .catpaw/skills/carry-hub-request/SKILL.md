---
name: carry-hub-request
description: CarryHub 项目网络请求规范。当需要编写接口调用、处理 API 响应、配置重试策略、处理 Token 刷新、封装请求函数时使用。涉及 bizAxios、useRequest、api 目录、ApiResponse 类型时激活。
---
# CarryHub 网络请求规范

## 核心原则

- **禁止**直接使用 `axios`，必须使用封装好的 `bizAxios`
- 请求函数统一封装在子包的 `api/` 目录下
- 响应类型用 `ApiResponse<T>` 泛型约束

## bizAxios 使用

```ts
// 从 shared 引入
import bizAxios from '@carry/shared/utils/bizAxios';
import type { ApiResponse } from '@carry/shared/types';

// api/enterprise.ts
export const getEnterpriseList = (params: ListParams) =>
  bizAxios.get<ApiResponse<{ list: Enterprise[]; total: number }>>('/api/enterprise/list', { params });

export const getEnterpriseDetail = (id: number) =>
  bizAxios.get<ApiResponse<Enterprise>>(`/api/enterprise/${id}`);
```

## 响应类型约定

```ts
interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}
```

## 组件内请求：用 useRequest（ahooks）

```ts
import { useRequest } from 'ahooks';
import { getEnterpriseList } from '../api/enterprise';

const { data, loading, error } = useRequest(
  () => getEnterpriseList(params),
  { refreshDeps: [params] }
);
```

- **禁止**手写 `useEffect` + `useState` 的请求逻辑，统一用 `useRequest`

## 重试策略（bizAxios 内置，无需手动配置）

- 仅对网络错误和 5xx 重试，**不重试 4xx**
- 重试延迟：指数退避 + 随机抖动
  ```
  delay = min(baseDelay * 2^attempt, maxDelay) + random(0, jitter)
  // baseDelay=300ms, maxDelay=10000ms, jitter=300ms, maxRetries=3
  ```
- `_retry` 标记防止无限循环

## Token 机制（bizAxios 内置，无需手动处理）

- AccessToken：内存优先，页面刷新后从 LocalStorage 恢复，放 Bearer Header
- RefreshToken：HttpOnly Cookie（前端不可读），后端设置
- 并发 401：`isRefreshing` 锁 + `failedQueue` 队列，防止多次并发 refresh

## 错误处理规范

bizAxios 拦截器已按错误类型做分类处理，**业务层不应再手动判断 status**：

| 错误类型 | 拦截器行为 | 业务层应做什么 |
|---|---|---|
| **401** | 自动无感刷新 Token，失败则跳登录 | 无需感知，完全透明 |
| **403** | dispatch `carry:forbidden` 事件，跳无权限页 | **不要再弹 toast**，否则双重处理（toast + 跳页） |
| **5xx / 网络错误** | 指数退避自动重试 3 次 | 重试耗尽后错误透传，用 `err.message` 展示 |
| **其余（400/404）** | 直接透传 | `err.message` 展示 |

```ts
// ✅ 正确：一行兜底，不手动判断 status
try {
  const res = await getEnterpriseList(params);
  // 业务处理
} catch (error) {
  // bizAxios 已处理 401/403/5xx，此处只展示透传的错误信息
  message.error((error as Error).message || '请求失败');
}

// ❌ 错误：手动判断 status（与拦截器重复，403 会出现 toast + 跳页双重处理）
} catch (error) {
  if (error.response?.status === 403) {
    message.error('无权限访问');   // ← 拦截器已跳页，这行会同时执行
  } else if (error.response?.status >= 500) {
    message.error('服务异常');     // ← 拦截器已重试，这里是重试耗尽后的兜底，无需再判断
  }
}

// ❌ 禁止：静默失败
const res = await getEnterpriseList(params).catch(() => null);
```
