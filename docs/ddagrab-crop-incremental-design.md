# 增量设计 v2.2：ddagrab 全屏 + crop 替换 gfxcapture（窗口录制）—— sentinel 改用 Python + PyInstaller

> sentinel 实现技术由 **Rust/Cargo** 改为 **Python 3 + ctypes + PyInstaller 单文件打包**；行为模型、接口、stdout 协议、任务列表其余项**全部沿用 v2.1**，仅 sentinel 内部实现与产物构建方式变化。
> 作者：软件架构师（高见远）
> 类型：**增量设计 + 任务分解 + 成本/风险评估**（仅设计，不含实现代码）
> 范围：CoWatch Windows Electron+React+TS 游戏录屏 —— 窗口录制捕获源替换（DDA+crop）+ Win32 事件驱动生命周期编排
> 配套图：`docs/class-diagram.mermaid`、`docs/sequence-diagram.mermaid`

---

## 0. 修订说明（相对 v2.1：sentinel 实现技术 Rust → Python，行为/接口/协议不变）

| 维度 | v2.1（旧） | v2.2（本版） |
|------|-----------|--------------|
| sentinel 语言 | Rust + windows-rs + Cargo | **Python 3 + ctypes（零运行时依赖）+ PyInstaller 单文件** |
| 源码位置 | `sentinel-src/src/main.rs` 等 | `electron/bin/build-sentinel/window_sentinel.py` + `build.ps1` |
| 产物构建 | `cargo build --release` → 拷 `electron/bin/` | `pyinstaller -F --noconsole --noupx --distpath ../ window_sentinel.py` → 直接落 `electron/bin/window_sentinel.exe` |
| 行为模型/接口/协议 | 不变 | **100% 不变**（stdout 行协议语言无关，TS 侧零改动） |
| 任务列表 | T1 为 Rust 扩展 | **仅 T1 描述改为 Python**；T2-T5 不变 |

> 用户已正式拍板：sentinel 用 Python 重写 + PyInstaller 打包；其余 v2.1 设计全部保留。

---

## 1. 已确证事实（设计前提，未变）

| 项 | 结论 |
|----|------|
| 根因 | 捕获侧断供：gfxcapture(WGC 推模式) 在游戏非前台/场景加载/交换链重建时收不到帧 → dup 填空 → 冻结。非编码瓶颈（编码器全程 28-30fps 稳）。 |
| ddagrab 已验证 | 全屏 DDA 拉模式稳定 30fps、零掉帧，绕过 WGC/DWM 节流。 |
| ffmpeg build | `ddagrab` `crop` `hwdownload` 可用（项目自带 `electron/bin/ffmpeg.exe` 已验证）。 |
| 打包 | `electron-builder.yml` 的 `extraResources` 已含 `from: electron/bin/ to: bin/`，放进去即打包（**不变**）。 |
| 续录机制 | `getNextSegmentNumber()` + `-start_number N` 续写同一 `tmpDir/index.m3u8`（pause/resume 复用）。 |
| 集成资产 | 已写好 `docs/sentinel-recorder集成代码.md`、`窗口哨兵集成风险分析.md`（描述 **stdout 行协议**，语言无关，Python 版直接复用）。 |

---

## 2. 成本/风险评估：Python(ctypes)+PyInstaller vs koffi（NAPI）+ zeromq + OBS

### 2.1 两条路线对比（获取"初始矩形 + 窗口事件"两个仅剩的原生能力）

| 维度 | **路线一：Python 3 + ctypes + PyInstaller** | **路线二：koffi（NAPI）在 Node 侧直调** |
|------|--------------------------------------------|----------------------------------------|
| 新语言/工具链 | Python 已在本机；PyInstaller 纯 Python 包、pip 安装、**无需 C 编译**；无 Rust 环境也能构建 | 无新语言；koffi 纯 JS FFI 加载器 |
| **Electron ABI 耦合** | **无**：独立 exe，与 Electron 版本 ABI 完全解耦，升级零风险 | **有**：koffi 是 NODE-API addon，必须 `@electron/rebuild` 对齐头文件；升级易碎 |
| **SetWinEventHook 消息泵** | **Python 单线程主线程跑 `GetMessageW` 循环天然满足**（WINEVENT_OUTOFCONTEXT 回调在同线程触发）→ 无需额外线程 | **需自建**：Node 主线程跑消息泵会阻塞事件循环，须开 worker thread + 消息循环，复杂易错（**决定性劣势**） |
| DPI 控制 | Python 进程自设 `PROCESS_PER_MONITOR_DPI_AWARE`，与 Electron 解耦 | 继承 Electron 主进程 DPI awareness，坐标难控 |
| electron-builder 打包 | `extraResources` 已含 `bin/*`，PyInstaller 产物直接落 `electron/bin/`，**零改动** | 须把 koffi 原生二进制纳入 `extraResources`/`asarUnpack`，有风险 |
| 集成资产 | 已有 IPC 方案/风险分析文档（语言无关 stdout 协议） | 无 |
| 构建步骤 | `pyinstaller` 一条命令 → `electron/bin/window_sentinel.exe`（CI 一步） | `npm i` + `electron-rebuild`（每升 Electron 重跑） |
| 新增运行时依赖 | **零**（ctypes 直调系统 DLL，无第三方安装） | koffi 原生 shim |
| **结论** | ✅ **推荐** | ❌ 不推荐 |

