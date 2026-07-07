# 录制持久化与补传 实现任务

## 任务清单

### Electron 主进程 — persistence 模块

#### 1. 文件结构
- [x] 创建 `electron/handlers/recorder/persistence/index.ts`
- [x] 在 `electron/handlers/recorder/index.ts` 中 import persistence 模块

#### 2. persistRecording — 持久化未上传切片
- [x] 实现 `persistRecording(sessionId, roomId, tmpDir, pendingFiles, segmentKeys, cfg)`：
  - 在 `app.getPath('userData')/pending-uploads/{sessionId}/` 创建目录
  - 将 pendingFiles 从 tmpDir rename 到持久化目录
  - 生成 manifest.json（含 sessionId、roomId、createdAt、totalSegments、segments[]、displayName、durationSeconds、apiOrigin、authToken）
  - 返回持久化目录路径，若 pendingFiles 为空则返回 null

#### 3. listPendingRecordings — 扫描持久化目录
- [x] 实现 `listPendingRecordings()`：
  - 扫描 `app.getPath('userData')/pending-uploads/` 下所有子目录
  - 读取各 manifest.json
  - 按 createdAt 倒序排序
  - 返回 `PendingRecording[]`（sessionId、roomId、createdAt、totalSegments、uploadedCount、totalSize、displayName、durationSeconds）

#### 4. resumeUpload — 补传单条录制
- [x] 实现 `resumeUpload(sessionId)`：
  - 读取 manifest.json
  - 用 manifest 中的 apiOrigin/authToken 初始化 uploader
  - 遍历 segments[] 逐片 doUpload
  - 每完成一片更新 manifest.uploadedCount
  - 全部完成后：调 finish API 入库 → 删除持久化目录 → 清理 manifest

#### 5. 类型定义
- [x] 定义 `Manifest`、`ManifestSegment` 接口（persistence/index.ts 内）
- [x] 定义 `PendingRecording` 接口（`src/types/recorder.ts`）

### Electron 主进程 — recorder/index.ts 改动

#### 6. stop() 流程改造
- [x] 将 `STOP_PENDING_THRESHOLD` 从 9999 改为 5
- [x] 在 flushPendingQueue 之后、cleanupUploader 之前插入持久化分支：
  - 获取 pendingQueue 剩余文件列表
  - pendingCount = 0 → 调 finish → cleanup → 删除 tmpDir
  - 1 ≤ pendingCount ≤ 5 → 等排空 → 调 finish → cleanup → 删除 tmpDir
  - pendingCount > 5 → persistRecording() → 不调 finish → cleanup → 删除 tmpDir（剩余文件已在 persist 中 rename 走）

#### 7. cleanupUploader 行为调整
- [x] `cleanupUploader()` 中移除 `pendingQueue = []`、`uploadQueue = []`（文件已移到持久化目录或已上传删除，队列引用可安全保留）

### Electron 主进程 — IPC 注册

#### 8. 新增 IPC 通道
- [x] 注册 `recorder:getPendingRecordings` → 调用 `listPendingRecordings()`
- [x] 注册 `recorder:resumePending` → 调用 `resumeUpload(sessionId)`

### 前端 — 类型 & 桥接

#### 9. global.d.ts 桥接声明
- [x] `window.electronBridge.recorder` 新增：
  - `getPendingRecordings(): Promise<PendingRecording[]>`
  - `resumePending(sessionId: string): Promise<void>`
  - `onPendingUpdate(cb: (list: PendingRecording[]) => void): void`
  - `offPendingUpdate(): void`

#### 10. Recorder 组件 — finishing 态适配
- [x] `handleStop` 中，stop 返回后根据 pendingCount 决定是否进入 finishing 态显示进度条：
  - pendingCount = 0 → 直接 ready
  - pendingCount > 0 且 stop 内部决定等待（≤5）→ finishing 态 + 进度条
  - pendingCount > 5 → stop 立即返回 → 直接 ready（无需 finishing 态，切片已持久化）

### 前端 — PendingUploads 组件

#### 11. 文件结构
- [x] 创建 `src/pages/Lobby/VideoUploader/PendingUploads.tsx`
- [x] 创建 `src/pages/Lobby/VideoUploader/PendingUploads.module.scss`

#### 12. PendingUploads 组件实现
- [x] 组件挂载时调 IPC `recorder:getPendingRecordings` 获取列表
- [x] 渲染待补传列表，每条显示：
  - 视频摘要（displayName 或 sessionId 前 8 位）
  - 切片进度（uploadedCount / totalSegments + 进度条）
  - 状态文字（"待补传" / "补传中"）
  - [补传] 按钮（仅在 idle 状态可点击）
- [x] 点击 [补传] → 调 IPC `recorder:resumePending(sessionId)` → 按钮变 loading
- [x] 通过 `recorder:progress` 更新当前补传进度
- [x] 补传完成 → 从列表移除该项
- [x] 处理空态：列表为空时不渲染任何内容

#### 13. VideoUploader 集成
- [x] 在 `VideoUploader/index.tsx` 中 import 并渲染 `<PendingUploads />`
- [x] 放在 VideoUploader 的 `<input>` 按钮下方

### 参考代码

- 现有 IPC 注册模式：`electron/handlers/recorder/index.ts` 第 481-527 行
- 现有 frontend bridge 调用模式：`src/components/Recorder/index.tsx`
- 现有 finishing 态进度条：`src/components/Recorder/index.tsx` 第 208-220 行
- 现有 CollapseSection 用法：`src/pages/Lobby/index.tsx` 第 740-743 行
- 现有 doUpload 函数：`electron/handlers/recorder/upload/index.ts` 第 233-311 行

---
完成所有任务后将 `- [x]` 改为 `- [x]`
