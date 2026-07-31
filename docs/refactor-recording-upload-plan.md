# 录制+上传链路重构方案

> 2026-07-31 · 齐活林（主理人）· 基于全链路代码深度阅读

## 一、当前状态概述

### 1.1 三次重构历史

| 阶段 | 架构 | 状态 |
|------|------|------|
| v1 单 FFmpeg | ffmpeg 录制 HLS → 上传 | 已废弃 |
| v2 双 FFmpeg | ffmpeg 录制原始切片 → ffmpeg 逐片转码 → 上传 | screen 模式仍在使用 |
| v3 window_capture.exe | OBS WGC headless exe（零拷贝 NVENC + 内嵌 AAC + HLS）→ 直传 upload | window 模式主路径 |

### 1.2 当前双模式代码结构

```
recorder/
├── index.ts              (947行) 协调层：状态+IPC+start/stop+crash重启+外部转码+持久化
├── recording/
│   ├── index.ts          (614行) 录制层：window→spawn exe / screen→spawn ffmpeg
│   ├── profiles.ts       (163行) window 模式的 capture/encode/mux Profile → exe CLI
│   ├── types.ts          (26行)  PauseReason/StopReason/CropRect
│   └── diagnostics.ts    (116行) DiagnosticLogger 死代码（全仓零引用）
├── transcoding/
│   └── index.ts          (211行) 转码层：仅 screen 模式；chokidar→串行转码→upload
├── upload/
│   ├── index.ts          (443行) 上传层：串行队列+pRetry+pendingQueue+token刷新
│   └── throttle.ts       (223行) 自适应限速 3~7Mbps
├── external-transcode/
│   └── index.ts          (290行) 外部视频转码：用户选文件→HLS→upload
├── watch-mode/           (3文件) 文件夹监听自动转码上传（已设计未集成）
├── persistence/
│   └── index.ts          (271行) 未上传切片落盘+manifest+补传
├── sentinel-client.ts    (227行) Python exe，窗口事件探测
├── window-watch.ts       (174行) 5s轮询 desktopCapturer（window模式禁用）
└── shared.ts             (78行)  FFmpeg路径+SessionAnchor
```

### 1.3 数据流（当前）

**Window 模式（方案2a · 主路径）：**
```
sentinel-client → window_capture.exe → [seq%05d.ts + index.m3u8]
                                         ↓ chokidar (windowUploadWatcher)
                                       upload (throttle+retry) → 后端
```

**Screen 模式（feat 基线 · 旧路径）：**
```
ffmpeg (ddagrab/gfxcapture) + audio_capture.exe → [seg%03d.ts]
                                                    ↓ chokidar (transcoding watcher)
                                                  transcoding → [seg%03d_opt.ts]
                                                    ↓ onTranscodeComplete
                                                  upload (throttle+retry) → 后端
```

## 二、终态目标

用户确认的终态：
1. **window_capture.exe 扩展支持 screen 模式**（WGC 全屏捕获），CoWatch 侧删掉 ddagrab/gfxcapture/audio_capture
2. **转码层废弃**（screen 模式也直接出 HLS 成品切片，像 window 模式一样）
3. **统一到「window_capture.exe + upload 两层架构」**

终态数据流：
```
window_capture.exe (--hwnd 窗口 / --screen 全屏) → [seq%05d.ts + index.m3u8]
                                                      ↓ chokidar watcher
                                                    upload (throttle+retry) → 后端
```

## 三、问题清单（按严重度分级）

### 🔴 P0：功能性 Bug（当前就会出问题）

#### P0-1：`getNextSegmentNumber()` 文件名模式不匹配 window 模式

**位置**：`recording/index.ts:405-420`

**现状**：
```typescript
function getNextSegmentNumber(): number {
  const files = fs.readdirSync(tmpDir);
  let maxNum = -1;
  for (const f of files) {
    const match = f.match(/^seg(\d+)_opt\.ts$/);  // ← 只匹配 screen 模式的 segNNN_opt.ts
    if (match) { ... }
  }
  return maxNum + 1;
}
```

