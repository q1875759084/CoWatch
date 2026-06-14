# 邀请码注册体系 技术设计

## 1. 功能概述

通过邀请码限制注册规模，邀请码类型决定注册后的用户身份：会员码（`max_count=1`，注册后获得 `vip:basic` 订阅）和普通码（`max_count=10`，注册后为普通成员）。所有账号均通过注册流程创建，无预置硬编码账号。同时为未来多维度权益体系打下数据层基础。

## 2. 涉及模块

### 后端（CoWatch-backend）

- `src/database/schema.ts` — 新增 `user_subscriptions`、`invite_codes` 表；`runMigrations` 废弃 `is_upload_whitelist`
- `src/database/subscription/index.ts` — 🆕 订阅查询层
- `src/database/inviteCode/index.ts` — 🆕 邀请码操作层
- `src/database/user/index.ts` — 清空 `PRESET_USERS`，删除 `seedDefaultUsers`
- `src/services/user/index.ts` — `registerUser` 加邀请码校验 + 按 `grant_plan` 写订阅
- `src/controllers/auth/index.ts` — `register` 传 `inviteCode`；`profile` 返回 `plans`
- `src/routes/auth/index.ts` — 解开注册接口注释
- `src/routes/rooms/index.ts` — 建房加 `requirePlan('vip:basic')` 中间件
- `src/middleware/planGuard.ts` — 🆕 `requirePlan` 工厂函数
- `src/middleware/uploadGuard.ts` — 流量限制改查 `hasActivePlan(userId, 'vip:basic')`

### 前端（CoWatch）

- `src/types/api.ts` — `UserInfo` 加 `plans: string[]`
- `src/context/UserContext.tsx` — 存储 `plans`，暴露 `hasPlan(plan)`
- `src/api/auth.ts` — `registerApi` 加 `inviteCode`
- `src/pages/Auth/index.tsx` — 解禁注册 tab + 邀请码输入框
- `src/pages/Dashboard/RoomModal.tsx` — 建房入口根据 `hasPlan('vip:basic')` 控制禁用

---

## 3. 数据库设计

### 新表：user_subscriptions

```sql
CREATE TABLE user_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  plan        TEXT NOT NULL,       -- 'vip:basic' | 'vip:pro' | 'cursor:basic' ...
  expires_at  INTEGER,             -- NULL = 永久；毫秒时间戳
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_subscriptions_user ON user_subscriptions (user_id);
```

### 新表：invite_codes

```sql
CREATE TABLE invite_codes (
  code        TEXT PRIMARY KEY,
  used_count  INTEGER NOT NULL DEFAULT 0,
  max_count   INTEGER NOT NULL DEFAULT 10,
  grant_plan  TEXT               -- NULL = 普通成员；'vip:basic' = 注册后写入该订阅
);
```

### users 表变更

- `is_upload_whitelist` 列**保留但停止读写**（旧数据兼容）
- 不新增任何列（用户身份通过 `user_subscriptions` 判断）

### Plan 命名规范

格式：`{domain}:{tier}`

| Plan 值 | 含义 |
|---------|------|
| `vip:basic` | 网站基础会员（当前阶段唯一值） |
| `vip:pro` | （预留）网站高级会员 |
| `cursor:basic` | （预留）自定义鼠标功能包 |

普通成员 = `user_subscriptions` 中无任何有效记录。

### 预置邀请码（启动时幂等写入）

**普通码**（`max_count=10`，`grant_plan=NULL`）：

| 邀请码 |
|--------|
| kfcvivo50 |
| 倍攻 |
| 你瞅啥 |
| 沙漠皇帝 |
| cpdd |
| whatcanisay |
| 凑个数吧 |

**会员码**（`max_count=1`，`grant_plan='vip:basic'`）：

| 邀请码 |
|--------|
| 0531 |
| 小萝卜 |
| 踩地火 |
| 不太聪明 |
| anxina |
| 变态萝莉控 |
| 世界第一h2 |

---

## 4. 接口设计

### 4.1 注册接口（已有，扩展参数）

- **方法**：POST
- **路径**：`/api/auth/register`

