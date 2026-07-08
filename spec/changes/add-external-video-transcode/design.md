# 桌面端外部视频转码上传 技术设计

## 1. 功能概述

桌面端（Electron）利用内置 ffmpeg，将用户用自带录屏软件产出的原始视频转码为符合 CoWatch 规范的 HLS 分段，**边转码边上传**。省去 Web 端"下载 .bat → 手动运行 → 等待整段压缩 → 上传整段 MP4"的中间步骤。仅面向 Electron 客户端用户。

## 2. 涉及模块

| 模块 | 类型 | 说明 |
|------|------|------|
| `electron/handlers/recorder/external-transcode/` | 🆕 新建 | 外部视频→HLS 分段转码核心，包含 FFmpeg 参数构建 + chokidar 监听 + 上传流水线 |
| `electron/handlers/recorder/index.ts` | 🔄 迭代 | 新增 IPC handler + File Dialog + 协调外部转码生命周期 |
| `electron/handlers/recorder/upload/` | 🔄 复用 | 已有上传层，`enqueueUpload()` + `doUpload()` 直接复用 |
| `src/types/recorder.ts` | 🔄 扩展 | 新增外部转码进度事件类型 |
| `src/pages/Room/` 上传区域 | 🔄 迭代 | Electron 环境下上传入口走转码管道 |

**后端无需改动**：分段通过已有 `/api/rooms/:roomId/recording/segment` 上传，完成后调用 `/api/rooms/:roomId/recording/finish`，与实时录制走同一套 API。

## 3. 架构设计

### 3.1 总体流水线

```
用户选文件 → FFmpeg 转码(HLS分段) → chokidar 监听新.ts → enqueueUpload() → COS
              \________________________/ \___________________________/
                    逐片产出                          逐片上传统
                    转码+上传流水线重叠（总耗时 ≈ max(转码, 上传)）
```

### 3.2 与现有录制管道的对比

| 阶段 | 现有录制管道 | 外部视频转码 |
|------|------------|------------|
| 输入 | 屏幕/窗口捕获（ddagrab/gfxcapture） | 本地视频文件（mp4/mkv/mov...） |
| 录制层 | FFmpeg HLS 录制 → seg*.ts | ❌ 不需要 |
| 转码层 | seg*.ts → seg*_opt.ts | 输入文件 → seg*_opt.ts（一步到位） |
| 上传层 | enqueueUpload(seg*_opt.ts) | 复用 `enqueueUpload(seg*_opt.ts)` |
| 结尾 | /recording/finish | 复用 /recording/finish |

### 3.3 模块职责

```
external-transcode/index.ts
├── startExternalTranscode(inputPath, outputDir, config)
│   ├── spawn FFmpeg（输入文件→HLS 分段，直接输出 _opt.ts）
│   ├── chokidar 监听 outputDir 新 _opt.ts 文件
│   └── 每发现一个 → enqueueUpload() → 上传层
├── stopExternalTranscode()
│   └── 终止 FFmpeg + 等待转码/上传排空
└── 类型定义
    ├── ExternalTranscodeConfig（roomId, authToken, apiOrigin, detectedEncoder...）
    └── ExternalTranscodeCallbacks（onProgress, onComplete, onError, onLog）
```

## 4. FFmpeg 转码参数

### 4.1 参数总表

与 Electron 转码层（`transcoding/index.ts`）对齐，差异点标注如下：

| 参数 | 值 | 来源 | 说明 |
|------|-----|------|------|
| 缩放 | `scale=w='min(iw,1600)':h=-2,format=yuv420p` | .bat 宽度上限 + 转码层 pix_fmt | 900p 上限，Web 端 .bat 同值 |
| 编码器 | NVENC → QSV → AMF → libx264 | 转码层 | 自适应检测 |
| 质量（硬编） | `-rc vbr -cq 30 -b:v 0` | 转码层 | NVENC CQ 30 |
| 质量（软编） | `-crf 30 -preset medium` | 转码层 | libx264 CRF 30 |
| B 帧（硬编） | `-bf 2` | 转码层 | NVENC |
| Lookahead（硬编） | `-rc-lookahead 20` | 转码层 | NVENC 码率前瞻 |
| Preset（硬编） | `-preset p5` | 转码层 | 质量优先 |
| GOP 上限 | `-g 300` | 转码层 | 10s@30fps，允许场景检测（**不加** -keyint_min / -sc_threshold 0） |
| 帧率 | `-vsync cfr -r 30` | 转码层 | 恒定帧率 |
| 音频 | `-c:a aac -b:a 128k` | .bat | 来源不可控，重编码保证兼容 |
| 输出容器 | `-f hls` + `-hls_time 10` | 录制层 | 直接产 HLS 分段，跳过 mpegts 中间态 |
| 分段命名 | `seg%03d_opt.ts` | 转码层 | 匹配上传层 `enqueueUpload` 期望的文件名 |

### 4.2 参数与 .bat 的关键差异

| .bat | 桌面端 | 原因 |
|------|------|------|
| `-sc_threshold 0 -keyint_min 300` | 不加（允许场景检测） | 后端不依赖等长 GOP，压缩率提升 5-10% |
| `b-adapt=0`（veryfast 默认） | `b-adapt=1`（medium 默认）/ NVENC lookahead 驱动 | 压缩率提升 20-30% |
| `-preset veryfast` | `-preset medium` / `-preset p5` | 已有硬件加速，时间换空间 |
| 仅软件编码 | 硬件优先 | 桌面端有 NVENC/QSV/AMF |