**问题**：window 模式 exe 产出 `seq%05d.ts`（如 `seq00001.ts`），此函数匹配不到任何文件 → 永远返回 0 → crash 续录 / pause-resume 从 0 重新编号 → **覆盖已有切片**

**影响路径**：
- `restartRecording()` → `getNextSegmentNumber()` → 续号 0 → 覆盖
- `resumeRecording()` → `getNextSegmentNumber()` → 续号 0 → 覆盖
- `pauseRecording()` → `recordedSecondsAtPause = getNextSegmentNumber() * seg_duration` → 0

**修复方向**：按模式匹配不同文件名模式，或统一为一种命名

---

#### P0-2：`persistence/index.ts` 的 `parseSegmentIndex` 不匹配 window 模式

**位置**：`persistence/index.ts:55-58`

**现状**：
```typescript
function parseSegmentIndex(fileName: string): number {
  const m = fileName.match(/^seg(\d+)/);  // ← 只匹配 segNNN
  return m ? parseInt(m[1], 10) : 0;
}
```

**问题**：window 模式的 `seq00001.ts` 不匹配 → manifest 中所有 segment 的 index 都为 0 → 后端按 index 重组时顺序错乱

**修复方向**：统一文件名解析正则，或统一命名规范

---

#### P0-3：`enqueueMissingFiles` 可能重复上传

**位置**：`upload/index.ts:197-210`

**现状**：stop 时扫描 tmpDir，把所有 `.ts` 且不在 `queuedFileNames` 中的文件入队

**问题**：
- screen 模式：`seg000.ts`（原始）和 `seg000_opt.ts`（转码后）都匹配 → 原始切片可能在转码后仍被补传
- window 模式：`seq00001.ts` 正确匹配，但 `index.m3u8` 被排除（非 `.ts`）→ 正确

**修复方向**：按模式过滤，screen 模式只补传 `_opt.ts`，或者废弃 screen 模式后此问题自然消失

---

### 🟡 P1：架构残留/死代码

#### P1-1：`muxProc` / `muxReady` / `currentMuxProfile` 旧 pipe 方案残留

**位置**：`recording/index.ts:90-91,94,180-181`

**现状**：
```typescript
let muxProc: ChildProcess | null = null;      // 永远为 null
let currentMuxProfile: MuxProfile | null = null; // 仅用于 crash 续录锚点续号
let muxReady = false;                           // 永远为 false
```

**问题**：
- `muxProc` 在 window 模式下永远为 null（exe 内一体封装，不需要外部 mux）
- 但 `isRecording()` 检查 `muxProc !== null`、`pauseRecording` 检查 `captureProc || muxProc`
- `currentMuxProfile` 仅用于 `startNumber` 续号，但续号逻辑本身已坏（见 P0-1）

**修复方向**：删除 `muxProc`/`muxReady`，`currentMuxProfile` 的续号功能修复后保留或重构

---

#### P1-2：双份状态：协调层 vs 录制层

**位置**：`index.ts` vs `recording/index.ts`

**冲突字段**：

| 字段 | 协调层 index.ts | 录制层 recording/index.ts |
|------|----------------|--------------------------|
| isUserStopped | L115 | L81 |
| currentSourceId | L127 | L84 |
| currentWindowTitle | L129 | L85 |
| tmpDir | L109 | L77 |
| crashRestartCount | L117 | L82 |

**问题**：两层各自维护同名变量，更新时机不同 → crash 重启时可能不一致

**示例**：`handleFfmpegCrash` 在协调层递增 `crashRestartCount`，然后调 `restartRecording`，录制层内部也递增自己的 `crashRestartCount` → 计数翻倍

**修复方向**：状态集中到一层（建议协调层），录制层改为无状态函数式调用或通过参数传递

---

#### P1-3：`DiagnosticLogger` 死代码

**位置**：`recording/diagnostics.ts`（116行）

**现状**：`DiagnosticLogger` 类全仓零引用，但它是专为卡顿诊断写的（inferredCaptureFps/dup/drop），排查时最该接却没接

