# 方案2a 窗口录制（window_capture.exe + Electron 集成）静态验证报告

> 验证人：CoWatch QA（严过关）
> 验证环境：**沙箱**（无法编译 C++ / 无法运行 Electron / 无 cl/cmake/网络/真实显示设备）
> 验证性质：**静态一致性审查 + 协议贯通性审查 + 真机 build/自测清单编制**（不声称"已编译通过/已运行通过"）
> 审查对象：C++ `electron/bin/capture-src/*` + TS `electron/handlers/recorder/recording/{index.ts,profiles.ts}`、`electron/handlers/recorder/{index.ts,shared.ts}`、支撑 `window-watch.ts`、`sentinel-client.ts`、`recording/types.ts`
> 对照：设计 `docs/axy-window-capture-design.md` §1.1–§1.6 / T02–T09；架构评审 `docs/architecture-review-obs-wgc.md` §K

---

## 0. 总判定（智能路由）

**路由决策：→ Engineer（software-engineer）**

发现 **3 个需要工程师修复的真实源码 bug**（含 1 个崩溃级线程安全、1 个死锁级健壮性、1 个退出码协议不符），外加若干低危编译风险点。**静态口径未通过"零阻断性 bug"标准**，须工程师修后再做真机 build 验证。

> 说明：本环境无法运行，故无可执行测试用例；下述"PASS/WARN/FAIL"为**静态一致性**结论。真机自测清单见 §2，用户须在其机器上验收。

**静态口径通过率（维度级）**：A 部分 PASS（含 1 处 FAIL 子项）｜B 部分 PASS（含 1 处 HIGH 健壮性缺陷）｜C 部分 全 PASS ｜D 部分 PASS（含 2 处 WARN）｜E 部分 **FAIL/WARN（含 HIGH 编译/线程风险）**。

---

## A. 协议契约一致性（设计 §1.4 vs 实现）

### A1. exe stdout JSON 三态 + 仅从 stdout 解析 —— `[PASS]`
- 状态行全部走 fd1（stdout）：
  - `emitJson`（main.cpp:41-44）、`emitError`（main.cpp:46-51）均 `_write(1, …)`；
  - `READY`（main.cpp:310-314，`_write(1, …)`）；
  - `CLOSED`（main.cpp:371-375，`emitJson` → fd1）。
- Electron 侧 **只解析 stdout**：`recording/index.ts:187-195`（`captureProc.stdout` 按行解析 → `handleCaptureLine`）；stderr 仅日志化（recording/index.ts:196-198），**不污染** READY/CLOSED/ERROR 握手。✓ 与设计 §1.4 一致。

### A2. `--stats` 遥测走 stderr（JSON `STATS`），不污染 stdout —— `[PASS]`
- `stats.cpp:138-149` `emit()` 用 `_write(2, …)`（fd2=stderr），字段 `capture_fps/encode_fps/gpu_pct/cpu_pct/drop_cnt/out_bps` 与设计 §1.6.C 一致。
- 与 A1 的 fd1 状态行互不混。✓

### A3. stdin `q` 优雅退出 —— `[PASS]`
- C++ 独立线程读 stdin：`main.cpp:58-66` `stdinControlLoop()` `_read(0,…)` 检测 `'q'/'\n'/'\r'` → `g_quit`。✓
- Electron 写 `q`：`recording/index.ts:272-287` `gracefulQuitWindow()` 对 `muxProc`/`captureProc` 均 `p.stdin?.write('q')`。✓

### A4. 退出码语义（参数缺失→2 / 初始化失败→1 / 正常→0）—— `[FAIL]`（子项）
- 参数解析失败 → `return 2`（main.cpp:181-184）；窗口三参皆缺 → `return 2`（main.cpp:186-190）；`resolveWindow` 失败 → `return 2`（main.cpp:187-190）。✓ 符合"参数缺失→2"。
- D3D11/WGC/NVENC/mux 初始化失败 → `return 1`（main.cpp:198-201、212-217、254-257、280-283）。✓ 符合"初始化失败→1"。
- 正常退出 → `return 0`（main.cpp:371-378）。✓
- **[BUG-1] 退出码协议不符（路由 Engineer）**：`main.cpp:352` NVENC 连续编码失败走 `emitError(2, "NVENC encode failed repeatedly")` 后 `break`，但随后 `main.cpp:365-378` 清理流程**仍然 `emitJson(CLOSED)` 且 `return 0`**——即"报告 ERROR(code=2) 却以干净退出码 0 结束"。后果：Electron 侧 `captureProc.on('close')`（recording/index.ts:199-210）对 `code===0` 判定为"窗口关闭类干净退出"→ `onShouldStop`，导致致命编码失败被误报为正常停止、不触发 crash 重启、错误隐蔽。**应改为：emit ERROR 后 `return 2`（且不应再发 CLOSED）**。

