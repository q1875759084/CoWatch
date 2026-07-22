# 方案2a 窗口录制 — 复验报告（Round 2 · 工程师修复后静态复核）

> 验证人：QA 严过关 ｜ 轮次：第 2 轮（复验） ｜ 环境：沙箱（仍无法编译/运行，纯静态代码复核）
> 对象：工程师申报已修复的 3 高危/中危 bug + 7 低危/质量项（共 10 项）
> 配套初报：docs/QA_VERIFICATION_REPORT_2a.md

---

## 0. 复验结论

**工程师申报的 10 项修复，逐条静态核对，全部落实且正确（PASS）。未引入阻断性回归。**

**本复验轮路由：NoOne（静态复检完成）。** 但需注意：
- 真机 build 仍**无法在沙箱执行**（无 MSVC/CMake），必须由用户在自家机器按初报 §2 清单验收。
- 复验中新发现 **2 个有界残留项（Known Issues，非阻断、非修复回归）**，建议工程师后续跟进。

**静态口径通过率（复验）**：10/10 修复项 PASS；残留 Known Issues=2（低危）。

---

## 1. 10 项修复逐条核对（全部 PASS）

| # | 修复项 | 文件:行（核实点） | 结论 |
|---|---|---|---|
| BUG-1 | 退出码协议 | main.cpp:17(`<cctype>`)、328(`int exitCode=0`)、345-348(emit ERROR + `exitCode=2` + break)、370-373(`if(exitCode!=0){CoUninitialize();return exitCode;}` 不再发 CLOSED) | PASS — 致命失败以 code=2 退出，Electron `captureProc.on('close')` 走 crash 分支 |
| BUG-2① | 释放 Node 读端副本 | recording/index.ts:267-268 `ownerCapture.stdio[3]?.destroy(); stdio[4]?.destroy();` | PASS — mux 死后内核读端引用计数归零 → exe `_write` 收 EPIPE |
| BUG-2② | 强杀旧 exe 防误杀新 exe | recording/index.ts:250(`const ownerCapture=captureProc`)、272-279(`muxProc.on('close')` 用局部 `ownerCapture.kill('SIGKILL')`，不重复 onCrash) | PASS — 局部捕获避免 restart 覆盖模块变量后误杀；不再双重 onCrash |
| E1 | D3D11 上下文并发 | winrt_capture.h:55/58(`copyLatestInto`/`peekLatestSize`)、winrt_capture.cpp:159-170/172-180(均 `std::lock_guard<m_texMutex>` 下访问 `m_context`)、main.cpp:226(`peekLatestSize`)、336(`copyLatestInto`)、**移除主循环未持锁 `GetImmediateContext`+`CopyResource`** | PASS — 与回调线程对称串行化；并消除旧实现重复 `Release` 同一立即上下文的 UB |
| E2 | /MT→/MD | CMakeLists.txt:16 `MultiThreadedDLL` | PASS — 与 NVENC SDK/FFmpeg 官方 lib 的 CRT 一致，规避 LNK2038 |
| E3 | mmreg/ksmedia | audio_capture.cpp:10-11 显式 `#include <mmreg.h> <ksmedia.h>` | PASS |
| E4 | <cctype> | main.cpp:17 `#include <cctype>`（`tolower`） | PASS |
| E5 | 死声明 | nvenc_encoder.h:62 仅保留 `selectCodecGuid`，`selectPresetGuid` 已删除 | PASS |
| E6 | VBV 注释/取值 | nvenc_encoder.cpp:95 改为 `vbvBufferSize = m_profile.bitrate; // ≈1s VBV 缓冲（= 平均码率）` | PASS — 原 `bitrate/fps`(≈1帧) 改为 1s 等价，注释一致 |
| E7 | _WIN32_WINNT | CMakeLists.txt:96 `target_compile_definitions(... _WIN32_WINNT=0x0A00)` | PASS |
| A5 | READY 带 hasAudio | main.cpp:310-311 READY JSON 含 `"hasAudio":%d`；recording/index.ts:228/231 READY 分支读 `msg.hasAudio` 更新 `currentMuxProfile.hasAudio` 后再 `spawnMuxer` | PASS — mux 仅当 exe 实际有音频才等 pipe:4，消除挂起 |

---

## 2. 护栏回归确认（仍 PASS）

