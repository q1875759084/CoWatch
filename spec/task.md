# CoWatch 用户系统重构 Task

> 目标：引入账号注册/登录，废弃 nickname 匿名鉴权，改造整体布局为「顶部 Bar + 左侧房间列表 + 右侧内容区」三栏结构。

---

## 数据模型变更

### 新增 `users` 表
| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| username | TEXT UNIQUE | 账号名（英文+数字+特殊字符） |
| password_hash | TEXT | bcrypt hash |
| nickname | TEXT | 默认等于 username，暂不开放修改 |
| created_at | INTEGER | |

### 废弃 `members` 表，新增 `room_members` 表
| 字段 | 类型 | 说明 |
|---|---|---|
| user_id | TEXT FK→users.id | |
| room_id | TEXT FK→rooms.id | |
| is_admin | INTEGER | 0/1 |
| is_online | INTEGER | 0/1 |
| joined_at | INTEGER | |
| PRIMARY KEY | (user_id, room_id) | |

### `rooms` 表变更
- `controller_id` 引用从 `members.id` 改为 `users.id`

---

## 鉴权方式变更

| 旧 | 新 |
|---|---|
| 无登录，每次进房间生成新 UUID memberId | JWT（存 localStorage），每次请求带 Authorization header |
| roomAuthMiddleware 用 userId+roomId 查 members 表 | authMiddleware 解析 JWT 拿 userId；roomAuthMiddleware 查 room_members 表 |
| WS 连接用 ?userId= 参数鉴权 | WS 连接用 ?token= 参数鉴权 |

---

## 后端改动范围

### 新增文件
- [ ] `src/database/user/index.ts` — users 表 DAO（createUser / findByUsername / findById）
- [ ] `src/database/roomMember/index.ts` — room_members 表 DAO（替代旧 member DAO）
- [ ] `src/controllers/auth/index.ts` — register / login controller
- [ ] `src/routes/auth/index.ts` — POST /api/auth/register、POST /api/auth/login
- [ ] `src/middleware/authMiddleware.ts` — 解析 JWT，挂载 req.userId；替代旧 roomAuthMiddleware 中的身份部分

### 修改文件
- [ ] `src/database/schema.ts` — 新增 users 表，room_members 表替代 members 表
- [ ] `src/middleware/roomAuth.ts` — 改为查 room_members（roomId + userId），删除旧 members 依赖
- [ ] `src/controllers/rooms/index.ts` — create/join/getUploadUrl/uploadLocal 全部改用 req.userId（由 authMiddleware 注入）；create/join 不再返回 userId；join 改为幂等（同一用户重复加入返回已有记录）
- [ ] `src/controllers/ws/registry.ts` — userId 已改为 users.id，无需修改接口但确认引用
- [ ] `src/ws/wsServer.ts` — 连接鉴权从 getMember 改为 getRoomMember；断线逻辑 getAdminByRoom 改查 room_members
- [ ] `src/routes/rooms/index.ts` — 在需要身份的路由前插入 authMiddleware
- [ ] `src/routes/index.ts` — 注册 auth 路由
- [ ] `src/app.ts` — 无结构变化，依赖自动跟随

### 删除文件
- [ ] `src/database/member/index.ts` — 废弃，由 roomMember/index.ts 替代

### 新增依赖
- `bcryptjs` + `@types/bcryptjs` — 密码 hash
- `jsonwebtoken` + `@types/jsonwebtoken` — JWT 签发/校验

---

## 前端改动范围

### 新增文件
- [ ] `src/api/auth.ts` — registerApi / loginApi
- [ ] `src/pages/Auth/index.tsx` — 注册/登录页（tab 切换）
- [ ] `src/pages/Auth/index.module.scss`
- [ ] `src/pages/Dashboard/index.tsx` — 主工作区（顶部Bar + 左侧房间列表 + 右侧内容区）
- [ ] `src/pages/Dashboard/index.module.scss`
- [ ] `src/pages/Dashboard/TopBar.tsx` — 顶部 bar，右侧显示用户信息 + 退出
- [ ] `src/pages/Dashboard/TopBar.module.scss`
- [ ] `src/pages/Dashboard/RoomList.tsx` — 左侧房间列表，底部 + 按钮，弹出创建/加入
- [ ] `src/pages/Dashboard/RoomList.module.scss`
- [ ] `src/pages/Dashboard/RoomModal.tsx` — 创建房间 / 加入房间弹窗（tab 切换）
- [ ] `src/pages/Dashboard/RoomModal.module.scss`
- [ ] `src/components/AuthGuard/index.tsx` — 路由守卫：未登录跳 /auth
- [ ] `src/hooks/useMyRooms.ts` — 拉取当前用户的房间列表

