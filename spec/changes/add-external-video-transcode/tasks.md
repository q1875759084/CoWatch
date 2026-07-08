# 桌面端外部视频转码上传 实现任务

## 任务清单

### 1. 类型定义

- [ ] 在 `src/types/recorder.ts` 新增 `ExternalTranscodeProgress` 接口
  - `phase: 'transcoding' | 'uploading' | 'completed' | 'failed'`
  - `uploaded: number`（已上传分段数）
  - `estimated: number`（预估总分段数，-1 表示未知）
- [ ] 在 `src/global.d.ts` → `ElectronBridge.recorder` 新增以下方法签名：
  - `transcodeExternal: (roomId: string, authToken: string) => Promise<{ cancelled: boolean } | { error: string }>`
  - `onExternalTranscodeProgress: (cb: (info: ExternalTranscodeProgress) => void) => void`
  - `offExternalTranscodeProgress: () => void`

### 2. 外部转码模块

- [ ] 创建 `electron/handlers/recorder/external-transcode/index.ts`
  - 类型定义：`ExternalTranscodeConfig`、`ExternalTranscodeCallbacks`
  - `startExternalTranscode(cfg, cbs)`：根据编码器构建 FFmpeg 命令（参数表见 design.md §4.1），spawn FFmpeg，chokidar 监听输出目录新 `*_opt.ts` 文件，逐个回调 `onSegmentReady` → 对接 `enqueueUpload()`
  - `stopExternalTranscode()`：SIGTERM 终止 FFmpeg，等待排空
  - FFmpeg 命令构建逻辑（编码器自适应 + 参数映射）
  - 进度估算：通过 FFmpeg stderr 解析 `time=` 行计算当前转码进度和预估分段数

### 3. IPC 注册 + 生命周期协调（electron/handlers/recorder/index.ts）

- [ ] 新增 IPC handler：`recorder:transcodeExternal`
  - 调用 `dialog.showOpenDialog`（视频格式 filter）
  - 创建临时目录 `cowatch-ext-{uuid}/`
  - 初始化上传层（`initUploader` 用新 sessionId）
  - 调用 `startExternalTranscode()`
  - FFmpeg 正常退出后等待上传排空 → 调用 `/recording/finish`
  - 出现错误时清理临时目录、推送错误到 renderer
  - 返回 `{ cancelled: boolean } | { error: string }` 给 renderer
- [ ] 新增 IPC handler：`recorder:transcodeExternal:cancel`
  - 调用 `stopExternalTranscode()` + 清理上传层
- [ ] 与录制互斥：启动前检查 `isRecording()` 和外部转码进行中标志

### 4. Preload 桥接（electron/preload.ts）

- [ ] 暴露 `recorder.transcodeExternal(roomId, authToken)` → `ipcRenderer.invoke`
- [ ] 暴露 `recorder.onExternalTranscodeProgress(cb)` → `ipcRenderer.on`
- [ ] 暴露 `recorder.offExternalTranscodeProgress()` → `ipcRenderer.removeListener`

### 5. 前端上传入口适配（src/pages/Lobby/VideoUploader/index.tsx）

- [ ] 新增 `ExternalTranscodeStatus` 状态：`'idle' | 'transcoding' | 'uploading' | 'slicing' | 'error'`
- [ ] 检测 `window.electronBridge?.isElectron` → 点击上传时走 `electronBridge.recorder.transcodeExternal()` 而非浏览器的 `<input type="file">` + `uploadToBackend()`
- [ ] 监听 `onExternalTranscodeProgress` 回调，更新进度 UI
- [ ] 转码完成后的 `slicing` 阶段复用现有 WS 广播逻辑（等待 `VIDEO_ADDED`）
- [ ] 非 Electron 环境保持现有逻辑不变

---

完成所有任务后将 `- [ ]` 改为 `- [x]`。
