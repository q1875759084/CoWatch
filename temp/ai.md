# GPU 管线优化尝试与结论（修正版）

## 目标

将录制层 CPU filter 链改为 GPU 链路，减轻 10 秒 GOP 边界帧的 CPU 争抢。

## 环境

- Windows 11，NVIDIA RTX 4060 Laptop + Intel UHD 双显卡
- FFmpeg 8.1 gyan.dev Windows 构建版
- 录制编码器 h264_nvenc，转码层 + 上传层全开

## 三轮测试（全部失败）

| 轮次 | Filter 链 | 位置 | scale_cuda? | 结果 |
|------|----------|------|-------------|------|
| 1 | `hwdownload,format=bgra,format=nv12,hwupload_cuda,scale_cuda=...` | -vf | ✅ | dup=4175 |
| 2 | `hwdownload,format=bgra,scale(CPU),format=nv12,hwupload_cuda` | -vf | ❌ | dup=3212 |
| 3 | `hwdownload,format=bgra,scale(CPU),format=nv12,hwupload_cuda` | lavfi 输入 | ❌ | 依旧卡顿 |

## 核实的 3 条铁证

### 铁证 1：scale_cuda 在 gfxcapture 下从未生效

- `testsrc` 合成源能跑 scale_cuda（无 D3D11 依赖），但 gfxcapture/ddagrab 不能
- CUDA device context（`-init_hw_device cuda`）与 ddagrab/gfxcapture 的 D3D11 context 冲突 → `Selected output not supported`
- `hwmap=derive_device=cuda` 在此 FFmpeg 构建版不支持 → `-40: Function not implemented`
- `hwupload_cuda` 可绕过自动初始化 CUDA，但：
  - `scale_cuda` 不支持 bgra→nv12 转换，需 CPU 先做 format=nv12
  - 要 scale_cuda 必须 filter 在 -vf，拆到 -vf 会破坏 gfxcapture 帧节拍
  - **二者互斥，gfxcapture 下 scale_cuda 不可行**

### 铁证 2：卡顿是真实且严重的——不是网络延迟

- dup=3212 / 2:09 时长，按 30fps ≈ 3870 帧期望 → **~83% 帧为复制帧**
- drop=0 始终（CFR 只复制不丢弃）
- 每 10s chokidar 触发新 ffmpeg 转码进程（NVDEC+NVENC），dup 突发增长：
  - seg000 转码期间 dup 73→271（+198）
  - seg002 转码期间 dup 534→777（+243）
- `[window-watch] 窗口未找到` 多次出现，与 dup 突发时间重叠
- 转码层无条件开启（`start()` 里 `startTranscodingWatcher` 无开关），每 10s spawn 全新 ffmpeg

### 铁证 3：CFR 写死，一旦丢帧永不恢复

- `recording/index.ts` 硬编码 `-vsync cfr -r 30`
- CFR 在捕获跟不上实时时不做降帧，只做帧复制 → dup 单调递增
- 一旦某次 10s 转码脉冲触发丢帧，后续每 10s 再来一次脉冲 → 永远爬不起来

## 正确结论

1. **scale_cuda 在 gfxcapture 场景下不可行**（约束 1 + 约束 4）
2. **卡顿根因不是 CPU scale**（旧 pipeline CPU scale 在 70% 录制中全程正常）
3. **根因是转码层 per-segment spawn + CFR 写死 + gfxcapture 窗口丢失**在国家预算边界形成不可恢复的恶性循环
