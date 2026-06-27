# Electron 实时录制 实现任务

## 任务清单

---

### 阶段 0：依赖与类型准备

#### 0.1 安装依赖（CoWatch 前端）
- [x] `npm install ffmpeg-static chokidar p-retry`
- [x] `npm install --save-dev @types/ffmpeg-static`

#### 0.2 `src/types/recorder.ts` — 新增录制相关类型
- [x] 新增 `RecorderSource`（id / name / thumbnailDataUrl / sourceType）
- [x] 新增 `EncoderDetectResult`（encoder / isSoftware）
- [x] 新增 `RecordingProgress`（uploaded / pending）
- [x] 新增 `RecorderState` 联合类型（'idle' | 'detecting' | 'ready' | 'recording' | 'finishing'）

#### 0.3 `src/global.d.ts` — 解注释 recorder 类型
- [x] 替换 `ElectronBridge.recorder` 字段占位注释，补全完整类型签名（与 preload.ts 一致）

---

### 阶段 1：Electron 主进程 — 录制处理器

#### 1.1 `electron/handlers/recorder.ts` — 编码器检测
- [x] 导入 `ffmpeg-static`，获取 ffmpeg 可执行路径（兼容 `app.isPackaged` 时 asar 解包路径）
- [x] 实现 `detectEncoder()`：依次测试 `h264_nvenc → h264_amf → h264_qsv → libx264`
  - 测试命令：`ffmpeg -f lavfi -i nullsrc -t 1 -c:v {encoder} -f null -`
  - 返回第一个返回码为 0 的编码器，记录 `isSoftware = encoder === 'libx264'`
- [x] 导出 `isSoftwareEncoder` 标志，供 `start()` 决策分辨率

#### 1.2 `electron/handlers/recorder.ts` — 窗口列表
- [x] 实现 `getSources()`：调用 `desktopCapturer.getSources({ types: ['window', 'screen'] })`
- [x] 将 `thumbnail.toDataURL()` 附到每个 source，返回 `RecorderSource[]`
- [x] 过滤掉 thumbnail 为空的条目
- [x] 根据 id 前缀自动标注 `sourceType: 'screen' | 'window'`

#### 1.3 `electron/handlers/recorder.ts` — 录制生命周期
- [x] 定义模块级状态：`sessionId`、`tmpDir`、`ffmpegProcess`、`segmentKeys: string[]`、`pendingSegments: string[]`、`uploadedCount`、`tickTimer`、`timeoutTimer`、`watcher`、`isUserStopped: boolean`
- [x] 实现 `start(windowId, displayTitle, roomId)`：
  - [x] 创建临时目录 `app.getPath('temp')/cowatch-rec/{sessionId}/`
  - [x] 构造 ffmpeg 命令（正常档 1600x900，软编档 854x480）
  - [x] `child_process.spawn` 启动 ffmpeg，stderr pipe 用于 crash 检测
  - [x] 用 `chokidar` 监听临时目录 `*.ts` 文件，`add` 事件触发 `uploadSegment()`
  - [x] 启动 tick 定时器（每秒推送 `recorder:tick`）
  - [x] 启动 2 小时超时定时器（到时调 `stop()`）
  - [x] 监听 ffmpeg 进程 `close` 事件，非正常退出转 `handleFfmpegCrash()`
- [x] 实现 `uploadSegment(filePath)`：
  - [x] 构造 objectKey：`cowatch/{roomId}/recordings/{sessionId}/{segmentName}`
  - [x] 用 `p-retry` 3 次（1s/4s/8s 指数退避 + 随机抖动）上传至后端 `/recording/segment`
  - [x] 成功：`fs.unlink` 本地文件，`segmentKeys.push(objectKey)`，推送 `recorder:progress`
  - [x] 3 次耗尽：`pendingSegments.push(filePath)`，推送 `recorder:progress`（pending 值体现）
  - [x] 监听 Electron `net` 模块 `online` 事件，恢复时批量补传 `pendingSegments`
