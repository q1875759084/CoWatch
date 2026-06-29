# 测试 MediaFoundation 音频录制

## 问题背景

当前情况：
- gyan.dev FFmpeg 8.1.2 → 不支持 wasapi ❌
- BtbN FFmpeg master → 不支持 wasapi ❌
- 但两者都有 --enable-mediafoundation ✅

## 测试命令

在 BtbN 的 bin 目录下运行：

### 1. 列出 MediaFoundation 设备

```bash
.\ffmpeg.exe -f gdigrab -list_devices true -i dummy 2>&1
```

或者尝试：

```bash
.\ffmpeg.exe -f lavfi -i amovie=filename=dummy 2>&1 | findstr audio
```

### 2. 使用 MediaFoundation 录制音频测试

```bash
.\ffmpeg.exe -f lavfi -i ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra -f gdigrab -i audio -t 5 -y test-mf.mp4
```

### 3. 或者使用 Windows 内置的音频捕获

尝试使用 "audio=" 前缀（某些 FFmpeg 构建支持）：

```bash
.\ffmpeg.exe -f lavfi -i ddagrab=output_idx=0:framerate=30 -f dshow -i audio="@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{57064E64-8BEF-413E-B019-0ACB9E02E6F7}" -t 5 -y test-dshow-guid.mp4
```

注意：GUID 来自之前 dshow 枚举输出的 Alternative name

## 如果以上都不行

### 最终方案：安装 VB-CABLE（虚拟音频电缆）

1. 下载：https://vb-audio.com/Cable/
2. 安装后会在 dshow 中创建新的音频设备
3. 设置 Windows 默认播放设备为 VB-CABLE Input
4. CoWatch 录制 VB-CABLE Output（就能录到系统声音）

这是最可靠的跨 FFmpeg 版本兼容方案。