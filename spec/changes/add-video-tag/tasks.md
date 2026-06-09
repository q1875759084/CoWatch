# 视频时间轴 Tag 实现任务

## 任务清单

### 后端

#### 1. 数据库
- [ ] `CoWatch-backend/src/database/schema.ts` — 新增 `tags` 表 + 索引
- [ ] `CoWatch-backend/src/database/tag/index.ts`（新建）— 实现以下函数：
  - `addTag(id, roomId, videoId, time, label, createdBy): TagRow`
  - `deleteTag(id): void`
  - `getTagsByRoomVideo(roomId, videoId): TagRow[]`

#### 2. HTTP 接口
- [ ] `CoWatch-backend/src/controllers/rooms/index.ts` — 新增 `listTags` 方法：
  - `GET /api/rooms/:roomId/tags?videoId=xxx`
  - 需鉴权（authMiddleware），校验 roomId 存在，返回 tag 列表
- [ ] `CoWatch-backend/src/routes/rooms/index.ts` — 注册路由

#### 3. WS 服务
- [ ] `CoWatch-backend/src/ws/wsServer.ts`：
  - 处理 `TAG_ADD`：校验主控 → `addTag` 落库 → `broadcast TAG_ADDED`
  - 处理 `TAG_DELETE`：校验主控 → `deleteTag` 删库 → `broadcast TAG_DELETED`
  - 处理 `TAG_SEEK`：校验主控 → `broadcast SYNC_STATE { isPlaying: false, currentTime }`（广播含发送方）
  - `ROOM_STATE` 下发时附带 `tags`：按当前 `video_url` 对应 videoId 查询 tags

---

### 前端

#### 4. 类型定义
- [ ] `CoWatch/src/types/room.ts`：
  - 新增 `Tag` interface
  - `WsMessageType` 新增 `TAG_ADD` / `TAG_ADDED` / `TAG_DELETE` / `TAG_DELETED` / `TAG_SEEK`
  - 新增 WS data 类型：`TagAddData` / `TagAddedData` / `TagDeleteData` / `TagDeletedData` / `TagSeekData`
  - `RoomStateData` 新增 `tags?: Tag[]`

#### 5. API 层
- [ ] `CoWatch/src/api/room.ts` — 新增 `getTagsApi(roomId, videoId): Promise<Tag[]>`

#### 6. WS Hook
- [ ] `CoWatch/src/hooks/useRoomWs.ts`：
  - `UseRoomWsOptions` 新增 `onTagAdded` / `onTagDeleted` 回调
  - `ws.onmessage` switch 中处理 `TAG_ADDED` / `TAG_DELETED`

#### 7. VideoPlayer
- [ ] `CoWatch/src/pages/Lobby/VideoPlayer.tsx`：
  - `VideoPlayerProps` 新增 `onDurationChange?: (duration: number) => void`
  - `<video>` 绑定 `onLoadedMetadata` 事件，触发时调用 `onDurationChange(video.duration)`

#### 8. VideoTagBar 组件（新建）
- [ ] `CoWatch/src/pages/Lobby/VideoTagBar.tsx`：
  - Props：`tags / duration / isController / onAdd / onDelete / onSeek`
  - 时间轴区域：横线 + tag 标记点（按 `time/duration*100%` 定位），hover 显示 label tooltip，点击调用 `onSeek`
  - 「+ 新增 Tag」按钮：仅 `isController` 时显示
  - 输入行：时间输入框（预填格式 `m:ss`）+ label 输入框 + 确认/取消
  - 时间格式工具函数：`formatTime(sec): string`（`m:ss`）、`parseTime(str): number | null`（解析 `m:ss` / `mm:ss`）
  - Tag 列表：每条显示时间 + label，主控可见删除按钮，点击整行 `onSeek`
- [ ] `CoWatch/src/pages/Lobby/VideoTagBar.module.scss`（新建）— 样式

#### 9. Lobby 页接入
- [ ] `CoWatch/src/pages/Lobby/index.tsx`：
  - 新增 `tags` state（`useState<Tag[]>`）
  - 新增 `duration` state（`useState<number>`，从 VideoPlayer `onDurationChange` 获取）
  - 初始化时通过 `ROOM_STATE` 的 `tags` 字段设置初始 tag 列表
  - 切换视频时（`activeVideoUrl` 变更）调用 `getTagsApi` 重新拉取 tags，同时重置 duration
  - WS 回调：`onTagAdded` 追加 tag，`onTagDeleted` 过滤删除
  - 处理函数：
    - `handleTagAdd(time, label)` → 生成 uuid → `sendMessage('TAG_ADD', ...)`
    - `handleTagDelete(id)` → `sendMessage('TAG_DELETE', { id })`
    - `handleTagSeek(time)` → `sendMessage('TAG_SEEK', { time })`
  - 在播放器和视频列表之间插入 `<VideoTagBar>` 组件（仅 `activeVideoUrl` 存在时渲染）

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
