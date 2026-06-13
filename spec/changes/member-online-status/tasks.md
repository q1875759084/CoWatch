# 成员在线状态 实现任务

## 任务清单

### 后端

#### 1. DB Schema & 迁移
- [ ] `src/database/schema.ts`：`runMigrations` 新增一条迁移，删除 `room_members.is_online` 列
  - SQLite 不支持 DROP COLUMN（3.35.0 以下），需确认版本；若不支持，在注释中说明该字段废弃、不再读写即可

#### 2. roomMember/index.ts
- [ ] `RoomMemberRow` 接口删除 `is_online: 0 | 1` 字段
- [ ] `joinRoom` 函数删除 `is_online` 相关 SQL 写入（`INSERT ... is_online = 0`）

#### 3. registry.ts
- [ ] 新增 `getOnlineUserIds(roomId: string): Set<string>` 工具函数
  - 返回 `new Set(roomClients.get(roomId)?.keys() ?? [])`

#### 4. wsServer.ts
- [ ] `ROOM_STATE` 下发 members 时：调用 `getOnlineUserIds(roomId)` 拼出 `isOnline` 字段
  ```ts
  const onlineIds = getOnlineUserIds(roomId);
  members: currentMembers.map((m) => ({
    userId: m.user_id,
    nickname: m.nickname,
    isAdmin: m.is_admin === 1,
    isOnline: onlineIds.has(m.user_id),
  }))
  ```
- [ ] `ws.on('close')` 改为广播 `MEMBER_OFFLINE`（替换原 `MEMBER_LEFT` 广播）
  ```ts
  broadcast(roomId, { type: 'MEMBER_OFFLINE', data: { userId } });
  ```
- [ ] `MEMBER_LEFT` 消息类型保留（暂不使用，供未来退群功能）

---

### 前端

#### 5. types/room.ts
- [ ] `WsMessageType` 联合类型新增 `'MEMBER_OFFLINE'`
- [ ] `Member` 接口新增 `isOnline: boolean`
- [ ] 新增 `MemberOfflineData` 接口 `{ userId: string }`

#### 6. RoomContext.tsx
- [ ] 新增 `setMemberOnline(userId: string, isOnline: boolean)` 方法
  ```ts
  setRoomState((prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      members: prev.members.map((m) =>
        m.userId === userId ? { ...m, isOnline } : m
      ),
    };
  });
  ```
- [ ] `addMember`：新增成员时附带 `isOnline: true`
- [ ] `removeMember`：保留方法（供未来退群用），不删除
- [ ] `RoomContextValue` 接口新增 `setMemberOnline`
- [ ] Context 默认值补充 `setMemberOnline: () => {}`

#### 7. useRoomWs.ts
- [ ] import 新增 `MemberOfflineData`
- [ ] `UseRoomWsOptions` 新增 `onMemberOffline?: (userId: string) => void`
- [ ] 解构新增 `onMemberOffline`
- [ ] 新增 `stableOnMemberOffline = useMemoizedFn(onMemberOffline ?? (() => {}))`
- [ ] `ws.onmessage` switch 新增 `MEMBER_OFFLINE` case：
  ```ts
  case 'MEMBER_OFFLINE': {
    const d = msg.data as unknown as MemberOfflineData | undefined;
    if (d) stableOnMemberOffline(d.userId);
    break;
  }
  ```
- [ ] `MEMBER_JOINED` case：调用 `addMember` 时确保传入 `isOnline: true`（现有逻辑已传 isAdmin，补充 isOnline）
- [ ] `MEMBER_LEFT` case：暂时保留，不做处理（或 console.log 占位）

#### 8. index.tsx（Lobby）
- [ ] 从 `useRoom` 解构 `setMemberOnline`
- [ ] 新增 `handleMemberOffline` 回调：`useMemoizedFn((userId) => setMemberOnline(userId, false))`
- [ ] `useRoomWs` 调用新增 `onMemberOffline: handleMemberOffline`
- [ ] `handleRoomState` 初始化成员时：`setMembers` 传入的数组已含 `isOnline`，确保透传正确

#### 9. MemberList 组件
- [ ] `src/components/MemberList/index.tsx`：
  - 组件内部按 `isOnline` 分两组，在线排前面
  - 渲染时在线成员用现有样式，离线成员加 `.offline` class
- [ ] `src/components/MemberList/index.module.scss`：
  - 新增 `.offline { opacity: 0.4; }`

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
