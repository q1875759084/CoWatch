# 视频删除 实现任务

## 任务清单

---

### 后端

#### 1. Tag DB 层
- [ ] `CoWatch-backend/src/database/tag/index.ts`：
  - 新增 `deleteTagsByVideo(videoId: string): void`，批量删除该视频的所有 tags

#### 2. 视频 DB 层
- [ ] `CoWatch-backend/src/database/roomVideo/index.ts`：
  - 新增 `deleteRoomVideo(videoId: string): void`

#### 3. 房间 HTTP 控制器
- [ ] `CoWatch-backend/src/controllers/rooms/index.ts`：
  - 新增 `deleteVideo` 方法：
    - 查视频是否存在（`getRoomVideoById`），不存在返回 404
    - 权限校验：`uploaderId === userId || isAdmin`，否则 403
    - 调用 `deleteTagsByVideo(videoId)` 级联删 tags
    - 调用 `deleteRoomVideo(videoId)` 删视频记录
    - `broadcast` 广播 `VIDEO_DELETED { videoId }`
    - 返回 `success(res, { videoId })`

#### 4. 房间路由
- [ ] `CoWatch-backend/src/routes/rooms/index.ts`：
  - 注册 `router.delete('/:roomId/videos/:videoId', roomAuthMiddleware, (req, res) => RoomsController.deleteVideo(req, res))`

---

### 前端

#### 5. 类型定义
- [ ] `CoWatch/src/types/room.ts`：
  - `WsMessageType` 新增 `'VIDEO_DELETED'`
  - 新增 `VideoDeletedData` 接口 `{ videoId: string }`

#### 6. API 层
- [ ] `CoWatch/src/api/room.ts`：
  - 新增 `deleteVideoApi(roomId: string, videoId: string): Promise<void>`，调用 `DELETE /api/rooms/:roomId/videos/:videoId`

#### 7. RoomContext
- [ ] `CoWatch/src/context/RoomContext.tsx`：
  - `RoomContextValue` 新增 `removeVideo: (videoId: string) => void`
  - 实现 `removeVideo`：`setRoomState` 过滤掉对应视频
  - Context 默认值和 Provider value 同步补充

#### 8. WS Hook
- [ ] `CoWatch/src/hooks/useRoomWs.ts`：
  - import `VideoDeletedData`
  - 解构 `removeVideo` from `useRoom()`
  - `case 'VIDEO_DELETED'`：调用 `removeVideo(d.videoId)`，同时触发 `stableOnVideoDeleted`
  - `UseRoomWsOptions` 新增 `onVideoDeleted?: (videoId: string) => void`
  - 新增 `stableOnVideoDeleted`

#### 9. Lobby 页
- [ ] `CoWatch/src/pages/Lobby/index.tsx`：
  - 新增 `handleDeleteVideo` 回调：
    - 调用 `deleteVideoApi(roomId, videoId)`
    - HTTP 成功后由后端广播，无需本地额外处理
  - `useRoomWs` 新增 `onVideoDeleted` 回调：
    - 若 `videoId === activeVideoId`：调用 `videoRef.current?.pause()`（或直接 reset）、`setActiveObjectKey(null)`、`setActiveVideoId('')`、`setTags([])`、`setDuration(0)`
  - `<VideoList>` 新增 props：`onDelete={handleDeleteVideo}`

#### 10. VideoList 组件
- [ ] `CoWatch/src/pages/Lobby/VideoList.tsx`：
  - import `DeleteOutlined` from `@ant-design/icons`
  - import `Modal, Tooltip` from `antd`
  - Props 新增 `onDelete: (videoId: string) => void`
  - `.nameRow` 中铅笔图标后新增删除按钮：
    - 有权限（`canRename`）且 hover 时可见
    - 激活中（`isActive`）时按钮 `disabled`，外层包裹 `<Tooltip title="视频正在播放中，无法删除">`
    - 非激活点击后调用 `Modal.confirm`，确认后执行 `onDelete(v.id)`
    - `onMouseDown preventDefault` 防止触发 input onBlur（与铅笔图标一致）
  - confirm 弹窗内容：`确认删除《{v.displayName ?? v.fileName}》？此操作不可撤销，同时会删除该视频的所有标注`

#### 11. VideoList 样式
- [ ] `CoWatch/src/pages/Lobby/VideoList.module.scss`：
  - 新增 `.deleteIcon`：与 `.editIcon` 样式一致，hover 时 `color: #fc8181`（红色警示）

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
