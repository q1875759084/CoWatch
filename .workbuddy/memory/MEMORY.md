# CoWatch 项目记忆（精简版）

## 项目概述
- Electron + React + TypeScript 桌面录播/上传；方案2a 自编译 `window_capture.exe`（WGC 抓屏 + NVENC 直编 + ffmpeg mux HLS）。源码 `electron/bin/capture-src/`。
- 录制架构/哨兵/上传队列等历史结论见旧记忆；本轮聚焦 capture-src 真机排错。

## capture-src NVENC/D3D11 硬约束（SDK 13.0）
- 预设：仅新 P1–P7 `NV_ENC_PRESET_Pn_GUID`；须 5 参 `nvEncGetEncodePresetConfigEx(enc,codec,presetGUID,TUNING_INFO_LOW_LATENCY,&cfg)`，4 参 `GetEncodePresetConfig` 返回 INVALID_PARAM(8)。
- apiVersion 硬编码 `NVENCAPI_VERSION`（=13.0），**不做驱动协商**（驱动 571+ 由 Electron 门禁保证）。
- NV12 作 RTV 须 `ID3D11Device3::CreateRenderTargetView1` + `D3D11_RENDER_TARGET_VIEW_DESC1`（成员 `Texture2D`+`PlaneSlice`）；`m_dev` 用 `com_ptr<ID3D11Device3>`。
- D3D11 杂项：`PSSetSamplers` 第3参须 `ID3D11SamplerState* const*`；`Draw(VertexCount,StartVertexLocation)`；线性采样器 `D3D11_FILTER_MIN_MAG_MIP_LINEAR`；无 `shellscaling.h`。
- `InitializeEncoder` 报 INVALID_PARAM 查 `tuningInfo` 须等于 `GetEncodePresetConfigEx` 所用；`encodeWidth/Height` 须偶数（main.cpp `encW&=~1u`）。
- 错误码：`NV_ENC_SUCCESS=0` … `INVALID_PARAM=8` … `OUT_OF_MEMORY=10` … `LOCK_BUSY=12`。

## LockBitstream:10 真因（2026-07-18 真机复盘）
- 现象：READY 后立刻 `[nvenc] LockBitstream failed: 10`、encode_fps 2.0→0.0、cpu 100%、ctrl+c 杀不掉。
- 根因：`tryLockPacket` 用 `doNotWait=1`（非阻塞）锁尚未产出数据的 bitstream（B 帧重排期 EncodePicture 返回 NEED_MORE_INPUT 的 slot）。NVENC 非阻塞锁“无数据”返回 **OUT_OF_MEMORY(10)**（非 LOCK_BUSY(12)）。我方仅把 12 当 kBusy，把 10 当致命 kError → 丢 slot → 管线死。
- 对照 OBS `obs-nvenc/nvenc.c:1089-1092` 只锁 `buffers_queued>0`（且非 finalize 需 `>=output_delay`）的缓冲，且 `doNotWait=false`（阻塞锁）规避该歧义。
- 修复：**非阻塞时把 `NV_ENC_ERR_OUT_OF_MEMORY`(10) 与 `LOCK_BUSY`(12) 同视为 kBusy**（稍后重试、保持 input mapped）。`bs.size=0`（对齐 OBS 自动 sizing）保持不变。
- 教训：工程师曾写“DEGRADE PATH”注释却未落地修复；**size=0 自动 sizing 假设正确，真因在 lock 状态分类**。

## OBS Studio 本地源码（重要：禁联网）
- 路径 `C:\Users\绝绝子\Desktop\Co\obs-studio`（旧版，架构跨版本稳定，无需更新）。研究须读本地，禁 WebFetch/GitHub。
- 重点：`plugins/obs-nvenc/nvenc.c`（bitstream ring / `get_encoded_packet` 锁逻辑 / `queue_frame` gating）、`nvenc-d3d11.c`（MapInputResource）、`plugins/win-capture/`（WGC 在渲染线程 render 非回调编码）、`libobs/obs-video.c`（`gs_stage_texture` + 线程解耦）。

