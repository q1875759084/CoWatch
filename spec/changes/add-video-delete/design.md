# 视频删除 技术设计

## 1. 功能概述

允许视频上传者或房间管理员删除视频列表中的视频，删除时级联清除该视频的所有 tag，并通过 WebSocket 实时广播给房间内全员同步移除。激活中的视频（`objectKey === activeObjectKey`）前端禁止删除操作，后端不校验激活状态。

---

## 2. 涉及模块

| 端 | 模块 | 路径 | 变更说明 |
|----|------|------|---------|
| 后端 | Tag DB 层 | `CoWatch-backend/src/database/tag/index.ts` | 新增 `deleteTagsByVideo(videoId)` |
| 后端 | 视频 DB 层 | `CoWatch-backend/src/database/roomVideo/index.ts` | 新增 `deleteRoomVideo(videoId)` |
| 后端 | 房间 HTTP 控制器 | `CoWatch-backend/src/controllers/rooms/index.ts` | 新增 `deleteVideo`：权限校验 → 级联删 tags → 删视频 → broadcast |
| 后端 | 房间路由 | `CoWatch-backend/src/routes/rooms/index.ts` | 注册 `DELETE /:roomId/videos/:videoId` |
| 前端 | 类型定义 | `CoWatch/src/types/room.ts` | `WsMessageType` 新增 `'VIDEO_DELETED'`；新增 `VideoDeletedData` |
| 前端 | API 层 | `CoWatch/src/api/room.ts` | 新增 `deleteVideoApi()` |
| 前端 | RoomContext | `CoWatch/src/context/RoomContext.tsx` | 新增 `removeVideo(videoId)` action |
| 前端 | WS Hook | `CoWatch/src/hooks/useRoomWs.ts` | 处理下行 `VIDEO_DELETED`，调用 `removeVideo` 更新 Context |
| 前端 | Lobby 页 | `CoWatch/src/pages/Lobby/index.tsx` | 新增 `handleDeleteVideo`；删除激活视频时清空播放状态；传 `onDelete` 给 VideoList |
| 前端 | VideoList 组件 | `CoWatch/src/pages/Lobby/VideoList.tsx` | 新增删除按钮，激活中禁用 + Tooltip 提示 |
| 前端 | VideoList 样式 | `CoWatch/src/pages/Lobby/VideoList.module.scss` | 删除按钮样式 |

---

## 3. 页面设计

### VideoList 组件（迭代）

#### 功能描述

视频列表每个 item 的操作区新增删除按钮（🗑 `DeleteOutlined`），与改名铅笔图标行为一致：
- hover item 时出现，仅有权限的用户可见（上传者 / 管理员）
- 激活中的视频（`v.objectKey === activeObjectKey`）按钮 disabled，hover 显示 Tooltip「视频正在播放中，无法删除」

#### 交互流程

- When 有权限的用户 hover 视频 item，the system shall 在名称右侧显示铅笔图标和删除图标
- When 激活中视频的删除按钮被 hover，the system shall 展示 Tooltip「视频正在播放中，无法删除」，按钮不可点击
- When 用户点击删除按钮（非激活视频），the system shall 弹出 `Modal.confirm` 确认弹窗「确认删除《{视频名}》？此操作不可撤销，同时会删除该视频的所有标注」
- When 用户确认删除，the system shall 调用 `onDelete(videoId)`，由 Lobby 负责调用 API
- When 删除成功，the system shall 后端广播 `VIDEO_DELETED`，全员 VideoList 移除该条目

#### 组件结构

```
VideoList
└── VideoItem × n
    ├── .itemLeft
    │   ├── 序号
    │   └── .itemInfo
    │       ├── .nameRow（展示态）
    │       │   ├── 视频名称（displayName ?? fileName）
    │       │   ├── 铅笔图标（EditOutlined，有权限 + hover 可见）
    │       │   └── 删除图标（DeleteOutlined，有权限 + hover 可见；激活中 disabled）
    │       ├── .nameInput（编辑态）
    │       └── 上传时间
    └── 播放按钮（仅主控可见）
```

#### 状态管理

删除无本地状态，点击后直接调用 `onDelete` 回调，由 Lobby 处理异步请求。确认弹窗使用 `Modal.confirm`（antd 命令式 API，无需额外 state）。

---

## 4. 接口设计

### DELETE /api/rooms/:roomId/videos/:videoId

删除视频及其所有 tags。

- **方法**：DELETE
- **路径**：`/api/rooms/:roomId/videos/:videoId`
- **权限**：已登录 + 房间成员 + （上传者 或 管理员）

```typescript
// 无请求体

// 响应
interface DeleteVideoResponse {
  videoId: string;
}
```

**错误码**：
- `403`：非上传者且非管理员
- `404`：视频不存在

---

## 5. WebSocket 消息设计

### 下行：VIDEO_DELETED（后端 → 全员）

HTTP DELETE 成功后，后端向房间广播：

```typescript
interface VideoDeletedData {
  videoId: string;
}
```

前端收到后：
1. `removeVideo(videoId)` 从 Context 移除视频
2. 若 `videoId === activeVideoId`（删除的是激活视频）：清空播放器、重置 `activeObjectKey`、清空 tags、重置 `activeVideoId`

---

## 6. 类型定义

```typescript
// src/types/room.ts

type WsMessageType =
  | /* 现有类型 */
  | 'VIDEO_DELETED';  // 新增

interface VideoDeletedData {
  videoId: string;
}
```

---

## 7. 关键决策记录

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 删除权限 | 上传者 + 管理员（与改名一致） | 统一权限模型 |
| 级联删除 | 同时删除该视频所有 tags | 避免孤儿数据 |
| 激活中拦截 | 仅前端禁用，后端不校验 | 攻击成本高收益低，成员刷新即恢复 |
| 同步方式 | HTTP DELETE + 后端 broadcast | 权限校验更严格，逻辑统一 |
| 确认交互 | `Modal.confirm` 弹窗确认 | 删除不可逆，需防误触 |
| WS 收到删除激活视频 | 清空播放器 + activeObjectKey + tags | 视频不存在，继续播放必然报错 |
