# 设计方案：ddagrab + crop + zmq 替换 gfxcapture

## 1. 问题回顾

| 捕获方式 | 模式 | 帧率稳定性 | 终端8实测 |
|---------|------|----------|----------|
| gfxcapture (WGC) | 推模式，DWM 控制递帧 | 负载下降至 5fps | dup=1663/67s，**卡顿** |
| ddagrab (DDA) | 拉模式，OS 固定节拍 | 稳定 30fps | dup=1/69s，**流畅** |

**目标**：窗口录制时用 ddagrab 替代 gfxcapture，通过 crop 滤镜裁到窗口矩形，用 zmq 滤镜动态更新 crop 坐标。

## 2. 架构设计

```
当前（窗口录制）：
  gfxcapture=window_title=xxx:max_framerate=30 → WGC推模式 → 5fps → 卡顿

改为：
  ddagrab=output_idx=0:framerate=30
    → hwdownload,format=bgra
    → crop=W:H:X:Y                    ← 初始值，zmq 可动态修改
    → zmq=bind_address=tcp://127.0.0.1:5555
    → scale,format=yuv420p
    → libx264 编码

  Node 层（window-position-tracker）：
    每 500ms 调用 GetWindowRect(hwnd) 获取窗口坐标
    坐标变化时，通过 ZMQ 客户端发送命令：
      Parsed_crop_0 w W h H x X y Y
```

## 3. 模块改动

### 3.1 新增模块：`window-position-tracker.ts`

```
位置：electron/handlers/recorder/window-position-tracker.ts

职责：
  - 根据窗口标题找到目标窗口的 HWND
  - 定时轮询 GetWindowRect 获取窗口位置和大小
  - 位置变化时通过 ZMQ 客户端通知 FFmpeg 更新 crop 参数
  - 窗口最小化/关闭时通知录制层

依赖：
  - koffi（调用 Win32 API）
  - zeromq.js（ZMQ 客户端，连接 FFmpeg zmq 滤镜）

公开 API：
  - startTracking(windowTitle, zmqPort, onWindowGone) → TrackerHandle
  - stopTracking() → void
```

**Win32 API 调用链**：
```
FindWindowW(null, title) → HWND
  → GetWindowRect(HWND, &rect) → { left, top, right, bottom }
  → IsWindowVisible(HWND) / IsIconic(HWND) → 窗口状态判断
```

**ZMQ 命令协议**（FFmpeg zmq 滤镜文档）：
```
FFmpeg zmq 滤镜接收的命令格式：
  <filter_label> <command> <argument>

对 crop 滤镜（lavfi 链中自动命名为 Parsed_crop_N）：
  Parsed_crop_0 w 640 h 400 x 100 y 100
```

**注意**：FFmpeg lavfi 滤镜链中的 filter 标签名取决于链的构建顺序。`crop` 是链中第一个可命令化的滤镜，标签名为 `Parsed_crop_0`。需要在启动时从 ffmpeg stderr 日志确认实际标签名。

### 3.2 修改模块：`recording/index.ts`

**改动点1：窗口录制改用 ddagrab + crop + zmq**

当前代码（第278-283行）：
```typescript
} else {
  const escapedTitle = currentWindowTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  inputArgs = [
    '-f', 'lavfi',
    '-i', `gfxcapture=window_title=${escapedTitle}:max_framerate=30,hwdownload,format=bgra,${winScaleFilter}`,
  ];
}
```

改为：
```typescript
} else {
  // 窗口录制：ddagrab 全屏 + crop 裁窗 + zmq 动态更新
  // 启动前先获取窗口初始位置
  const initRect = getWindowRect(currentWindowTitle);
  if (initRect) {
    const cropFilter = `crop=${initRect.w}:${initRect.h}:${initRect.x}:${initRect.y}`;
    inputArgs = [
      '-f', 'lavfi',
      '-i', `ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra,${cropFilter},zmq=b=tcp://127.0.0.1:${zmqPort},${winScaleFilter}`,
    ];
  } else {
    // 窗口未找到，回退到 gfxcapture
    const escapedTitle = currentWindowTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    inputArgs = [
      '-f', 'lavfi',
      '-i', `gfxcapture=window_title=${escapedTitle}:max_framerate=30,hwdownload,format=bgra,${winScaleFilter}`,
    ];
  }
}
```

**改动点2：启动/停止 window-position-tracker**

在 `startRecording` 中：
```typescript
if (currentSourceId.startsWith('window:') && process.platform === 'win32') {
  windowPositionTracker = startWindowPositionTracker(
    currentWindowTitle,
    zmqPort,
    () => { cbs.onShouldStop?.(); },  // 窗口关闭
  );
}
```

在 `stopRecording` 中：
```typescript
if (windowPositionTracker) {
  windowPositionTracker.stop();
  windowPositionTracker = null;
}
```

### 3.3 修改模块：`window-watch.ts`

**角色变化**：从"检测窗口存活"扩展为"检测窗口存活 + 跟踪窗口位置"

现有 window-watch 继续保留（desktopCapturer 方式），但新增一个基于 Win32 API 的轻量轮询器作为位置跟踪的数据源。

## 4. 技术细节

### 4.1 ZMQ 依赖

需要安装 `zeromq.js`（纯 JS 实现，无需编译原生模块）：

```bash
npm install zeromq.js
```

| 包 | 类型 | 大小 | 原生模块 |
|----|------|------|---------|
| `zeromq.js` | 纯 JS | ~200KB | 无 |
| `zeromq` | C++ addon | ~5MB | 需编译 |

**推荐 `zeromq.js`**：纯 JS、零编译、跨平台兼容。

### 4.2 Win32 API 调用

需要安装 `koffi`（调用 Win32 API）：

```bash
npm install koffi
```

| 包 | 类型 | 大小 | 维护 |
|----|------|------|------|
| `koffi` | C FFI | ~500KB | 活跃 |
| `node-ffi-rs` | C FFI | ~300KB | 活跃 |
| `ffi-napi` | C FFI | ~1MB | 停维 |

**推荐 `koffi`**：活跃维护、API 简洁、支持 async。

需要的 Win32 函数：
- `FindWindowW(lpClassName, lpWindowName)` → HWND
- `GetWindowRect(hWnd, lpRect)` → RECT { left, top, right, bottom }
- `IsWindow(hWnd)` → BOOL
- `IsIconic(hWnd)` → BOOL（最小化检测）
- `GetForegroundWindow()` → HWND（前台窗口检测）

### 4.3 窗口位置 → crop 参数映射

```
GetWindowRect 返回的是屏幕坐标（像素）：
  rect = { left: 100, top: 200, right: 1920, bottom: 1080 }