### 2.2 选 Python（而非既有 Rust 源码）的理由（用户拍板）

1. **本机无 Rust 环境**：原 Rust 路线需 `cargo` + `x86_64-pc-windows-msvc` target 安装与验证，构建环境成本高且不确定。
2. **Python 已安装、PyInstaller 纯 Python 包**：`pip install pyinstaller` 即可，无需 C/C++ 编译链，开箱即用。
3. **规避既有 Rust 源码不确定性**：不依赖他人 sentinel-src 的 Rust 实现/维护，降低理解与上手成本。
4. **协议完全一致（核心收益）**：stdout 行协议语言无关，`sentinel-client.ts` 只读行文本，**TS 侧零改动**；sentinel 内部实现可整体替换而不动上层（行为模型/接口/UI 全部不变）。
5. **如实代价**：exe 体积更大、冷启动略慢、杀软误报概率高于 Rust —— 已在 §2.5 列出并给对策，属可接受权衡。

### 2.3 zeromq.js 是否还需要？ —— **完全不必要（确认）**
决策 1-4（移动/关闭=END、最小化/切走=PAUSE、遮挡=录、单屏）已消灭"实时动态 crop"需求（那本是 koffi/zeromq 唯一存在理由）。仅剩的静态矩形+事件由 sentinel stdout 协议满足，无需 zmq 滤镜 + zeromq 客户端。故 `zeromq.js` 不引入；ffmpeg `zmq`/`azmq` 滤镜本期无调用。

### 2.4 回应用户质疑："为何不直接编译 OBS swap-chain hook？"
**不取 OBS 注入**：DLL 注入 + hook D3D9/11/12/Vulkan swap-chain + 32/64 位 + 反作弊(EAC/BattlEye)兼容，工程量/风险是 DDA+crop 小助手的 **10 倍以上**；且注入有封号风险，DDA 不注入零冲突；根因(DWM 节流)已由 DDA 根治。**结论：保持 DDA(ddagrab)+crop+轻量 sentinel。**

### 2.5 Python 路线风险说明（新增，相对 Rust 的权衡）

| 风险 | 说明 | 对策 |
|------|------|------|
| **杀软误报** | PyInstaller onefile 是自解压打包体，常被启发式判为可疑（常见 AV 触发点）。这是相对 Rust 原生二进制的**新增风险**。 | ① **代码签名**（Authenticode）降低 SmartScreen/AV 告警，与 Electron 应用同一签名流程；② 向 Microsoft Defender / 各 AV 厂商提交误报白名单；③ 用 `--noupx` 避免 UPX 压缩（UPX 是高频触发源）；④ 必要时评估 `--onedir` 减小误报。 |
| **exe 体积** | onefile 打包 Python 解释器+stdlib ≈ **6-12 MB**（Rust 版仅数百 KB）。 | 可接受；可用 `--exclude-module` 裁剪未用模块略减。受 `extraResources` 纳入，对安装包增量有限。 |
| **启动耗时** | onefile 首次运行解压到 `%TEMP%`（有缓存，后续复用），冷启动 **~100-300ms**（Rust 原生近瞬时）。 | 录制启动路径可接受；若不达标可改 `--onedir`（多文件、启动更快）。 |
| **stdout 缓冲** | Python 默认块缓冲，若不刷新会致 sentinel-client 读行卡住（**关键必须项**）。 | 所有协议输出用 `print(..., flush=True)`，或启动时 `sys.stdout.reconfigure(line_buffering=True)`。 |
| **控制台窗口** | 默认 PyInstaller 会弹黑框。 | 用 `--noconsole` 隐藏；stdout 协议仍经父进程 pipe 送达（--noconsole 仅影响是否分配控制台，不影响被重定向的 pipe）。 |
| **32/64 位匹配** | 必须用 **64-bit Python** 构建，匹配 Electron 64-bit；64-bit 下 hwnd 为 64-bit，ctypes `HWND` 正确处理。 | 构建机装 64-bit Python；CI 固定解释器版本。 |
| **UAC/UIPI** | `SetWinEventHook` 跨完整性级别不投递事件（低 IL 收不到高 IL 进程事件）。与 Rust 版**同限制**，非 Python 新增。 | CoWatch 与目标通常同 IL（均标准用户）；若 CoWatch 以管理员运行则目标也需管理员。 |

