# Upload Token 管理 Bug

## 状态：全部修复（2026-07-07）

两个子 bug 均已修复。upload 层成为自包含模块：遇到 401 自行调用 `/api/auth/refresh`，不依赖 renderer。

---

## Bug 描述

录制超过 1 小时（JWT accessToken TTL）时，切片上传返回 401。

后端 `ACCESS_EXPIRES = '1h'`，前端 `MAX_RECORD_MS = 2h`，窗口重叠。

## 两个子 Bug

```
┌─ Bug A：token 刷新后 upload 层拿不到 ───────────────────────────┐
│  renderer 401 → refresh → bridge.updateAuthToken(newToken)       │
│    → setAuthTokenForRecorder 只更新 currentAuthToken             │
│    → upload 层 config.authToken 仍是旧值 → 后续切片 401          │
└──────────────────────────────────────────────────────────────────┘

┌─ Bug B：token 根本没机会刷新 ───────────────────────────────────┐
│  录制 >1h + 用户切游戏窗口不碰 UI                                  │
│    → 渲染进程无 HTTP 请求 → axios 拦截器的 401 链永不触发          │
│    → upload 层 token 默默过期 → 401 → pendingQueue 积压          │
└──────────────────────────────────────────────────────────────────┘
```

根本原因：双 Token 无感登录的 axios 拦截器只覆盖渲染进程，主进程 `electron.net.fetch` 的切片上传不走拦截器。

## 修复

### Bug A — token 同步（3 行，recorder/index.ts + upload/index.ts）

```typescript
// upload/index.ts
export function updateAuthToken(token: string): void {
  if (config) config.authToken = token;
}

// recorder/index.ts
export function setAuthTokenForRecorder(token: string): void {
  currentAuthToken = token;
  updateAuthToken(token);  // ← 同步到 upload 层
}
```

### Bug B — 主进程自刷新（~40 行，upload/index.ts）

`refreshTokenFromMainProcess()`：主进程直接调 `/api/auth/refresh`，`credentials: 'include'` 共享 renderer 的 HttpOnly refresh cookie。

`doUpload()` 中 pRetry 回调检测 `response.status === 401` → 调 `refreshTokenFromMainProcess()` → 拿到新 token 写 `config.authToken` → throw 触发 pRetry 重试。

关键设计：
- `tokenRefreshed` 标志确保每片只刷新一次（防止 401 循环）
- 刷新成功 → 重试用新 token；刷新失败 → 走正常 pRetry / pendingQueue
- 全部在 upload 层自闭环，renderer 零感知

## 后续演进

### 短期：录制专用 Token

```
recordingToken：2h 有效，绑定 roomId + sessionId
  → 用户 JWT 刷新不影响录制
  → 后端新增 POST /api/rooms/:roomId/recording/start → { sessionId, recordingToken }
```

### 长期：COS 直连（去掉后端 segment 接口）

```
Electron Client → COS STS 预签名直传
  → 不经过后端 HTTP
  → 鉴权从 JWT → COS STS 临时密钥
  → refreshTokenFromMainProcess 换成 refreshStsToken，其余代码不动
```
