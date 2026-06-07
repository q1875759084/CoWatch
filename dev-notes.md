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

---

## 踩坑记录

### XHR 绕过 axios 拦截器导致上传 401

**现象：** 视频文件上传接口返回 401，getUploadUrl 接口却正常（200）。

**根因：** `VideoUploader` 使用原生 `XMLHttpRequest` 直接 PUT 文件到后端，完全绕过了 axios 请求拦截器，导致 `Authorization: Bearer <token>` 头没有被自动注入。

**解决：** 改用封装的 `request`（axios 实例）调用 `request.put(url, file, { onUploadProgress })`，进度回调用 `onUploadProgress` 替代 `xhr.upload.onprogress`，token 由拦截器自动注入，无感刷新也正常触发。

**补充：** OSS 预签名直传例外——OSS 通过 URL query 参数鉴权，加上自定义 `Authorization` 头反而会报错，这种场景继续用 XHR。

---

### Express 静态文件目录与 tsx 直接运行时 `__dirname` 不一致导致视频 404

**现象：** 视频上传成功（磁盘文件 4.2MB），但播放器显示 0:00 黑屏，`/uploads/...` 路由返回 404。

**根因：** `app.ts` 中写的是：
```ts
const uploadsDir = path.resolve(__dirname, '../../uploads');
```
这是按"编译后 `dist/src/app.js`"的层级写的。但开发环境用 `tsx src/app.ts` 直接运行，`__dirname` 指向 `src/`，`../../uploads` 解析到 `Desktop/uploads`（不存在）。

与此同时 controller 里写的是 `'../../../uploads'`，从 `src/controllers/rooms/` 上溯三层正好到项目根 `CoWatch-backend/uploads`，两者路径不一致。

**解决：** `app.ts` 改为：
```ts
const uploadsDir = path.resolve(__dirname, '../uploads');
```
从 `src/` 上溯一层即到项目根，与 controller 写文件路径对齐。

**规律：** 用 `tsx` 直接运行 TypeScript 时，`__dirname` 就是源文件所在目录；而 `tsc` 编译后运行时 `__dirname` 是 `dist/` 下对应的目录，相对层级不同，需要区分对待。