### 2.6 Python ctypes 能力逐项确认（v2.1 全部所需能力均可实现）

| 能力 | Win32 API / 常量 | ctypes 可用性 |
|------|------------------|--------------|
| 钩子事件 | `EVENT_OBJECT_LOCATIONCHANGE`(0x800B)、`EVENT_OBJECT_MINIMIZESTART`(0x0016)、`EVENT_OBJECT_MINIMIZEEND`(0x0017)、`EVENT_SYSTEM_FOREGROUND`(0x0003)、`EVENT_OBJECT_DESTROY`(0x8001) | 常量整数直接传值；`SetWinEventHook(eventMin, eventMax, 0, cb, 0, 0, WINEVENT_OUTOFCONTEXT\|WINEVENT_SKIPOWNPROCESS)` 在 `user32` |
| 消息泵 | `GetMessageW`（`user32`） | 主线程 `while True: GetMessageW(...)`；Python 单线程天然满足（WINEVENT_OUTOFCONTEXT 回调在同线程） |
| 窗口矩形 | `GetWindowRect`（`user32`） | 可用（但优先用 DWMWA 扩展边界） |
| DWM 扩展边界 | `DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS=9, ...)`（`dwmapi`） | 可用，`byref(RECT)` + `sizeof(RECT)` |
| DPI | `GetDpiForMonitor`（`shcore`, `MDT_EFFECTIVE_DPI=0`）；`SetProcessDpiAwareness`（`shcore`, `PROCESS_PER_MONITOR_DPI_AWARE=2`） | 可用；启动首行先设 DPI awareness 再算坐标 |
| 显示器 | `MonitorFromWindow`（`user32`）、`GetMonitorInfoW`（`user32`, `MONITORINFO`） | 可用 |
| 枚举/前台 | `EnumWindows`（`user32`，`WINFUNCTYPE` 回调）、`GetForegroundWindow`（`user32`） | 可用 |
| Win32 回调 | `WINFUNCTYPE` 定义 `WinEventProc(hWinEventHook, event, hwnd, idObject, idChild, dwEventThread, dwmsEventTime)` | ctypes 支持 Win32 回调 |
| stdout 协议 | `print(f"RECT {x} {y} {w} {h}", flush=True)` 等 | 经父进程 pipe 送达 `sentinel-client.ts`（readline） |

> 结论：**Python + ctypes 可 100% 覆盖 v2.1 所需的全部 Win32 能力**，无功能缺口。

---

## 3. 实现方案 + 框架选型

### 3.1 捕获源替换（决策闭环）
废弃 `gfxcapture=window_title=...`（WGC 推模式），`window:` 源改用 **ddagrab 抓全屏 + crop 裁到窗口矩形**。屏幕录制（`screen:`）现状已用 ddagrab，二者滤镜链一致，风险低。

### 3.2 ffmpeg 滤镜链（inputArgs 草案）
```
-f lavfi -i "ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra,crop=<W>:<H>:<X>:<Y>,scale=w='min(iw\,1280)':h=-2,format=yuv420p"
```
- `output_idx=0`：**固定主屏**（决策 4，单屏）。
- `<X>:<Y>:<W>:<H>`：crop 矩形，**物理像素、相对主屏左上角(0,0)**（由 sentinel 计算，见 §3.5）。
- `crop` 紧接 `hwdownload,format=bgra` 之后、复用现有 `winScaleFilter` 之前，仅字符串注入。
- 其余（`-vsync cfr -r 30`、`-g`、`-hls_time`、`-start_number` 等）与现状一致。
- 不含 zmq（§2.3）。

### 3.3 行为模型（用户最终拍板，全部可由 SetWinEventHook 区分 —— 不变）

