# recorder.ts 集成代码 — window_sentinel.exe

以下代码段需要添加/修改到 `electron/handlers/recorder.ts` 中。
标注了精确的插入位置和上下文。

---

## 1. 新增模块级变量（在 audioCaptureProcess 后面，约第 156 行）

```typescript
/**
 * window_sentinel 子进程（Windows 窗口录制模式下的窗口关闭监听）。
 * null = 未启动或已终止，或当前为全屏录制模式（不需要哨兵）。
 *
 * 工作模式：
 *   sentinel 通过 SetWinEventHook(EVENT_OBJECT_DESTROY) 监听目标窗口，
 *   窗口关闭时输出 "CLOSED" 到 stdout，主进程 readline 读取后调用 stop() 优雅停止。
 *   sentinel 异常退出且未输出 CLOSED → 不触发 stop()，fallback 到轮询兜底。
 */
let windowSentinelProcess: ChildProcess | null = null;
/** sentinel 是否已输出 CLOSED（防止 close 事件误判为窗口关闭） */
let sentinelClosedReceived = false;
/** 轮询兜底定时器（sentinel 异常退出后启用） */
let sentinelFallbackTimer: ReturnType<typeof setInterval> | null = null;
```

---

## 2. 新增 getSentinelPath() 函数（在 getAudioCapturePath() 后面，约第 320 行）

```typescript
/**
 * 获取 window_sentinel 可执行文件路径（仅 Windows + 窗口录制模式）。
 *
 * window_sentinel 是独立可执行文件，通过 SetWinEventHook 监听目标窗口关闭事件，
 * 输出 "CLOSED" 到 stdout，由主进程 readline 读取。
 *
 * 来源：electron/sentinel-src/ 编译（Rust + windows-rs）
 *   cargo build --release --target x86_64-pc-windows-msvc
 *   将编译产物复制到 electron/bin/window_sentinel.exe
 *
 * macOS 不支持 sentinel（无 SetWinEventHook），始终返回 null。
 * 全屏录制模式不需要 sentinel，但此函数不做模式判断，由调用方决定。
 */
function getSentinelPath(): string | null {
  // macOS 不使用 sentinel
  if (process.platform !== 'win32') return null;

  const binName = 'window_sentinel.exe';

  if (app.isPackaged) {
    const bundledPath = path.join(process.resourcesPath, 'bin', binName);
    if (fs.existsSync(bundledPath)) return bundledPath;
  } else {
    const localPath = path.join(__dirname, '..', 'electron', 'bin', binName);
    if (fs.existsSync(localPath)) return localPath;
  }

  console.warn('[recorder] window_sentinel.exe 未找到，窗口关闭将 fallback 到轮询检测');
  return null;
}
```

---

## 3. 新增 startSentinel() 函数（在 spawnFfmpeg() 前面）

```typescript
/**
 * 启动 window_sentinel.exe 监听目标窗口关闭事件（仅 Windows 窗口录制模式）。
 *
 * 通信模式：spawn + stdout/stderr pipe
 *   - stdout: readline 逐行读取，"CLOSED" → 触发 stop()
 *   - stderr: 日志输出（不影响业务逻辑）
 *   - close: 区分 sentinel 自身崩溃 vs 窗口关闭
 *
 * 竞态保护：
 *   - isUserStopped 守卫防止双重 stop()
 *   - sentinelClosedReceived 区分 "CLOSED" 输出 vs 进程异常退出
 *   - sentinel 异常退出 → fallback 到 desktopCapturer 轮询
 *
 * @param displayTitle 目标窗口标题（与 gfxcapture 的 window_title 参数一致）
 */
function startSentinel(displayTitle: string): void {
  const sentinelBin = getSentinelPath();
  if (!sentinelBin) {
    // sentinel 不存在 → 直接启动轮询兜底
    console.warn('[recorder] window_sentinel 不可用，启动轮询兜底');
    startPollingFallback(displayTitle);
    return;
  }

  sentinelClosedReceived = false;

  windowSentinelProcess = spawn(sentinelBin, ['--title', displayTitle], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const sentinelProc = windowSentinelProcess;

  // stdout readline: 逐行读取 sentinel 输出
  const readline = require('readline');
  const rl = readline.createInterface({ input: sentinelProc.stdout });

  rl.on('line', (line: string) => {
    const trimmed = line.trim();

    if (trimmed === 'CLOSED' && !isUserStopped) {
      sentinelClosedReceived = true;
      console.log('[recorder] window_sentinel 检测到目标窗口关闭，触发优雅停止');
      stop(); // 窗口关闭 → 优雅停止录制
    } else if (trimmed === 'NOT_FOUND') {
      console.warn('[recorder] window_sentinel 启动时未找到目标窗口');
      // 窗口可能已被关闭，或标题不匹配
      // 不触发 stop()（可能是 desktopCapturer 缓存的旧窗口）
      // 但应该通知 UI
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('recorder:warning', '目标窗口可能已关闭');
      }
    } else if (trimmed.startsWith('HEARTBEAT')) {
      // 心跳（可选功能，当前版本默认不输出）
      console.log('[recorder] window_sentinel heartbeat');
    }
  });

  // stderr: 日志输出
  sentinelProc.stderr.on('data', (data: Buffer) => {
    console.log(`[sentinel] ${data.toString().trim()}`);
  });

  // close 事件: 区分 sentinel 自身退出 vs 窗口关闭
  sentinelProc.on('close', (code) => {
    if (!isUserStopped && !sentinelClosedReceived && code !== 0) {
      // sentinel 异常退出且未输出 CLOSED → sentinel 自身崩溃
      // 不触发 stop()，启动轮询兜底
      console.warn(`[recorder] window_sentinel 异常退出（code=${code}），启动轮询兜底`);
      windowSentinelProcess = null;
      startPollingFallback(displayTitle);
    } else {
      // 正常情况：窗口关闭 → sentinel 输出 CLOSED → 退出 (code 0)
      // 或：录制停止 → cleanup kill sentinel → exit code = SIGTERM
      console.log(`[recorder] window_sentinel 退出（code=${code})`);
      windowSentinelProcess = null;
    }

    // 关闭 readline 接口
    rl.close();
  });

  console.log(`[recorder] window_sentinel 已启动，监听窗口: "${displayTitle}"`);
}

/**
 * 轮询兜底：sentinel 不可用时的窗口关闭检测。
 *
 * 每 2 秒用 desktopCapturer.getSources() 枚举窗口列表，
 * 检查 displayTitle 是否仍存在。消失时调用 stop() 优雅停止。
 *
 * 场景触发：
 *   1. window_sentinel.exe 不存在（macOS 或 Windows 上 exe 未安装）
 *   2. sentinel 异常退出（自身崩溃）
 *
 * 性能：desktopCapturer.getSources() 每 2s 调用一次，
 *   带有 thumbnailSize: { width: 0, height: 0 } 跳过缩略图采集，
 *   CPU 开销约 1-2ms/次，对录制性能无影响。
 */
function startPollingFallback(displayTitle: string): void {
  if (sentinelFallbackTimer) return; // 防止重复启动

  console.log('[recorder] 启动轮询兜底，每 2s 检查窗口: "' + displayTitle + '"');

  sentinelFallbackTimer = setInterval(async () => {
    if (isUserStopped) {
      // 录制已停止，清理定时器
      if (sentinelFallbackTimer) {
        clearInterval(sentinelFallbackTimer);
        sentinelFallbackTimer = null;
      }
      return;
    }

    try {
      // 枚举窗口列表（跳过缩略图采集以降低开销）
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
      });

      // 检查目标窗口标题是否仍存在
      const stillExists = sources.some((s) => s.name === displayTitle);

      if (!stillExists) {
        console.log('[recorder] 轮询检测到目标窗口消失，触发优雅停止');
        if (sentinelFallbackTimer) {
          clearInterval(sentinelFallbackTimer);
          sentinelFallbackTimer = null;
        }
        stop(); // 窗口消失 → 优雅停止录制
      }
    } catch (err) {
      // desktopCapturer.getSources 可能因权限问题抛出
      console.warn('[recorder] 轮询枚举窗口失败:', (err as Error).message);
    }
  }, 2000);
}
```