### A5. READY 缺少音频协商标志 —— `[WARN]`（路由 Engineer，低危）
- READY JSON（main.cpp:310-314）仅含 `w/h/fps/codec`，**无 hasAudio 字段**。Electron 侧 `buildMuxArgs` 的 `hasAudio` 取自 `MuxProfile`（recording/index.ts:252，默认 `true`，见 `makeDefaultProfiles` profiles.ts:165），而 exe 内 `hasAudio` 由"音频编码器是否真的初始化成功"决定（main.cpp:262-269、279）。
- 风险：若 exe 端音频初始化失败（无声卡/回环不可用），`muxTarget.hasAudio=false` → exe **不写 fd4**（mux_target.cpp:88、pipe 模式 `m_audioFd=-1`）；但 Electron mux 仍带 `-f aac -i pipe:4` 等待音频流 → ffmpeg-mux 因缺 pipe:4 数据而挂起/超时。建议：① READY 增加 `hasAudio` 字段由 Electron 据此重构 mux 参数；或 ② exe 音频失败时仍维持 fd4（写静音/空包）。属边界健壮性，非 happy-path blocker。

---

## B. fd 继承链路（方案2a 核心）

### B1. exe spawn 5 路 stdio —— `[PASS]`
- `recording/index.ts:184` `spawn(exePath, exeArgs, { stdio: ['pipe','pipe','pipe','pipe','pipe'] })` → fd0 stdin / fd1 stdout / fd2 stderr / fd3 视频写端 / fd4 音频写端。✓ 与设计 §1.2 一致。

### B2. spawnMuxer 用 `{fd: captureProc.stdio[3].fd}` / `{fd: captureProc.stdio[4].fd}` 继承读端 —— `[PASS]`（契约正确）
- `recording/index.ts:248-256`：`stdio[3] = { fd: captureProc.stdio[3].fd }`，`stdio[4] = { fd: captureProc.stdio[4].fd }`（hasAudio 时，否则 `'ignore'`）。ffmpeg-mux 参数 `-i pipe:3` / `-i pipe:4`（profiles.ts:108-127）。✓ 与设计 §1.2/§1.5 一致。

### B3. mux_target 三态 fd 行为 —— `[PASS]`
- `pipe` 模式：`mux_target.cpp:85-90` `m_videoFd=3; m_audioFd=hasAudio?4:-1`（**复用 Node 继承的 fd3/4，exe 不另建 pipe**）。✓
- `file` 模式：`mux_target.cpp:92-135` 私有 `CreatePipe` + `CreateProcessW(…, EXTENDED_STARTUPINFO_PRESENT, PROC_THREAD_ATTRIBUTE_HANDLE_LIST …)` 把读端继承给 ffmpeg-mux（写端 `_open_osfhandle` 转 fd 交给 PipeOutput）。✓ 与 Electron 侧同构（§1.6.A 方案 Y）。
- `null` 模式：`mux_target.cpp:78-83` `m_videoFd=m_audioFd=-1`，**不写 fd、不 spawn mux**；`pipe_output.cpp:17-18` `writeFd` 对 `fd<0` 直接 `return`（不 `_write`、不阻塞）。✓ **null 模式护栏达成，无"假定 fd3/4 必有读者"的写阻塞**。

### B4. 管道死锁健壮性缺陷 —— `[FAIL]`（路由 Engineer，HIGH）
- **[BUG-2] Electron 侧 fd 继承后未释放自身读端 → 死锁风险。** `spawnMuxer` 把 `captureProc.stdio[3].fd`/`[4].fd` 复制进 mux 后，**Node 仍持有 `captureProc.stdio[3]`/`[4]` 这两个 Readable（读端）打开**（recording/index.ts:184 创建的 pipe 流默认不关闭）。当 mux 崩溃/退出时，其继承的读端句柄关闭，但 Node 仍持有一份读端引用 → 内核管道读端引用计数未归零 → exe 的 `_write(fd3/fd4)` **不会收到 EPIPE**，而是把 64KB 内核缓冲写满后**永久阻塞在 `pipe_output.cpp:22` 的 `_write`**（设计 §1.6.A 明确预警的死锁场景）。
- 叠加：mux 崩溃回调 `muxProc.on('close')`（recording/index.ts:263-268）仅调 `onCrash`，而 crash 重启路径 `restartRecording`（recording/index.ts:341-373）**直接 `captureProc = spawn(...)` 覆盖模块级变量，未 kill 旧的阻塞 exe** → 旧 exe 泄漏 + 新 exe 并存。
- **修复建议**：① `spawnMuxer` 完成后立即 `captureProc.stdio[3]?.destroy(); captureProc.stdio[4]?.destroy();`，让 Node 释放自身读端副本（仅 mux 持有读端；mux 死 → EPIPE → exe 丢包继续而非阻塞）；② `muxProc.on('close')` 中 `captureProc?.kill('SIGKILL')` 兜底强杀旧 exe。此属设计 §1.6.F"护栏"的集成侧落地缺口，须修。