| 行为 | Win32 事件 | sentinel 判定 | 录制行为 |
|------|-----------|--------------|---------|
| **移动**（前台可见时） | `EVENT_OBJECT_LOCATIONCHANGE`（shouldRecord 且超阈值，去抖确认） | → `STOP MOVED` | **END**：`stop()` 干净结束会话（非续录） |
| **最小化** | `EVENT_SYSTEM_MINIMIZESTART` | → `PAUSE MINIMIZED` | `pauseRecording()`：优雅停 ffmpeg+音频，**留会话** |
| **alt+tab / 切走** | `EVENT_SYSTEM_FOREGROUND`（新前台 hwnd ≠ 目标） | → `PAUSE FOREGROUND_LOST` | `pauseRecording()` |
| **非抢占重叠 / toast / 遮挡** | 无 FOREGROUND 变化 / 目标仍前台 | **不触发任何事件** | **正常录制**（决策 2） |
| **关闭 / 销毁** | `EVENT_OBJECT_DESTROY` | → `STOP CLOSED` | **END**：`stop()` 干净结束 |
| **最小化恢复** | `EVENT_SYSTEM_MINIMIZEEND`（且前台） | → `RESUME` | `resumeRecording()`：续号新开 ffmpeg |
| **切回** | `EVENT_SYSTEM_FOREGROUND`（hwnd == 目标） | → `RESUME` | `resumeRecording()` |

- pause/resume **仅**由最小化/切走两类触发；move/close 走 `stop()`。
- move/close 的 END 与用户主动停止走**同一** `stop()` 收尾路径；pause 走续录机制，**产生 HLS 段间隙**（见 §9）。

### 3.4 检测机制：事件驱动 sentinel（`shouldRecord` 状态机，Python 单线程消息泵）

sentinel（Python 脚本）维护 `isForeground` + `isMinimized`，推导 `shouldRecord = isForeground && !isMinimized`：

```
init:   baselineRect = 当前矩形; isForeground/isMinimized 取初始查询(启动即前台可见); shouldRecord=true
        → print("RECT <x> <y> <w> <h>", flush=True)

FOREGROUND(hwnd):
    isForeground = (hwnd == targetHwnd)
    recompute shouldRecord; 若 false→true 发 RESUME, true→false 发 PAUSE(FOREGROUND_LOST)

MINIMIZESTART:
    isMinimized = true; recompute; shouldRecord 变 false → PAUSE(MINIMIZED)

MINIMIZEEND:
    isMinimized = false; recompute; 若变 true → baselineRect=当前矩形(吸收恢复位移); RESUME

LOCATIONCHANGE:
    if !shouldRecord → 忽略（最小化/恢复过渡噪声，不判移动）
    else 读当前矩形; 与 baselineRect 差异超阈值 → 进入"待确认"
        去抖: 连续 2 次确认同一新位置(事件即时读 + ~150ms 复读) → STOP MOVED
        若回弹到 baseline → 取消

DESTROY:
    STOP CLOSED

主线程: while GetMessageW(msg, 0, 0, 0): TranslateMessage; DispatchMessage  # WINEVENT_OUTOFCONTEXT 回调在此线程触发
```

- **遮挡/非抢占重叠**：不抢焦点 → 无 FOREGROUND 变化 → 无事件 → 正常录制（决策 2 自然成立）。
- **hung/NR**：窗口不移动、不丢前台 → 不触发 → 不误判（见 §10）。
- LOCATIONCHANGE 仅在 `shouldRecord` 且真实移动时才发 `STOP MOVED`；最小化/恢复的过渡噪声被 `shouldRecord` 与"RESUME 时重置 baseline"双重抑制。
- Python `WINFUNCTYPE` 回调在消息泵同线程执行，单线程即可，无需额外线程（与 §2.1 消息泵结论一致）。

### 3.5 坐标空间（关键结论 —— 隔离在 sentinel 进程内，单屏）

所有坐标运算在 sentinel 进程内（自设 DPI awareness，与 Electron 解耦）。ddagrab `output_idx=0` = 原生物理像素、主屏左上角 (0,0)。算法（Python ctypes 调用）：

```
1. EnumWindows 按标题匹配 → 目标 hwnd
2. DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rect)   # 物理像素，虚拟屏坐标
3. MonitorFromWindow(hwnd) → 主屏 HMONITOR（单屏假设，output_idx=0）
4. GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &dpiX, &dpiY); scale = dpiX/96.0
5. GetMonitorInfo(hmon, &mi) → mi.rcMonitor; monPhysLeft=mi.rcMonitor.left*scale; monPhysTop=mi.rcMonitor.top*scale
6. crop（相对主屏左上角，物理像素）= rect - monPhysOrigin
      x = rect.left - monPhysLeft;  y = rect.top - monPhysTop
      w = rect.right - rect.left;   h = rect.bottom - rect.top
7. 输出首行： RECT <x> <y> <w> <h>     # output_idx 固定 0，协议省略
```

