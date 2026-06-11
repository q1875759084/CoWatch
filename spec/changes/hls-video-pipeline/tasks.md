# HLS 视频切片流水线 实现任务

change-id: `hls-video-pipeline`

---

## 任务清单

### 一、后端基础层

#### 1. 数据库 Schema 迁移
- [x] `src/database/schema.ts`：`room_videos` 表新增 `hls_prefix TEXT` 和 `hls_status TEXT DEFAULT 'pending'`
- [x] `src/database/roomVideo/index.ts`：新增 `updateHlsStatus(videoId, prefix, status)` 函数；`getVideoById(videoId)` 函数（hlsService 查询用）

#### 2. ossService 新增片段上传
- [x] `src/services/ossService.ts`：新增 `uploadHlsSegment(objectKey, filePath)` —— 将本地 .ts 文件上传到 COS 并返回 objectKey
- [x] `src/services/ossService.ts`：新增 `getHlsSegmentSignedUrl(objectKey, expireSeconds = 2 * 3600)` —— 生成 2h 有效期的 CDN TypeA 签名 URL（复用现有 `getSignedUrl` 逻辑，只改默认有效期）
- [x] `src/services/ossService.ts`：新增 `listHlsSegments(hlsPrefix)` —— 列举 COS 某前缀下所有 .ts 文件（用于 generateM3u8）

#### 3. hlsService（新建核心服务）
- [x] 新建 `src/services/hlsService.ts`
- [x] 实现 `transcodeToHls(videoId, objectKey, hlsPrefix)`：
  - 生成临时目录 `os.tmpdir()/cowatch-hls-{videoId}/`
  - **COS 模式**：用 `getSignedUrl(objectKey, 3600)` 获取原始文件临时 URL，作为 ffmpeg `-i` 输入
  - **本地模式**：ffmpeg `-i` 直接指向 `uploads/{objectKey}` 本地路径
  - ffmpeg 命令：`-c copy -f hls -hls_time 15 -hls_list_size 0 -hls_segment_filename {tmpDir}/seg%03d.ts {tmpDir}/index.m3u8`
  - ffmpeg 进程用 Node.js `child_process.spawn` 执行，stdout/stderr 收集日志
  - **COS 模式**：遍历 tmpDir 中 `.ts` 文件，调用 `uploadHlsSegment` 批量上传（串行，避免带宽爆炸）
  - 调用 `updateHlsStatus(videoId, hlsPrefix, 'done')`
  - 清理 tmpDir（`fs.rm(tmpDir, { recursive: true, force: true })`）
  - 任何步骤失败：调用 `updateHlsStatus(videoId, '', 'error')`，re-throw
- [x] 实现 `generateM3u8(videoId)`：
  - 查询 `getVideoById(videoId)` 得到 `hls_prefix`、`hls_status`
  - 若 `hls_status !== 'done'` 抛出 `{ code: 425, message: '视频切片尚未完成' }`
  - **COS 模式**：调用 `listHlsSegments(hlsPrefix)` 列举片段列表；**本地模式**：`fs.readdirSync` 读取本地目录
  - 对每个 `.ts` 片段生成签名 URL（`getHlsSegmentSignedUrl`）
  - 拼装 m3u8 文本（`#EXTM3U` / `#EXT-X-TARGETDURATION:15` / `#EXTINF:` / `#EXT-X-ENDLIST`）
  - 返回 m3u8 字符串

---

### 二、后端接口层

#### 4. rooms controller 迭代
- [x] `src/controllers/rooms/index.ts`：`getUploadUrl` —— 移除 `isUploadWhitelisted` 白名单分支，OSS 模式统一返回 `mode: 'proxy'`
- [x] `src/controllers/rooms/index.ts`：`proxyUpload` —— 上传完成后**不立即**广播 `VIDEO_ADDED`；先写入 DB（`hls_status: 'pending'`），然后**异步**调用 `transcodeToHls`，切片完成后广播 `VIDEO_ADDED`（含 `m3u8ObjectKey`）
- [x] `src/controllers/rooms/index.ts`：`uploadLocal`（本地模式）—— 同样改为先写 DB，再异步切片，切片完成后广播
- [x] `src/controllers/rooms/index.ts`：移除 `setVideo` handler（白名单直传 confirm 接口废弃）

#### 5. rooms router 迭代
- [x] `src/routes/rooms/index.ts`：新增 `GET /:roomId/videos/:videoId/m3u8` 路由（`roomAuthMiddleware`，调用 `generateM3u8`）
- [x] `src/routes/rooms/index.ts`：移除 `PUT /:roomId/video` 路由（白名单 confirm 接口废弃）

#### 6. wsServer 迭代
- [x] `src/ws/wsServer.ts`：`toPlayUrl` 改为返回 m3u8 API 路径（`/api/rooms/{roomId}/videos/{videoId}/m3u8`）而非签名 URL
  - 注意：`ROOM_STATE` 和 `SWITCH_VIDEO` 的 `videoUrl` 字段语义统一变为 m3u8 API 路径
  - `toPlayUrl` 需要 `videoId` 参数（当前只有 `objectKey`），需从 `room_videos` 表查出对应 `videoId`