**定性**：**非纯冗余，是生产级错误上报基础**。当前根本无法追踪用户录屏失败的错误信息——DiagnosticLogger 是唯一能落盘 ffmpeg/exe 诊断数据的机制，应激活而非删除

**修复方向**：接入录制管道（解析 ffmpeg stderr 的 frame=/dup=/drop= 行 + 错误行），落盘诊断日志供失败排查；window 模式解析 exe stdout JSON 协议（STATS/ERROR）一并记录

---

#### P1-4：`stop()` 中字符串前缀耦合

**位置**：`index.ts:497,622`

**现状**：
```typescript
if (!currentSourceId.startsWith('window:')) {  // 是否走 transcoding
  await stopTranscodingWatcher();
  await waitForTranscodeQueue();
}
// ...
if (currentSourceId.startsWith('window:')) {  // crash 路径
  const alive = await checkWindowAlive(currentSourceId);
```

**问题**：硬耦合 sourceId 格式，到处用字符串前缀区分模式

**修复方向**：引入显式的 `RecordingMode` 枚举（WINDOW / SCREEN），start 时确定，后续用模式判断而非字符串解析

---

#### P1-5：`window-watch.ts` 在 window 模式下空壳运行

**位置**：`recording/index.ts:142-151` 调用 `startWindowWatcher`，但 `enablePollingStop=false`

**现状**：window 模式下 `startWindowWatcher` 返回空壳 `{ stop() {} }`，但仍在 `stopRecording` 中调用 `windowWatcher.stop()`

**问题**：无功能但增加代码路径复杂度

**修复方向**：window 模式不调用 `startWindowWatcher`，仅保留 `isWindowAlive` 给 crash 路径

---

#### P1-6：FFmpeg 编码参数构建重复 3 处

**位置**：`external-transcode/index.ts:188-231`（buildFfmpegArgs）/ `transcoding/index.ts:153-209`（transcodeFile）/ `recording/index.ts:480-491`（spawnFfmpeg screen 模式）

**现状**：三处独立构建 h264_nvenc/h264_qsv/libx264 编码器选择与参数，容易不同步

**修复方向**：抽取共享的编码参数构建函数。

**注**：recording 层的 `spawnFfmpeg`（screen 模式）在 window_capture.exe 支持全屏后整层废弃（见 P2-3，exe 录制+编码+封装一步到位），届时此处重复自然消失，**当前不单独修改 ffmpeg 相关内容**（性价比低）；待 exe 全屏落地后，剩余重复为 external-transcode + transcoding 两处，再抽共享函数

---

#### P1-7：`store.ts` 整文件注释死代码

**位置**：`electron/handlers/store.ts`（16 行，全部注释）

**现状**：`storeHandlers` 整个对象被注释（L11-15），仅剩 import 和说明注释；preload.ts 未导入。阶段1本地存储方案废弃后的残留

**修复方向**：**保留为未来扩展**（非纯冗余）。本地存储 IPC 框架（绕开 cookie sameSite 限制持久化 token），阶段1方案废弃但框架可复用；暂不删除，后续启用时取消注释并接入 preload + main.ts IPC handler

---

#### P1-8：`EncodeProfile` 死代码链

**位置**：`recording/profiles.ts:32-39,67,130-135` + `recording/index.ts:30,38`

**现状**：
- `EncodeProfile` 接口定义了 bitrate/bf/rcLookahead/preset/gop
- `makeDefaultProfiles()` 产出 encode profile
- `buildExeArgs(enc)` 收 enc 参数但**函数体内完全不引用**（L71 注释「enc 字段预留…当前录制质量一律走 exe 默认值，不下传」）
- `EncodeProfile.bitrate=8_000_000` 与实际 VBR 码率（4000/6000）完全不符

**问题**：整条 encode 链（定义→产出→传递→接收但不读）是死代码，且 bitrate 值误导

**修复方向**：删除 `EncodeProfile` 类型 + `makeDefaultProfiles` 的 encode 返回 + `buildExeArgs` 的 enc 参数 + recording/index.ts 的 encode 字段