## 方法论铁律（用户 2026-07-17 强调）
- capture-src 任何改动**先读 OBS 本地模块、按已验证骨架落地，禁止凭空生成后打补丁**；**铁律升级（2026-07-18）**：用 OBS 源码就该**逐字忠实搬 OBS 代码**——每个自我实现都是隐形 bug；缺依赖/DLL 就补齐依赖（vendor libobs / 链 libavformat）而非手搓；除非是重型且不必要的、易测试且性能影响小的实现才允许偏离。**最大陷阱=线程根偏差**：`DQTYPE_THREAD_DEDICATED`(main 当协调者) 而非 OBS 的 `DQTYPE_THREAD_CURRENT`(main=图形线程=dispatcher) 会催生整条自搓链（无主循环→回调注入→独立编码线程→SPSC+非阻塞 lock+kBusy），须从根对齐而非在混合体上打补丁。
- QA 静态复核须含「构建配置一致性」：比对 `.cpp` 与 `CMakeLists.txt` 源列表（曾漏编 `staging_texture.cpp` 致 LNK2019）。
- 沙箱无 C++ 工具链 → 所有修复静态自审 + 真机验证；改动须最小、不重构无关代码。

## 当前主线状态（2026-07-18）
- 已完成：WGC+NVENC 线程解耦重写（方案B）、B 帧允许(bf=2+LOW_LATENCY)、NEED_MORE_INPUT 当在途、N1 kBusy 保持 mapped、窗口缩放暂缓。
- 待真机验证：本轮回修 LockBitstream:10 状态分类。
- **设备丢失 OBS 子系统（v1 上线门禁）已落地并静态双重验真**：忠实搬 `gs_device_loss`/`RebuildDevice`；`init/start/rebuild` 内联 WGC 工作（取消 `TryEnqueue+f.get`）；**#41 进一步彻底删除偏离 OBS 的自我实现 `devicePollThread` 独立轮询线程**，device-loss 检测收敛到主循环（图形线程）顶部主动 `GetDeviceRemovedReason()`、重建仅主循环安全点同步执行（`g_deviceLost` 已删，无独立线程、无跨线程 device/immediateCtx 写，完全对齐 OBS 单图形线程模型）；`CMakeLists` 补 `device_loss.cpp`（消 LNK2019）；并修 device-loss 快路径 slot 泄漏（render_encode_one/drainEncoded 两处对称补 `freeSlots.push_back`+`inFlight.pop_front`）。工程师(#39/#41)+QA(#40/#41) 均 IS_PASS: YES / 路由 NoOne。**仅待真机复编复验**（dGPU 禁用/启用确定性 device-removed、Alt+Tab 1–2min、push/file/null 三态各≥3 循环零崩溃零 exit≠0 无缝续录 + REBUILD 事件 + 无 slot 耗尽）。

## capture_fps=0 + ctrl+c 死锁（2026-07-13 真机排错·三缺陷已落盘待验证）
- **A) capture_fps=0+cpu=100**：`convertLatestInto` 持 `m_texMutex` 跑完整 GPU 转换饿死 WGC 回调 → 改**延迟上下文**(`m_deferred`)锁外录制 BGRA→NV12 绘制 + 锁内 `ExecuteCommandList`+Flush+copyInto。
- **C) staging slot 泄漏**：`submitRendered` 忽略 `tryPush` 返回 → 改返回 `bool`+失败时 `releaseSlot`。
- **EOS) ctrl+c 死锁**：缺 `NV_ENC_PIC_FLAG_EOS` → 收尾 `drain(true)` 阻塞 `LockBitstream` 永久 → 加 `submitEos()` + **有界排空**(5s 预算 + 残留 slot 兜底释放)。EOS `outputBitstream` 留空是 OBS/SDK 规范写法（非缺陷）。
- **铁律**：`m_context`/`BgraToNv12::m_ctx`/`immediateCtx` 是**同一立即上下文（非线程安全）**，所有立即上下文访问须经 `m_texMutex` 串行；延迟上下文录制可在锁外。
- 验证：工程师+QA 静态 IS_PASS=YES、路由 NoOne；沙箱无 MSVC 未编译，待真机复验（详见 2026-07-13.md 续15）。