### 修改文件
- [ ] `src/utils/storage.ts` — 存储从 UserIdentity（roomId 绑定）改为 AuthToken + UserInfo（不含 roomId）；currentRoomId 单独管理
- [ ] `src/utils/request.ts` — 请求拦截器自动注入 Authorization: Bearer <token>
- [ ] `src/context/UserContext.tsx` — UserInfo 去掉 roomId / isAdmin（改到 RoomContext）；新增 token 字段；login/logout 方法
- [ ] `src/context/RoomContext.tsx` — 新增 isAdmin 字段（从登录用户 + room_members 角色联合确定）
- [ ] `src/api/room.ts` — createRoomApi / joinRoomApi 不再传 nickname（从登录态取）；新增 getMyRoomsApi
- [ ] `src/types/api.ts` — 新增 AuthResponse；CreateRoomResponse / JoinRoomResponse 去掉 userId 字段
- [ ] `src/router/index.tsx` — 路由重构：/ → AuthGuard → Dashboard；/auth → Auth 页；/room/:roomId/* 保持不变但也套 AuthGuard
- [ ] `src/App.tsx` — Provider 层次不变，RouterProvider 不变
- [ ] `src/hooks/useRoomWs.ts` — WS 连接参数从 ?userId= 改为 ?token=
- [ ] `src/components/RoomGuard/index.tsx` — 守卫逻辑调整：只校验已登录，roomId 匹配由路由参数决定
- [ ] `src/pages/Lobby/index.tsx` — 布局迁移到 Dashboard 框架内，Lobby 只保留右侧内容区逻辑
- [ ] `src/pages/WatchRoom/index.tsx` — 同上，只保留右侧内容区逻辑

### 删除文件
- [ ] `src/pages/Home/index.tsx` — 由 Dashboard 替代
- [ ] `src/pages/Home/CreateRoomForm.tsx`
- [ ] `src/pages/Home/JoinRoomForm.tsx`
- [ ] `src/pages/Home/index.module.scss`
- [ ] `src/pages/Home/Form.module.scss`

---

## 新路由结构

```
/auth                     → Auth 页（未登录可访问）
/                         → AuthGuard → Dashboard（左侧默认显示房间列表，右侧为空）
/room/:roomId/lobby       → AuthGuard → Dashboard（右侧为 Lobby 内容）
/room/:roomId/watch       → AuthGuard → Dashboard（右侧为 WatchRoom 内容）
```

---

## 执行顺序建议

```
后端优先：
 1. schema.ts（表结构）
 2. user DAO
 3. roomMember DAO
 4. authMiddleware
 5. auth controller + routes
 6. 更新 roomAuth middleware
 7. 更新 rooms controller
 8. 更新 wsServer

前端跟进：
 9. storage.ts
10. request.ts（注入 token）
11. types/api.ts
12. api/auth.ts
13. api/room.ts（getMyRoomsApi）
14. context/UserContext
15. context/RoomContext
16. hooks/useMyRooms
17. hooks/useRoomWs（改 token 参数）
18. components/AuthGuard
19. components/RoomGuard（简化）
20. pages/Auth（注册/登录页）
21. pages/Dashboard/TopBar
22. pages/Dashboard/RoomList + RoomModal
23. pages/Dashboard/index（组装三栏布局）
24. pages/Lobby（裁剪为纯内容区）
25. pages/WatchRoom（裁剪为纯内容区）
26. router/index.tsx
27. 删除旧 Home 页文件
```

---

## 注意事项

- JWT secret 存 `.env`（`JWT_SECRET=`），`.env.example` 同步添加
- 密码校验正则：`/^[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+$/`，最短 6 位
- WS 鉴权改为 `?token=` 后，`useRoomWs` 需从 context 取 token 而非 userId
- `room_members` 表用复合主键 `(user_id, room_id)`，join 操作幂等（已在房间则更新 joined_at）
- 旧数据库文件建议删除重建（开发阶段，无迁移脚本需求）