- [x] `src/ws/wsServer.ts`：新增辅助函数 `getVideoIdByObjectKey(objectKey)` —— 查 `room_videos` 返回 `video.id`

#### 7. uploadGuard 迭代
- [x] `src/middleware/uploadGuard.ts`：移除 `isUploadWhitelisted` 导入和调用（所有人走此中间件）
- [x] 验证：白名单用户现在走 `upload-proxy`，`uploadGuard` 同样生效（流量限制统一）

---

### 三、前端层

#### 8. 应用入口浏览器检测
- [x] `src/index.tsx`：在 `ReactDOM.createRoot` 之前检测 `Hls.isSupported()`，若为 false 则 `document.body.innerHTML = '<div ...>请使用 Chrome 或 Edge 浏览器访问 CoWatch</div>'` 并 `return`，终止 React 渲染

#### 9. API 层迭代
- [x] `src/api/room.ts`：移除 `confirmVideoUploadApi`（白名单直传 confirm 接口废弃）
- [x] `src/api/room.ts`：新增 `getVideoM3u8Api(roomId, videoId): Promise<string>` —— GET `/rooms/{roomId}/videos/{videoId}/m3u8`，返回 m3u8 文本内容

#### 10. 类型定义迭代
- [x] `src/types/api.ts`：`UploadUrlResponse.mode` 类型改为 `'proxy' | 'local'`（移除可选 undefined）
- [x] `src/types/room.ts`：`VideoAddedData` 新增 `m3u8ObjectKey?: string`；`videoUrl` 注释更新为"m3u8 API 路径"
- [x] `src/types/room.ts`：`SwitchVideoData.videoUrl` 注释更新

#### 11. VideoUploader 迭代
- [x] `src/pages/Lobby/VideoUploader.tsx`：`UploadStatus` 新增 `'slicing'` 状态
- [x] 移除 OSS 直传分支（`else` 分支中的 `uploadToOss` + `confirmVideoUploadApi` 调用）
- [x] 上传 200 响应后切换到 `'slicing'`，展示"服务器切片中，请稍候..."转圈
- [x] 监听 WS `VIDEO_ADDED`（通过 props 回调或 Context）：收到对应文件名的消息后切换到 `'done'`
  - 方案：通过 `VideoUploader` 接收 `onVideoAdded?: (fileName: string) => void` prop，父组件（Lobby）注入后在 WS 消息处传出；`VideoUploader` 内部维护 `pendingFileName` ref 对比
- [x] 移除 `uploadToOss` 函数（不再需要）

#### 12. VideoPlayer 迭代（hls.js 接入）
- [x] 安装依赖：`npm install hls.js`（自带类型定义，无需额外 @types）
- [x] `src/pages/Lobby/VideoPlayer.tsx`：import hls.js（`import Hls from 'hls.js'`）
- [x] 新增 `hlsRef = useRef<Hls | null>(null)`
- [x] 新增 `useEffect`（依赖 `src`）：
  - 若 `hlsRef.current` 存在，先 `hlsRef.current.destroy()`
  - 若 `!src`，直接 return
  - 创建 `new Hls()`，`hls.loadSource(src)`，`hls.attachMedia(videoEl)`
  - 监听 `Hls.Events.ERROR`：`fatal` 类型 + `MEDIA_ERROR` 尝试 `hls.recoverMediaError()` 一次；其他 fatal 直接 `hls.destroy()`
  - cleanup：`hls.destroy()`
- [x] `<video>` 标签移除 `src={src}` 属性（改由 hls.js 控制），保留其他 props 不变
- [x] 移除 `preload="metadata"`（hls.js 自行管理预加载）

#### 13. SW 完全重写
- [x] `src/sw.ts`：完全重写为 ~80 行 cache-first 逻辑（见 design.md §6）
  - 更新 `CACHE_NAME` 为 `'cowatch-hls-v1'`（触发旧缓存清理）
  - 拦截条件改为 `.ts` 片段（`pathname.includes('/cowatch/') && pathname.endsWith('.ts')`）
  - 移除 `parseRange`、`buildRangeResponseFromStream`、`inFlight` Map

---

### 四、收尾

#### 14. 依赖与配置
- [x] 后端 `package.json`：确认 `ffmpeg-static` 或系统 ffmpeg 可用；若用系统 ffmpeg，在 README 中注明安装要求
- [x] 前端 `package.json`：`hls.js` 已安装（`"hls.js": "^1.6.16"`）

#### 15. 本地联调验证
- [ ] 本地模式端到端：上传 → 切片 → hls.js 播放 → SW 缓存 `.ts`
- [ ] 检查 SW DevTools：Cache Storage 中出现 `cowatch-hls-v1`，`.ts` 片段被缓存
- [ ] 检查 seek：跳转后只请求目标片段（Network 面板），无多余完整文件请求

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
