# QA 验证报告 — 音频改动导致无法停止录屏（BugFix 回归修复）

**验证人**：Edward（QA 工程师，严过关）
**验证方式**：仅 Read / 运行 `tsc` / 逻辑复核，**未修改任何源码**
**改动文件**：`electron/handlers/recorder/recording/index.ts`（仅此一处）
**验证轮次**：Round 1（一次通过，无需 Round 2）

---

## 验证结论

✅ **全部 6 项 PASS → 路由判定：NoOne / 成功**
本次 BugFix 修复已正确落盘，未引入新编译错误，修复方向正确，可放行。

---

## 逐项核对结果

### ✅ 1. 文件落盘核对（两处改动均实际存在，文案/位置与描述一致）

**改动 1 — `stopRecording` Windows 分支（L104-119）**
```typescript
if (process.platform === 'win32') {
  if (audioCaptureProcess) {
    try {
      // 关键修复：先断开源 stdout → ffmpeg stdin 的管道，再结束 stdin。
      audioCaptureProcess.stdout?.unpipe?.();   // L112
      audioCaptureProcess.stdout?.destroy();    // L114
      audioCaptureProcess.kill('SIGINT');       // L116
    } catch (_) { /* ignore */ }
    audioCaptureProcess = null;
  }
  setTimeout(() => {                            // L120
    ffmpegProcess?.stdin?.write('q');           // L121
    ffmpegProcess?.stdin?.end();                // L122
  }, 200);
}
```
- `unpipe?.()`（L112）、`destroy()`（L114）均在 `kill('SIGINT')`（L116）之前落盘 ✅
- `use_wallclock_as_timestamps` 参数位置未改（见第 2 项）✅

**改动 2 — `spawnFfmpeg` 管道处（L380-394）**
```typescript
if (audioCaptureProcess) {
  const stdout = audioCaptureProcess.stdout;
  if (stdout) {
    stdout.on('unpipe', () => {                 // L384
      callbacks.onLog?.('[recording] audio_capture stdout 已与 ffmpeg stdin 断开管道(unpipe)');
    });
    stdout.pipe(proc.stdin);                    // L387
  }
}
```
- 诊断日志 `stdout.on('unpipe', ...)` 已落盘，且**注册在 `stdout.pipe(proc.stdin)` 之前**（L384 < L387）✅
- 文案与工程师声明完全一致：`[recording] audio_capture stdout 已与 ffmpeg stdin 断开管道(unpipe)` ✅
- 注：行号位于 L380-394（工程师估的 369-375 略有偏移，属正常估计误差，改动本体一致）

### ✅ 2. 未触碰项（gap 修复与既有参数均保留）

| 项目 | 位置 | 状态 |
|------|------|------|
| `-use_wallclock_as_timestamps 1` | L319 `audioInputArgs` | 保留 ✅ |
| `aresample` 滤镜 | L320 `'aresample=async=1:min_hard_comp=0.100:first_pts=0'` | 保留 ✅ |
| `-c:a aac` | L321 | 保留 ✅ |
| 视频编码参数（encodeArgs / platformVfArgs） | L325-354 | 未动 ✅ |
| 转码层 | 不在本文件（独立模块） | 未动 ✅ |

→ "不能丢的 gap 修复"（`use_wallclock_as_timestamps`）与音频管线其余部分完整保留，无回归。

### ✅ 3. unpipe 参数核对

- 落盘代码：`audioCaptureProcess.stdout?.unpipe?.()`（**无参数**，L112）✅
- 等价性：Node.js `Readable.unpipe()` 无参时取消该流**所有** pipe 目标；本场景源 stdout 仅有一个目标（ffmpeg stdin，见 L387），故无参 `unpipe()` 等价于 `unpipe(proc.stdin)`，正确且安全 ✅

### ✅ 4. 执行顺序正确性

- 顺序：`unpipe()`（L112）→ `destroy()`（L114）→ `kill('SIGINT')`（L116）——**非 kill 在前** ✅
- `ffmpegProcess.stdin.write('q')` + `.end()`：位于 `setTimeout(..., 200)`（L120-123），在 unpipe/destroy/kill 块**之后**执行，未被提前或被删除 ✅
- `kill('SIGINT')` 处于 `try/catch` 内，异常被吞掉，不会中断后续 200ms 'q' 流程 ✅