启动首行 `SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE)`（务必在任何 DPI 查询**之前**调用）。
> 单屏约束：假设主屏位于虚拟屏原点（单显示器或主屏在 (0,0)）；窗口在主屏外超出本期（决策 4）。

---

## 4. 文件列表（增量，标注 新增 / 修改 / 删除 / 不变）

| 文件 | 状态 | 改动要点 |
|------|------|---------|
| `electron/sentinel-src/src/main.rs` | **删除** | 不再用 Rust 实现（v2.2 改 Python） |
| `electron/sentinel-src/Cargo.toml` | **删除** | 同上 |
| `electron/sentinel-src/BUILD.md` | **删除** | 同上（Python 构建见 `build-sentinel/`） |
| `electron/bin/build-sentinel/window_sentinel.py` | **新增** | ctypes 实现：SetWinEventHook 钩子 + GetMessageW 消息泵 + 坐标/DPI 计算 + stdout 协议（RECT/PAUSE/RESUME/STOP/NOT_FOUND） |
| `electron/bin/build-sentinel/build.ps1` | **新增** | PyInstaller 打包脚本（输出 `electron/bin/window_sentinel.exe`） |
| `electron/bin/build-sentinel/requirements.txt` | **新增(可选)** | 仅开发期依赖 `pyinstaller`（不进运行时） |
| `electron/bin/window_sentinel.exe` | **产物** | PyInstaller `--distpath ../` 直接落此路径（与现有 extraResources 一致） |
| `electron/handlers/recorder/recording/index.ts` | **修改** | `window:` 分支改用 ddagrab+crop（读 `cfg.crop`，`output_idx=0`）；`crop?` 字段；`pauseRecording/resumeRecording/isPaused` + `gracefulStopInProgress` 守卫 + `onPauseStateChange`；move/close 走 `stop()`；sentinel 缺失 fallback 到 gfxcapture。（**与 v2.1 同，未因换语言改变**） |
| `electron/handlers/recorder/recording/types.ts` | **新增(可选)** | `CropRect` / `PauseReason` / `StopReason` 类型 |
| `electron/handlers/recorder/window-watch.ts` | **修改(降级)** | crop 模式不启动 5s `desktopCapturer` 轮询；保留 `isWindowAlive` 作 crash 兜底 |
| `electron/handlers/recorder/index.ts`（协调层） | **修改** | 启动 sentinel（读 `RECT`→crop）；`PAUSE`→`pauseRecording`；`RESUME`→`resumeRecording`；`STOP`→`stop(reason)`；`NOT_FOUND`→fallback；暴露 `recorder:pauseState` + `recorder:autoStopped(reason)` IPC。（**sentinel-client 协议零改动**） |
| `electron/handlers/recorder/sentinel-client.ts` | **不变** | 封装 spawn + readline 解析（RECT/PAUSE/RESUME/STOP/NOT_FOUND）；与 Python 版协议 100% 兼容，仅 spawn 的 exe 路径相同（仍是 `electron/bin/window_sentinel.exe`） |
| `electron/preload.ts` | **修改** | 暴露 `recorder:pauseState(reason)` + `recorder:autoStopped(reason)` |
| `src/components/Recorder/index.tsx` | **修改** | 监听 `pauseState` 显示"已暂停（已最小化/已切换）"；监听 `autoStopped` 显示"窗口已移动/已关闭，录制已结束" |
| `package.json` | **不变** | 零新增 npm 依赖（koffi/zeromq 均不引入；pyinstaller 仅开发期） |
| `electron-builder.yml` | **不变** | `extraResources` 已含 `bin/*`，sentinel 放入即打包 |

---

## 5. 数据结构和接口（类图 + 接口签名）

> 完整 Mermaid 见 `docs/class-diagram.mermaid`。TS 侧模块关系语言无关，sentinel 为黑盒子进程（`window_sentinel.exe`），内部由 Python 实现，对外契约不变。

### 5.1 关键类型
```typescript
interface CropRect { x: number; y: number; w: number; h: number; } // 物理像素，主屏相对
type PauseReason = 'MINIMIZED' | 'FOREGROUND_LOST';
type StopReason  = 'MOVED' | 'CLOSED';

interface RecordingConfig {
  // ... 现有字段 ...
  crop?: CropRect; // window: 源 + win32 时由协调层填入
}
interface RecordingCallbacks {
  // ... 现有 onCrash / onShouldStop / onLog ...
  onPauseStateChange?: (paused: boolean, reason?: PauseReason) => void;
  onAutoStopped?: (reason: StopReason) => void; // 移动/关闭 → 结束
}
```

