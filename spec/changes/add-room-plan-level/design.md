# 房间等级体系 技术设计

## 1. 功能概述

引入房间等级（`plan_level`）字段，将功能限制从「用户会员等级」解耦到「房间等级」。
free 房间整体不可用（过期态），basic/pro 房间拥有全量功能。
Admin 可在 dashboard 手动设置房间等级；后端每日凌晨自动检查房主会员状态并降级过期房间。

## 2. 涉及模块

- **CoWatch-backend**：数据库迁移、database/room、database/roomSubscription（新）、middleware/roomPlanGuard（新）、controllers/rooms、routes/rooms、controllers/admin/roomsController、routes/admin、jobs/roomDowngrade（新）、app.ts
- **CoWatch**（前端）：types/room.ts、context/RoomContext.tsx、components/RoomGuard
- **daibao-dashboard**：types/index.ts、api/cowatch.ts、pages/cowatch/Admin/Rooms

## 3. 数据模型

### 3.1 rooms 表新增字段

```sql
ALTER TABLE rooms ADD COLUMN plan_level TEXT NOT NULL DEFAULT 'free';
ALTER TABLE rooms ADD COLUMN owner_id TEXT REFERENCES users(id);
UPDATE rooms SET owner_id = (
  SELECT user_id FROM room_members WHERE room_id = rooms.id AND is_admin = 1 LIMIT 1
);
```

- `plan_level`：`'free'` | `'vip:basic'` | `'vip:pro'`，默认 `'free'`
- `owner_id`：房主 user_id，用于每日降级检查

### 3.2 room_subscriptions 表（新建）

统一管理房间等级的「持有来源」，为未来双轨付费体系奠基。

```sql
CREATE TABLE room_subscriptions (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES rooms(id),
  plan        TEXT NOT NULL,           -- 'vip:basic' | 'vip:pro'
  source      TEXT NOT NULL,           -- 'admin_grant' | 'user_membership' | 'room_package'（预留）
  granted_by  TEXT,                    -- admin userId（source=admin_grant 时）
  expires_at  BIGINT,                  -- NULL = 永久；毫秒 Unix timestamp
  created_at  BIGINT NOT NULL
);
```

本期写入时机：
- **创建房间**：`source = 'user_membership'`，由用户当前最高会员等级决定
- **Admin 手动设置**：`source = 'admin_grant'`，永久有效（expires_at = NULL）

### 3.3 会员等级 → 房间等级映射

```
vip:pro   → plan_level = 'vip:pro'
vip:basic → plan_level = 'vip:basic'
无会员     → 无法创建房间（现有 requirePlan('vip:basic') 守卫保持不变）
```

## 4. 接口设计

### 4.1 GET /api/rooms/:roomId（getInfo，已有，扩展返回）

新增返回字段：`planLevel: 'free' | 'vip:basic' | 'vip:pro'`

```typescript
interface RoomInfoResponse {
  roomId: string;
  roomName: string;
  planLevel: 'free' | 'vip:basic' | 'vip:pro'; // 新增
  activeObjectKey: string | null;
  controlMode: string;
  controllerId: string | null;
  members: MemberInfo[];
}
```

free 房间也正常返回（含 `planLevel: 'free'`），前端据此渲染过期页。

### 4.2 POST /api/rooms（create，已有，扩展逻辑）

创建时：
1. 查询房主当前最高 plan，决定 `plan_level`
2. 同时写入 `room_subscriptions` 记录（source = 'user_membership'）
3. 写入 `owner_id = userId`

### 4.3 POST /api/admin/cowatch/rooms/:roomId/plan-level（新增）

Admin 手动设置房间等级。

- **方法**：POST
- **路径**：`/api/admin/cowatch/rooms/:roomId/plan-level`
- **需要**：adminAuthMiddleware

```typescript
// 请求 Body
interface SetRoomPlanLevelRequest {
  planLevel: 'free' | 'vip:basic' | 'vip:pro';
}

// 响应
// { code: 200, message: '房间等级已更新', data: null }
```

逻辑：
1. 更新 `rooms.plan_level`
2. 写入 `room_subscriptions`（source = 'admin_grant', expires_at = null）

### 4.4 GET /api/admin/cowatch/rooms（已有，扩展返回）

新增返回字段：`plan_level: string`、`owner_id: string | null`

## 5. 中间件：requireRoomActive

```typescript
// src/middleware/roomPlanGuard.ts
export function requireRoomActive(): RequestHandler {
  // 从 req.params.roomId 查 rooms.plan_level
  // 若为 'free'，返回 403：{ code: 403, message: '房间已过期，请购买会员或房间续费包' }
  // 否则 next()
}
```

挂载位置（routes/rooms.ts）：
- 所有需要房间成员身份 + 操作的接口（upload、labels、tags、videos list 等）
- **不挂载** getInfo（前端需要拿到 planLevel 才能显示过期页）
- **不挂载** join（让用户可以看到过期提示，而不是"403 无权限"）

## 6. 每日降级 Job

```typescript
// src/jobs/roomDowngrade.ts
// 每日凌晨 3:00 执行
// 逻辑：
//   1. 查询所有 plan_level != 'free' 的房间
//   2. 对每个房间的 owner_id，查询 getActivePlans
//   3. 若 owner 已无有效 plan（或最高 plan 低于房间当前等级）：
//      - 检查该房间是否有 source='admin_grant' 或 source='room_package' 的有效订阅
//      - 若有，跳过（admin_grant / room_package 不受用户会员影响）
//      - 若无，降级为 'free'
```

在 `app.ts` 中启动（start() 内，runMigrations 之后）。

## 7. 前端：RoomGuard 过期页

进入 `/room/:roomId/lobby` 时：
1. `RoomGuard` 调用 `GET /api/rooms/:roomId`（getInfo）
2. 拿到 `planLevel` 写入 `RoomContext`
3. 若 `planLevel === 'free'`，渲染遮挡页（不进行 WS 连接、不加载视频列表）
4. 否则正常渲染 Lobby

过期页文案：**「房间已过期，请购买会员或房间续费包」**（文案待定）

## 8. 关键决策记录

| 问题 | 结论 |
|------|------|
| free 房间行为 | 整体不可用，getInfo 正常返回 planLevel:'free'，前端渲染遮挡页 |
| basic vs pro 功能区分 | 本期不区分，功能完全相同 |
| pro 独占（原视频直传）| 架构预留，本期不实现 |
| 历史房间会员升级后 | 不自动升级，需 Admin 手动或用户后续付费 |
| 降级检查频率 | 每日凌晨 3:00 cron；前端进入房间时拉一次 getInfo |
| 套餐配额（限额 x+y）| 下期实现 |
| room_subscriptions 表 | 本期仅写入，不做配额校验查询 |