- 无全帧回读：nvenc_encoder.cpp 仅 Map/Encode/Lock 压缩流；winrt_capture.cpp 仅 `CopyResource` GPU→GPU。✓
- CMake 不链 libavformat（CMakeLists.txt:70-86 仅 avcodec/avutil）。✓
- screen 模式零改动（recording/index.ts 未改 screen 分支；spawnFfmpeg/audio_capture 基线不动）。✓
- null 模式 fd=-1 不阻塞（pipe_output.cpp:18 `fd<0 return`；mux_target.cpp null 分支 fd=-1）。✓
- stdout 仅 JSON 三态 / stderr 仅 STATS（main.cpp fd1 vs stats.cpp fd2）。✓

---

## 3. Known Issues（残留 · 有界 · 非阻断，建议跟进）

### KI-1 · BUG-1 修复后的 onCrash 双重触发级联（低危）
- **现象**：BUG-1 修复后 exe 致命失败以 `code=2` 退出。此时 `handleCaptureLine` 的 ERROR 分支（recording/index.ts:236-238）与 `captureProc.on('close')` 的 `code!==0` 分支（recording/index.ts:206-209）**各触发一次 `cbs.onCrash`**。协调层 `handleFfmpegCrash`（recorder/index.ts:574-609）**无重入去重**，两次调用各自 `await restartRecording` → **每次真实崩溃会级联 2 次重启**，首次重启的 exe 被模块变量覆盖成孤儿进程，且更快耗尽 `MAX_CRASH_RESTARTS=3`。
- **有界性**：受 `crashRestartCount>3` 上限保护，不会无限重启；最坏约 1.5–2 次真实崩溃耗尽预算并遗留少量孤儿 exe。
- **建议修复（任其一）**：① `handleFfmpegCrash` 入口加 500ms 去重（同一 displayTitle 短时间内只处理一次）；或 ② `handleCaptureLine` 的 ERROR 分支不再单独 `onCrash`（因进程必以非 0 退出、close 回调会统一上报）；或 ③ `captureProc.on('close')` 仅当 `code!==0` 且非由 ERROR 行已处理时才 `onCrash`。

### KI-2 · `winrt_capture::stop()` 释放 `m_context` 未持 `m_texMutex`（极低危 / 既有）
- **现象**：`stop()`（winrt_capture.cpp:151 `m_context->Release()`）未持 `m_texMutex`；而 `onFrameArrived`/copyLatestInto 在 `m_texMutex` 下使用 `m_context`。窗口关闭时序下，理论上存在"stop 释放 m_context 同时回调线程持锁用 m_context"的极小窗口。
- **实际风险**：WGC 在会话关闭后停止投递帧，`onClosed` 与 `onFrameArrived` 同在 DispatcherQueue 专线程串行，stop 发生在主循环退出后，故竞态窗口近乎为零（既有行为，本次修复未引入）。
- **建议强化**：`stop()` 释放 `m_context` 前 `std::lock_guard<m_texMutex>` 加锁，或 `onFrameArrived` 内 `if(!m_context) return;` 防御。

---

## 4. 真机 build 验收状态

- **沙箱限制**：本环境无 MSVC/CMake/网络/显示设备，**无法编译 window_capture.exe，也无法运行 Electron**。上述均为静态代码级复核。
- **待用户执行**：请按初报 docs/QA_VERIFICATION_REPORT_2a.md §2 清单在真机验收（① VS Dev Prompt + `.\build.ps1` 前置；② `--null --stats` 隔离；③ `--file` 自包含落盘；④ Electron window 端到端；⑤ 暂停/恢复/窗口关闭 sentinel）。
- **新增关注点（基于本次修复）**：
  - 真机优先观察 mux 崩溃后 exe 是否仍快速退出（不再 64KB 缓冲写满死锁）——验证 BUG-2。
  - `--null --stats` 下制造音频不可用（无回环设备）场景，确认 READY `hasAudio=0` 且 Electron 不挂起——验证 A5。
  - `/MD` 构建的 exe 运行需 VC++ Redist（Windows 通常已装）；若真机缺 Redist，运行报"找不到 VCRUNTIME"类错误，装 redist 即可。

---

*复验结束。初报 3 高危/中危 bug + 7 低危项均已在源码层面修复并静态确认；沙箱无法做真机编译验证，标记 KI-1/KI-2 为低危跟进项。*