---

## C. 护栏达成（偏离即 FAIL）

### C1. 无全帧 GPU→CPU→GPU 回读 —— `[PASS]`
- `nvenc_encoder.cpp:161-197`：`nvEncMapInputResource`（GPU 侧注册纹理）→ `nvEncEncodeFrame` → `nvEncLockBitstream`（**仅取出压缩码流**，非全帧）→ `Unmap`。**无** `Map(D3D11_MAP_READ)` / staging / `GetBuffer` 把整帧拷回 CPU。✓（主理人已确认的"无 staging"在此再确认：Map 仅用于 NVENC 注册）。
- `winrt_capture.cpp:187` 帧回调仅 `m_context->CopyResource`（GPU→GPU 同设备拷贝）写入共享纹理，无 CPU 读回。✓
- 设计 §2.1 所列 `frame_buffer.*`（staging 回读）**目录中不存在**（已删除）。✓

### C2. exe 不链 libavformat（mux 交外部 ffmpeg-mux）—— `[PASS]`
- `CMakeLists.txt:70-86` 链接 `windowsapp/dwmapi/d3d11/dxgi/runtimeobject/ole32/oleaut32/uuid/mfplat/mfuuid/nvEncodeAPI/avcodec/avutil`。**无任何 avformat**。✓ 与设计 §1.1/§F 一致。

### C3. screen 模式零改动 —— `[PASS]`
- 转码层监听/排空被 `if (!currentSourceId.startsWith('window:'))` 守卫：`recorder/index.ts:470`（stopTranscodingWatcher/waitForTranscodeQueue）。✓
- screen 分支（recorder/index.ts:376-441）保留基线 ddagrab+`audio_capture.exe`+转码；`recording/index.ts:501-625` `spawnFfmpeg`/`audio_captureProcess` 路径**未被篡改**。✓
- window 模式成品 `segNNN_opt.ts` 直接进 upload（`startWindowUploadWatcher` recorder/index.ts:623-642，匹配 `_opt.ts`），**无 transcode 接线**。✓

---

## D. 参数注入（设计 §1.5 vs 实现）

### D1. `buildExeArgs()` 展开与 main.cpp 解析一致 —— `[PASS]`
- `profiles.ts:63-101`：窗口定位 `pid>hwnd>title`（71-77，pid 时附 `--window-index`），`--fps/--w/--h/--cursor`，`--codec/--bitrate/--bf/--rc-lookahead/--preset/--gop`，`--audio[--audio-device]`，`--out/--seg`，`--mux-target`，`--stats`。
- 与 `main.cpp:100-134` `parseArgs` 逐一对应（含 `--window-index` 100-109、`--mux-target` 125-129、`--stats` 130）。✓ 优先级 pid>hwnd>title（profiles.ts:71 vs main.cpp:136-157 `resolveWindow`）。✓

### D2. `buildMuxArgs()` 产出 `seg%03d_opt.ts` + `-c copy` —— `[PASS]`
- `profiles.ts:108-127`：`-y -fflags +genpts -f h264/hevc -i pipe:3` +（hasAudio）`-f aac -i pipe:4` + `-c copy -f hls -hls_time … -hls_list_size 0 -start_number … -hls_segment_filename <dir>/seg%03d_opt.ts <dir>/index.m3u8`。✓ 与 upload 层 `_opt.ts` 契约一致，零改动接入。

### D3. 参数不写死、默认值集中 profiles.ts —— `[PASS]`（注）
- exe 内 `main.cpp:78-98` 有 fallback 默认值（codec= h264_nvenc、bitrate=8M、bf=2…），但生产路径 `buildExeArgs` 始终显式注入（profiles.ts），默认值集中在 `makeDefaultProfiles`（profiles.ts:136-168）。exe 默认值仅作安全网、非覆盖。✓ 调试改 profiles.ts 即生效。

### D4. `--w/--h` 解析但未生效 —— `[WARN]`（INFO 级，非阻断）
- `main.cpp:111-112` 解析 `--w/--h`，但 `encW/encH` 实际取自**首帧尺寸**（main.cpp:232-235），`--w/--h` 仅作注释"v1 仅作提示/透传"未被应用。偏离设计 §1.4"强制输出尺寸覆盖首帧"，但与 §9.3"固定首帧尺寸+letterbox"决策一致。属已知取舍，不影响 happy-path；若需强制尺寸须在 exe 内加 resize/letterbox。

