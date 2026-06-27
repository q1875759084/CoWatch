# Electron 实时录制 技术设计

## 1. 功能概述

为 CoWatch Electron 客户端实现第一期实时录制功能：ffmpeg 后台录制游戏窗口，每 10 秒生成一个 `.ts` 切片并实时上传 COS，录制结束后房间视频列表自动出现录屏，供所有成员回放。不是直播，录制期间其他成员不可见内容。

---

## 2. 涉及模块

| 仓库 | 模块 | 路径 |
|------|------|------|
| CoWatch（前端） | Electron 主进程录制处理器 | `electron/handlers/recorder.ts` |
| CoWatch（前端） | Preload contextBridge | `electron/preload.ts` |
| CoWatch（前端） | 类型声明 | `src/global.d.ts` |
| CoWatch（前端） | 录制控件 UI | `src/components/Recorder/` |
| CoWatch-backend | 录制完成接口 | `src/controllers/rooms/index.ts` |
| CoWatch-backend | 路由注册 | `src/routes/rooms/index.ts` |

---

## 3. 模块设计

### 3.1 `electron/handlers/recorder.ts`（Main 进程）

**职责**：接管所有录制生命周期，Renderer 通过 IPC 调用，主进程全权管理 ffmpeg 子进程、切片上传、重试队列。

#### 状态机

```
idle → detecting → ready → recording → finishing → idle
```

| 状态 | 说明 |
|------|------|
| `idle` | 初始/结束状态，控件可交互 |
| `detecting` | 编码器检测中（UI 挂载时自动触发） |
| `ready` | 编码器已确定，可开始录制 |
| `recording` | 录制进行中，ffmpeg 运行 |
| `finishing` | 已停止 ffmpeg，等待剩余切片上传完成 |

#### 编码器检测（`detectEncoder`）

UI 挂载时调用，依次探测：
```
h264_nvenc → h264_amf → h264_qsv → libx264（兜底）
```
检测命令：`ffmpeg -f lavfi -i nullsrc -t 1 -c:v {encoder} -f null -`，返回码 0 = 支持。

检测到软件编码（`libx264`）时记录 `isSoftwareEncoder = true`，`start()` 时触发弹窗警告并自动降 480p30。

#### 窗口列表（`getSources`）

调用 `desktopCapturer.getSources({ types: ['window', 'screen'] })`，返回 `{ id, name, thumbnail }[]`，由 Renderer 弹窗展示。

#### 开始录制（`start(windowId, displayTitle, sourceType)`）

1. 在 `app.getPath('temp')/cowatch-rec/{sessionId}/` 创建临时目录；若创建失败则 fallback 到 `app.getPath('userData')/recordings/{sessionId}/`
2. 启动 ffmpeg 子进程：
   - `sourceType === 'screen'`：`-f gdigrab -i desktop`（整屏，兼容全屏独占游戏）
   - `sourceType === 'window'`：`-f gdigrab -i title="{displayTitle}"`（窗口，仅限可以被 GDI 捕获的窗口）
3. 用 `chokidar` 监听临时目录（`awaitWriteFinish: { stabilityThreshold: 200 }`），每发现新 `.ts` 文件立即调用 `uploadSegment()`
4. 启动 2 小时超时定时器，到时自动触发 `stop()`
5. 启动计时器，每秒向 Renderer 推送 `recorder:tick`（录制时长秒数）

**ffmpeg 可执行路径处理（打包兼容）**：
```typescript
import ffmpegPath from 'ffmpeg-static';
// ffmpeg-static 打包进 asar 后 .exe 无法执行，必须指向 unpacked 目录
const ffmpegBin = app.isPackaged
  ? ffmpegPath!.replace('app.asar', 'app.asar.unpacked')
  : ffmpegPath!;
```

**ffmpeg 命令（900p30 正常档）**：
```bash
ffmpeg -f gdigrab -framerate 30 -i desktop \
  -s 1600x900 -c:v {encoder} -crf 30 -g 300 \
  -f hls -hls_time 10 -hls_list_size 0 \
  -hls_segment_filename "<tmpDir>/seg%03d.ts" \
  "<tmpDir>/index.m3u8"
```

**ffmpeg 命令（480p30 降级档，软编 + CPU 高负载时自动切换）**：
```bash
# 与正常档相同，仅替换 -s 854x480
```

#### 切片上传（`uploadSegment(filePath)`）

```
单片上传 → p-retry 3 次（1s / 4s / 8s，随机抖动）
  成功 → 删除本地临时文件，segmentKeys.push(objectKey)
  失败（3 次耗尽）→ 进入 pendingSegments 队列，不中断录制
```

**上传路径（objectKey）**：`cowatch/{roomId}/recordings/{sessionId}/{segmentName}`（复用 COS 目录结构）

网络恢复监听：监听 `net` 模块（Electron）的 `online` 事件，触发时批量补传 `pendingSegments`。

#### 停止录制（`stop()`）

