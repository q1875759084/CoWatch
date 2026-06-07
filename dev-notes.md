# CoWatch 开发笔记

## 架构决策

### 多人视频同步方案选型

**背景：** 需要多个浏览器客户端实时同步视频播放进度。

**结论：** 选用 WebSocket（服务端广播进度事件给所有房间成员）。

**为什么不用 WebRTC DataChannel：** P2P 方案需要信令服务器，多人场景（>2人）网状连接复杂度高，维护成本大。

**为什么不用轮询：** 每隔 N 秒拉取进度会有明显延迟，进度条抖动体验差，且服务器压力随人数线性增长。

---

### 视频存储选 OSS 预签名直传

**背景：** 房主需要上传录屏视频供所有成员播放。

**结论：** 前端直传 OSS（阿里云），服务端只负责生成预签名 PUT URL 和保存访问 URL，不经手视频流。

**原因：** 服务器零带宽压力，所有成员直接从 CDN 拉流，播放流畅；服务端只同步进度控制事件，职责清晰。

---

## 工具与概念

### 前端优先 + Mock 驱动开发策略

**背景：** 前后端分离项目，开发者更熟悉前端，希望先调试 UI 流程而不依赖后端服务。

**方案：**
1. API 层（`api/room.ts`）顶部声明 `const USE_MOCK = true`，Mock 模式下所有函数返回固定假数据，不发真实请求
2. WebSocket Hook（`useRoomWs.ts`）Mock 模式下用 `setTimeout` 模拟服务端推送事件（如延迟 500ms 推 `ROOM_STATE`）
3. 后端完成后，将 `USE_MOCK` 改为 `false` 即可切换到真实联调，前端代码几乎无需改动

**优点：** 前端可独立完整调试所有页面和交互流程；Mock 数据格式与真实接口保持一致，联调返工少。

---

### WebSocket 视频同步防回环处理

**背景：** 视频播放器的 `timeupdate` 事件会在 `currentTime` 被赋值时触发，导致收到远端 SYNC 消息 → 同步播放器 → 触发 `timeupdate` → 再次广播的无限循环。

**解决：** 在 VideoPlayer 组件中维护 `isSyncingRef = useRef(false)`：
- 收到远端 `SYNC_PROGRESS` / `SYNC_STATE` 事件时，先将 `isSyncingRef.current = true`
- 执行 `video.currentTime = ...` 等同步操作
- 在下一个 microtask（`Promise.resolve().then(...)`）中重置为 `false`
- `timeupdate` 回调中检查 `isSyncingRef.current`，为 `true` 时跳过广播

**注意：** 进度条广播还需加 throttle 200ms，避免拖动时消息过于密集。
