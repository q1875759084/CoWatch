# 视频改名 实现任务

## 任务清单

---

### 后端

#### 1. 数据库 Schema 迁移
- [x] `CoWatch-backend/src/database/schema.ts`：在 `runMigrations()` 末尾追加迁移，为 `room_videos` 表新增 `display_name TEXT` 列

#### 2. 视频 DB 层
- [x] `CoWatch-backend/src/database/roomVideo/index.ts`：
  - `RoomVideoRow` 新增 `display_name: string | null` 字段
  - 新增 `updateDisplayName(videoId: string, displayName: string): void` 方法

#### 3. 房间 HTTP 控制器
- [x] `CoWatch-backend/src/controllers/rooms/index.ts`：
  - `listVideos` 响应中每个视频带上 `displayName: v.display_name ?? null`
  - 新增 `renameVideo` 方法：
    - 校验 `displayName` 非空、不超 50 字符
    - 校验当前用户为上传者或房间管理员，否则返回 403
    - 调用 `updateDisplayName()` 写库
    - 调用 `broadcast()` 向房间广播 `VIDEO_RENAMED`

#### 4. 房间路由
- [x] `CoWatch-backend/src/routes/rooms/index.ts`：
  - 注册 `router.patch('/:roomId/videos/:videoId/name', roomAuthMiddleware, (req, res) => RoomsController.renameVideo(req, res))`

#### 5. WS Server（仅注释说明，无需新增消息处理）
- [x] `CoWatch-backend/src/ws/wsServer.ts`：下行 `VIDEO_RENAMED` 消息由 HTTP 控制器 broadcast，WS Server 无需额外处理上行消息（无变更）

---

### 前端

#### 6. 类型定义
- [x] `CoWatch/src/types/room.ts`：
  - `VideoItem` 新增 `displayName?: string`
  - `WsMessageType` 新增 `'VIDEO_RENAMED'`
  - 新增 `VideoRenamedData` 接口 `{ videoId: string; displayName: string }`
- [x] `CoWatch/src/types/api.ts`：
  - `VideoItemResponse` 新增 `displayName?: string`

#### 7. API 层
- [x] `CoWatch/src/api/room.ts`：
  - 新增 `renameVideoApi(roomId: string, videoId: string, displayName: string): Promise<void>`，调用 `PATCH /api/rooms/:roomId/videos/:videoId/name`

#### 8. RoomContext
- [x] `CoWatch/src/context/RoomContext.tsx`：
  - `RoomContextValue` 新增 `renameVideo: (videoId: string, displayName: string) => void`
  - 实现 `renameVideo`：用 `setRoomState` 更新对应视频的 `displayName`
  - Context 默认值和 Provider value 同步补充

#### 9. WS Hook
- [x] `CoWatch/src/hooks/useRoomWs.ts`：
  - `UseRoomWsOptions` 新增 `onVideoRenamed?: (videoId: string, displayName: string) => void`
  - `case 'VIDEO_RENAMED'`：解析 `VideoRenamedData`，直接调用 `renameVideo` 更新 Context，同时触发 `stableOnVideoRenamed`

#### 10. Lobby 页
- [x] `CoWatch/src/pages/Lobby/index.tsx`：
  - 新增 `handleRenameVideo` 回调：调用 `renameVideoApi()`，改名者自身通过 WS 广播接收更新
  - `<VideoList>` 新增 props：`currentUserId`、`isAdmin`、`onRename`
  - HTTP 初始化视频列表时携带 `displayName`

#### 11. VideoList 组件
- [x] `CoWatch/src/pages/Lobby/VideoList.tsx`：
  - Props 新增 `currentUserId`、`isAdmin`、`onRename`
  - 内部 `useState` 管理 `editingId` / `inputValue`
  - 名称展示改为 `v.displayName ?? v.fileName`
  - 有权限用户 hover item 时显示铅笔图标，点击进入编辑态
  - 回车确认（非空时保存），Esc / 失焦取消
  - `onMouseDown preventDefault` 防止铅笔按钮 click 触发 input onBlur

#### 12. VideoList 样式
- [x] `CoWatch/src/pages/Lobby/VideoList.module.scss`：
  - 新增 `.nameRow` / `.editIcon` / `.nameInput` 样式

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
