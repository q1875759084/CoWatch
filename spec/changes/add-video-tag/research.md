# Research: 视频时间轴 Tag 功能

## 现有实现调研

### 视频同步机制
- 进度同步通过 `SYNC_PROGRESS` WS 消息广播，调用 `videoRef.current.syncSeek(time)`
- 播放状态同步通过 `SYNC_STATE`（含 `isPlaying` + `currentTime`）
- 切换视频通过 `SWITCH_VIDEO` 消息
- **Tag 跳转** 可复用 `SYNC_STATE` 消息（isPlaying=false，time=tag.time），主控 seek 后广播全员

### Tag 数据存储
- 当前无后端 tag 表，需新增
- Tag 与视频（videoId）关联，非房间级，避免切换视频后 tag 串位
- 需要字段：id, videoId, roomId, time（秒，浮点）, label（文本）, createdBy

### 时间轴组件
- 原生 `<video>` 带有浏览器默认控制栏，需要在播放器**下方**额外渲染一条自定义横轴
- 时间轴宽度对应视频总时长，Tag 位置 = `(tag.time / duration) * 100%`
- 视频 `duration` 需从 `onLoadedMetadata` 事件获取（`video.duration`）
- 目前 `VideoPlayer` 未暴露 `duration`，需要扩展 handle 或通过 props callback 传出

### 权限
- Tag 的增删：仅主控（isController）
- Tag 的跳转：主控点击，跳转后广播全员（与 SYNC_STATE 一致）

---

## 最终决策

| # | 问题 | 决策 | 备注 |
|---|------|------|------|
| 1 | Tag 数据存储在哪里？ | **后端 SQLite 持久化**，WS 广播增删 | 新增 `tags` 表，字段见下方 |
| 2 | Tag 跳转时播放状态？ | **强制暂停**，等主控手动点播放 | 跳转后画面不连贯，给其他7人准备时间 |
| 3 | 增删权限？ | **仅主控**可新增/删除 | `isController` 判断 |
| 4 | 新增时时间默认值？ | **自动填入当前播放时间**（可手动修改） | 调用 `videoRef.current.getCurrentTime()` |
| 5 | Tag 区域位置？ | **播放器下方、视频列表上方**，独立区块 | 含自定义时间轴 + tag 列表 |
| 6 | Tag 归属？ | **`videoId + roomId` 双重绑定** | 同一视频在不同房间有各自的 tag |

---

## 数据模型

### tags 表（新增）
```sql
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  video_id   TEXT NOT NULL,
  time       REAL NOT NULL,        -- 秒，浮点
  label      TEXT NOT NULL,
  created_by TEXT NOT NULL,        -- userId
  created_at INTEGER NOT NULL      -- unix ms
);
```

### WS 消息（新增）
| 消息类型 | 方向 | data 字段 |
|---------|------|----------|
| `TAG_ADD` | 主控 → 服务端 → 全员广播 | `{ id, videoId, time, label }` |
| `TAG_DELETE` | 主控 → 服务端 → 全员广播 | `{ id }` |
| `TAG_SEEK` | 主控 → 服务端 → 全员广播 | `{ time }`（复用 SYNC_STATE，isPlaying=false） |

`ROOM_STATE` 下发时附带当前视频的 tags 列表（`tags: Tag[]`）。

---

## 涉及改动文件

### 后端
- `src/database/schema.ts` — 新增 `tags` 表
- `src/database/tag/index.ts` — tag CRUD 操作（新建）
- `src/controllers/rooms/index.ts` — 新增 `GET /rooms/:roomId/tags?videoId=` 接口
- `src/ws/wsServer.ts` — 处理 `TAG_ADD` / `TAG_DELETE` / `TAG_SEEK` 消息，广播，更新 ROOM_STATE 下发逻辑

### 前端
- `src/types/room.ts` — 新增 `Tag` 类型、WS 消息类型
- `src/api/room.ts` — 新增 `getTagsApi`
- `src/hooks/useRoomWs.ts` — 新增 `onTagAdd` / `onTagDelete` 回调
- `src/pages/Lobby/VideoPlayer.tsx` — 新增 `onDurationChange` callback，暴露 `duration`
- `src/pages/Lobby/VideoTagBar.tsx` — 新建：自定义时间轴 + tag 列表区块
- `src/pages/Lobby/VideoTagBar.module.scss` — 新建：样式
- `src/pages/Lobby/index.tsx` — 引入 VideoTagBar，传入 tags 状态和操作回调