1. 向 ffmpeg 发送停止信号（**Windows 上 `SIGTERM` 等同于 `SIGKILL`，会强杀进程导致末片截断**）：
   ```typescript
   if (process.platform === 'win32') {
     ffmpegProcess.stdin?.write('q'); // ffmpeg 收到 q 后优雅写入 #EXT-X-ENDLIST 再退出
   } else {
     ffmpegProcess.kill('SIGTERM');
   }
   ```
   spawn 时须保留 `stdin: 'pipe'`。
2. 等待 ffmpeg `close` 事件
3. 等待所有正在进行的上传完成（`Promise.all`），并补传 `pendingSegments`
4. 调用后端 `POST /api/rooms/:roomId/recording/finish`，传入有序 `segmentKeys[]`
5. 删除临时目录
6. 状态置为 `idle`

#### 崩溃重启（`handleFfmpegCrash`）

监听 ffmpeg 进程 `close` 事件，非正常退出（code !== 0 且非用户主动停止）时：
- 记录已上传到第几个切片（`uploadedCount`）
- 重新启动 ffmpeg，附加 `-hls_start_number {uploadedCount}` 续录
- Renderer 侧无感知，计时器继续

---

### 3.2 `electron/preload.ts`

解注释并扩展 `contextBridge.exposeInMainWorld`，新增 `recorder` 命名空间：

```typescript
contextBridge.exposeInMainWorld('electronBridge', {
  isElectron: true as const,
  apiOrigin: process.env.ELECTRON_API_ORIGIN || 'http://localhost:3002',
  recorder: {
    detectEncoder: () => ipcRenderer.invoke('recorder:detectEncoder'),
    getSources: () => ipcRenderer.invoke('recorder:getSources'),
    start: (windowId: string, displayTitle: string, roomId: string) =>
      ipcRenderer.invoke('recorder:start', windowId, displayTitle, roomId),
    stop: () => ipcRenderer.invoke('recorder:stop'),
    onTick: (cb: (seconds: number) => void) =>
      ipcRenderer.on('recorder:tick', (_e, s) => cb(s)),
    onProgress: (cb: (info: { uploaded: number; pending: number }) => void) =>
      ipcRenderer.on('recorder:progress', (_e, info) => cb(info)),
    offTick: () => ipcRenderer.removeAllListeners('recorder:tick'),
    offProgress: () => ipcRenderer.removeAllListeners('recorder:progress'),
  },
});
```

---

### 3.3 `src/global.d.ts`

解注释 `ElectronBridge.recorder` 类型定义，与 preload.ts 保持一致：

```typescript
recorder: {
  detectEncoder: () => Promise<{ encoder: string; isSoftware: boolean }>;
  getSources: () => Promise<Array<{ id: string; name: string; thumbnailDataUrl: string }>>;
  start: (windowId: string, displayTitle: string, roomId: string) => Promise<void>;
  stop: () => Promise<void>;
  onTick: (cb: (seconds: number) => void) => void;
  onProgress: (cb: (info: { uploaded: number; pending: number }) => void) => void;
  offTick: () => void;
  offProgress: () => void;
};
```

---

### 3.4 `src/components/Recorder/`（Renderer React 组件）

**位置**：房间内视频列表标题栏右侧，悬浮展示，不影响现有布局。

**文件结构**：
```
src/components/Recorder/
  index.tsx          # 主组件（状态机驱动）
  WindowPicker.tsx   # 窗口选择弹窗
  index.module.scss
```

#### 状态与交互流程

```
组件挂载
  → useEffect: electronBridge.recorder.detectEncoder()
  → isSoftware=true 时提示警告

[待机]
  录制按钮（非 Electron: 置灰 + hover "请使用客户端"）
  点击"开始录制" → 弹出 WindowPicker

[WindowPicker]
  展示窗口列表（thumbnailDataUrl 作为预览图）
  列表为空/仅 CoWatch 自身 → "请先启动要录制的程序"
  用户选择 + 确认 → recorder.start(windowId, displayTitle, roomId)

[录制中]
  🔴 00:12:34（计时器，每秒更新）
  点击"停止录制" → recorder.stop() → 进入完成等待

[完成等待]
  上传进度条（uploaded / total）
  所有片段上传完成 → 控件恢复待机
  房间视频列表自动刷新（WS VIDEO_ADDED 推送）
```

#### 路由守卫（录制中禁止切换房间）

在 `src/components/RoomGuard/` 或 Lobby 路由层增加：
- 录制进行中时，监听路由变化并弹窗拦截
- `beforeunload` 事件：调用 `recorder.stop()`，等待 finish 后允许关闭（超时 10s 强制关闭）

**录制状态存储**：`src/context/RecorderContext.tsx`（轻量 Context），仅在 Lobby 路由层挂载，存储 `isRecording: boolean` 供路由守卫读取。

---

## 4. 接口设计（后端）

### `POST /api/rooms/:roomId/recording/finish`

录制结束，后端生成 m3u8 写库并广播。

**鉴权**：`authMiddleware` + `roomAuthMiddleware` + `requireRoomActive()`

