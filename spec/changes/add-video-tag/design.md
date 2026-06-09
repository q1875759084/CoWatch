# 视频时间轴 Tag 技术设计

## 1. 功能概述

主控在复盘过程中可在视频时间轴上打 Tag，记录关键问题节点（如"3:47 问题a"）。点击 Tag 后全员跳转到该时间点并强制暂停，等待主控手动播放。Tag 持久化存储，刷新后保留，通过 WebSocket 实时同步给全员。

## 2. 涉及模块

| 端 | 模块 | 路径 |
|----|------|------|
| 后端 | 数据库 schema | `CoWatch-backend/src/database/schema.ts` |
| 后端 | Tag DB 层 | `CoWatch-backend/src/database/tag/index.ts`（新建） |
| 后端 | HTTP 接口 | `CoWatch-backend/src/controllers/rooms/index.ts` |
| 后端 | WS 服务 | `CoWatch-backend/src/ws/wsServer.ts` |
| 前端 | 类型定义 | `CoWatch/src/types/room.ts` |
| 前端 | API 层 | `CoWatch/src/api/room.ts` |
| 前端 | WS Hook | `CoWatch/src/hooks/useRoomWs.ts` |
| 前端 | VideoPlayer | `CoWatch/src/pages/Lobby/VideoPlayer.tsx` |
| 前端 | VideoTagBar（新建） | `CoWatch/src/pages/Lobby/VideoTagBar.tsx` |
| 前端 | Lobby 页 | `CoWatch/src/pages/Lobby/index.tsx` |

## 3. 页面设计

### VideoTagBar 组件（新建）

#### 功能描述

位于播放器下方、视频列表上方，包含两个区域：
1. **自定义时间轴**：一条横线，按视频时长比例定位 Tag 标记点，悬浮显示 label
2. **Tag 操作区**：「+ 新增 Tag」按钮 + Tag 列表（每条含时间、label、删除按钮）

#### 交互流程

**新增 Tag：**
- When 主控点击「+ 新增 Tag」，the system shall 在 Tag 列表末尾追加一行输入区（时间输入框预填当前播放时间，文本输入框为空）
- When 主控点击「确认」，the system shall 校验时间格式（`m:ss` 或 `mm:ss`）和 label 非空，通过后 WS 发送 `TAG_ADD`，服务端落库并广播全员
- When 主控点击输入行的「取消」，the system shall 移除该输入行，不触发网络请求

**删除 Tag：**
- When 主控点击某 Tag 的删除按钮，the system shall WS 发送 `TAG_DELETE`，服务端删库并广播全员

**点击 Tag 跳转：**
- When 任意成员（主控）点击时间轴或列表中的 Tag，the system shall（仅主控有效）WS 发送 `TAG_SEEK`，服务端广播 `SYNC_STATE { isPlaying: false, currentTime: tag.time }`，全员强制暂停跳转

**切换视频时：**
- When `activeVideoUrl` 变更，the system shall 清空当前 Tag 列表，重新拉取新视频对应的 Tag（通过 HTTP `GET /rooms/:roomId/tags?videoId=xxx`）

#### 组件结构

```
VideoTagBar
├── TagTimeline（时间轴横线 + tag 标记点）
│   └── TagMarker × n（悬浮tooltip显示label，点击跳转）
├── 「+ 新增 Tag」按钮（仅主控可见）
└── TagList
    ├── TagItem × n（时间 | label | 删除按钮）
    └── TagInputRow（新增中状态：时间输入框 + label输入框 + 确认 + 取消）
```

#### 状态管理

使用 `useState` 本地状态（tags 列表、是否显示输入行、输入行草稿值）。
tags 初始值来自：
1. `ROOM_STATE` WS 消息（进房间时服务端下发当前视频的 tags）
2. 切换视频时 HTTP 拉取

## 4. 接口设计

### GET /api/rooms/:roomId/tags

切换视频时前端主动拉取目标视频的 Tag 列表。