### 5.2 模块公开 API（与 v2.1 一致，未变）
```typescript
// ── recording 层 ──
export function pauseRecording(): void;        // 优雅停 ffmpeg+音频，留会话（仅最小化/切走）
export function resumeRecording(): Promise<void>;// 续号新开 ffmpeg（复用 -start_number）
export function isPaused(): boolean;

// ── sentinel 客户端（不变）──
interface SentinelCallbacks {
  onRect(rect: CropRect): void;
  onPaused(reason: PauseReason): void;
  onResumed(): void;
  onStopped(reason: StopReason): void;
  onNotFound(): void;
}
interface SentinelHandle { stop(): void; }
function startSentinel(title: string, cbs: SentinelCallbacks): SentinelHandle | null;
// 返回 null = sentinel 不可用 → 调用方 fallback 到 gfxcapture
```

### 5.3 类图（摘要，TS 侧不变）
- `RecordingConfig` 聚合 `CropRect`。
- `RecordingLayer` 提供 `start/stop/pause/resume/isPaused`；`spawnFfmpeg()` 读 `cfg.crop` 构建 ddagrab+crop。
- `SentinelClient` 持有 `SentinelHandle`，回调 `onRect/onPaused/onResumed/onStopped/onNotFound`；spawn 的 exe 路径仍为 `electron/bin/window_sentinel.exe`（Python 版）。
- `Coordinator` 编排 `RecordingLayer` + `SentinelClient` + `WindowWatch`(仅兜底)。

---

## 6. 程序调用流程（时序图）

> 完整 Mermaid 见 `docs/sequence-diagram.mermaid`。五段：启动 / 暂停 / 恢复 / 移动结束 / 关闭结束（sentinel 参与者现标注为 Python/PyInstaller 实现，行为不变）。

### 6.1 启动
```
UI ──recorder:start(windowId,title)──▶ Coordinator
Coordinator ──startSentinel(title)──▶ SentinelClient ──spawn electron/bin/window_sentinel.exe (Python)──▶ window_sentinel.exe
window_sentinel.exe(Python): EnumWindows + DwmGetWindowAttribute + DPI(主屏) + SetProcessDpiAwareness
window_sentinel.exe ──stdout "RECT <x> <y> <w> <h>"──▶ SentinelClient ──onRect──▶ Coordinator
Coordinator ──startRecording(cfg{crop})──▶ RecordingLayer
RecordingLayer ──spawnFfmpeg(ddagrab+crop, output_idx=0)──▶ ffmpeg
window_sentinel.exe: GetMessageW 消息泵，监听 LOCATIONCHANGE/DESTROY/MINIMIZESTART/MINIMIZEEND/FOREGROUND
```

### 6.2 暂停（最小化 / alt+tab）
```
window_sentinel.exe: MINIMIZESTART / FOREGROUND(other)
window_sentinel.exe ──stdout "PAUSE <reason>"──▶ SentinelClient ──onPaused──▶ Coordinator
Coordinator ──pauseRecording()──▶ RecordingLayer
RecordingLayer: kill audio(SIGINT) → 200ms 后 ffmpeg stdin 'q' → ffmpegProcess=null（留会话）
RecordingLayer ──onPauseStateChange(true,reason)──▶ Coordinator ──recorder:pauseState──▶ UI("已暂停(已最小化/已切换)")
```

### 6.3 恢复（最小化恢复 / 切回）
```
window_sentinel.exe: MINIMIZEEND / FOREGROUND(target)
window_sentinel.exe ──stdout "RESUME"──▶ SentinelClient ──onResumed──▶ Coordinator
Coordinator ──resumeRecording()──▶ RecordingLayer
RecordingLayer: spawnFfmpeg() → getNextSegmentNumber() 续号 N → 重新拉 audioCaptureProcess 并 pipe
RecordingLayer ──onPauseStateChange(false)──▶ Coordinator ──recorder:pauseState──▶ UI("已恢复")
```

### 6.4 移动结束（前台可见时移动，去抖确认）
```
window_sentinel.exe: LOCATIONCHANGE(shouldRecord, 去抖确认新位置)
window_sentinel.exe ──stdout "STOP MOVED"──▶ SentinelClient ──onStopped──▶ Coordinator
Coordinator ──stop('MOVED')──▶ 正常收尾 + finish + cleanup
Coordinator ──recorder:autoStopped('MOVED')──▶ UI("窗口已移动，录制已结束")
```