crop 参数需要：
  w = right - left   // 1820
  h = bottom - top   // 880
  x = left           // 100
  y = top            // 200

ZMQ 命令：
  Parsed_crop_0 w 1820 h 880 x 100 y 200
```

### 4.4 边界情况处理

| 情况 | 处理方式 |
|------|---------|
| 窗口移动 | ZMQ 更新 crop 坐标，下一帧生效 |
| 窗口缩放 | ZMQ 更新 crop w/h/x/y |
| 窗口最小化 | `IsIconic()=true` → 暂停 crop 更新（保持最后坐标），DWM 仍合成该窗口 surface |
| 窗口关闭 | `IsWindow()=false` → 触发 `onShouldStop` |
| 窗口移到副屏 | ddagrab `output_idx` 对应主屏，窗口移出主屏时 crop 区域为空 → 需检测并提示 |
| 重叠窗口遮挡 | DDA 捕获的是桌面合成结果，遮挡窗口会入镜 → **接受为已知限制** |
| 全屏独占游戏 | DDA 能捕获全屏游戏（flip model）→ 正常工作 |
| 窗口化游戏 | 正常工作（DDA 捕获桌面 → crop 到窗口区域） |

### 4.5 多显示器

用户可能有多个显示器。`ddagrab` 的 `output_idx` 指定捕获哪个屏幕。

**需要确认窗口在哪个显示器上**：
```typescript
// Win32 API
MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST) → HMONITOR
GetMonitorInfoW(hMonitor, &info) → MONITORINFO { rcMonitor, rcWork }

// rcMonitor.left/top/right/bottom 是虚拟屏幕坐标
// ddagrab output_idx 需要映射到显示器序号
```

或者简化处理：**始终捕获窗口所在的显示器**。`desktopCapturer.getSources` 已有屏幕列表，可与 Win32 监视器信息匹配。

## 5. 改动量评估

| 文件 | 改动类型 | 改动量 |
|------|---------|--------|
| `recording/index.ts` | 修改 | 中（滤镜链重构 + tracker 生命周期） |
| `window-position-tracker.ts` | **新增** | 中（~150行：Win32 API + ZMQ 客户端 + 轮询） |
| `window-watch.ts` | 不变 | — |
| `shared.ts` | 不变 | — |
| `index.ts`（协调层） | 微改 | 传递 zmqPort 到录制层 |
| `package.json` | 新增依赖 | +koffi, +zeromq.js |

## 6. 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| ZMQ 命令延迟（500ms轮询间隔内窗口已移动） | 中 | 视觉上最多 1 帧偏差，可接受 |
| crop 滤镜标签名不确定（`Parsed_crop_0` 还是其他） | 低 | 从 ffmpeg stderr 解析标签名，或用 `crop=@crop_label` 显式命名 |
| koffi/zeromq.js 打包兼容性 | 中 | koffi 支持 electron-builder 打包，zeromq.js 是纯 JS |
| 窗口移出主屏 | 低 | 检测 crop 区域有效性，无效时回退 gfxcapture |
| 重叠窗口入镜 | 确定 | 文案提示，或提示用户全屏游戏 |

## 7. 实施步骤

1. **安装依赖**：`koffi` + `zeromq.js`
2. **实现 `window-position-tracker.ts`**：Win32 API + ZMQ 客户端 + 轮询
3. **修改 `recording/index.ts`**：窗口录制路径改为 ddagrab + crop + zmq
4. **验证**：窗口录制测试，观察 dup 是否降至接近 0
5. **边界测试**：窗口移动/缩放/最小化/关闭/多显示器
