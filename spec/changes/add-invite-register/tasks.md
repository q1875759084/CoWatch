# 邀请码注册体系 实现任务

## 后端（CoWatch-backend）

### 1. 数据库层

- [x] `src/database/schema.ts`：`initSchema` 新增 `user_subscriptions` 表 + `invite_codes` 表
- [x] `src/database/schema.ts`：`runMigrations` 废弃 `is_upload_whitelist` 写入注释
- [x] `src/database/schema.ts`：`initSchema` 末尾调用 `seedInviteCodes()`（替代原 `seedDefaultUsers`）
- [x] 新建 `src/database/subscription/index.ts`
  - `hasActivePlan(userId, plan): boolean`
  - `getActivePlans(userId): string[]`
  - `addSubscription(userId, plan, expiresAt?): void`
- [x] 新建 `src/database/inviteCode/index.ts`
  - `getInviteCode(code): InviteCodeRow | null`
  - `consumeInviteCode(code): void`
  - `seedInviteCodes(): void`（写入 7 个普通码 + 7 个会员码，幂等）
- [x] `src/database/user/index.ts`：删除 `PRESET_USERS` 常量 + `seedDefaultUsers` 函数；`createUser` 保持不变

### 2. 中间件

- [x] 新建 `src/middleware/planGuard.ts`
  - `requirePlan(plan: string): RequestHandler`
  - 调用 `hasActivePlan(req.userId!, plan)`，失败返回 403
- [x] `src/middleware/uploadGuard.ts`：流量限制白名单判断改为 `hasActivePlan(userId, 'vip:basic')`

### 3. 服务层

- [x] `src/services/user/index.ts`：`registerUser(username, password, inviteCode)` 新增逻辑
  - 调用 `getInviteCode(inviteCode)`，不存在或已满则抛错
  - 创建用户后调用 `consumeInviteCode`
  - 若 `grant_plan` 非空，调用 `addSubscription(userId, grant_plan, undefined)`
  - 返回值 `AuthResult` 加 `plans: string[]`

### 4. Controller & 路由

- [x] `src/controllers/auth/index.ts`
  - `register`：从 `req.body` 取 `inviteCode` 传给 `registerUser`
  - `profile`：`getUserProfile` 返回值加 `plans`（调用 `getActivePlans`）
- [x] `src/services/user/index.ts`：`getUserProfile` 返回值加 `plans`
- [x] `src/routes/auth/index.ts`：将注册接口从 503 兜底改为真实路由
- [x] `src/routes/rooms/index.ts`：建房路由 `POST /` 加 `requirePlan('vip:basic')` 中间件

---

## 前端（CoWatch）

### 5. 类型 & API

- [x] `src/types/api.ts`：`UserInfo` 加 `plans: string[]`
- [x] `src/api/auth.ts`：`registerApi(username, password, inviteCode)` 加第三参数

### 6. UserContext

- [x] `src/context/UserContext.tsx`
  - `StoredUserInfo` 加 `plans: string[]`
  - `UserContextValue` 加 `hasPlan: (plan: string) => boolean`
  - `login` 函数接收并存储 `plans`
  - `getProfileApi` 恢复后更新 `plans`
  - `hasPlan` 实现：`userInfo?.plans.includes(plan) ?? false`
- [x] `src/utils/storage.ts`：`StoredUserInfo` 加 `plans` 字段（本地缓存兼容）

### 7. 注册页

- [x] `src/pages/Auth/index.tsx`
  - 注册 tab 移除 `disabled` 属性，修改文案为「注册」
  - 注册表单新增邀请码输入框（`inviteCode` state）
  - `handleSubmit` 调用 `registerApi` 时传入 `inviteCode`

### 8. Dashboard 建房入口

- [x] `src/pages/Dashboard/RoomList.tsx`：引入 `useUser`，`hasPlan('vip:basic') === false` 时按钮禁用（样式 + cursor）
- [x] `src/pages/Dashboard/RoomList.module.scss`：新增 `.addBtnDisabled` 样式
- [x] 使用 Antd `Tooltip`，内容：「创建房间需要会员权限」

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