### D5. file 模式 C++ mux 输出命名与 Electron 不一致 —— `[WARN]`（INFO 级）
- `mux_target.cpp:108-115` 产出 `seg%03d.ts`（**无 `_opt`**），而 Electron `buildMuxArgs` 产出 `seg%03d_opt.ts`。file 模式为诊断自包含验证，不进入 upload 层，故可接受；但若用户期望 file 模式产物也能被 upload 拾取，须补 `_opt` 后缀。建议统一。

---

## E. 编译风险静态审查（真机 build 预警）

### E1. `[HIGH/BUG]` D3D11 立即上下文被双线程并发使用（崩溃级未定义行为）—— 路由 Engineer
- 捕获回调线程：`winrt_capture.cpp:180-189` 在 `m_texMutex` 保护下 `m_context->CopyResource(m_latestTexture, tex)`。
- 主循环线程：`main.cpp:340-343` `device->GetImmediateContext(&ctx)`（`ctx` 与 `m_context` 为**同一立即上下文**）后 `ctx->CopyResource(encodeTex, latest)`，**未持 `m_texMutex`**。
- 两线程对同一 `ID3D11DeviceContext` 并发调用方法 = D3D11 明确的线程不安全 → 数据竞争/偶发崩溃/纹理损坏。**修复**：把主循环 `getLatestTexture` + `CopyResource(encodeTex, latest)` + `GetDesc` 全部纳入 `m_texMutex` 保护（与回调对称），或在回调内完成"latest→encodeTex"拷贝、主循环只读已就绪的 encodeTex。

### E2. `[HIGH/WARN]` 静态运行时 `/MT` 与 FFmpeg 开发库 `/MD` 链接冲突风险
- `CMakeLists.txt:16` `CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<…>"` 强制 **/MT（静态运行时）**。若 `FFMPEG_ROOT` 提供的 `avcodec.lib/avutil.lib` 及 `nvEncodeAPI.lib` 为 **/MD（动态运行时）** 构建，链接将报 **LNK2038: mismatch detected for 'RuntimeLibrary'**。`build.ps1` 未校验对方运行时。建议：① 统一为 /MD（去掉第 16 行或改 `MultiThreadedDLL`）；或 ② 确保 FFmpeg/NVENC 库亦 /MT 构建；并文档化前置要求。

### E3. `[WARN/LOW]` `audio_capture.cpp` 可能缺 `mmreg.h`/`ksmedia.h`
- `audio_capture.cpp:67` `SPEAKER_FRONT_LEFT|SPEAKER_FRONT_RIGHT`（mmreg.h）、`:68` `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT`（ksmedia.h）。`<mmdeviceapi.h>/<audioclient.h>` 不一定传递性包含二者。MSVC 多数情况可用，但建议显式 `#include <mmreg.h>` `#include <ksmedia.h>` 防未声明标识符。

### E4. `[WARN/LOW]` `main.cpp:70` `tolower` 未含 `<cctype>`
- `parseBitrate` 用 `tolower(...)`，仅间接可能经 windows.h 传递可用。建议显式 `#include <cctype>`。

### E5. `[WARN/LOW]` `nvenc_encoder.h:63` 声明 `selectPresetGuid` 但 .cpp 未定义（定义名为 `presetGuidFor`，nvenc_encoder.cpp:18）
- 私有成员未调用 → 不触发链接错误，但头/源不同步、属死声明。建议删除头中 `selectPresetGuid` 声明或改名统一。

### E6. `[WARN/LOW]` `nvenc_encoder.cpp:95` VBV 注释/取值不符
- `vbvBufferSize = bitrate / fps` ≈ 1 帧（~0.26s @8Mbps/30fps），注释写"~1s"不符。不影响编译，但调参时易误判；建议改注释或按 1s 设 `vbvBufferSize = bitrate`。

### E7. `[INFO]` `_WIN32_WINNT` 未显式设置
- WGC / `DispatcherQueue` / `windows.graphics.capture.interop.h` 需 `_WIN32_WINNT >= 0x0A00`。现代 Windows SDK 默认即 0x0A00，通常无碍；建议在 `CMakeLists.txt` 显式 `target_compile_definitions(... _WIN32_WINNT=0x0A00)` 以防旧 SDK。

