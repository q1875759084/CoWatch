## 如何解决
既然根因是 gfxcapture 的捕获机制，解法只有换捕获源：

### 推荐方案：ddagrab + crop 裁窗
用 DDA 全屏捕获（已验证稳定30fps）+ crop 滤镜裁到窗口区域：

当前（卡顿）：
  gfxcapture=window_title=xxx:max_framerate=30 → WGC推模式 → 5fps

改为（稳定）：
  ddagrab=output_idx=0:framerate=30 → DDA拉模式 → 30fps
  + crop=W:H:X:Y → 裁到窗口矩形

  需要解决的问题 ：

1. 窗口坐标获取 ：用 Win32 API（ GetWindowRect ）实时获取窗口位置
2. crop 坐标动态更新 ：窗口移动时 crop 参数要更新（FFmpeg 的 crop 滤镜不支持运行时改参数，需要其他方案）
3. 窗口最小化/关闭处理 ：窗口不可见时 DDA 捕获到的是桌面，需检测并暂停
crop 动态更新的技术方案 ：

FFmpeg 的 crop 滤镜参数是静态的，不能运行时改。两个替代方案：

- 方案1：sendcmd + zmq 滤镜 ：FFmpeg 支持 zmq 滤镜接收运行时命令动态调整参数，但需要编译时启用 --enable-libzmq （需验证当前 build）
- 方案2：录制全屏 + 后期裁剪 ：录制时不裁，转码层加 crop（转码时窗口位置已确定，可静态裁剪）。但用户可能移动窗口，且全屏内容会入镜
- 方案3：固定区域捕获 ：提示用户将游戏窗口固定在屏幕某区域（如全屏窗口化），crop 到固定坐标。最简单但不灵活
方案2 的优势 ：录制层完全不动（ddagrab 全屏），只在转码层加 crop。但问题是窗口可能移动，且全屏录制会包含桌面内容（隐私问题）。

方案1（zmq）如果可行是最优解 ：录制时 ddagrab 全屏 + crop 初始坐标，Node 层定时 GetWindowRect 检测窗口位置变化，通过 zmq 发送命令更新 crop 参数。

& "c:\Users\绝绝子\Desktop\Co\CoWatch\electron\bin\ffmpeg.exe" -filters 2>&1 | Select-String "zmq" 
zmq 和 azmq 滤镜都可用。 当前 FFmpeg build 已编译 --enable-libzmq 。
现在验证 sendcmd 滤镜是否也可用（配合 zmq 做运行时命令注入）：
& "c:\Users\绝绝子\Desktop\Co\CoWatch\electron\bin\ffmpeg.exe" -filters 2>&1 | Select-String "sendcmd|crop" 
全部可用。总结：

滤镜 用途 状态 zmq 接收 ZMQ 运行时命令，动态调整下游滤镜参数 ✅ 可用 sendcmd 向下游滤镜发送命令（静态时序） ✅ 可用 crop 裁剪视频区域 ✅ 可用

ddagrab + zmq + crop 方案在当前 FFmpeg build 上完全可行 ：
ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra,
  crop=W:H:X:Y,zmq,scale=w='min(iw,1280)':h=-2,format=yuv420p

  Node 层通过 ZeroMQ 向 ffmpeg 进程发送命令动态更新 crop 参数：
  // 窗口移动时发送
zmq.send(`crop w=${newW} h=${newH} x=${newX} y=${newY}`)