### 4.3 FFmpeg 命令示例

**NVENC（硬件编码）**：
```bash
ffmpeg -i input.mp4 \
  -vf "scale=w='min(iw,1600)':h=-2,format=yuv420p" \
  -c:v h264_nvenc -rc vbr -cq 30 -b:v 0 -preset p5 -bf 2 -rc-lookahead 20 \
  -c:a aac -b:a 128k \
  -vsync cfr -r 30 \
  -g 300 \
  -f hls -hls_time 10 -hls_list_size 0 \
  -hls_segment_filename seg%03d_opt.ts \
  -start_number 0 \
  index.m3u8
```

**libx264（软件兜底）**：
```bash
ffmpeg -i input.mp4 \
  -vf "scale=w='min(iw,1600)':h=-2,format=yuv420p" \
  -c:v libx264 -crf 30 -preset medium \
  -c:a aac -b:a 128k \
  -vsync cfr -r 30 \
  -g 300 \
  -f hls -hls_time 10 -hls_list_size 0 \
  -hls_segment_filename seg%03d_opt.ts \
  -start_number 0 \
  index.m3u8
```

## 5. 交互流程

### 主流程（EARS 语法）

1. **When** 用户在 Electron 客户端的房间页点击"上传视频"按钮，**the system shall** 弹出原生文件选择对话框（仅视频格式），而非浏览器 `<input type="file">`。
2. **When** 用户确认文件后，**the system shall** 在临时目录创建 `cowatch-ext-{uuid}/`，启动 FFmpeg 转码。
3. **When** FFmpeg 写出一个 `segXXX_opt.ts` 完成写入后，**the system shall** 通过 chokidar 检测到并调用 `enqueueUpload()` 立即上传。
4. **When** 上传层完成每片上传，**the system shall** 通过 IPC 推送进度到渲染进程（已上传片数 / 总片数或百分比）。
5. **When** FFmpeg 正常退出（code=0）+ 上传队列全部排空，**the system shall** 调用 `/recording/finish`，视频出现在房间视频列表中。
6. **When** 转码或上传过程中用户取消，**the system shall** 清理已产出的临时文件，终止 FFmpeg，放弃未上传的切片。

### 异常处理

| 异常 | 处理 |
|------|------|
| FFmpeg 启动失败 | IPC 推送错误消息（"视频转码启动失败"），不创建临时目录 |
| FFmpeg 中途 crash | 已上传的分段丢失（后端不完整），推送错误，清理临时目录 |
| 单片上传失败 | 上传层已有指数退避 + pendingQueue 机制，最多重试 2 次 |
| 用户取消 | 终止 FFmpeg（SIGTERM），等待上传排空，清理临时目录 |
| 输入文件格式不支持 | FFmpeg 解析阶段失败，推送"不支持的视频格式"错误 |
| Token 过期 | 上传层已有主进程自行 refresh 机制 |

## 6. 类型定义

```typescript
// src/types/recorder.ts

/** 外部视频转码进度 */
export interface ExternalTranscodeProgress {
  /** 已上传分段数 */
  uploaded: number;
  /** 预估总分段数（基于视频时长 / 10s，-1 表示未知） */
  estimated: number;
  /** 转码状态 */
  phase: 'transcoding' | 'uploading' | 'completed' | 'failed';
}
```

## 7. IPC 通道

| 通道 | 方向 | 说明 |
|------|------|------|
| `recorder:transcodeExternal` | renderer → main (handle) | 触发外部视频转码。renderer 通知主进程打开文件选择对话框并开始转码 |
| `recorder:transcodeExternal:progress` | main → renderer (send) | 推送转码/上传进度 |
| `recorder:transcodeExternal:cancel` | renderer → main (handle) | 用户取消转码 |

## 8. 与现有录制互斥

外部转码和实时录制共用上传层（模块级单例），因此**不能同时进行**：
- 启动外部转码前检查 `isRecording()`，若正在录制则拒绝
- 启动录制前检查外部转码状态，若正在转码则拒绝
- 前端 UI 在任一项进行中时禁用另一项的入口

## 9. 关键决策记录

| # | 问题 | 结论 |
|---|------|------|
| 1 | 编码器选择 | 与 Electron 转码层一致：NVENC > QSV > AMF > libx264 兜底 |
| 2 | 输出格式 | HLS 分段（边转边传），不复用 MP4 |
| 3 | 音频 | 重编码 AAC 128k（输入来源不可控） |
| 4 | GOP | 仅 `-g 300`，允许场景检测 |
| 5 | 传输方式 | 分段流水线，转一片传一片，复用 upload 层 |
| — | 清晰度上限 | 900p（`min(iw, 1600)`） |
| — | B 帧 | 与转码层一致（NVENC: `-bf 2`，软编: 默认 + b-adapt=1） |
| — | Lookahead | 硬编保留 `-rc-lookahead 20`，软编不需要 |
| — | Preset | NVENC: `p5`，软编: `medium` |