### 6.5 关闭结束
```
window_sentinel.exe: DESTROY → stdout "STOP CLOSED" → SentinelClient ──onStopped──▶ Coordinator
Coordinator ──stop('CLOSED')──▶ finish ──recorder:autoStopped('CLOSED')──▶ UI("窗口已关闭，录制已结束")
```

---

## 7. 任务列表（有序、含依赖）

### Tier A（本期必做：ddagrab 静态 crop + 移动/关闭=END + 最小化/切走=PAUSE/RESUME + window-watch 降级）
| ID | 任务 | 源文件（状态） | 依赖 | 优先级 |
|----|------|--------------|------|--------|
| **T1** | 写 `electron/bin/build-sentinel/window_sentinel.py`（**Python + ctypes**）：SetWinEventHook 钩子（LOCATIONCHANGE/DESTROY/MINIMIZESTART/MINIMIZEEND/FOREGROUND）+ `GetMessageW` 主线程消息泵 + `shouldRecord` 状态机 + baseline/抑制逻辑；DWMWA_EXTENDED_FRAME_BOUNDS / GetDpiForMonitor 坐标计算；DPI awareness；stdout 行协议（RECT/PAUSE/RESUME/STOP/NOT_FOUND，务必 `flush=True`）。再用 PyInstaller 产出 `electron/bin/window_sentinel.exe`：`pyinstaller -F --name window_sentinel --noconsole --noupx --distpath ../ window_sentinel.py`（64-bit Python 构建）。编写 `build.ps1` 与可选 `requirements.txt`。 | `build-sentinel/window_sentinel.py`(新)、`build.ps1`(新)、`requirements.txt`(新,可选)、产物 `electron/bin/window_sentinel.exe` | — | P0 |
| **T2** | recording 层：`window:` 分支改用 ddagrab+crop（读 `cfg.crop`，`output_idx=0`）；`crop?` 字段；`pauseRecording/resumeRecording/isPaused` + `gracefulStopInProgress` 守卫 + `onPauseStateChange`（仅最小化/切走触发）；move/close 走 `stop()`；sentinel 缺失 fallback 到 gfxcapture。（**与 v2.1 同，未变**） | `recording/index.ts`(改)、`recording/types.ts`(新,可选) | T1(需 crop 数据结构约定) | P0 |
| **T3** | 协调层 + sentinel 客户端：`sentinel-client.ts`（**协议零改动**）封装 spawn+readline；协调层 win32 `window:` 启动 sentinel、读 RECT→crop；`PAUSE`→pause、`RESUME`→resume、`STOP`→stop(reason)、`NOT_FOUND`→fallback；暴露 `recorder:pauseState` + `recorder:autoStopped(reason)` IPC。 | `recorder/index.ts`(改)、`sentinel-client.ts`(不变) | T1, T2 | P0 |
| **T4** | window-watch 降级：crop 模式不启动 5s `desktopCapturer` 轮询（`startWindowWatcher` 按模式门控）；保留 `isWindowAlive` 作 crash 一次性兜底。 | `window-watch.ts`(改) | T3 | P1 |
| **T5** | UI：preload 暴露 `pauseState` + `autoStopped`；`Recorder/index.tsx` 显示暂停横幅与结束原因横幅。 | `preload.ts`(改)、`src/components/Recorder/index.tsx`(改) | T3 | P1 |

> T1→T2→T3 为主链路；T4/T5 并行于 T3 之后。**Tier B（zmq 动态 crop）已删除**（决策 1-4 消灭需求，zeromq 不必要）。**仅 T1 描述因换 Python 而改变，T2-T5 与 v2.1 完全一致。**

---

## 8. 依赖包列表
### 必选（Tier A 运行时）
- **零新增 npm 依赖**（koffi/zeromq 不引入）。
- sentinel **运行时零第三方依赖**：Python ctypes 直调系统 DLL（`user32`/`dwmapi`/`shcore`/`kernel32`），无需 pip 安装任何包；产物为独立 exe。
- 仅**开发期**依赖 `pyinstaller`（写入 `build-sentinel/requirements.txt`，不进运行时、不进 npm）。
### 不引入
- `koffi`：NAPI addon，ABI 风险 + 需自建消息泵，不取。
- `zeromq.js`：动态 crop 需求已灭，完全不必要；ffmpeg `zmq`/`azmq` 滤镜无调用。

---

