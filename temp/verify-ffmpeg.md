# FFmpeg BtbN 版本验证指南

## 1. 确认 WASAPI 支持

打开 PowerShell 或 CMD，运行：

```bash
cd C:\Users\绝绝子\Desktop\CoWatch\electron\bin
.\ffmpeg.exe -formats | findstr wasapi
```

**预期输出**（应该看到）：
```
 D  wasapi           Windows Audio Session API audio input/output
```

如果没有输出或报错，说明 WASAPI 模块不可用。

## 2. 测试 WASAPI 设备枚举

```bash
.\ffmpeg.exe -f wasapi -list_devices true -i dummy 2>&1
```

**预期输出**（应该看到类似）：
```
[wasapi @ ...] "Speakers (Realtek Audio)" (loopback)
[wasapi @ ...] "Headphones (USB Audio)" (loopback)
[wasapi @ ...] "Microphone (Realtek Audio)"
```

关键：必须包含 `(loopback)` 标记的设备！

## 3. 测试 ddagrab 是否还在

```bash
.\ffmpeg.exe -filters | findstr ddagrab
```

**预期输出**：
```
 V->V  ddagrab          Capture the Windows desktop using the Desktop Duplication API.
```

## 4. 完整测试录制命令

```bash
.\ffmpeg.exe -f lavfi -i ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra -f wasapi -i audio=default -t 5 -y test-output.mp4
```

这个命令会：
- 用 ddagrab 录制屏幕（5秒）
- 用 wasapi loopback 录制系统声音
- 输出到 test-output.mp4

播放 test-output.mp4，检查是否有游戏声音！

## 常见问题

### Q: 提示"找不到 DLL"
A: 确保所有 .dll 文件都在同一目录下（shared 版本依赖这些 DLL）

### Q: WASAPI 枚举失败
A:
1. 确认 Windows 音频服务正在运行
2. 尝试以管理员权限运行
3. 检查是否有音频设备连接

### Q: ddagrab 失败
A:
1. 需要 Windows 10 1803+ 或 Windows 11
2. 需要显卡支持 DX11/DX12
3. 不能在远程桌面环境下使用

## 下一步

验证通过后，运行 CoWatch 测试：

```bash
npm run electron:preview:test
```

Console 应该显示：
```
[recorder] ✅ 使用 WASAPI: Speakers (Realtek Audio)
[recorder] 音频输入: wasapi → Speakers (Realtek Audio)
```