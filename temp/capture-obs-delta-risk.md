# 全量对齐 OBS 后，capture-src 真正"不能复刻"的差异与风险

> 聚焦结论：对齐 OBS 单图形线程模型后，capture→convert→encode 全部可复用 OBS；
> 唯一 OBS 里没有、必须自己写的，是 **本地 HLS 落盘那一段**（分段 + 收尾 + ffmpeg 进程生命周期）。
> 风险全部集中在这一道边界，不在捕获/转换/编码。

## 关键前提修正
`7.18ai1.md` 称"OBS 核心不 HLS、只写 FLV/MP4/RTMP" —— **对本仓库源码不成立**。
本仓库 OBS 已内置 HLS muxer：
- `obs-studio/plugins/obs-ffmpeg/obs-ffmpeg-hls-mux.c:316` 定义 `ffmpeg_hls_muxer`（protocols="HLS"）
- `obs-studio/plugins/obs-ffmpeg/obs-ffmpeg.c:350` 注册
- 同样把编码包经管道喂给外部 `obs-ffmpeg-mux.exe`（`:310`/`:626`），由 libavformat 做 `-f hls`（ffmpeg-mux.c:976）

**OBS 与我们的唯一差别**：OBS 的 HLS 用 `method=PUT` 把 .ts/.m3u8 **推到远端 HTTP 服务器**（`:128-133`），从不在本地落盘。

→ 连"ffmpeg 管道分段"机制都不是自创，可直接抄 OBS `obs-ffmpeg-mux.exe` 模式，只把 sink 从远端 PUT 换成本地文件路径。
→ 真正的不可复刻差异比"OBS 完全没有 HLS"小得多。

## 全量对齐 OBS 后，唯一真差异（不可复刻）

| 真差异 | OBS 怎么做 | 我们为什么必须不同 | 风险 | 严重度 |
|---|---|---|---|---|
| **本地 HLS 成片**（.ts/.m3u8 落盘） | HLS 仅 `method=PUT` 推远端，核心不落本地；所有输出经外部 `obs-ffmpeg-mux.exe` | 需本地文件供 hls.js 边录边看 + 本地转码 | 切段须对齐 IDR；目录缺失静默失败 | P0 |
| **seg 边界 keyframe 对齐** | `keyint_sec` 定 `hls_time`（nvenc.c:140），ffmpeg 在下一个 IDR 切段 | 我们 mux 不 force keyframe，依赖 record 层 keyint==segSeconds 契约 | keyint 配错 → 段长漂移 / live 延迟劣化 | P0（契约） |
| **live→VOD playlist 收尾（#EXT-X-ENDLIST）** | helper 靠 EOF finalize；无本地 playlist 概念 | 成片须可被 VOD 判定结束 | 5s 强杀丢 ENDLIST → 播放器当 live 轮询 | P0 |
| **ffmpeg 管道生命周期稳健性** | 同模式外部进程 | 复用 OBS 模式仅换本地 sink | 进程退出兜底须干净（不丢尾片） | P0/P1 |

## 边界外差异（不在 capture-src 内，不影响对齐）
- **两层编码 record→transcode**：record 层 = OBS NVENC 仅**参数差**（无 B 帧 / lookahead，避免抢游戏 GPU），可复用；transcode + 上传 + COS 在 Electron 主进程，属业务编排差异。
- **实时复盘 / 边录边看**：OBS Replay Buffer 是内存环形缓冲（obs-output.c:1090），非 HLS 流。我们需 hls.js 增量读本地 seg。
- **COS 上传**：OBS 不上传，业务需落 COS（已在 Electron 主进程实现）。

## mux_target.cpp 核实结论（推翻"7.18ai1.md 说这部分是对的"）
happy path 成立（自建 pipe + stdin + 清继承标志 + 关读端 + stop 关写端 EOF；`-f hls -hls_time -hls_list_size 0 -hls_segment_filename` 可产 HLS），但 **5 处隐患**：
1. 无 `-force_key_frames`，切段全依赖上游 record 层 keyint==segSeconds 契约，配错→段长漂移（P1 契约）；
2. `-r <fps>` 对 VFR 的 WGC 源做 CFR 假设、合成 PTS→丢精度（P2）；
3. 5s `TerminateProcess`（:141）若触发，ffmpeg 来不及 finalize→playlist **无 #EXT-X-ENDLIST**→VOD 播放器当 live 轮询（P1，须重构处理）；
4. `-hls_list_size 0` 是 VOD 增长式 playlist，非滑动窗口 live（P2 设计，对 record+转码消费反而安全）；
5. `cfg.fps<=0` 生成 `-r 0` 静默失败；stop 不校验 mux 退出码/stderr（P2）。

## 一句话回答用户
> 对齐 OBS 后，真的要自己写的只有"本地 HLS 落盘那一段"：切段对齐 IDR、stop 时干净写出 #EXT-X-ENDLIST、ffmpeg 进程生命周期稳健。
> 风险全集中在这一个边界；capture/convert/encode 与兼容性（色彩/DPI/resize/HDR/设备丢失/音频时钟）对齐 OBS 后即消失。
