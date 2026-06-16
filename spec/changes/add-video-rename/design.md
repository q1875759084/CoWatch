# 视频改名 技术设计

## 1. 功能概述

允许视频上传者或房间管理员为视频设置自定义显示名称（`displayName`），改名后通过 WebSocket 实时广播给房间内全员，帮助成员在复盘时快速识别视频内容。

---

## 2. 涉及模块

| 端 | 模块 | 路径 | 变更说明 |
|----|------|------|---------|
| 后端 | 数据库 Schema | `CoWatch-backend/src/database/schema.ts` | `room_videos` 新增 `display_name TEXT` 列 + 迁移 |
| 后端 | 视频 DB 层 | `CoWatch-backend/src/database/roomVideo/index.ts` | 新增 `updateDisplayName()`；`RoomVideoRow` 补字段 |
| 后端 | 房间 HTTP 控制器 | `CoWatch-backend/src/controllers/rooms/index.ts` | 新增 `renameVideo`；`listVideos` 返回 `displayName` |
| 后端 | 房间路由 | `CoWatch-backend/src/routes/rooms/index.ts` | 注册 `PATCH /:roomId/videos/:videoId/name` |
| 后端 | WS Server | `CoWatch-backend/src/ws/wsServer.ts` | 处理上行 `VIDEO_RENAME`，广播下行 `VIDEO_RENAMED` |
| 前端 | 类型定义 | `CoWatch/src/types/room.ts` | `VideoItem` 新增 `displayName?`；`WsMessageType` 新增两条 |
| 前端 | API 类型 | `CoWatch/src/types/api.ts` | `VideoItemResponse` 新增 `displayName?` |
| 前端 | API 层 | `CoWatch/src/api/room.ts` | 新增 `renameVideoApi()` |
| 前端 | WS Hook | `CoWatch/src/hooks/useRoomWs.ts` | 处理下行 `VIDEO_RENAMED` 回调 |
| 前端 | RoomContext | `CoWatch/src/context/RoomContext.tsx` | 新增 `renameVideo(videoId, displayName)` action |
| 前端 | VideoList 组件 | `CoWatch/src/pages/Lobby/VideoList.tsx` | 展示名称、hover 铅笔图标、inline 改名交互 |
| 前端 | VideoList 样式 | `CoWatch/src/pages/Lobby/VideoList.module.scss` | 铅笔图标 + 输入框样式 |
| 前端 | Lobby 页 | `CoWatch/src/pages/Lobby/index.tsx` | 传 `onRename` / `currentUserId` / `isAdmin`；处理 WS 回调 |

---

## 3. 页面设计

### VideoList 组件（迭代）

#### 功能描述

视频列表中每个 item 支持：
- 展示 `displayName ?? fileName` 作为视频名称
- hover 整个 item 时，名称右侧出现铅笔图标（✏️），仅有权限的用户（上传者 / 管理员）可见
- 点击铅笔图标，名称区域变为 inline 输入框
- 回车保存，Esc / 失焦取消

#### 交互流程

- When 有权限的用户 hover 视频 item，the system shall 在名称右侧显示铅笔图标
- When 用户点击铅笔图标，the system shall 将名称区域替换为 `<input>`，预填当前展示名（`displayName ?? fileName`），并自动聚焦全选
- When 用户按下回车，the system shall 若输入非空则调用 `renameVideoApi()` 并通过 WS 广播；若输入为空则取消（不保存）
- When 用户按下 Esc 或 input 失焦，the system shall 取消编辑，恢复原名称显示
- When 播放按钮点击，the system shall 触发 `onPlay(objectKey, videoId)`（item 整体点击不再触发播放）

#### 组件结构

```
VideoList
└── VideoItem × n
    ├── .itemLeft
    │   ├── 序号
    │   └── .itemInfo
    │       ├── .nameRow（展示态）
    │       │   ├── 视频名称（displayName ?? fileName）
    │       │   └── 铅笔图标（hover item 时可见，仅有权限用户）
    │       ├── .nameInput（编辑态，替换 .nameRow）
    │       └── 上传时间
    └── 播放按钮（仅主控可见）
```

#### 状态管理

`VideoList` 接收新 props：
- `currentUserId: string` — 用于判断当前用户是否为上传者
- `isAdmin: boolean` — 用于判断是否为管理员
- `onRename: (videoId: string, displayName: string) => void` — 改名回调，由 Lobby 处理网络请求

VideoItem 内部用 `useState` 管理：
- `editingId: string | null` — 当前正在编辑的视频 id（同时只能编辑一个）
- `inputValue: string` — 输入框草稿值

---

## 4. 接口设计

### PATCH /api/rooms/:roomId/videos/:videoId/name

更新视频的自定义显示名称。

- **方法**：PATCH
- **路径**：`/api/rooms/:roomId/videos/:videoId/name`
- **权限**：已登录 + 房间成员（后端校验：上传者 或 房间管理员）

```typescript
// 请求体
interface RenameVideoRequest {
  displayName: string;  // 最长 50 字符，不可为纯空白
}

// 响应
interface RenameVideoResponse {
  videoId: string;
  displayName: string;
}
```

**错误码**：
- `400`：`displayName` 为空或超长
- `403`：非上传者且非管理员
- `404`：视频不存在

---

## 5. WebSocket 消息设计

### 上行：VIDEO_RENAME（前端 → 后端）

```typescript
// HTTP PATCH 成功后，后端内部广播；前端不直接发此消息
// 实际方案：前端调 HTTP，后端完成写库后向房间广播 VIDEO_RENAMED
```

> **方案选择**：走 HTTP + 后端广播（而非纯 WS），原因：
> 1. 改名需要权限校验和持久化，HTTP 更合适
> 2. 后端 PATCH 成功后直接 broadcast，逻辑简洁，无需前端发 WS 消息

### 下行：VIDEO_RENAMED（后端 → 全员）

```typescript
interface VideoRenamedData {
  videoId: string;
  displayName: string;
}
```

---

## 6. 类型定义

### 前端新增 / 修改

```typescript
// src/types/room.ts
interface VideoItem {
  // ... 现有字段 ...
  displayName?: string;  // 新增：用户自定义展示名，null/undefined 时 fallback 到 fileName
}

type WsMessageType =
  | /* 现有类型 */
  | 'VIDEO_RENAMED';  // 新增下行消息类型

// 新增 data 类型
interface VideoRenamedData {
  videoId: string;
  displayName: string;
}
```

```typescript
// src/types/api.ts
interface VideoItemResponse {
  // ... 现有字段 ...
  displayName?: string;  // 新增
}
```

---

## 7. 关键决策记录

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 改名权限 | 上传者 + 房间管理员 | 灵活管理，管理员可纠正不规范命名 |
| 交互入口 | hover item → 铅笔图标 → inline 编辑 | 不占空间，符合直觉 |
| 同步方式 | HTTP 写库 + 后端 broadcast WS | 权限校验更严格，逻辑更简洁 |
| 空值 fallback | `displayName ?? fileName`（保留扩展名） | 实现最简，旧数据无需迁移 |
| 确认方式 | 回车确认，Esc / 失焦取消 | 符合 inline 编辑惯例 |
| 播放触发 | 仅播放按钮触发，item 整体不响应点击 | 避免与铅笔图标 / 输入框交互冲突 |
