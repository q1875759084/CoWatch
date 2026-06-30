# CoWatch 项目记忆

## 项目概述
- Electron + React + TypeScript 桌面应用，支持屏幕/窗口录屏并上传至云端
- 录屏核心：Windows 用 ddagrab(整屏) / gfxcapture(窗口)，macOS 用 avfoundation
- 音频：Windows 用 audio_capture.exe (WASAPI Loopback)，通过 pipe 传入 ffmpeg
- 输出格式：HLS (hls_time=10s, h264_nvenc/amf/qsv 硬编码)

## 录制架构关键点
- `electron/handlers/recorder.ts` 是核心录制逻辑（1300+ 行）
- 双队列容错上传：pRetry → pendingQueue → triggerRetryQueue 指数退避补传
- ffmpeg crash 自动重启（MAX_CRASH_RESTARTS=3），通过 -hls_start_number 续录
- stop() 流程：cleanup → 扫描尾片补传 → await activeUploads → pendingQueue 2轮补传 → finish 接口 → 清理临时目录

## 已知问题与解决方案
- 窗口录屏模式下被录制窗口关闭时，ffmpeg 误判为 crash 并无意义重启 3 次后报错
- 无主动窗口状态检测机制
- CoWatch 主窗口关闭时无 before-quit 钩子，ffmpeg 被强杀，尾片丢失
- **解决方案**：window_sentinel.exe（Rust + SetWinEventHook）+ 轮询兜底
  - sentinel 通过 SetWinEventHook(EVENT_OBJECT_DESTROY) 监听目标 hwnd 关闭
  - 窗口关闭 → 输出 "CLOSED" 到 stdout → Node.js readline → stop() 优雅停止
  - sentinel 异常退出 → fallback 到 desktopCapturer 每 2s 轮询
  - 进程假死 → 两种方案都无法检测，ffmpeg crash 重启兜底（原问题不变）
  - 源码位置：electron/sentinel-src/（Rust + windows-rs crate）
  - 集成代码：docs/sentinel-recorder集成代码.md
  - 风险分析：docs/窗口哨兵集成风险分析.md

## 项目二进制依赖（electron/bin/）
- ffmpeg.exe — gyan.dev full build（含 ddagrab filter）
- audio_capture.exe — WASAPI Loopback 音频采集（huxinhai/audio-capture）
- window_sentinel.exe — 窗口关闭哨兵（自编译，Rust + windows-rs）