```typescript
// 请求体
interface RegisterRequest {
  username: string;     // 6-20位，字母/数字/特殊字符
  password: string;     // 至少6位
  inviteCode: string;   // 必填
}

// 响应 data
interface RegisterResponse {
  userInfo: {
    userId: string;
    username: string;
    nickname: string;
    plans: string[];    // 会员码注册 = ['vip:basic']；普通码注册 = []
  };
  accessToken: string;
}
```

**校验逻辑（顺序执行）**：
1. `username` / `password` 格式校验（现有逻辑不变）
2. 查 `invite_codes`：code 存在 且 `used_count < max_count`，否则 400
3. 创建用户（现有逻辑）
4. `used_count += 1`（事务内）
5. 若 `grant_plan` 非空，向 `user_subscriptions` 写一条 `expires_at=NULL` 记录
6. 返回 `plans`（步骤 5 写入的 plan，或空数组）

### 4.2 获取用户信息接口（已有，扩展返回）

- **方法**：GET
- **路径**：`/api/auth/profile`

```typescript
// 响应 data（扩展）
interface ProfileResponse {
  userInfo: {
    userId: string;
    username: string;
    nickname: string;
    plans: string[];   // 当前用户有效 plan 列表，普通成员为 []
  };
}
```

---

## 5. 核心模块设计

### 5.1 database/subscription/index.ts

```typescript
// 查询用户是否持有某 plan（含到期判断：expires_at IS NULL OR expires_at > Date.now()）
function hasActivePlan(userId: string, plan: string): boolean

// 获取用户所有有效 plan 列表
function getActivePlans(userId: string): string[]

// 写入订阅记录
function addSubscription(userId: string, plan: string, expiresAt?: number): void
```

### 5.2 database/inviteCode/index.ts

```typescript
// 查询邀请码（含 grant_plan）；不存在或已满则返回 null
interface InviteCodeRow {
  code: string;
  used_count: number;
  max_count: number;
  grant_plan: string | null;
}
function getInviteCode(code: string): InviteCodeRow | null

// 核销：used_count += 1（在 registerUser 事务中调用）
function consumeInviteCode(code: string): void

// 初始化预置邀请码（幂等，已存在则跳过）
function seedInviteCodes(): void
```

### 5.3 middleware/planGuard.ts

```typescript
// 校验失败返回 403：{ code: 403, message: '该功能需要 vip:basic 权限，请升级会员' }
function requirePlan(plan: string): RequestHandler
```

---

## 6. 前端设计

### 6.1 UserContext 扩展

```typescript
interface StoredUserInfo {
  userId: string;
  username: string;
  nickname: string;
  plans: string[];   // 新增
}

interface UserContextValue {
  hasPlan: (plan: string) => boolean;  // 新增
}
```

`hasPlan` 实现：`userInfo?.plans.includes(plan) ?? false`

### 6.2 注册页（Auth/index.tsx）

交互流程：
- When 用户点击「注册」tab，shall 展示注册表单（账号 + 密码 + 邀请码）
- When 用户提交，shall 显示加载态，禁用提交按钮
- When 邀请码不存在或已满，shall 在表单下方展示错误信息（来自后端 400 响应）
- When 注册成功，shall 自动登录并跳转 Dashboard（与现有登录逻辑一致）

### 6.3 Dashboard 建房入口

- When `hasPlan('vip:basic') === false`，建房按钮禁用，hover 显示 tooltip「创建房间需要会员权限」
- When `hasPlan('vip:basic') === true`，按钮正常可点击

---

## 7. 关键决策记录

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 权益存储结构 | 独立 `user_subscriptions` 表 | 支持多套餐叠加、独立到期时间，横向扩展零成本 |
| 预置账号 | 完全删除，所有账号均通过注册创建 | 逻辑统一，会员身份由会员码决定 |
| 会员开通方式 | `grant_plan` 非空的邀请码，注册后自动写订阅 | 与普通注册流程统一，无需额外接口 |
| `is_upload_whitelist` | 保留列但停止读写，改查订阅表 | 兼容旧数据，不做破坏性迁移 |
| Plan 命名规范 | `{domain}:{tier}`，如 `vip:basic` | 可读性强，支持前缀查询 |
| 建房权限控制 | `requirePlan('vip:basic')` 中间件，路由层注入 | 易复用，后续新增权益点只加一行 |
| 前端感知身份 | `plans` 随 profile 返回，`hasPlan()` 封装 | UI 禁用 + 转化提示，后端作最终防线 |