### E8. `[PASS]` 其余编译面
- NVENC SDK 头（`nvEncodeAPI.h`）、libavcodec/libavutil 头包含正确；`CreateDispatcherQueueController` 在 STA 主线程调用正确（main.cpp:177 COINIT_APARTMENTTHREADED + winrt_capture.cpp:41-45）；cppwinrt 投影头由 `build.ps1` 生成（build.ps1:51-72）；`_O_WRONLY/_O_BINARY` 经 `<io.h>` 在 MSVC 可用（mux_target.cpp:4,125,127）；TS 侧 `recording/types.ts` 导出 `PauseReason`（recording/index.ts:26 引用）、`window-watch.ts` 导出带 `enablePollingStop` 的 `startWindowWatcher`（recording/index.ts:138-144 调用）、`sentinel-client.ts` `startSentinel` 签名与协调层调用（recorder/index.ts:306-323）一致 → **TS 导入/导出核对无缺失**（无缺失模块导致的编译错误）。

---

## F. 智能路由判定与测试通过率

- **源码真实 bug 计数**：3（BUG-1 退出码协议不符 / BUG-2 管道死锁健壮性 / E1 上下文线程安全），均须 **Engineer** 修复；另 5 项低危编译风险（E2–E7）建议工程师一并处理。
- **本环境无测试可跑**（沙箱），故无执行态测试通过率；下述为**静态一致性口径**：
  - A 协议契约：**4 PASS / 1 FAIL（BUG-1）** ＋ 1 WARN（A5）
  - B fd 继承：**3 PASS / 1 FAIL（BUG-2 死锁）** ＋ B 契约本身 PASS
  - C 护栏：**3 PASS / 0 FAIL**
  - D 参数注入：**3 PASS / 0 FAIL** ＋ 2 WARN（D4/D5）
  - E 编译风险：**多处 WARN，2 HIGH（E1/E2）**
- **最终路由：Engineer（software-engineer）**。待 BUG-1/2/E1 修复 + E2 链接前置澄清后，再做真机 build 验证（§2）。

---

## 1. 工程师需修复的 Bug 清单（路由 Engineer）

| # | 文件:行 | 严重度 | 问题 | 修复方向 |
|---|---|---|---|---|
| BUG-1 | main.cpp:352 → 365-378 | 中（协议） | NVENC 连续失败 emit ERROR(2) 后仍 `return 0` 且发 CLOSED，误报为干净停止 | emit ERROR 后 `return 2`；不再发 CLOSED；或设 `g_fatal=true` 在清理分支以错误码退出 |
| BUG-2 | recording/index.ts:184/248-256/263-268 | 高（死锁） | Node 保留 `captureProc.stdio[3/4]` 读端 → mux 死后 exe `_write` 阻塞无 EPIPE；且 crash 重启未强杀旧 exe | `spawnMuxer` 后 `captureProc.stdio[3]?.destroy(); [4]?.destroy()`；`muxProc.on('close')` 中 `captureProc?.kill('SIGKILL')` |
| E1 | winrt_capture.cpp:180-189 + main.cpp:340-343 | 高（崩溃） | 同一 ID3D11DeviceContext 被回调线程与主循环线程并发 `CopyResource` | 主循环 `getLatestTexture`+`CopyResource(encodeTex,latest)`+`GetDesc` 全部纳入 `m_texMutex`；或回调内完成拷贝 |
| E2 | CMakeLists.txt:16 | 高（链接） | /MT 静态运行时 vs FFmpeg/NVENC 库可能 /MD → LNK2038 | 统一运行时（建议 /MD）或文档化库构建要求 |
| A5 | main.cpp:310-314 + recording/index.ts:252 | 低 | READY 无 hasAudio，exe 音频失败与 mux 期望不一致 | READY 增加 hasAudio；或 exe 音频失败时维持 fd4 静音 |
| E3–E7 | audio_capture.cpp / main.cpp / nvenc_encoder.h/.cpp | 低 | 缺 include、死声明、VBV 注释、_WIN32_WINNT | 见 §E 各条 |

---

## 2. 真机 build + 自测清单（用户在自家机器验收）

> 前置：Windows 10/11 + VS2022 Build Tools（含 MSVC/cl.exe）+ Windows SDK 10.0.19041+ + CMake/Ninja + NVIDIA Video Codec SDK（设 `$env:NVENC_SDK_ROOT`）+ FFmpeg 开发库（avcodec/avutil，设 `$env:FFMPEG_ROOT`）+ C++/WinRT（NuGet 或 SDK cppwinrt.exe）。

