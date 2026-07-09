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

## 7.9.1 录屏卡顿问题（已定位根因）
- **主因**：转码层无条件开启，每 10s 对每个 .ts 切片 spawn 全新 ffmpeg（NVDEC+NVENC p5/cq30），与录制层抢同一 NVENC/显存/磁盘 → 每 10s 操作迟滞脉冲。
- **次因**：录制层 `recording/index.ts:331` 写死 `-vsync cfr -r 30`，掉队时 dup 单调累加、永不回落 → "一旦卡顿全程不自愈"。
- **催化剂**：gfxcapture 窗口丢失（`[window-watch] 窗口未找到`）致 capture stall，dup 突发。
- **铁证**：temp/终端.txt 实测 dup=3212（2:09，~83% 复制帧），实际跑 CPU `scale=`（非 scale_cuda），日志误标"CPU scale_cuda"。
- **ai.md 不可信点**："scale_cuda 管线 29fps 稳定" 与 111.md（gfxcapture 场景 scale_cuda 不可行，约束4）及终端实测双重矛盾，系合成源 testsrc 过度外推；hwdownload 不可去、VFR 是对症解药这两点可采信。
- **已证伪**：scale_cuda 在 gfxcapture 实时捕获下不可行（CUDA↔D3D11 context 冲突 + 拆 -vf 破坏帧节拍）。不要再在此方向投入。
- **D1（录制即成品/删转码层）已被用户否决**：三层架构是刻意的——录制必须用无 B 帧/无 lookahead 轻量参数避免抢游戏 GPU，但这使 720p30 码率≈1080p60，浪费 CDN 且上传无法兼顾游戏带宽，故转码层不可替代。
- **R0（录制期零转码 + stop 后单进程批量转码）已被证伪不可行**：用户三个问题戳穿——① 轻量件码率 10Mbps > 上传限速 7Mbps → 录制期持续积压（1h=1.35GB/2h=2.7GB，停后 3.6~7.2min 排空），"即复盘"不成立；② 2h 素材 10x 转码需 ~12min + 上传 ~7min = ~19min 停等且用户须保持开 CoWatch；③ 若提前复盘 CDN 仍 serv 原片(10M) → 3.3x 成本窗口。**R0 在"实时复盘"与"CDN 成本"两目标均未达标。**
- **关键前提挑战（高见远，2026-07-09）**："录制须无 B 帧/无 lookahead 才能不拖游戏"大概率**错误**。NVENC 是 GPU 上与 3D/图形引擎**物理分离**的独立硬件块，B 帧/lookahead 只吃编码引擎时片与少量帧缓冲显存，不抢游戏渲染。若录制致卡，真凶更可能是：① CPU `libswscale` scale 抢 CPU；② 磁盘 I/O；③ 并发第二转码进程抢 NVENC/PCIe。**D1 当年被否是因为"无 B/lookahead→高码率"；若允许 B 帧/lookahead 则 D1 的失效根消失。**
- **独显场景主推荐 E0（直播单遍模型，取代 R0）**：录制即按**最终质量**用 NVENC 单次编码（允许 B 帧/lookahead、中等 preset、CBR≈可承受上行 X%），**实时令牌桶限速上传，无独立转码阶段**。四目标全满足：① NVENC 不抢 3D 引擎、CPU scale 改为"捕获即降分辨率"去 CPU 争用；② 令牌桶限上行 60–70%；③ 无积压无二次转码→停止即复盘；④ 单份 3Mbps 成品无翻倍。E0 ≠ D1（E0 允许 B 帧且输出即最终质量）。改动中低：录制编码参数 + 删 transcoding 停止后批处理 + 上传限速固化。
- **退守 E1（仅当"无 B/lookahead"前提被用户坚持不可推翻时）**：录制期不上传，stop 后单进程转码(12min/2h)+限速上传(3~7min)→接受 ~12-19min 停等；CDN 始终单份 3M 生产件无翻倍窗口。**E1 以与 R0 相同停等换取 CDN 单份低成本，严格优于 R0。**
- **直播对照（OBS）**：单遍实时 NVENC 编码(CBR 直传，含 B 帧/lookahead)无第二阶段 → 无转码脉冲/积压/二次上传；输出码率=上行可承受值→无积压；单份最终码率文件→无翻倍。这是 E0 的参照模型。
- **NVENC 多 session 误区**：session 是驱动/授权概念（并发数上限），非硬件并行车道；消费级 N 卡通常 1 个物理编码引擎（少数旗舰 2 个但共享总吞吐），多 session 是时分复用 → 录制+转码同刻编码互相抢同一引擎使每帧延迟翻倍偶超 33ms。
- **单帧 33ms 时序瓶颈**：录制链路①抓屏(GPU)→②hwdownload(复制引擎/PCIe)→③CPU scale(最重CPU段)→④hwupload(复制引擎/PCIe)→⑤NVENC(争抢时爆)→⑥写盘。常态 5–10ms；转码脉冲使⑤+②/④+⑥ 共享资源排队超预算 → CFR dup。

## 录制卡顿再排查(2026-07-09/10) 硬事实（取代上面 7.9.1 的部分结论）
- **编码侧非瓶颈（terminal5 铁证）**：全程 speed≈1x、dup=0、drop=0、编码fps=收到fps。排除 CPU scale / hwdownload / NVENC / B 帧为卡顿主因。上面"单帧 33ms 时序瓶颈→CFR dup"在实测 dup=0 下不成立（dup 放大器假设被推翻）。
- **真瓶颈 = 捕获源被 DWM/负载门控**：inferredCaptureFps 从低起点(12)单调滑到 5~8、负载松即回弹(29fps 爆发)。WGC(gfxcapture)/DDA 经 DWM，呈现率随游戏 GPU 负载降 → 捕获帧率塌。
- **fps=30 强制使 inferredCaptureFps 指标盲**：源被钉 30fps PTS，WGC 交付稀时重复同帧(dup=0 但内容卡)。测真实捕获率须去掉 fps=30。旧版(6c0772e) gfxcapture 也带 fps=30 → "旧版更顺"可能是 mask 假象，对照须去 fps=30 才有意义。
- **CUDA 零拷贝直编在本机物理不可行**：`hwmap=derive_device=cuda` → -40(ENOSYS)；scale_npp 构建不带；scale_cuda 依赖同派生也失败。不要投入此方向。
- **录制层禁 B 帧/lookahead（用户实测）**：加 B 帧即从一开始就塌（单帧编码延迟>33ms 实时预算）。B 帧/lookahead 只留离线转码层。
- **10s 转码脉冲确为独立抖动**：skip 转码(SKIP_TRANSCODE_IN_MODE_A)后游戏顺滑 → 三层架构转码脉冲须消除（E0 或停止后单遍收口）。
- **为什么 OBS 直播不卡、CoWatch 卡**：OBS Game Capture 挂钩游戏 swap-chain 读后缓冲**绕过 DWM**；CoWatch 走 WGC 被 DWM 门控。根解=捕获机制重写(WGC→DDA 干净对照，或 swap-chain 挂钩注入，属架构级重构)。
