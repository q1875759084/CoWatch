# CoWatch 游戏复盘网站 技术设计

## 1. 功能概述

CoWatch 是一个多人游戏录屏同步复盘平台，面向游戏团队复盘场景：房主创建房间并上传录屏视频，受邀成员通过分享链接免注册加入，所有成员实时同步观看同一视频，支持进度条主控权的管理与转移。

---

## 2. 涉及模块

| 模块 | 路径 | 说明 |
|------|------|------|
| 前端应用 | `frontend/` | React 19 + Webpack |
| 后端服务 | `backend/` | Node.js 20 + Express + ws + SQLite |

### 前端页面清单

| 页面 | 路由 | 说明 |
|------|------|------|
| 首页 | `/` | 创建房间 / 输入房间码加入 |
| 等待室 | `/room/:roomId/lobby` | 上传视频、查看成员列表、等待开始 |
| 复盘房间 | `/room/:roomId/watch` | 视频同步播放、控制权管理 |

---

## 3. 页面设计

### 3.1 首页（Home）

#### 功能描述
提供两个入口：创建新房间（输入昵称后生成房间）、加入已有房间（输入房间码 + 昵称）。

#### 交互流程
- When 用户点击「创建房间」并输入昵称后提交，the system shall 调用创建房间 API，生成房间，将创建者设为管理员，跳转至等待室。
- When 用户输入房间码和昵称后点击「加入」，the system shall 校验房间是否存在且未关闭，成功则加入房间并跳转等待室。
- When 房间码无效或房间已关闭，the system shall 展示错误提示，留在当前页面。

#### 组件结构
```
HomePage
├── CreateRoomForm        # 创建房间表单（昵称输入 + 提交）
└── JoinRoomForm          # 加入房间表单（房间码 + 昵称 + 提交）
```

#### 状态管理
本地 `useState` 管理表单状态；用户身份（userId、nickname、roomId、isAdmin）存入 `localStorage` + React Context（`UserContext`），全局共享。

---

### 3.2 等待室（Lobby）

#### 功能描述
房主在此上传视频到 OSS，等待成员加入；所有成员可看到当前在线人数；房主上传完成后点击「开始复盘」跳转播放房间。

#### 交互流程
- When 管理员进入等待室，the system shall 展示「上传视频」区域和「开始复盘」按钮（上传完成前禁用）。
- When 管理员选择视频文件并上传，the system shall 调用后端获取 OSS 预签名 URL，前端直传 OSS，上传完成后将视频 URL 保存到房间记录。
- When 管理员点击「开始复盘」，the system shall 通知所有 WebSocket 客户端跳转至 `/room/:roomId/watch`。
- When 普通成员进入等待室，the system shall 展示等待提示和当前成员列表，隐藏上传和开始按钮。
- When 有新成员加入/离开，the system shall 通过 WebSocket 实时更新成员列表。

#### 组件结构
```
LobbyPage
├── MemberList            # 在线成员列表（头像 + 昵称 + 管理员标识）
├── VideoUploader         # 视频上传组件（仅管理员可见）
│   └── UploadProgress    # 上传进度条
└── StartButton           # 开始复盘按钮（仅管理员可见，上传后可点击）
```

#### 状态管理
- 成员列表：WebSocket 消息驱动，存在 `useState`
- 上传状态：本地 `useState`（idle / uploading / done）
- 房间信息：`UserContext` 共享

---

### 3.3 复盘房间（WatchRoom）

#### 功能描述
核心页面。所有成员同步播放视频，支持两种控制模式的切换，进度条操作实时广播。

#### 交互流程

**视频同步**
- When 当前进度控制者拖动进度条或点击播放/暂停，the system shall 通过 WebSocket 广播 `SYNC_PROGRESS` / `SYNC_STATE` 事件，其余成员收到后强制同步播放器状态。
- When 新成员加入房间，the system shall 向其推送当前视频进度和播放状态，使其立即与房间同步。

