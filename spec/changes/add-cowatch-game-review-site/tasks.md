# CoWatch 游戏复盘网站 实现任务

## 开发顺序说明

> 采用**前端优先 + Mock 驱动**策略：先完整实现前端，API 层和 WS Hook 内置 `USE_MOCK` 开关，Mock 模式下返回固定数据/模拟事件，无需后端即可调试全流程 UI。前端完成后再实现后端，按 design.md 接口格式对齐，关闭 Mock 开关即可联调。

## 任务清单

---

### 一、前端（frontend/）

#### 1. 项目初始化
- [ ] 初始化 `frontend/` 目录，创建 `package.json`（React 19、react-router-dom v6、webpack 5、babel、typescript 可选）
- [ ] 配置 `webpack.config.js`（开发 devServer 代理 `/api` 和 `/ws` 到后端）
- [ ] 创建 `frontend/src/` 目录结构：`pages/`、`components/`、`context/`、`hooks/`、`api/`、`types/`、`utils/`

#### 2. 类型定义
- [ ] 创建 `frontend/src/types/room.ts` — ControlMode、RoomStatus、Member、RoomInfo、WsMessage 等类型

#### 3. Context & 全局状态
- [ ] 创建 `frontend/src/context/UserContext.tsx` — 存储 userId、nickname、roomId、isAdmin，支持从 localStorage 恢复
- [ ] 创建 `frontend/src/context/RoomContext.tsx` — 存储 RoomState（members、controlMode、controllerId、playbackState、videoUrl）

#### 4. API 层
- [ ] 创建 `frontend/src/api/room.ts`
  - 顶部声明 `const USE_MOCK = true`，Mock 模式下所有函数返回固定假数据（不发真实请求）
  - `createRoom(nickname)` — POST `/api/rooms`
  - `joinRoom(roomId, nickname)` — POST `/api/rooms/:roomId/join`
  - `getRoomInfo(roomId)` — GET `/api/rooms/:roomId`
  - `getUploadUrl(roomId, userId, fileName, fileType)` — GET `/api/rooms/:roomId/upload-url`
  - `confirmVideoUpload(roomId, userId, videoUrl)` — PUT `/api/rooms/:roomId/video`

#### 5. WebSocket Hook
- [ ] 创建 `frontend/src/hooks/useRoomWs.ts` — 封装 WebSocket 连接管理
  - 顶部读取 `USE_MOCK` 开关，Mock 模式下用 `setTimeout` 模拟服务端推送事件（如延迟 500ms 推送 ROOM_STATE）
  - 自动连接/重连
  - 消息收发：`sendMessage(type, data)` 方法
  - 分发各类下行事件到 RoomContext（SYNC_PROGRESS、CONTROL_CHANGED、MODE_CHANGED、MEMBER_JOINED、MEMBER_LEFT、ROOM_STARTED、ROOM_STATE）
  - 防回环标记：`isSyncingRef`，收到远端 SYNC 时置 true，同步完成后重置

#### 6. 工具函数
- [ ] 创建 `frontend/src/utils/throttle.ts` — 简单 throttle 实现（用于进度条广播节流 200ms）
- [ ] 创建 `frontend/src/utils/storage.ts` — localStorage 读写封装（userId、nickname、roomId、isAdmin）

#### 7. 公共组件
- [ ] 创建 `frontend/src/components/MemberList.tsx` — 成员列表（头像首字母、昵称、管理员标识、在线状态）
- [ ] 创建 `frontend/src/components/LoadingSpinner.tsx` — 加载状态组件

#### 8. 首页（HomePage）
- [ ] 创建 `frontend/src/pages/Home/index.tsx`
  - 布局：左侧创建房间、右侧加入房间（或上下排列）
  - 关键逻辑：调用 createRoom / joinRoom API，成功后写 UserContext + localStorage，跳转等待室
- [ ] 创建 `frontend/src/pages/Home/CreateRoomForm.tsx`
  - 昵称输入框 + 「创建房间」按钮
  - 加载态、错误提示处理
