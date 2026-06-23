# 房间等级体系 实现任务

## 任务清单

### CoWatch-backend / 数据库迁移

#### 1. migrations/003_room_plan.sql
- [ ] 新增 `rooms.plan_level` 字段（DEFAULT 'free'）
- [ ] 新增 `rooms.owner_id` 字段（外键 → users.id）
- [ ] 回填历史房间 `owner_id`（取 room_members.is_admin=1 的成员）
- [ ] 新建 `room_subscriptions` 表

### CoWatch-backend / 数据层

#### 2. src/database/room/index.ts
- [ ] `createRoom` 新增 `ownerId` + `planLevel` 参数
- [ ] 新增 `setRoomPlanLevel(roomId, planLevel)` 函数
- [ ] `getRoomById` 返回类型 `RoomRow` 新增 `plan_level` + `owner_id` 字段
- [ ] 新增 `getAllRoomsWithPlan()` — 查询所有 plan_level != 'free' 的房间（供 cron 使用）

#### 3. src/database/roomSubscription/index.ts（新文件）
- [ ] 定义 `RoomSubscriptionRow` 接口
- [ ] 实现 `addRoomSubscription(roomId, plan, source, grantedBy?, expiresAt?)` 函数
- [ ] 实现 `getActiveRoomSubscriptions(roomId)` — 查询房间所有有效订阅（非过期）

### CoWatch-backend / 中间件

#### 4. src/middleware/roomPlanGuard.ts（新文件）
- [ ] 实现 `requireRoomActive()` 中间件
  - 从 `req.params.roomId` 查 `rooms.plan_level`
  - `plan_level === 'free'` 时返回 `403`：`{ code: 403, message: '房间已过期，请购买会员或房间续费包' }`
  - 否则 `next()`

### CoWatch-backend / 控制器

#### 5. src/controllers/rooms/index.ts
- [ ] `create`：查询房主最高 plan → 写入 `plan_level` + `owner_id`；同时写 `room_subscriptions`
- [ ] `getInfo`：返回数据新增 `planLevel` 字段

#### 6. src/controllers/admin/roomsController.ts
- [ ] `list`：返回数据新增 `plan_level`、`owner_id` 字段
- [ ] 新增 `setPlanLevel` handler：更新 `rooms.plan_level` + 写入 `room_subscriptions`（source='admin_grant'）

### CoWatch-backend / 路由

#### 7. src/routes/rooms/index.ts
- [ ] 在以下接口上挂载 `requireRoomActive()`（位于 `roomAuthMiddleware` 之后）：
  - `GET /:roomId/videos`
  - `GET /:roomId/tags`
  - `GET /:roomId/videos/:videoId/m3u8`
  - `GET /:roomId/upload-url`
  - `POST /:roomId/upload-proxy`
  - `PUT /:roomId/upload`
  - `PATCH /:roomId/videos/:videoId/name`
  - `DELETE /:roomId/videos/:videoId`
  - `PUT /:roomId/videos/:videoId/labels`
- [ ] **不挂载** `GET /:roomId`（getInfo）和 `POST /:roomId/join`

#### 8. src/routes/admin/index.ts
- [ ] 注册 `POST /cowatch/rooms/:roomId/plan-level` → `AdminRoomsController.setPlanLevel`

### CoWatch-backend / 定时任务

#### 9. src/jobs/roomDowngrade.ts（新文件）
- [ ] 实现 `scheduleRoomDowngradeJob()` 函数
  - 每日凌晨 3:00 执行（使用 `setInterval` + 计算首次触发时间，无需第三方 cron 库）
  - 查询所有 `plan_level != 'free'` 的房间
  - 对每个房间：若 owner 已无有效 plan，且无 `admin_grant`/`room_package` 来源的有效订阅，则降级为 `'free'`

#### 10. src/app.ts
- [ ] 在 `start()` 内 `runMigrations` 之后调用 `scheduleRoomDowngradeJob()`

---

### CoWatch（前端）

#### 11. src/types/room.ts
- [ ] `RoomInfo` 接口新增 `planLevel: 'free' | 'vip:basic' | 'vip:pro'`

#### 12. src/context/RoomContext.tsx
- [ ] `RoomState` 新增 `planLevel: 'free' | 'vip:basic' | 'vip:pro'`
- [ ] `InitRoomPayload` 包含 `planLevel`
- [ ] `initRoom` 写入 `planLevel`

#### 13. src/components/RoomGuard/index.tsx
- [ ] 调用 `getRoomInfoApi(roomId)` 获取 `planLevel`（新增加载态）
- [ ] `planLevel === 'free'` 时渲染过期遮挡页（文案：「房间已过期，请购买会员或房间续费包」）
- [ ] 否则调用 `initRoom` 写入 context 后渲染 `children`

---

### daibao-dashboard

#### 14. src/types/index.ts
- [ ] `CoWatchRoom` 新增 `plan_level: string`、`owner_id: string | null`

#### 15. src/api/cowatch.ts
- [ ] 新增 `setRoomPlanLevelApi(roomId, planLevel)` 函数

#### 16. src/pages/cowatch/Admin/Rooms/index.tsx
- [ ] 新增"等级"列（Tag 颜色：gold=vip:pro，blue=vip:basic，red=free）
- [ ] 新增"设置等级"按钮 → 弹出 Modal，Select 选择目标等级，确认后调 `setRoomPlanLevelApi`
- [ ] 操作成功后刷新列表

---
完成所有任务后将 `- [ ]` 改为 `- [x]`