**请求体**：
```typescript
interface RecordingFinishRequest {
  /** 有序切片 objectKey 列表，格式：cowatch/{roomId}/recordings/{sessionId}/seg{NNN}.ts */
  segmentKeys: string[];
  /** 录制视频的展示名，格式：自动录制 2026-06-27 20:30 */
  displayName: string;
  /** 实际录制时长（秒） */
  durationSeconds: number;
}
```

**响应**：
```typescript
interface RecordingFinishResponse {
  videoId: string;
}
```

**后端处理逻辑**：
1. 参数校验：`segmentKeys` 非空数组，每项以 `.ts` 结尾
2. 用 `uuidv4()` 生成 `videoId`，`hlsPrefix = cowatch/{roomId}/recordings/{sessionId}/`（从 segmentKeys[0] 提取前缀）
3. 调用 `addRoomVideo(videoId, roomId, hlsPrefix, displayName, userId)`（`video_url` 存 hlsPrefix，复用现有字段语义）
4. 调用 `updateHlsStatus(videoId, 'ready', hlsPrefix)` — 切片已在 COS，直接标 ready，无需转码
5. 调用 `generateM3u8(videoId, roomId)` 验证 m3u8 可生成（COS 列举切片）
6. 广播 `VIDEO_ADDED`（复用现有 WS 事件，`broadcast(roomId, { type: 'VIDEO_ADDED', videoId })`）
7. 返回 `{ videoId }`

> **注意**：无需新建数据库表，`room_videos` 表结构完全复用。`video_url`（即 `objectKey`）存 hlsPrefix，与普通上传一致，下游播放链路（getSegment、generateM3u8）零改动。

---

## 5. 类型定义

### 前端新增（`src/types/recorder.ts`）
```typescript
export interface RecorderSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
}

export interface EncoderDetectResult {
  encoder: string;
  isSoftware: boolean;
}

export interface RecordingProgress {
  uploaded: number;   // 已上传片段数
  pending: number;    // 待上传片段数（网络异常时 > 0）
}

export type RecorderState = 'idle' | 'detecting' | 'ready' | 'recording' | 'finishing';
```

---

## 6. 依赖新增

| 包 | 用途 | 安装位置 |
|----|------|---------|
| `ffmpeg-static` | 内置各平台 ffmpeg 二进制，无需用户安装 | `CoWatch` dependencies |
| `chokidar` | 稳定的跨平台文件监听（替代 `fs.watch`） | `CoWatch` dependencies |
| `p-retry` | 切片上传指数退避重试 | `CoWatch` dependencies |

---

## 7. 关键决策记录

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 切片状态存储位置 | 客户端本地（内存 + 临时文件） | 无需服务端存中间状态；崩溃重启后从本地续录 |
| 后端是否新建表 | 不新建 | `room_videos` 表完全复用，`video_url` 存 hlsPrefix，下游播放链路零改动 |
| 网络中断策略 | p-retry 3 次 + pending 队列 + 网络恢复批补传 | 切片永不丢弃；不中断录制 |
| 编码器检测时机 | 组件挂载时（非点击开始时） | 避免用户点击后等待 1~2 秒的感知延迟 |
| 路由守卫范围 | 仅 Lobby（房间内） | 录制只发生在房间内，其他页面无需守卫 |
| `beforeunload` 处理 | 调 stop() + 超时 10s 强制关闭 | 保证录制结束广播能发出；超时防止关不掉 |
| 切片 objectKey 格式 | `cowatch/{roomId}/recordings/{sessionId}/seg{NNN}.ts` | 与普通上传目录隔离，便于区分和清理 |
| finish 接口鉴权 | authMiddleware + roomAuthMiddleware + requireRoomActive | 与其他房间接口一致 |
| ffmpeg-static 打包路径 | `app.isPackaged` 时替换 `app.asar → app.asar.unpacked` | asar 内 .exe 无法执行，必须 asarUnpack 后指向物理路径 |
| Windows 停止 ffmpeg | stdin 写 `q` 而非 `SIGTERM` | Windows 上 SIGTERM = SIGKILL，强杀导致末片截断、无 #EXT-X-ENDLIST |
| 录制捕获目标 | 优先提供整屏（`-i desktop`），窗口模式作为可选项 | DirectX/DX12/Vulkan 全屏独占游戏 GDI 不可捕获，整屏兜底兼容性最好 |
| chokidar 写稳定性 | `awaitWriteFinish: { stabilityThreshold: 200 }` | Windows 文件系统下 ffmpeg 写切片过程中会触发 `add`，等稳定后再上传防止传输不完整切片 |
| 临时目录 fallback | 主路径创建失败时降级到 `userData/recordings/` | 企业机器可能封锁 `%TEMP%`，`userData` 是 Electron 应用目录，权限有保证 |

---

## 8. Windows 已知限制（暂不处理，后续修复无破坏性）

| 限制 | 表现 | 后续修复代价 |
|------|------|-------------|
| `desktopCapturer` 预览图对全屏游戏为黑 | WindowPicker 缩略图显示黑色 | 仅改 UI 渲染逻辑，不影响录制链路 |
| `net.online` 可能误报 | VPN/代理场景下 pending 队列补传不及时 | 加一个 `setInterval` 轮询，不改现有逻辑 |