**控制权 - 「管理员指定」模式（默认）**
- When 管理员点击某成员头像旁的「指定控制」，the system shall 广播 `TRANSFER_CONTROL` 事件，指定成员获得控制权，其余成员进度条禁用。
- When 当前控制者离开房间，the system shall 自动将控制权转移回管理员。

**控制权 - 「自由抢控」模式**
- When 管理员点击模式切换开关，the system shall 广播 `MODE_CHANGE` 事件，所有成员进度条变为可操作状态。
- When 任意成员操作进度条，the system shall 广播进度事件，其他成员同步（最后写入者生效）。

**管理员操作**
- When 管理员切换控制模式（指定 ↔ 自由），the system shall 更新房间模式并广播变更。

#### 组件结构
```
WatchRoomPage
├── VideoPlayer           # 核心播放器（基于 <video> 原生元素封装）
│   └── CustomControls    # 自定义控制栏（播放/暂停、进度条、时间、全屏）
├── ControlPanel          # 控制权面板
│   ├── ModeToggle        # 模式切换开关（仅管理员可见）
│   ├── CurrentController # 当前控制者显示
│   └── MemberList        # 成员列表（指定模式下管理员可点击指定）
└── StatusBar             # 状态栏（房间码、在线人数、控制模式标识）
```

#### 状态管理
使用 React Context（`RoomContext`）管理房间级状态，避免深层 props 传递：

```typescript
interface RoomState {
  roomId: string;
  videoUrl: string;
  members: Member[];
  controlMode: 'designated' | 'free';   // 控制模式
  controllerId: string;                  // 当前控制者 userId
  playbackState: {
    currentTime: number;
    isPlaying: boolean;
  };
}
```

本地播放器操作与 WebSocket 消息需做**防回环处理**：收到远端 SYNC 事件时，设置 `isSyncingRef = true` 再操作播放器，操作完成后重置，避免触发本地的 `timeupdate` 事件再次广播。

---

## 4. 接口设计

### 4.1 创建房间
- **方法**：POST
- **路径**：`/api/rooms`

```typescript
// 请求
interface CreateRoomRequest {
  nickname: string;       // 创建者昵称
}

// 响应
interface CreateRoomResponse {
  roomId: string;         // 6位房间码，如 "A3F9K2"
  userId: string;         // 创建者 userId（UUID）
  isAdmin: boolean;       // true
  inviteUrl: string;      // 完整邀请链接
}
```

### 4.2 加入房间
- **方法**：POST
- **路径**：`/api/rooms/:roomId/join`

```typescript
// 请求
interface JoinRoomRequest {
  nickname: string;
}

// 响应
interface JoinRoomResponse {
  userId: string;
  isAdmin: boolean;       // false
  roomId: string;
  videoUrl: string | null;  // 若已上传则返回
  status: 'waiting' | 'watching';
}
```

### 4.3 获取 OSS 预签名上传 URL
- **方法**：GET
- **路径**：`/api/rooms/:roomId/upload-url`
- **权限**：仅管理员可调用（通过 userId + roomId 校验）

```typescript
// Query 参数
interface UploadUrlQuery {
  userId: string;
  fileName: string;
  fileType: string;   // MIME type，如 "video/mp4"
}

// 响应
interface UploadUrlResponse {
  uploadUrl: string;  // OSS 预签名 PUT URL
  videoUrl: string;   // 上传完成后的访问 URL
}
```

### 4.4 确认视频上传完成
- **方法**：PUT
- **路径**：`/api/rooms/:roomId/video`
- **权限**：仅管理员

```typescript
// 请求
interface SetVideoRequest {
  userId: string;
  videoUrl: string;
}

// 响应
interface SetVideoResponse {
  success: boolean;
}
```

### 4.5 获取房间信息
- **方法**：GET
- **路径**：`/api/rooms/:roomId`

```typescript
// 响应
interface RoomInfoResponse {
  roomId: string;
  status: 'waiting' | 'watching' | 'closed';
  videoUrl: string | null;
  controlMode: 'designated' | 'free';
  controllerId: string | null;
  members: Array<{
    userId: string;
    nickname: string;
    isAdmin: boolean;
    isOnline: boolean;
  }>;
}
```