---

## 4. start() 函数修改（约第 1085 行后面）

在 `ffmpegProcess = spawnFfmpeg(...)` 和 `attachFfmpegHandlers(...)` 之后，添加：

```typescript
  // ── 窗口录制模式：启动 window_sentinel 监听窗口关闭 ──────────────────
  // 全屏录制不需要 sentinel（屏幕不会"关闭"）
  if (currentSourceId.startsWith('window:') && process.platform === 'win32') {
    startSentinel(displayTitle);
  }
```

---

## 5. cleanup() 函数修改（约第 640 行区域）

在清理 tickTimer / timeoutTimer / retryTimerRef 之后，添加：

```typescript
  // 停止 window_sentinel（录制停止时 kill）
  if (windowSentinelProcess) {
    try { windowSentinelProcess.kill('SIGINT'); } catch (_) { /* 已退出 */ }
    windowSentinelProcess = null;
  }

  // 停止轮询兜底定时器
  if (sentinelFallbackTimer) {
    clearInterval(sentinelFallbackTimer);
    sentinelFallbackTimer = null;
  }
```

---

## 6. handleFfmpegCrash() 修改（约第 986 行区域）

**重要**：在 kill audioCaptureProcess 之后，**不要 kill sentinel**。

确认当前代码：
```typescript
  // 终止旧的 audio_capture 进程（spawnFfmpeg 内部会启动新的）
  if (audioCaptureProcess) {
    try {
      if (process.platform === 'win32') {
        audioCaptureProcess.kill('SIGINT');
      } else {
        audioCaptureProcess.kill('SIGTERM');
      }
    } catch (_) { /* 已退出 */ }
    audioCaptureProcess = null;
  }
```

在这段之后，**不要添加 kill sentinel 的代码**。sentinel 在整个录制会话中只启动一次，
与 ffmpeg crash 无关。如果目标窗口仍在，sentinel 应继续监听。

---

## 7. 注意事项

1. **readline 导入**：`require('readline')` — Node.js 内置模块，无需安装
   如果项目使用 ES module，改用 `import * as readline from 'readline'`
   （需检查 recorder.ts 的模块格式）

2. **desktopCapturer.getSources thumbnailSize: { width: 0, height: 0 }**：
   Electron 文档中 thumbnailSize 最小值为 1×1，设为 0×0 可能不被支持。
   如果不支持，改用 `{ width: 1, height: 1 }`（1px 缩略图，开销极低）。

3. **sentinel stdout flush 延迟**：sentinel 输出 CLOSED 后 sleep 100ms 再退出，
   确保 Node.js 侧 readline 能收到。已在 Rust 源码中处理。

4. **isUserStopped 幏等守卫**：这是防止双重 stop 的关键防线。
   无论 sentinel CLOSED 和用户 stop button 哪个先触发，
   第二个都会被 `if (isUserStopped) return` 拦截。