## 9. 共享知识（跨文件约定）
1. **坐标空间**：crop 由 sentinel 计算（DWMWA 物理像素 − 主屏物理原点），Node 侧原样透传，**禁止** TS 侧 DPI 换算。
2. **sentinel 输出协议（stdout 行协议，TS 侧 100% 兼容，逐字段对照）**：
   - `RECT <x> <y> <w> <h>` —— 启动首行，物理像素、主屏相对（Python `print(..., flush=True)`）。
   - `PAUSE <reason>` —— reason ∈ `MINIMIZED`/`FOREGROUND_LOST` → pauseRecording。
   - `RESUME` —— 恢复 → resumeRecording。
   - `STOP <reason>` —— reason ∈ `MOVED`/`CLOSED` → stop(reason)（干净结束）。
   - `NOT_FOUND` —— 未找到窗口 → fallback 到 gfxcapture / 提示。
   - **字段逐条与 v2.1 / sentinel-client.ts 完全一致**，切 Python 后 TS 侧零改动。
3. **单屏约定**：`output_idx` 固定 0；跨屏/窗口在主屏外超出本期。
4. **crop clamp**：`x,y≥0`；`x+w≤monitorW`；`y+h≤monitorH`；越界按主屏边界 clamp（可能损边缘，已知限制）。
5. **结束路径**：move/close → 走现有 `stop()`（finish+cleanup+上传收尾），与用户停止一致。
6. **HLS 段间隙（决策 3 重新生效）**：pause/resume 复用 `-start_number` 续录 → 产生段间隙；播放器是**固定 Electron webview**（锁定 Chromium + 自有 HLS 处理），兼容性确定性、与用户系统浏览器无关、QA 可验证；间隙由播放器按段列表 / `EXT-X-DISCONTINUITY` 处理。
7. **隐私约定**：pause 同时停 `audioCaptureProcess`（不录桌面音频）；resume 重启之。
8. **shouldRecord 抑制**：LOCATIONCHANGE 仅在 `shouldRecord` 时判移动；最小化/恢复过渡的 LOCATIONCHANGE 被忽略；RESUME 时重置 `baselineRect` 吸收恢复位移。
9. **Python 构建约定**：64-bit Python + PyInstaller `--noconsole --noupx`；输出直接落 `electron/bin/`；stdout 协议必须 `flush=True`（见 §2.5）。

---

## 10. 误判防范（Task C，语言无关，Python 版同样适用）
1. **hung/NR 不触发**：目标"未响应"仅表现为消息循环卡死/DWM 临时冻结表面，**窗口矩形坐标不变** → `LOCATIONCHANGE` 不 firing；窗口也不丢前台 → `FOREGROUND` 不变。hung/NR **不会**误触发 PAUSE/END（呼应决策 1 的误判担忧）。
2. **移动去抖（防拖拽抖动/回弹）**：LOCATIONCHANGE 高频 firing（拖拽连续触发）。sentinel 仅当当前 rect 与 `baselineRect` 差异超阈值（如 >4px）进入"待确认"；**连续 2 次确认**（事件即时读 + ~150ms 复读）均显示**同一新位置**才发 `STOP MOVED`；若回弹到 baseline（拖拽取消/动画回弹）则取消，不结束。
3. **最小化/恢复过渡噪声抑制**：最小化/恢复会产生 LOCATIONCHANGE，但彼时 `shouldRecord=false`（isMinimized 或在过渡中）→ 忽略；`RESUME` 时重置 `baselineRect=当前矩形`，使恢复位移不被视为"移动"。
4. **与崩溃续录隔离**：pause/resume 走 `gracefulStopInProgress` 守卫（pause 期间 ffmpeg `close` 不触发 `onCrash`），与 crash 的 `restartRecording`（`-start_number` 续录）是两条独立路径。

> 上述四条均为**协议/状态机层逻辑**，与 sentinel 用 Rust 还是 Python 实现无关；Python ctypes 完整支持，故在 v2.2 下**完全不变**。

---

## 11. 待明确事项
> v1/v2/v2.1 累计的边界问题已全部由用户决策闭环：移动=END（决策 1）、遮挡=录（决策 2）、段间隙由播放器处理（决策 3）、单屏（决策 4）、最小化/alt+tab=PAUSE（用户最终模型）、丢弃 koffi/zeromq（§2）、sentinel 改用 Python+PyInstaller（用户拍板）、DWMWA 坐标、window-watch 降级。
>
> **当前无未确认边界**：四种行为模型已全部拍板且可由 SetWinEventHook 区分；sentinel 实现语言已定（Python）。

**评估+修订就绪，待用户确认后交工程师实现。**