### ① VS Developer Prompt 下编译前置检查
```powershell
# 以"Developer Command Prompt for VS 2022"或 `vsdevcmd` 启动
where cl; cmake --version; ninja --version
Test-Path "$env:NVENC_SDK_ROOT/include/nvEncodeAPI.h"   # 应为 True
Test-Path "$env:FFMPEG_ROOT/lib/avcodec.lib"            # 应为 True
# 建议先确认 FFmpeg/NVENC 库运行时（/MD vs /MT）与 CMakeLists 第16行一致，否则先修正 E2
cd electron/bin/capture-src
.\build.ps1        # 默认 Release，产物拷贝到 ../window_capture.exe
# 预期：无 LNK2038、无未声明标识符；末尾 "[build] 完成"
```

### ② 隔离测 exe 自身（最常用，`--null --stats`）
```powershell
cd electron/bin
.\window_capture.exe --title "记事本" --fps 30 --w 1920 --h 1080 `
  --codec h264_nvenc --bitrate 8M --bf 2 --rc-lookahead 20 `
  --null --stats
```
- **预期现象**：stderr 每 ~1.5s 打一行 `{"type":"STATS","capture_fps":~30,"encode_fps":~30,"gpu_pct":N,"cpu_pct":N,"drop_cnt":0,"out_bps":~8e6}`；无窗口时退出码 2（无 `--title` 匹配则 `ERROR`+exit 2）；可 `q`<Enter> 或 Ctrl+C 干净退出（**不阻塞**——验证 null 模式护栏）。
- **失败判因**：
  - 立即 exit 2 + stdout `{"type":"ERROR","code":2,"msg":"no window locator…"}` → 标题不匹配，换 `--hwnd`/`--pid`；
  - exit 1 + `WGC init failed` → 该窗口不支持 WGC（UWP/无边框/最小化），换普通窗口；
  - exit 1 + `NVENC init failed` → NVENC DX11 interop 不可用（驱动/核显），检查 NVIDIA 驱动；
  - **若 exe 卡死不退出（非 null 模式）** → 即 BUG-2 类死锁，但 null 模式应不卡；若 null 也卡说明有其它阻塞，回报。