- [x] 实现 `stop()`：
  - [x] 设 `isUserStopped = true`，清除 tick 和超时定时器
  - [x] 向 ffmpeg 发送 `SIGTERM`，等待 `close` 事件（5s 超时后强杀）
  - [x] `watcher.close()`
  - [x] `Promise.allSettled` 等待所有进行中上传完成，补传 `pendingSegments`
  - [x] 调用后端 `POST /api/rooms/:roomId/recording/finish`，附带 `segmentKeys`、`displayName`、`durationSeconds`
  - [x] `fs.rm(tmpDir, { recursive: true, force: true })`
  - [x] 重置所有模块级状态
- [x] 实现 `handleFfmpegCrash()`：
  - [x] `isUserStopped` 为 true 时直接返回（正常停止，非 crash）
  - [x] 等待当前进行中的上传完成
  - [x] 用 `-hls_start_number {uploadedCount}` 重启 ffmpeg，继续写入同一 tmpDir
  - [x] 重新挂 `chokidar` watcher

#### 1.4 `electron/handlers/recorder.ts` — 导出 IPC handler 注册函数
- [x] 导出 `registerRecorderHandlers()` 函数，注册所有 ipcMain handle：
  - `recorder:detectEncoder` → `detectEncoder()`
  - `recorder:getSources` → `getSources()`
  - `recorder:start` → `start(windowId, displayTitle, roomId)`
  - `recorder:stop` → `stop()`

---

### 阶段 2：Electron 主进程 — 接入 main.ts / preload.ts

#### 2.1 `electron/main.ts` — 注册 IPC 处理器
- [x] 导入 `registerRecorderHandlers`, `setApiOriginForRecorder` from `./handlers/recorder`
- [x] 在 `app.whenReady()` 中调用 `setApiOriginForRecorder(API_ORIGIN)` 和 `registerRecorderHandlers()`
- [x] 清除旧占位注释块

#### 2.2 `electron/preload.ts` — 暴露 recorder 命名空间
- [x] 在 `contextBridge.exposeInMainWorld` 中实现 `recorder` 对象：
  - `detectEncoder`：`ipcRenderer.invoke('recorder:detectEncoder')`
  - `getSources`：`ipcRenderer.invoke('recorder:getSources')`
  - `start`：`ipcRenderer.invoke('recorder:start', windowId, displayTitle, roomId)`
  - `stop`：`ipcRenderer.invoke('recorder:stop')`
  - `onTick`：`ipcRenderer.on('recorder:tick', ...)`
  - `onProgress`：`ipcRenderer.on('recorder:progress', ...)`
  - `offTick` / `offProgress`：移除对应监听器

---

### 阶段 3：后端 — 录制接口

#### 3.1 `CoWatch-backend/src/controllers/rooms/index.ts` — 新增方法
- [x] 新增 `recordingSegment(req, res)` 方法（接收单个切片，上传 COS 或写本地）
- [x] 新增 `recordingFinish(req, res)` 方法：
  - [x] 从 `req.params` 取 `roomId`，从 `req.body` 取 `segmentKeys`、`displayName`、`durationSeconds`
  - [x] 参数校验：`segmentKeys` 非空数组，每项以 `.ts` 结尾，长度 ≤ 1000
  - [x] 从 `segmentKeys[0]` 提取 hlsPrefix（截至最后一个 `/` 前的部分）
  - [x] `addRoomVideo(videoId, roomId, hlsPrefix, displayName, userId)`
  - [x] `updateHlsStatus(videoId, 'ready', hlsPrefix)`（切片已在 COS，直接标 ready）
  - [x] `broadcast(roomId, { type: 'VIDEO_ADDED', ... })`
  - [x] `success(res, { videoId })`

#### 3.2 `CoWatch-backend/src/routes/rooms/index.ts` — 注册路由
- [x] 注册 `POST /:roomId/recording/segment`（pro 房间专用）
- [x] 注册 `POST /:roomId/recording/finish`（pro 房间专用）