### ✅ 5. 类型 / 编译

- 命令：`cd C:/Users/绝绝子/Desktop/Co/CoWatch && npx tsc -p tsconfig.electron.json --noEmit`
- 退出码：`2`（存在错误），**错误总数 = 5**
- 5 条错误全部为**已知无关错误**，且**无一位于改动文件** `electron/handlers/recorder/recording/index.ts`：

| # | 位置 | 类型 | 是否本次引入 |
|---|------|------|------|
| 1 | `electron/handlers/cache.ts(42,8)` TS6059 rootDir | 预存 | 否 |
| 2 | `electron/handlers/recorder/index.ts(29,30)` TS7016 uuid | 预存 | 否 |
| 3 | `electron/handlers/recorder/index.ts(31,77)` TS6059 rootDir(src/types/recorder) | 预存 | 否 |
| 4 | `electron/main.ts(30,21)` TS2552 `__API_ORIGIN__` | 预存 | 否 |
| 5 | `electron/preload.ts(18,15)` TS2304 `__API_ORIGIN__` | 预存 | 否 |

→ **本次改动引入的新错误：0 条** ✅

### ✅ 6. 逻辑正确性（修复方向合理）

机理复核：
1. `-use_wallclock_as_timestamps 1`（L319）将音频 PCM 输入标记为"live 源"，ffmpeg 输入线程按墙钟时间计算 PTS；当音频源进程死亡但 stdin 管道仍连接时，输入线程可能阻塞在 wallclock 等待，不消费 'q'。
2. 原停止流程在 Windows 上直接 `kill('SIGINT')` 音频源，其 stdout 仍可能向 ffmpeg stdin 泵尾部数据 → ffmpeg 音频输入（pipe:0）无法干净收到 EOF → 'q' 不被处理 → ffmpeg 卡死（退出码 null，直至 15s SIGKILL 兜底）。
3. 修复：先 `unpipe()`（解除 stdout→stdin 绑定）、再 `destroy()`（关闭源 stdout 并触发 `unpipe` 事件，从而写出诊断日志）、最后 `kill('SIGINT')`；此后 200ms 的 'q'+`end()` 才能让 ffmpeg 干净退输入并正常退出。

→ 解释自洽、修复方向正确，且新增 `unpipe` 诊断日志便于真机确认管道确实断开 ✅

---

## 真机验证步骤（如何确认修复生效）

> 注意：本修复仅作用于 **Windows（win32）** 分支的 `stopRecording`。macOS/Linux 走 SIGTERM 分支，不受此改动影响，`unpipe` 日志在其它平台停止时不会触发。

1. **环境**：Windows 上以 dev 或 packaged 模式启动 CoWatch（`audio_capture.exe` 须存在，音频采集启用）。
2. **开始录制**：选屏幕或窗口开始录制，确认日志出现：
   - `[recording] 音频输入已启用墙钟时间戳(use_wallclock_as_timestamps)...`
   - ffmpeg 启动参数中含 `-use_wallclock_as_timestamps 1 -f s16le ... -i pipe:0` 及 `-af aresample=...`
3. **停止录制**：点停止。
4. **看日志确认修复**：
   - 应看到 `[recording] audio_capture stdout 已与 ffmpeg stdin 断开管道(unpipe)`（诊断日志触发 = 管道已断开）；
   - 应看到 `[recording] ffmpeg 正常退出，code=0`（或非零但非 null），且退出发生在 15s SIGKILL 兜底**之前**（即远早于 15s）。
5. **回归确认**：
   - 输出 `index.m3u8`+`segNNN.ts` 正常生成，播放有音轨（确认 `use_wallclock_as_timestamps` gap 修复未丢）；
   - 对比"修复前"现象：修复前应卡到 15s 才被 SIGKILL 杀掉（退出码 null），无 `unpipe` 日志。

---

## 路由判定

- **Send To：NoOne（成功）**
- 原因：6 项验证全部 PASS；改动正确落盘、顺序正确、无参数误删/误改、tsc 零新增错误、修复逻辑合理。无需工程师返工，无需测试脚本自修。
- 说明：仓库既有 5 个无关 tsc 错误（cache.ts rootDir、recorder/index.ts uuid+rootDir、main.ts/preload.ts `__API_ORIGIN__`）与本次改动无关，已标注忽略。