### ③ `--file` 自包含落盘（验证成品，不依赖 Electron）
```powershell
.\window_capture.exe --pid 1234 --out D:\tmp\cap --seg 10 --file --audio --stats
# 或简版（无音频）：.\window_capture.exe --title 记事本 --out D:\tmp\cap --seg 10 --file
```
- **预期现象**：`D:\tmp\cap\` 下出现 `seg000.ts / seg001.ts … index.m3u8`，用播放器可正常播放（含音轨若带 `--audio`）；stderr 有 STATS；`q` 退出后 mux 收尾、m3u8 完整。
- **失败判因**：
  - 找不到 `ffmpeg-mux.exe`/`ffmpeg.exe` 同目录 → `mux target init failed` exit 1，把 `ffmpeg.exe` 放 `electron/bin/`；
  - 仅出 `seg000.ts` 一片 → mux 提前 EOF，查 exe 是否中途崩溃（stderr ERROR）。

### ④ Electron 内 window 模式端到端（READY→mux→upload→切片出现）
- Dev：`npm run dev`；Prod：打包后启动。开始录制选**窗口源**（如记事本）。
- **预期现象**：
  - Electron 日志出现 `[recording] capture READY w=… h=… fps=30 codec=h264_nvenc` → 随后 `[recording] ffmpeg-mux 启动（仅封装 HLS）`；
  - `tmpDir` 下出现 `seg000_opt.ts / seg001_opt.ts …` 并被 upload 层上传（**绕过 transcode**）；
  - 播放 m3u8 画面平滑、无回读脉冲（对比方案1 同分辨率应明显更稳）。
- **失败判因**：
  - 无 READY / `window_capture 异常退出 code=1` → 真机 NVENC/WGC 不可用（见②判因）；
  - 有 READY 但**无 `segNNN_opt.ts`** 或 mux 挂起 → **疑似 BUG-2 死锁**或 A5 音频不匹配，重点排查；
  - 切片出现但上传不走动 → upload 层/throttle，非本模块。

### ⑤ 暂停/恢复/窗口关闭 sentinel 收尾
- 录制中按 Win+D 最小化（sentinel 发 PAUSE）→ Electron 日志 `暂停录制（MINIMIZED）` 且 `segNNN_opt.ts` 停增；恢复前台 → `恢复录制（重启 exe + mux）`，新切片从续号开始、`index.m3u8` 连续。
- 关闭被录窗口 → sentinel STOP / exe `CLOSED reason=window_closed` → 干净收尾、finish 接口调用、tmpDir 清理。
- **失败判因**：暂停后切片不续号/时间轴跳变 → `registerSessionAnchor`/`-start_number` 续号逻辑；关闭后进程残留 → 检查 stop 路径是否强杀 exe（与 BUG-2 修复相关）。

### 附：编译/运行期高频问题速查
- LNK2038 → E2 运行时不一致；
- 未声明 `SPEAKER_FRONT_LEFT`/`KSDATAFORMAT_SUBTYPE_IEEE_FLOAT` → E3 补 include；
- 偶发卡死/花屏/崩溃 → E1 上下文竞争（最高优先级）；
- mux 挂起无切片 → BUG-2 / A5；
- 退出码 0 但实为失败 → BUG-1。

---

*报告结束。静态审查未发现"编译必挂"的语法级错误（除 E2/E3 等环境依赖项），但发现 3 处真实源码缺陷（BUG-1/2、E1）需 Engineer 修复后方可真机验收。*

---

## 第 2 轮回归验证结论（QA 严过关 · 静态口径）

> 环境：沙箱（同 round 1，无 cl/cmake/网络/真实显示），**静态一致性 + 协议贯通性回归审查**，不声称已编译/已运行。
> 范围：复验 round 1 提出的 3 高危/中危 bug（BUG-1/2、E1）+ 7 低危/质量项（E2、A5、E3–E7）是否真实落盘、无偏离、护栏仍成立。
> 判定口径：静态一致性（file:line 证据）。本轮未改动任何实现代码。

### 0. 总体判定（智能路由）

**路由决策：→ NoOne（静态口径无阻断性源码 bug）。**

10 项修复点全部 **[PASS]**，3 项护栏全部 **[PASS]**，未发现新阻断性 bug（协议不符/死锁/null 阻塞/fd 接错/编译必挂）。源码层面修复真实落盘、与设计 §1.4/§1.6 契约一致、护栏未退化。

> 说明：本环境无法编译/运行，故仍**不能替代真机 build 验证**。结论为"静态审查未发现阻断性 bug，待真机 build + 自测清单（§2）验收"。

### 1. 修复点逐项确认（A–F 对应）

| # | 修复点 | 结论 | 证据（file:line） |
|---|---|---|---|
| BUG-1 | 致命编码失败置 `exitCode=2`、break 后 `if(exitCode!=0) return exitCode`（不发 CLOSED） | **[PASS]** | main.cpp:345-349（emitError(2)+exitCode=2+break）；main.cpp:367-373（清理段 `if(exitCode!=0){CoUninitialize();return exitCode;}`）；CLOSED 仅在 exitCode==0 时发（main.cpp:375-379） |
| BUG-2 | spawnMuxer 后 `stdio[3/4]?.destroy()` 释放 Node 读端副本；`muxProc.on('close')` 用局部 `ownerCapture.kill('SIGKILL')` 且不重复 onCrash；pipe_output `written<0`(EPIPE) 立即 break | **[PASS]** | recording/index.ts:267-268（destroy stdio[3/4]）；recording/index.ts:272-279（ownerCapture.kill + 无 onCrash）；pipe_output.cpp:23-27（EPIPE break 丢包） |
| E1 | 新增 `copyLatestInto`/`peekLatestSize` 均在 `m_texMutex` 下访问 `m_context`；主循环/首帧定尺寸改用之，无未持锁 `GetImmediateContext`+`CopyResource` 并发 | **[PASS]** | winrt_capture.h:55,58（声明）；winrt_capture.cpp:159-170（copyLatestInto 持锁 CopyResource）、172-180（peekLatestSize 持锁 GetDesc）、203-210（回调持锁 CopyResource）；main.cpp:226（peekLatestSize 定尺寸）、336（copyLatestInto 拷帧）；grep `GetImmediateContext` in main.cpp → 0 命中 |
| E2 | `/MT`→`/MD`（动态 CRT） | **[PASS]** | CMakeLists.txt:16 `CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL$<...>"` |
| A5 | READY 含 `hasAudio`；TS 解析 `msg.hasAudio` 覆盖 `currentMuxProfile.hasAudio` 后再 spawnMuxer；音频不可用时 mux 不带 `-i pipe:4`、stdio[4] 改 ignore | **[PASS]** | main.cpp:310-311（READY 含 hasAudio）；recording/index.ts:231（覆盖 hasAudio）再 line:232 spawnMuxer；recording/index.ts:257-261（hasAudio 时 stdio[4]={fd} 否则 'ignore'）；profiles.ts:114-116（hasAudio 时才有 `-f aac -i pipe:4`） |
| E3 | audio_capture.cpp 显式 `#include <mmreg.h> <ksmedia.h>` | **[PASS]** | audio_capture.cpp:10-11 |
| E4 | main.cpp 加 `#include <cctype>` | **[PASS]** | main.cpp:17 |
| E5 | nvenc_encoder.h 删未定义声明 `selectPresetGuid`（实现为 anon `presetGuidFor`） | **[PASS]** | grep `selectPresetGuid` in capture-src → 0 命中；nvenc_encoder.h:62 仅 `selectCodecGuid`（已定义 nvenc_encoder.cpp:36）；nvenc_encoder.cpp:18 anon `presetGuidFor` |
| E6 | nvenc_encoder.cpp VBV 注释改正（与值一致） | **[PASS]** | nvenc_encoder.cpp:95 `vbvBufferSize = bitrate; // ≈1s VBV 缓冲（=平均码率）` |
| E7 | CMakeLists.txt 加 `target_compile_definitions(... _WIN32_WINNT=0x0A00)` | **[PASS]** | CMakeLists.txt:96 |