---

#### P1-9：`CropRect` / RECT 解析链死代码

**位置**：`recording/types.ts:14-19`（CropRect）+ `sentinel-client.ts:33,38,185`（解析 RECT）+ `index.ts:308`（onRect 空函数）

**现状**：
- sentinel-client 解析 RECT 协议 → 调用 `callbacks.onRect?.({x,y,w,h})`
- 但 window 模式传的 onRect 是空函数 `(_rect) => { /* window 模式不使用 crop */ }`
- CropRect 类型仅作为 onRect 参数类型存在，无实际数据消费

**问题**：RECT 解析→回调→空函数，整条链是死代码（解析了但上层不用 crop）

**修复方向**：删除 CropRect 类型 + sentinel-client 的 RECT 解析与 onRect 回调 + index.ts 的 onRect 空函数。screen 模式也不用 crop（全屏捕获无需裁剪）

---

#### P1-10：`/recording/finish` 接口调用重复 3 处

**位置**：`index.ts:535`（stop）/ `index.ts:770`（另一 finish 路径）/ `persistence/index.ts:227`（resumeUpload）

**现状**：三处独立拼接 `${apiOrigin}/api/rooms/${roomId}/recording/finish` 并 fetch，鉴权头/错误处理各不相同

**修复方向**：抽取共享的 `callFinishApi(roomId, apiOrigin, token)` 函数

---

### 🟢 P2：设计一致性/未来重构

#### P2-1：协调层 `index.ts` 947 行过长

**现状**：混合了双模式 + 外部转码 + 持久化 + IPC 注册 + 状态管理

**修复方向**：按职责拆分（如 `recorder-lifecycle.ts` / `recorder-ipc.ts` / `external-transcode-handler.ts`）

---

#### P2-2：`watch-mode` 已设计未集成

**现状**：3 文件纯新增，但未在 `registerRecorderHandlers` 中接线

**修复方向**：本轮重构后集成

---

#### P2-3：screen 模式 → window_capture.exe 统一

**目标**：window_capture.exe 扩展 `--screen <index>` 参数支持 WGC 全屏捕获

**exe 侧改动**：
- `config.cpp`：新增 `--screen` 参数解析
- `capture_session.cpp`：WGC 源类型从 `window_capture` 切换为 `monitor_capture`（OBS 原生支持 WGC 全屏）
- 无需新增编码/封装逻辑（已有 HLS muxer）

**CoWatch 侧改动**：
- 删除 `spawnFfmpeg()` / `attachFfmpegHandlers()` / `getAudioCapturePath()` / `resolveAvfIndex()`
- 删除 `transcoding/index.ts` 整个文件
- 删除 `recording/diagnostics.ts`（死代码）
- `start()` 统一走 exe 路径，按 `--hwnd` vs `--screen` 区分
- `sentinel-client.ts` 仅 window 模式需要，screen 模式不需要

---

#### P2-4：统一文件命名规范

**现状**：
- window 模式：`seq%05d.ts`（定宽5位、从1起）
- screen 模式：`seg%03d.ts` / `seg%03d_opt.ts`（定宽3位、从0起）

**修复方向**：统一为 `seq%05d.ts`（从1起），后端按文件名字典序重组时天然有序

---

#### P2-5：`shared.ts` 职责混乱

**位置**：`recorder/shared.ts`（78 行）

**现状**：一个文件混了三个不相关职责：
- FFmpeg 路径解析（`getFfmpegPath()`）
- SessionAnchor（pause/resume 续录锚点机制）
- 共享常量（HLS_SEGMENT_DURATION 等）

**修复方向**：拆分为 `ffmpeg-path.ts` + `session-anchor.ts` + 常量留在 shared.ts

---

#### P2-6：`detectEncoder` 与 window 模式脱节

**位置**：`index.ts:188-220`（detectEncoder）+ `index.ts:326`（makeDefaultProfiles）