- [ ] 创建 `frontend/src/pages/Home/JoinRoomForm.tsx`
  - 房间码输入框 + 昵称输入框 + 「加入房间」按钮
  - 加载态、房间不存在错误提示

#### 9. 等待室（LobbyPage）
- [ ] 创建 `frontend/src/pages/Lobby/index.tsx`
  - 初始化 WS 连接（useRoomWs）
  - 监听 `MEMBER_JOINED` / `MEMBER_LEFT` 更新成员列表
  - 监听 `ROOM_STARTED` 事件，跳转 `/room/:roomId/watch`
  - 非管理员展示等待提示
- [ ] 创建 `frontend/src/pages/Lobby/VideoUploader.tsx`（仅管理员可见）
  - 文件选择（accept="video/*"）
  - 调用 getUploadUrl → 直传 OSS（XMLHttpRequest PUT）→ 调用 confirmVideoUpload
  - 展示上传进度（progress 事件）
  - 状态：idle / uploading / done / error
- [ ] 创建 `frontend/src/pages/Lobby/StartButton.tsx`（仅管理员可见）
  - 上传完成前禁用
  - 点击发送 `START_WATCH` WS 消息

#### 10. 复盘房间（WatchRoomPage）

- [ ] 创建 `frontend/src/pages/WatchRoom/index.tsx`
  - 初始化/恢复 WS 连接
  - 从 RoomContext 读取 videoUrl、controllerId、controlMode
  - 布局：左侧视频播放器（主体）+ 右侧控制面板

- [ ] 创建 `frontend/src/pages/WatchRoom/VideoPlayer.tsx` — 核心组件
  - 基于原生 `<video>` 元素封装
  - 自定义控制栏（CustomControls）：播放/暂停、进度条、当前时间/总时长、全屏
  - **发送逻辑**：当前用户为控制者时，进度条拖动（throttle 200ms）发 `SYNC_PROGRESS`，播放/暂停发 `SYNC_STATE`
  - **接收逻辑**：收到 `SYNC_PROGRESS` / `SYNC_STATE` 时，通过 `isSyncingRef` 防回环，强制同步播放器状态
  - 非控制者进度条设为 `disabled`（pointer-events: none）

- [ ] 创建 `frontend/src/pages/WatchRoom/CustomControls.tsx`
  - 播放/暂停按钮
  - 进度条（`<input type="range">`）
  - 时间显示（当前时间 / 总时长）
  - 全屏按钮
  - 接收 `disabled` prop 控制是否可操作

- [ ] 创建 `frontend/src/pages/WatchRoom/ControlPanel.tsx`
  - 展示当前控制者昵称
  - `ModeToggle`：仅管理员可见，切换 designated ↔ free，发送 `MODE_CHANGE` WS 消息
  - 成员列表：designated 模式下，管理员可点击成员发送 `TRANSFER_CONTROL`；free 模式下仅展示列表

- [ ] 创建 `frontend/src/pages/WatchRoom/StatusBar.tsx`
  - 展示：房间码、在线人数、当前控制模式标识

#### 11. 路由配置
- [ ] 创建 `frontend/src/router/index.tsx`
  - `/` → HomePage
  - `/room/:roomId/lobby` → LobbyPage（需校验 UserContext 存在，否则重定向首页）
  - `/room/:roomId/watch` → WatchRoomPage（同上）
- [ ] 创建 `frontend/src/App.tsx` — 挂载 Router + Context Provider

#### 12. 入口文件
- [ ] 创建 `frontend/src/index.tsx` — ReactDOM.createRoot 挂载
- [ ] 创建 `frontend/public/index.html` — HTML 模板

---

### 二、后端（backend/）

> 前端 Mock 阶段完成后再实现，严格按 design.md 接口格式实现，完成后关闭前端 `USE_MOCK` 开关即可联调。