---

## 5. WebSocket 事件设计

WebSocket 连接地址：`ws://host/ws?roomId=xxx&userId=xxx`

### 客户端 → 服务端（上行）

| 事件类型 | 触发时机 | 数据 |
|---------|---------|------|
| `SYNC_PROGRESS` | 控制者拖动进度条（throttle 200ms） | `{ currentTime: number }` |
| `SYNC_STATE` | 控制者点击播放/暂停 | `{ isPlaying: boolean, currentTime: number }` |
| `TRANSFER_CONTROL` | 管理员指定某人控制 | `{ targetUserId: string }` |
| `MODE_CHANGE` | 管理员切换控制模式 | `{ mode: 'designated' \| 'free' }` |
| `START_WATCH` | 管理员点击开始复盘 | `{}` |

### 服务端 → 客户端（下行，广播给房间所有人）

| 事件类型 | 触发条件 | 数据 |
|---------|---------|------|
| `SYNC_PROGRESS` | 控制者进度变化 | `{ currentTime: number, fromUserId: string }` |
| `SYNC_STATE` | 控制者播放状态变化 | `{ isPlaying: boolean, currentTime: number }` |
| `CONTROL_CHANGED` | 控制权转移 | `{ controllerId: string, controllerNickname: string }` |
| `MODE_CHANGED` | 控制模式变更 | `{ mode: 'designated' \| 'free' }` |
| `MEMBER_JOINED` | 新成员加入 | `{ userId: string, nickname: string, isAdmin: boolean }` |
| `MEMBER_LEFT` | 成员离开 | `{ userId: string }` |
| `ROOM_STARTED` | 管理员开始复盘 | `{ videoUrl: string }` |
| `ROOM_STATE` | 新成员加入时单播当前状态 | `{ currentTime, isPlaying, controllerId, controlMode }` |

---

## 6. 数据库 Schema（SQLite）

```sql
-- 房间表
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,        -- 6位房间码
  status      TEXT DEFAULT 'waiting',  -- waiting / watching / closed
  video_url   TEXT,
  control_mode TEXT DEFAULT 'designated',
  controller_id TEXT,
  created_at  INTEGER,
  updated_at  INTEGER
);

-- 成员表
CREATE TABLE members (
  id          TEXT PRIMARY KEY,        -- UUID
  room_id     TEXT NOT NULL,
  nickname    TEXT NOT NULL,
  is_admin    INTEGER DEFAULT 0,       -- 0/1
  is_online   INTEGER DEFAULT 0,
  joined_at   INTEGER,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);
```

---

## 7. 类型定义

统一放在各自项目的 `src/types/` 目录下：

**前端** `frontend/src/types/room.ts`
```typescript
export type ControlMode = 'designated' | 'free';
export type RoomStatus = 'waiting' | 'watching' | 'closed';

export interface Member {
  userId: string;
  nickname: string;
  isAdmin: boolean;
  isOnline: boolean;
}

export interface RoomInfo {
  roomId: string;
  status: RoomStatus;
  videoUrl: string | null;
  controlMode: ControlMode;
  controllerId: string | null;
  members: Member[];
}
```

**后端** `backend/src/types/room.ts` — 同上结构，供服务端内部使用。

---

## 8. 关键决策记录

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 同步机制 | WebSocket 广播 | 低延迟，适合实时同步场景 |
| 视频存储 | OSS 预签名直传 | 服务器零带宽压力，各端直接从 CDN 拉流 |
| 控制权双模式 | 「管理员指定」为默认，可切换「自由抢控」 | 复盘场景通常需要有序讲解，自由模式作为灵活补充 |
| 身份方案 | 无注册，UUID + localStorage | 降低使用门槛，临时协作场景够用 |
| 防回环处理 | `isSyncingRef` flag | 收到远端 SYNC 时临时屏蔽本地 timeupdate 广播 |
| 进度同步节流 | throttle 200ms | 平衡同步实时性与 WebSocket 消息频率 |
| 数据库 | SQLite（better-sqlite3） | 零配置，独立部署友好，复盘场景并发量不高 |