**现状**：`detectEncoder()` 用 ffmpeg 探测 h264_nvenc/qsv/amf，但 window 模式实际用 exe 内部的 `obs_nvenc_h264_tex`（与 ffmpeg 探测结果无关）。检测结果传给 `makeDefaultProfiles` 产出 encode profile，但 encode 不下传（见 P1-8）→ 造成「检测有用」的假象

**问题**：检测结果仅对 screen 模式（spawnFfmpeg）有意义；window 模式的检测是空转

**修复方向**：screen 模式废弃后，detectEncoder 一并删除；过渡期可仅在 screen 分支调用

---

#### P2-7：`profiles.ts` 码率硬编码

**位置**：`recording/profiles.ts:104-112`（buildExeArgs 内 vbrByRes）

**现状**：`vbrByRes` 在函数内部定义，720p/900p 码率（4000/6000、6000/9000）硬编码，无法外部覆盖；新增分辨率档需改代码

**修复方向**：码率配置外置为模块级常量或参数，buildExeArgs 从参数读取

---

#### P2-8：IPC 注册隐式依赖

**位置**：`index.ts:924`（registerRecorderHandlers 末尾调用 registerWatchHandlers）

**现状**：`registerWatchHandlers()` 在 `registerRecorderHandlers()` 末尾被隐式调用，watch-mode 的 IPC 注册依赖 recorder 的注册触发

**修复方向**：在 main.ts 中显式调用 `registerWatchHandlers()`，解除隐式依赖

---

## 四、重构方案（分阶段）

### Phase 1：P0 Bug 修复（紧急，不架构变动）

**目标**：修复 window 模式的功能性 Bug，不改动架构

| 编号 | 修复项 | 文件 | 改动量 |
|------|--------|------|--------|
| P0-1 | `getNextSegmentNumber` 支持 `seq%05d.ts` | recording/index.ts | ~10行 |
| P0-2 | `parseSegmentIndex` 支持 `seq%05d.ts` | persistence/index.ts | ~5行 |
| P0-3 | `enqueueMissingFiles` 按模式过滤 | upload/index.ts | ~10行 |

**风险**：低，纯 Bug 修复

---

### Phase 2：P1 清理（中期，低风险删改）

**目标**：清理死代码和残留，降低后续重构复杂度

| 编号 | 清理项 | 文件 | 改动量 |
|------|--------|------|--------|
| P1-1 | 删除 `muxProc`/`muxReady`，保留 `currentMuxProfile` 续号 | recording/index.ts | ~20行 |
| P1-2 | 状态集中到协调层，录制层通过参数传递 | recording/index.ts + index.ts | ~60行 |
| P1-3 | 删除 `diagnostics.ts` 或接入管道 | diagnostics.ts | 删除或~30行接入 |
| P1-4 | 引入 `RecordingMode` 枚举替代字符串前缀 | index.ts + recording/index.ts | ~30行 |
| P1-5 | window 模式不调用 `startWindowWatcher` | recording/index.ts | ~10行 |
| P1-6 | 抽取共享编码参数构建函数 | transcoding + external-transcode | ~40行 |

**风险**：中低，需要回归测试 pause/resume/crash 路径

---

### Phase 3：screen 模式统一到 exe（大改，需架构决策）

**目标**：window_capture.exe 扩展 screen 支持，CoWatch 侧删除 ffmpeg 录制路径

#### 3a. exe 侧扩展
- `config.cpp`：新增 `--screen <index>` 参数
- `capture_session.cpp`：WGC 源切换为 `monitor_capture`
- 测试 WGC 全屏捕获的兼容性（独占全屏游戏/HDR/多显示器）

#### 3b. CoWatch 侧清理
- 删除 `spawnFfmpeg()` / `attachFfmpegHandlers()` / `getAudioCapturePath()` / `resolveAvfIndex()`
- 删除 `transcoding/index.ts`
- 删除 `recording/diagnostics.ts`（如果 Phase 2 未删）
- `start()` 统一走 exe 路径
- `sentinel-client.ts` 仅 window 模式启动