#### 3.3 `CoWatch-backend/src/app.ts` — CORS
- [x] 在 `allowedHeaders` 中添加 `X-Object-Key`

---

### 阶段 4：前端 — RecorderContext

#### 4.1 `src/context/RecorderContext.tsx` — 新建轻量录制状态 Context
- [x] 定义 `RecorderContextValue`：`recorderState: RecorderState`、`setRecorderState`
- [x] 提供 `RecorderProvider`，仅在 Lobby 路由层挂载
- [x] 导出 `useRecorderState()` hook

---

### 阶段 5：前端 — Recorder UI 组件

#### 5.1 `src/components/Recorder/WindowPicker.tsx`
- [x] 接收 props：`sources: RecorderSource[]`、`onConfirm(source, sourceType: 'screen' | 'window')`、`onCancel()`
- [x] `screen` 类型 source 标注"整屏"，`window` 类型标注窗口名称
- [x] 渲染窗口缩略图网格，点选高亮，确认按钮
- [x] `screen` 类型缩略图为黑时，显示提示文字"整屏（独占模式）"而非显示黑图（黑缩略图在独占全屏游戏场景下是预期行为）
- [x] 空列表时显示"请先启动要录制的程序，然后点击刷新"提示

#### 5.2 `src/components/Recorder/index.tsx` — 主控件
- [x] 组件挂载时调用 `electronBridge.recorder.detectEncoder()`，结果存本地 state
- [x] 软编时渲染警告 toast："当前使用 CPU 软件编码，视频分辨率已自动降为 480p，可能影响游戏性能"
- [x] 非 Electron 环境（`!window.electronBridge`）：按钮置灰，hover tooltip "请使用 CoWatch 客户端"
- [x] 待机态（ready）：渲染"开始录制"按钮，点击弹出 WindowPicker
- [x] WindowPicker 确认后：调用 `recorder.start()`，切换到录制态
- [x] 录制态：展示红点脉冲动画 + 计时器（`onTick` 驱动，格式 HH:MM:SS）+ "停止录制"按钮
- [x] "停止录制"点击：调用 `recorder.stop()`，切换到 finishing 态
- [x] finishing 态：展示上传进度条（`onProgress` 驱动，`uploaded/(uploaded+pending)`）
- [x] 上传完成（pending=0 且 finishing）：恢复 idle 态
- [x] 组件卸载时 `recorder.offTick()` / `recorder.offProgress()` 清理监听器

#### 5.3 `src/components/Recorder/index.module.scss`
- [x] `.wrap`：flex row 容器
- [x] `.btn`：录制按钮基础样式
- [x] `.btnStop`：停止录制按钮（红色边框）
- [x] `.btnDisabled`：置灰样式
- [x] `.recordingDot`：脉冲红点动画
- [x] `.timer`：计时文本（等宽字体）
- [x] `.progressBar` / `.progressFill`：上传进度条（finishing 态展示）
- [x] WindowPicker 弹窗相关样式（grid、sourceItem、thumbnail 等）

---

### 阶段 6：前端 — 接入房间页

#### 6.1 `src/components/CollapseSection/index.tsx` — 新增 titleExtra prop
- [x] 添加 `titleExtra?: ReactNode` prop，标题行右侧插槽，点击不触发折叠

#### 6.2 视频列表标题栏接入 Recorder 组件
- [x] 在视频列表 `CollapseSection` 的 `titleExtra` 挂载 `<Recorder roomId={roomId} />`
- [x] 仅 `vip:pro` 等级房间显示（`roomMeta?.planLevel === 'vip:pro'`）

#### 6.3 路由守卫（录制中禁止切换房间）
- [x] `RecorderProvider` 包裹 Lobby 路由（`RoomPage` 外壳 + `RoomPageInner` 实现体）
- [x] `RoomPageInner` 中 `useEffect` 监听 `recorderState === 'recording'`，注册 `beforeunload` 拦截
- [x] `beforeunload`：调用 `recorder.stop()`，设置 `e.returnValue = ''` 触发浏览器确认框

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