#### 1. 项目初始化
- [ ] 初始化 `backend/` 目录，创建 `package.json`（Node.js 20，依赖：express、ws、better-sqlite3、uuid、multer、dotenv、cors）
- [ ] 创建 `backend/src/` 目录结构：`routes/`、`services/`、`types/`、`db/`、`ws/`
- [ ] 创建 `backend/.env.example`（OSS 配置：OSS_REGION、OSS_BUCKET、OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET）

#### 2. 数据库
- [ ] 创建 `backend/src/db/index.js` — 初始化 SQLite 连接（better-sqlite3）
- [ ] 创建 `backend/src/db/schema.js` — 执行建表 SQL（rooms 表 + members 表）
- [ ] 创建 `backend/src/db/roomDao.js` — 房间 CRUD 操作（createRoom、getRoomById、updateRoom、setVideoUrl、setControlMode、setControllerId）
- [ ] 创建 `backend/src/db/memberDao.js` — 成员 CRUD 操作（addMember、getMembersByRoom、getMember、setOnline）

#### 3. 类型定义
- [ ] 创建 `backend/src/types/room.js` — JSDoc 类型注释（ControlMode、RoomStatus、Member、RoomInfo）

#### 4. REST API 路由
- [ ] 创建 `backend/src/routes/rooms.js`
  - `POST /api/rooms` — 创建房间（生成 6 位房间码、创建者设为管理员、写 DB）
  - `POST /api/rooms/:roomId/join` — 加入房间（校验房间状态、写成员记录）
  - `GET  /api/rooms/:roomId` — 获取房间信息（含成员列表）
  - `GET  /api/rooms/:roomId/upload-url` — 获取 OSS 预签名上传 URL（校验管理员权限）
  - `PUT  /api/rooms/:roomId/video` — 确认视频上传完成（写 videoUrl 到 DB、WS 广播通知）

#### 5. OSS 服务
- [ ] 创建 `backend/src/services/ossService.js` — 封装阿里云 OSS SDK，生成预签名 PUT URL 和访问 URL

#### 6. WebSocket 服务
- [ ] 创建 `backend/src/ws/wsServer.js` — 核心 WS 服务
  - 连接鉴权：从 query 参数读取 roomId、userId，校验合法性
  - 房间连接池管理：`Map<roomId, Set<WebSocket>>`
  - 成员上线/下线处理：更新 DB isOnline，广播 `MEMBER_JOINED` / `MEMBER_LEFT`
  - 新成员加入时单播 `ROOM_STATE`（当前 currentTime、isPlaying、controllerId、controlMode）
  - 消息路由：根据 type 分发处理各事件
- [ ] 实现 `SYNC_PROGRESS` 处理 — 校验发送者是否为当前控制者（自由模式下跳过校验），广播给房间其他人
- [ ] 实现 `SYNC_STATE` 处理 — 同上，同步播放/暂停状态
- [ ] 实现 `TRANSFER_CONTROL` 处理 — 校验发送者为管理员，更新 DB controllerId，广播 `CONTROL_CHANGED`
- [ ] 实现 `MODE_CHANGE` 处理 — 校验发送者为管理员，更新 DB controlMode，广播 `MODE_CHANGED`
- [ ] 实现 `START_WATCH` 处理 — 校验发送者为管理员，更新房间 status 为 watching，广播 `ROOM_STARTED`

#### 7. 入口文件
- [ ] 创建 `backend/src/app.js` — 组装 Express 中间件（cors、json 解析）、挂载路由
- [ ] 创建 `backend/src/server.js` — 启动 HTTP Server + WebSocket Server，监听端口

---

### 三、联调验证

- [ ] 启动后端服务（`node src/server.js`），验证 REST API 可访问
- [ ] 启动前端开发服务器（`webpack serve`），验证代理配置正常
- [ ] 端到端测试：两个浏览器窗口分别创建/加入房间，验证视频同步、控制权转移、模式切换全流程

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