#### 3c. 统一文件命名
- exe 已用 `seq%05d.ts`，screen 模式统一后自然一致
- `getNextSegmentNumber` / `parseSegmentIndex` 统一为一个正则

**风险**：高，exe 侧改动需要重新编译+真机测试 WGC 全屏兼容性

---

### Phase 4：协调层拆分（可选，改善可维护性）

**目标**：把 947 行的 `index.ts` 拆分为职责清晰的模块

```
recorder/
├── lifecycle.ts        start/stop/crash 重启（~250行）
├── ipc.ts              IPC 注册（~150行）
├── external-handler.ts 外部转码+监听模式入口（~200行）
├── state.ts            集中状态管理（~50行）
├── recording/          录制层（精简后 ~300行）
├── upload/             上传层（不变）
├── persistence/        持久化（不变）
├── sentinel-client.ts  哨兵（不变）
└── shared.ts           共享（不变）
```

**风险**：中，纯重构不改功能，但需要完整回归

---

## 五、决策记录（2026-07-31 用户确认）

| 决策项 | 结论 | 说明 |
|--------|------|------|
| 执行方式 | **本轮只输出文档，不执行代码改动** | 所有 Phase 等文档细化讨论定稿后再动手 |
| P0 修复时机 | 先讨论再定 | 想先看具体修复 diff 再决定是否立即执行 |
| Phase 3a exe 扩展 | 先讨论 | 与其他问题一样，本次只输出文档，细化后再做 |
| Screen 模式过渡 | 标记废弃但保留 | Phase 3 完成前，screen 旧路径加 `@deprecated` 注释，功能保留不维护新特性 |
| macOS 支持 | **已移除 macOS 死代码** | 2026-07-31 已删全部 `darwin`/`avfoundation` 分支（5 文件 ~90 行）；CoWatch 自始为 Windows-only，macOS 仅是早期开发环境受限时的临时考虑 |

## 六、待讨论问题（细化中）

> 以下问题本轮仅讨论和细化文档，不执行。

### Q1：Phase 1 P0 Bug 修复——是否立即执行？

**3 个 Bug 当前就会出问题，但不影响首次录制（仅影响 crash 续录 / pause-resume / 持久化补传）：**

| Bug | 触发条件 | 后果 | 修复量 |
|-----|---------|------|--------|
| P0-1 `getNextSegmentNumber` 不匹配 `seq%05d.ts` | window 模式 crash 重启 或 pause-resume | 续号永远返回 0 → 覆盖已有切片 | ~10行 |
| P0-2 `parseSegmentIndex` 不匹配 `seq%05d.ts` | window 模式 stop 时持久化 manifest | 所有 segment index=0 → 后端重组顺序错乱 | ~5行 |
| P0-3 `enqueueMissingFiles` 重复上传 | screen 模式 stop 时扫描 tmpDir | 原始+转码切片都可能被补传 | ~10行 |

**讨论要点**：
- P0-1 和 P0-2 修的是同一个根因（文件名正则不匹配），建议一起修
- P0-3 仅影响 screen 模式，如果 screen 标记废弃则优先级降低
- 修复方向有两种选择，需讨论：
  - **方案 A**：按模式匹配不同正则（`seq%05d.ts` + `seg%03d_opt.ts` 都支持）
  - **方案 B**：统一文件命名为 `seq%05d.ts`，删掉旧正则（但需要 exe 侧确认 screen 模式也用这个格式）

### Q2：Phase 2 的 P1-2（双份状态）是否在这一轮做？

**现状**：协调层 `index.ts` 和录制层 `recording/index.ts` 各自维护 5 个同名变量，更新时机不同，crash 重启时可能不一致。

**讨论要点**：
- 这是 Phase 2 中最大的改动（~60行），影响所有路径
- 如果 Phase 3 要做（screen 统一到 exe），协调层和录制层都会大改，P1-2 提前做可能白费
- **建议**：如果确定做 Phase 3，P1-2 推迟到 Phase 4（协调层拆分）一起做；如果不做 Phase 3，P1-2 在 Phase 2 做

