# 成员在线状态 技术设计

## 1. 功能概述

将成员列表从"在线才显示、断线即删除"改为类似 QQ 群的持久模型：用户加入房间后永久成为成员，WS 连接状态决定在线/离线，断线不从列表移除，仅降低视觉权重并排到后面。

## 2. 涉及模块

- **后端**：`CoWatch-backend`
  - `src/database/schema.ts`
  - `src/database/roomMember/index.ts`
  - `src/controllers/ws/registry.ts`
  - `src/ws/wsServer.ts`
- **前端**：`CoWatch`
  - `src/types/room.ts`
  - `src/context/RoomContext.tsx`
  - `src/hooks/useRoomWs.ts`
  - `src/pages/Lobby/index.tsx`
  - `src/components/MemberList/index.tsx`
  - `src/components/MemberList/index.module.scss`

## 3. 模块设计

### 3.1 在线状态权威来源

**决策**：纯内存，以进程内 `roomClients: Map<roomId, Map<userId, WebSocket>>` 为唯一权威。

- WS 连接建立 → `addClient` → 该用户在线
- WS 断开 → `removeClient` → 该用户离线
- 进程重启 → Map 清空 → 所有人天然离线，无脏数据
- DB `room_members.is_online` 字段废弃，通过迁移脚本删除

**为什么不写 DB**：在线状态变更频率极高（每次刷新/关闭标签页），写 DB 产生大量低价值 IO；进程重启后 `is_online=1` 的脏数据需要额外清理逻辑；内存方案更简单且天然正确。

### 3.2 ROOM_STATE 下发 members

新成员加入时，后端构建 members 列表的逻辑：

```
DB：getMembersByRoom(roomId)           → 全量成员（谁加入过）
内存：getOnlineUserIds(roomId)          → 当前在线 userId 集合

合并 → members[].isOnline = onlineSet.has(member.userId)
```

注意：`addClient` 必须在 `broadcastExcept(MEMBER_JOINED)` 之前执行（现有代码已满足），
确保新成员发送 ROOM_STATE 时自己也在 onlineSet 里，`isOnline: true`。

### 3.3 WS 消息语义

| 消息类型 | 方向 | 触发时机 | 语义 |
|---------|------|---------|------|
| `MEMBER_JOINED` | 下行 | 新用户 WS 连接成功 | 新成员加入，附带 `isOnline: true` |
| `MEMBER_OFFLINE` | 下行（新增） | WS 断开（`ws.on('close')`） | 成员离线，前端标记 `isOnline: false` |
| `MEMBER_LEFT` | 下行（保留） | 未来退群功能 | 成员永久离开，前端从列表删除 |

**为什么新增 `MEMBER_OFFLINE` 而不复用 `MEMBER_LEFT`**：
语义解耦，`MEMBER_LEFT` 保留给未来"踢人/退群"功能，避免语义混淆。

### 3.4 MemberList UI 规则

- 在线成员排在前面，离线成员排在后面（两组内部维持加入时间顺序）
- 在线：现有样式不变（亮色）
- 离线：`opacity: 0.4`，无额外指示器（极简）
- 排序在组件内部完成，外部传入原始 members 数组即可

## 4. 接口/消息类型设计

### 新增：MEMBER_OFFLINE 下行消息

```typescript
// src/types/room.ts
export interface MemberOfflineData {
  userId: string;
}
```

### 修改：Member 类型

```typescript
// src/types/room.ts
export interface Member {
  userId: string;
  nickname: string;
  isAdmin: boolean;
  isOnline: boolean;  // 新增
}
```

### 修改：MemberJoinedData

```typescript
// src/types/room.ts（已有，无需新增字段——isAdmin 已有，isOnline 由 MEMBER_JOINED 触发时天然为 true）
// MEMBER_JOINED 下行时前端直接将 isOnline 置为 true，无需后端额外下发
```

## 5. 关键决策记录

| 问题 | 决策 | 理由 |
|------|------|------|
| 成员持久化 | 永久保留 | 类 QQ 群语义，加入即成员 |
| 在线状态存储 | 纯内存（`roomClients`） | 高频变更不适合写 DB，进程重启天然清零 |
| `MEMBER_LEFT` 语义 | 保留给退群，新增 `MEMBER_OFFLINE` | 语义解耦，为未来功能预留扩展点 |
| 离线样式 | `opacity: 0.4`，无圆点 | 极简，与暗色主题一致 |
| 控制权转移 | 保持现有逻辑不变 | 与在线状态功能解耦 |