```typescript
// Query 参数
interface GetTagsQuery {
  videoId: string;
}

// 响应
interface GetTagsResponse {
  tags: Tag[];
}

interface Tag {
  id: string;
  videoId: string;
  roomId: string;
  time: number;       // 秒，浮点
  label: string;
  createdBy: string;  // userId
  createdAt: number;  // unix ms
}
```

### WebSocket 消息（新增）

#### TAG_ADD（上行：主控 → 服务端）
```typescript
interface TagAddData {
  id: string;       // 前端生成 uuid
  videoId: string;
  time: number;
  label: string;
}
```
服务端：校验主控身份 → 落库 → 广播 `TAG_ADDED` 给全员（含发送方）

#### TAG_ADDED（下行：服务端 → 全员广播）
```typescript
// data 与 Tag 结构一致
interface TagAddedData extends Tag {}
```

#### TAG_DELETE（上行：主控 → 服务端）
```typescript
interface TagDeleteData {
  id: string;
}
```
服务端：校验主控身份 → 删库 → 广播 `TAG_DELETED` 给全员

#### TAG_DELETED（下行：服务端 → 全员广播）
```typescript
interface TagDeletedData {
  id: string;
}
```

#### TAG_SEEK（上行：主控 → 服务端）
```typescript
interface TagSeekData {
  time: number;
}
```
服务端：校验主控身份 → 广播 `SYNC_STATE { isPlaying: false, currentTime: time }` 给**全员（含发送方）**

> 注意：TAG_SEEK 复用 `SYNC_STATE` 下行消息，无需新增下行消息类型。

#### ROOM_STATE 扩展
新增 `tags` 字段，下发当前激活视频的 Tag 列表：
```typescript
interface RoomStateData {
  // ...existing fields...
  tags?: Tag[];  // 当前 video_url 对应视频的 tag 列表
}
```

## 5. 类型定义

新增到 `CoWatch/src/types/room.ts`：

```typescript
export interface Tag {
  id: string;
  videoId: string;
  roomId: string;
  time: number;
  label: string;
  createdBy: string;
  createdAt: number;
}

// WsMessageType 新增
| 'TAG_ADD'
| 'TAG_ADDED'
| 'TAG_DELETE'
| 'TAG_DELETED'
| 'TAG_SEEK'

// WS data 类型
export interface TagAddData { id: string; videoId: string; time: number; label: string; }
export interface TagAddedData extends Tag {}
export interface TagDeleteData { id: string; }
export interface TagDeletedData { id: string; }
export interface TagSeekData { time: number; }
```

## 6. 权限控制

| 操作 | 权限 |
|------|------|
| 查看 tag（时间轴 + 列表） | 全员 |
| 新增 tag | 仅主控（`isController`），非主控不显示「+ 新增 Tag」和确认按钮 |
| 删除 tag | 仅主控，非主控不显示删除按钮 |
| 点击 tag 跳转 | 全员可点击，但 WS 只有主控发出的 TAG_SEEK 才被服务端处理 |

## 7. 数据模型

```sql
CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  video_id    TEXT NOT NULL,
  time        REAL NOT NULL,
  label       TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);
CREATE INDEX IF NOT EXISTS idx_tags_room_video ON tags (room_id, video_id);
```

## 8. 关键决策记录

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 存储方式 | SQLite 持久化 + WS 广播 | 刷新后保留，多人实时同步 |
| 跳转后播放状态 | 强制暂停 | 画面不连贯，给其他成员准备时间 |
| 增删权限 | 仅主控 | 复盘节奏由主控掌控 |
| 新增默认时间 | 当前播放时间（可修改） | 减少手动输入 |
| UI 位置 | 播放器下方独立区块 | 宽敞，tag 展示完整 |
| Tag 归属 | videoId + roomId 双绑 | 同一视频在不同房间 tag 独立 |
| TAG_SEEK 实现 | 复用 SYNC_STATE 下行消息 | 无需新增下行消息类型，逻辑与进度同步一致 |
| TAG_ADD/ADDED 分离 | 上行 TAG_ADD，下行 TAG_ADDED | 与 VIDEO_ADDED 等消息保持命名一致性 |