### Q3：Phase 3a 的 exe 扩展——C++ 改动范围

**exe 侧需要的改动**（基于 window_capture 仓库代码阅读）：

| 文件 | 改动 | 难度 |
|------|------|------|
| `config.cpp` | 新增 `--screen <index>` 参数解析 | 低（仿照 `--hwnd`） |
| `capture_session.cpp` | WGC 源从 `window_capture` 切换为 `monitor_capture` | 中（OBS 原生支持，需验证 API 调用差异） |
| `capture_session.cpp` | 全屏捕获的画布尺寸/裁剪逻辑 | 中（窗口模式有 crop，全屏模式不需要） |

**讨论要点**：
- OBS 的 `monitor_capture` 源类型原生支持 WGC 全屏，API 层面改动不大
- 但需要验证：独占全屏游戏兼容性、HDR→SDR 色彩转换、多显示器选择
- 谁来做 C++ 改动？团队全做 / TS 归团队 C++ 归用户 / 先不做
- **本轮结论**：先讨论，本次只输出文档

### Q4：Phase 3 期间 screen 模式的过渡策略

**用户已决定**：标记废弃但保留。

**具体做法**：
- `recording/index.ts` 的 `spawnFfmpeg()` / `attachFfmpegHandlers()` 加 `@deprecated` JSDoc 注释
- `transcoding/index.ts` 文件头加 `@deprecated` 注释
- `start()` 中 screen 分支加注释 `// @deprecated Phase 3 后将由 exe --screen 替代`
- 功能保留，不删代码，不加新特性
- 前端 UI 暂不改动（screen 模式选项仍可用）

### Q5：macOS 支持处理

**用户已决定**：移除 macOS 相关代码。CoWatch 自始为 Windows-only 产品，macOS 从未是产品需求。

**背景**：早期因开发环境受限（在 macOS 上开发），临时保留了 `darwin`/`avfoundation` 分支与 electron-builder 的 `mac:` 打包配置。但目标平台始终是 Windows，这些只是开发期的临时兼容，非产品目标。

**已完成（2026-07-31）**：
- 删除 `recording/index.ts` 的 `resolveAvfIndex()` 及 `avfoundation` 分支（`darwin` ffmpeg 输入）
- 删除 `cachedAvfIndex` 全链路变量与 `RecordingConfig.cachedAvfIndex` 字段
- 简化 `main.ts`（移除 `app.on('activate')`）、`shared.ts`（`getFfmpegPath` 平台包裹）、`electron-builder.yml`（`mac:` 段）
- 共 5 文件，净删除约 90 行死代码；Windows 运行时行为不变
- AI 工具配置同步清理（2026-07-31 追加）：`.claude/CLAUDE.md`（第29行删 `macOS 静音`/`macOS avfoundation` 描述）与 `.catpaw/rules/aiPartner/项目背景.md`（第43行同删）；Windows 录制/音频描述原样保留——避免 AI 读取元配置时仍按 macOS 兼容理解项目

**结论**：后续无需考虑 macOS 兼容；如确有跨平台需求，走独立方案（不依赖 window_capture.exe）。

### Q6：`external-transcode` 的定位

**现状**：`external-transcode/index.ts`（290行）是独立的"用户选视频文件→FFmpeg→HLS→upload"功能，与录制链路无关，但共享 upload 层。

**讨论要点**：
- 它使用的是 CoWatch 自带的 `ffmpeg.exe`（非 window_capture.exe）
- 如果 Phase 3 删除了录制路径的 ffmpeg 调用，`external-transcode` 仍需 ffmpeg（用途不同）
- 选项：
  - **A**：保留独立，ffmpeg 路径解析仍走 `shared.ts` 的 `resolveFfmpegPath()`
  - **B**：也改用 exe（但 exe 是实时捕获，不适合文件转码）
  - **C**：抽取为独立模块（不归 recorder 管）
- **建议**：选 A，external-transcode 与录制链路解耦，保留独立 ffmpeg 路径