### 2. 护栏复检（偏离即 FAIL）

| 护栏 | 结论 | 证据 |
|---|---|---|
| 无全帧 GPU→CPU 回读 | **[PASS]** | nvenc_encoder.cpp:161-197 仅 `nvEncMapInputResource`+`EncodeFrame`+`LockBitstream`，`out.data.assign` 读的是**压缩码流 bitstream**（非源帧），无 `Map(D3D11_MAP_READ)`/staging/`GetBuffer` 回读（grep `D3D11_MAP_READ\|staging\|GetBuffer\|Map(` → 仅注释命中 nvenc_encoder.cpp:4）；winrt_capture.cpp:210 仅 `CopyResource`（GPU→GPU） |
| exe 不链 libavformat | **[PASS]** | CMakeLists.txt:70-86 仅链 windowsapp/dwmapi/d3d11/dxgi/runtimeobject/ole32/oleaut32/uuid/mfplat/mfuuid/nvEncodeAPI/avcodec/avutil；grep `avformat` → 仅注释 |
| screen 模式零改动 | **[PASS]** | recording/index.ts 严格 `if(currentSourceId.startsWith('window:'))` 分支隔离：startRecording:127/136、stopRecording:306、restartRecording:360、pauseRecording:397、resumeRecording:414；screen 走 `spawnFfmpeg`+`attachFfmpegHandlers`（line 132/381/612-636 原样），window 走 `spawnMuxer`（`-c copy`，无 transcode 接线）。注：recorder/index.ts（协调层）不在本轮复验文件集，但其 screen 守卫在 round 1 已 [PASS] 且本轮 window 改动未触碰该文件。 |

### 3. 智能路由判定 + 静态通过率

- **阻断性源码 bug**：0（协议不符 / 死锁 / null 阻塞 / fd 接错 / 编译必挂 均未见）。
- **静态口径通过率**：修复点 **10/10 PASS**（BUG-1/2、E1、E2、A5、E3、E4、E5、E6、E7）；护栏 **3/3 PASS**。
- **路由**：→ **NoOne**。

### 4. 非阻断观察项（建议后续，不阻塞本轮结案）

1. **crash-restart 时 `muxProc` 模块级指针可能被旧 mux 的 close 处理清空**（recording/index.ts:272-279 新加 `muxProc=null`）。当旧 exe 崩溃→restart→新 mux 已 spawn，而旧 mux 仍在 finalize 时，旧 mux 的 `on('close')` 会执行 `muxProc=null`，把**新** mux 的模块级指针误清空，导致后续 pause/stop 的 `gracefulQuitWindow` 不去 `q` 新 mux。功能上新 mux 因旧 exe 已退出而经 EOF 收尾，非死锁/非协议断裂，属状态管理脆弱点。建议：`on('close')` 内用闭包局部引用比对后再置空（`if (muxProc === thisMux) muxProc = null`）。**非本轮修复引入的设计边角，低危。**
2. **file 模式音频能力判据偏差**（main.cpp:277 vs 301）。exe 侧 `mc.hasAudio = audioEncoderReady`（编码库 init 成功）与运行时 `audioEnabled`（WASAPI 捕获真正 start 成功）存在时间差。若 `--audio --file` 下编码库 init 成功但 WASAPI start 失败，exe 私有 ffmpeg-mux 会按 `hasAudio=true` 等 `-i pipe:4` 却无音频写入 → 诊断态 file 模式可能挂起。生产 pipe 模式不受影响（Electron 以 READY 的 `audioEnabled` 为准）。**低危、仅 file 诊断态边角。**

### 5. 结案结论

round 1 提出的 3 高危/中危 + 7 低危/质量项**全部真实落盘、与设计契约一致、护栏未退化**，静态审查口径下**未发现任何阻断性源码 bug**。本轮给出 **通过（静态口径）** 的结案判定；最终验收仍以**真机 build + §2 自测清单**为准（本沙箱无法编译/运行，不替代真机验证）。
