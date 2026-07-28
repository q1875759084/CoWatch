# CoWatch「文件夹监听自动转码上传模式」技术架构设计 + 接口契约 + 任务分解（修订版 v3.2）

> 版本：v3.2（一期精简版 + 文件结构定稿 + UI 复用模式 B 列表）
> 范围：**模式 B（手动选文件转码上传）的监听变种**。纯设计，不写实现代码、不改动现有 `external-transcode` / `upload` 模块。
> 依据：对仓库 4 个关键文件的实地 Read 复核（`external-transcode/index.ts`、`upload/index.ts`、`ElectronVideoUploader/index.tsx`、`recorder/index.ts` 相关段），行号见文末证据索引。
> **相对 v3.1 的修订点**：① 新增 IPC 注册拆出到独立 `watch-mode/ipc.ts`（不对旧有臃肿文件做架构优化，仅本轮新增功能按正确结构组织）；② **删除独立面板 W8（WatchModeSettings）+ 删除 W9（QueueRow 抽取）**——监听模式检测到文件后直接复用模式 B 的「上传视频」列表 UI（`ElectronVideoUploader`），行为与手动点击上传完全同构；③ 文件路径精确化为 `watch-mode/` 三文件（index/types/ipc）；④ 更正 external-transcode 描述（它就是模式 B 转码引擎，非"监听模式半成品"）。

---

## 1. TL;DR（结论先行）

| 项 | 结论 |
|---|---|
| **技术可行性** | ✅ **YES**——监听模式 = 模式 B 的自动版，仅用「自动捡文件入队」替换「手动选文件」。下游 `external-transcode` + `upload` 模块级单例 **100% 复用、零改动**。核心链路在仓库中已跑通。 |
| **核心架构决策** | 保持 `external-transcode` 与 `upload` 模块级单例不变，新增轻量 `watch-mode/` 模块（自包含三文件：index/types/ipc）：负责**单目录监听 + 两层去重（ignoreInitial + 内存 Set）+ 串行泵 pump()**，逐个调用既有的 `startExternalVideoTranscode()`。串行天然规避 NVENC 并发上限与单例冲突。**检测到的文件自动进入模式 B 的「上传视频」列表 UI，不另建面板。** |
| **对模式 B 的复用率** | **≈ 98%**。`external-transcode`（转码引擎）、`upload`（上传层）、`startExternalVideoTranscode`（协调编排）、`ElectronVideoUploader`（**含 UI 列表**）、`transcodeExternal`/`onExternalTranscodeProgress` IPC 通道 **100% 复用**；新增部分仅为「源 watcher + 串行泵 + IPC glue + 监听开关/目录选择器（极小 UI）」（已删除 change 状态机 / manifest / 独立面板 / QueueRow 抽取）。 |
| **一句话总评** | 工程量极小（约 **350–480 行**，集中在 electron 侧新增文件 + 极小前端开关）、风险极低；v2 中最大复杂度来源「暂停恢复 change 状态机」已按方案 B 移除，独立面板已删除改为复用模式 B 列表，一期风险面从「1 高 + 6 中 + 4 低」压缩到「1 必须配置 + 1 低」。 |
| **开发成本** | **7 个文件**：3 新增（electron 侧 watch-mode 三文件）+ **4 小改**（preload/global.d.ts/types/recorder/index.ts 钩子）；**总新增/改造 ≈ 350–480 行**（v3.1 估 600–760，v3.2 再减约 250 行：删 W8 面板 ~190 + W9 QueueRow ~60）。前端几乎零新增（仅监听开关+目录选择器，可嵌入既有设置区）。 |
| **测试成本** | **约 9–10 个场景**，测试代码 **≈ 400–550 行**（vitest，mock chokidar/fs + 1 个 IPC 集成）；难度 **中等**。（测试场景不变，删的是 UI 测试非核心逻辑测试。） |
| **风险** | **登记 11 条 → 一期存活 2 条**：R1（半写文件，必须配置项，零成本）+ R5-sub（监听目录被删：仅静默 crash guard，无 UI，低）；其余 9 条 DROP/DEMOTE（详见 §6）。无阻塞项。 |

---

## 2. 架构设计

### 2.1 整体数据流（对比模式 B）

**模式 B（手动）数据流：**
```
[用户点"选择文件" → dialog 多选]
   → ElectronVideoUploader 队列(queued→processing)
   → bridge.recorder.transcodeExternal(filePath)
   → 协调层 startExternalVideoTranscode
        ├─ 建 temp/cowatch-ext/<uuid> 输出目录
        ├─ initUploader(disableThrottle:true)
        ├─ startExternalTranscode (spawn FFmpeg → HLS)
        ├─ chokidar(输出目录) → onSegmentReady → enqueueUpload
        └─ 完成 → waitForUploadQueue → finish → 清理临时目录
触发器：用户手动选择（一个/多个文件一次性入队）
```

**监听模式数据流（差异点用 ◆ 标注）：**
```
◆[用户指定"单个监控目录"(源) + 系统自动输出到 %TEMP%/cowatch-ext/<uuid>]（单目录，一个 chokidar 实例）
        │
◆[源 watcher：chokidar 监听"单目录"]（ignoreInitial:true + 源侧 awaitWriteFinish{pollInterval:2000,stabilityThreshold:5000} + 扩展名白名单 + 内存 Set）
        │  ◆只捡"启动后新增"的视频；已存在文件被 ignoreInitial 过滤
        ▼
[watch-mode 串行调度器]（队列 + 自驱泵 pump()，逐个调用既有 startExternalVideoTranscode）
        │  ◆单目录、串行、文件自动入队到模式 B 的 ElectronVideoUploader 列表 UI
        ▼
┌──────────────────────────────┐
│ 复用模式 B 链路（完全不变）     │
│  startExternalVideoTranscode  │
│   ├ temp/cowatch-ext/<uuid>   │  ◆每任务唯一输出子目录（已内置，天然规避分段名冲突）
│   ├ initUploader(disableThrottle)
│   ├ startExternalTranscode    │
│   │   └ FFmpeg → HLS 分段      │
│   ├ chokidar(输出目录)→enqueueUpload
│   └ 完成→finish→清理           │
└──────────────┬───────────────┘
                ▼
        [后端 /recording/segment + /recording/finish]
```

**四处本质差异（其余完全一致）：**
1. **触发器**：手动点击 dialog → 源目录 chokidar `add` 事件（事件驱动、近实时）。
2. **输入形态**：一次性多文件入队 → 单目录持续扫描、随到随捡（增量）。
3. **调度形态**：前端对"已确定的文件列表"逐一起转 → 新增"运行时队列 + 串行泵"，对新到的文件动态入队并串行消费。
4. **（无 change 处理）**：一期不监听源文件 `change` 事件（回 v1 行为），OBS 暂停恢复的场景见 §2.2c「phase1 已知限制」。

> 转码 + 上传链路（FFmpeg 参数、HLS 分段、上传限速/401 刷新/补传）**零改动**。

### 2.2 关键技术决策（逐项方案 + 理由）

#### a) 源目录 watcher 设计（单目录）

**单监控目录**：用户指定唯一一个目录（源），**一个 chokidar 实例**监听。不监听子目录（chokidar 默认不递归，除非显式 `depth`/`recursive`），避免误捡嵌套临时目录。运行时不支持增减目录（`addWatchPath`/`removeWatchPath` 原 v1 的 v2 预留项**本期不做**，与"单目录"决策一致）。

**chokidar 配置（源侧，区别于 external-transcode 输出侧的 500/100）：**
```ts
chokidar.watch(folderPath, {            // 单目录（非数组）
  persistent: true,
  ignoreInitial: true,                 // 关键：启动瞬间已存在的文件不触发 → 满足"旧视频忽略"
  awaitWriteFinish: {
    pollInterval: 2000,                // 仅影响"写完判定"的采样频率（每 2s 探一次大小），不影响"发现新文件"的及时性——发现是 ReadDirectoryChangesW 事件驱动
    stabilityThreshold: 5000,          // 固定 5000ms（最稳）：容忍录制中的正常写入停顿（OBS 长录制偶尔几百 ms 停顿），避免被误判"写完"提前触发转码
  },
  // 不传 ignored，过滤在 'add' 回调里做（按扩展名）
});
```
- **`pollInterval=2000` 的含义与安全性**：它只决定 chokidar 内部"探测文件大小是否稳定"的轮询间隔，与"文件系统事件 → 发现新文件"是两套机制。新文件出现由 `ReadDirectoryChangesW` 事件即时驱动，`pollInterval` 再大也不延迟发现。取 2000ms 是性能保守值（减少轮询开销），且不会让"捡到新文件"变慢。
- **`stabilityThreshold=5000ms`（固定值）**：源视频是 OBS/ShadowPlay 顺序大文件写入，可能持续数秒到数分钟。该参数语义是"文件大小连续稳定 N ms 才认为写完"。固定 5000ms（最稳）可容忍录制中的正常停顿（几百 ms 的卡顿不会被误判为"写完"），详见风险 R_stability。
- **总触发延迟口径**：文件写完后，chokidar 最多约 2s（`pollInterval`）采样确认大小不再变化，再叠加 5s（`stabilityThreshold`）稳定窗口 → **总触发延迟约 7s**（"写完"到"开始转码"的间隔）。这是"不强调即时性、换取不误触发"的取舍，符合监听模式的批量/后台定位。

**扩展名白名单：**
```ts
const VIDEO_EXT = /\.(mp4|mkv|mov|avi|webm|flv|wmv)$/i;
// 仅匹配白名单；天然排除 .tmp / .part / .crdownload 等半写中间名
```
- OBS 默认 `.mkv`/`.mp4`，ShadowPlay 默认 `.mp4`，均覆盖。不匹配则直接丢弃，避免把临时文件当成品。

**增量去重（两层，重启安全由 ignoreInitial 保证）：**
1. **`ignoreInitial: true`**（主防线）：watcher 启动时已存在的文件不会发 `add` → 旧视频天然忽略（满足约束）；同时挡掉 app 重启瞬间所有已存在文件，无需 manifest 去重。
2. **运行期内存 `Set<string>`（绝对路径）**：同一文件可能被 chokidar 多次 `add`（写后改名、临时名→正名），用 `Set` 去重（类比 `external-transcode` 的 `detectedFiles`，见 `external-transcode/index.ts:49`）。
   - **启动快照预种 Set**（belt-and-suspenders）：`start()` 时对源目录 `fs.readdirSync` 一次，把当前文件全塞进内存 Set，进一步防止任何历史文件漏触发。

#### b) 转码调度器（最关键决策）

**问题本质**：`external-transcode` 与 `upload` **都是模块级单例**（`external-transcode/index.ts:41-51` 的 `ffmpegProcess`/`watcher`/`detectedFiles`；`upload/index.ts:71-83` 的 `uploadQueue`/`pendingQueue`/`isUploading`）。监听模式可能连续捡到多个视频 → 必须串行消费（同时只能 1 个 FFmpeg / 1 路 NVENC），且本次决策明确：**并发 = external-transcode 单例串行（接受，受单例限制）**。

**方案：保持单例 + 外部串行调度器（延续 v1 方案 Y，零侵入）。**
- 新增 `watch-mode/` 模块负责**单目录监听 + 两层去重 + 排队**；**逐个调用既有的 `startExternalVideoTranscode()`**（签名见 `recorder/index.ts:713-758`）；协调层补一个"任务完成回调"钩子 `onJobDone?`。
- **分段名冲突天然已解**：`startExternalVideoTranscode` 每次调用都 `fs.mkdirSync(temp/cowatch-ext/<uuid>)` 建**唯一输出子目录**（`recorder/index.ts:724-726`）。每文件都用新 uuid → 独立输出目录 → 天然规避分段名冲突。
- **NVENC 并发天然规避**：串行泵 → 同时只 1 路 FFmpeg/NVENC，永远不撞 GeForce 3~5 路上限。
- **改造成本最低**：唯一的"侵入"是给 `startExternalVideoTranscode` 加一个**可选** `onJobDone?:(ok:boolean, errMsg?:string)=>void` 参数，并在 `handleExternalTranscodeComplete`/`handleExternalTranscodeError` 末尾调用它（现有 `recorder/index.ts:822,834` 的 `isExternalTranscoding=false` 之后）。手动上传器不传该参数 → 行为完全不变。

**调度器伪逻辑（新增 `watch-mode/index.ts` 内）：**
```ts
let running = false;
const pending: WatchJob[] = [];
const inProgress = new Set<string>();        // 正在转码中的源路径（串行守卫）

function onAddFile(filePath: string) {
  if (!VIDEO_EXT.test(filePath)) return;                 // 扩展名过滤
  if (memorySet.has(filePath)) return;                   // 运行期去重
  memorySet.add(filePath);
  pending.push({ path: filePath });
  pump();
}

async function pump() {
  if (running) return;
  const job = pending.shift();
  if (!job) return;
  running = true;
  inProgress.add(job.path);
  emitEvent({ type: 'fileStarted', path: job.path });
  await new Promise<void>((resolve) => {
    startExternalVideoTranscode(roomId, authToken, job.path, (ok, errMsg) => {
      inProgress.delete(job.path);
      emitEvent(ok ? { type: 'fileCompleted', path: job.path }
                   : { type: 'fileFailed', path: job.path, error: errMsg });
      running = false;
      resolve();
      pump();                                            // 自动下一个
    });
  });
}
```
- 调度器自身是模块级单例管理一份状态，与 `external-transcode` 单例**不冲突**：它只负责"何时调用"，真正的"同一时刻只跑一个"由 `startExternalVideoTranscode` 内部的 `isExternalTranscoding` 守卫（`recorder/index.ts:718,721,822,834`）+ 串行 `pump` 双重保证。
- **停止监听语义（决策 #6）**：`stopWatch()` 仅关闭源 watcher（`watcher.close()`），**不再接收新 `add`**；但 `pump()` 不中止，已 `pending` 中或 `inProgress` 的任务**继续跑完**（等同模式 B 多选文件未完成任务，不丢数据）。源文件留盘，下次启动可重捡。

#### c) phase1 已知限制（长暂停后半段丢失）

> ⚠️ **phase1 已知限制**：监听模式不处理 OBS「暂停→恢复」的二次文件增长。用户录制中请勿暂停超过 5 秒，或改用 ShadowPlay（无暂停概念）。违反将导致该次录制后半段不上传——这是有意取舍（方案 B 忽略 `change` 事件），非静默 bug，已在 §6 风险登记册明示。

**背景**：OBS 支持"暂停录制→恢复录制"。源 watcher 仅在文件首次写完稳定（`awaitWriteFinish`）触发一次 `add` 并转码；若用户**恢复录制**使文件继续变大，触发的是 `change` 事件。一期**不监听 `change` 事件**（回 v1 行为），因此：前半段被转码上传、后半段会被静默丢弃。

**为何一期不做**：该场景极窄（仅 OBS 且暂停超 5 秒；ShadowPlay 无暂停→零影响；短暂停 <5s→零影响），而为它做的三维状态机是 v2 唯一 HIGH 风险项、且要额外 ~180–200 行。phase2 可做方案 C（最简 change 处理 ~40–60 行）补回正确性，不丢数据。

#### d) 输出目录策略

- **每文件独立输出子目录**：✅ 已由 `startExternalVideoTranscode` 的 `temp/cowatch-ext/<uuid>` 内置实现（见 2.2b）。监听模式无需额外处理，直接复用。
- **输出目录生命周期**：
  - **成功**：`handleExternalTranscodeComplete` 在 `finish` 后 `fs.rm(extTmpDir, {recursive:true, force:true})` 清理（`recorder/index.ts:823-825`）。✅ 复用。
  - **失败**：`handleExternalTranscodeError` 同样 `fs.rm` 清理（`recorder/index.ts:835-837`）。✅ 复用。
  - **源视频文件**：默认**保留**（`deleteSourceOnSuccess` 默认 `false`，防误删）；可选开关开启后于成功回调（`onJobDone`）后删除。这是监听模式唯一新增的清理语义。
- **位置**：`%TEMP%/cowatch-ext/...`（CoWatch 临时区），与"输出目录=CoWatch 临时，FFmpeg 写 HLS 分段"完全一致。用户**无需指定输出目录**，v3 由系统临时区按任务隔离（单目录决策进一步简化配置）。

#### e) 与模式 B 的前端关系（UI 复用）

**核心决策：监听模式不建独立面板，直接复用模式 B 的「上传视频」列表 UI。**

**产品语义对齐**：监听模式的实质 = 模式 B 的自动化版——把「用户手动点击选择视频文件」替换为「CoWatch 自动检测源目录新增视频」。检测到文件后，后续行为应与用户手动点选上传**完全一致**：入队到同一列表、走同一转码+上传链路、显示同一进度/状态。

**具体做法：**
- 监听模式 `pump()` 串行泵在调用 `startExternalVideoTranscode` 的同时/之后，**将文件推入 `ElectronVideoUploader` 的既有队列**（通过既有 `recorder:transcodeExternal` IPC 或等价路径）。该文件自动出现在「上传视频」列表中（含文件名 + 进度 + 状态），与用户手动选择的文件**视觉与行为完全同构**。
- 进度复用既有 `recorder:transcodeExternal:progress` 通道（`ElectronVideoUploader/index.tsx` 已有监听逻辑），无需新进度通道。
- **不抽取 `QueueRow` 共享组件**（W9 删除）——只有一份 UI 列表，不存在"两个面板共用"场景。
- **不新建 `WatchModeSettings` 独立面板**（W8 删除）——不需要独立队列/独立状态/独立进度显示。

**监听模式唯一的前端新增 UI（极小，≤30 行 JSX）：**
- **监听开关**（enable/disable）：控制 watcher 启停，可嵌入 `ElectronVideoUploader` 面板顶部或房间设置区。
- **目录选择器**：一次性的"选择监控目录"对话框（`selectWatchFolder` IPC），选定后持久化到 userData 小 JSON（跨重启恢复）。
- **监听状态指示**：极简文本标签（如"🔴 监听中 · D:\Recordings"或"⚪ 已停止"），放在开关旁。

> v3.1 的 ~190 行独立面板 + ~60 行 QueueRow 抽取已全部删除（净省 ~220 行前端代码）。监听模式的前端改动收敛到"开关+选目录+状态标签"，可嵌入既有 UI 无需新页面。

**本期不强制互斥（决策 #7）**：四种模式的统一互斥 **phase2 才做**，届时实现方式再定。**本期不预留任何 `modeState` 之类的中间状态**。

#### f) IPC 接口设计（新增）

复用既有通道：`recorder:transcodeExternal:progress`（→ 进度，send）、`recorder:transcodeExternal:cancel`（→ 取消当前任务）。新增以下：

| IPC | 方向 | 用途 |
|---|---|---|
| `recorder:selectWatchFolder` | renderer→main (handle) | 打开**单目录**选择对话框，返回选定路径（类比 `selectVideoFiles`，`recorder/index.ts:704-711`） |
| `recorder:startWatch` | renderer→main (handle) | 启动监听：传入 `roomId/authToken/folderPath/options` |
| `recorder:stopWatch` | renderer→main (handle) | **停止监听**：关闭源 watcher（不再捡新文件）；**已排队/处理中任务继续跑完**；源文件留盘供下次重捡 |
| `recorder:getWatchStatus` | renderer→main (handle) | 返回 `{active, folderPath, queued, processing}` 供 UI 恢复状态 |
| `recorder:watchMode:event` | main→renderer (send) | 监听专属队列事件：`fileQueued/fileStarted/fileCompleted/fileFailed`，驱动 UI 队列行状态机（文件名级） |

> 进度仍走 `transcodeExternal:progress`；`watchMode:event` 仅承载"哪个文件进入/离开队列"的语义，二者职责分离。
> **本期不做**：`addWatchPath`/`removeWatchPath`（单目录决策下无必要）。

### 2.3 文件列表及职责（新增 / 小改 / 纯类型）

> **架构原则**：本轮新增功能按正确结构组织（IPC 拆独立文件、模块自包含），**不对旧有臃肿文件做架构优化**。`recorder/index.ts`（935 行）仅接受最小钩子（`onJobDone` + 一行 `registerWatchHandlers()` 调用），不重构其既有 IPC 注册风格。

| # | 文件（精确路径） | 类型 | 关键内容 | 复用 / 改动 |
|---|---|---|---|---|
| **W1** | `electron/handlers/recorder/watch-mode/index.ts` | **新增** | 源 watcher（单目录 chokidar `ignoreInitial`+`awaitWriteFinish{pollInterval:2000,stabilityThreshold:5000}`+扩展名白名单+内存 `Set`）、两层去重、**串行泵 `pump()`**、与协调层 `startExternalVideoTranscode(.., onJobDone)` 对接、监听事件发射 | chokidar 用法照搬 `external-transcode:74`；`startExternalVideoTranscode` API 100% 复用 |
| **W2** | `electron/handlers/recorder/watch-mode/types.ts` | **新增（纯类型）** | `WatchModeOptions`、`WatchJob`、`WatchStatus`、`WatchEvent`、`SelectFolderResult` | — |
| **W3** | `electron/handlers/recorder/watch-mode/ipc.ts` | **新增** | `registerWatchHandlers()`：注册 `selectWatchFolder/startWatch/stopWatch/getWatchStatus` 4 个 IPC；`selectWatchFolder` 对话框在此实现；内部调用 W1 引擎函数 | **从 recorder/index.ts 拆出**，避免既有文件继续膨胀 |
| **W4** | `electron/handlers/recorder/index.ts` | **小改** | ① `startExternalVideoTranscode` 增加可选 `onJobDone?` 形参，在 `handleExternalTranscodeComplete`/`Error` 末尾回灌（`:822,834` 后）；② `registerRecorderHandlers()` 末尾加一行 `registerWatchHandlers(mainWindow)` 调用；③ 加 `[phase2] modeGuard 锚点注释`（不写实现） | **仅协调层最小钩子**，不碰 `external-transcode`/`upload`/既有 IPC 注册体 |
| **W5** | `electron/preload.ts` | **小改** | `recorder` 下新增 `selectWatchFolder/startWatch/stopWatch/getWatchStatus/onWatchModeEvent/offWatchModeEvent` 桥方法（结构照搬 `preload.ts:88-102`） | 纯透传 |
| **W6** | `src/global.d.ts` | **小改（含纯类型）** | 在 `ElectronBridge['recorder']` 补 W5 对应类型声明 | 纯类型 |
| **W7** | `src/types/recorder.ts` | **小改（纯类型）** | 新增 `WatchModeOptions`/`WatchStatus`/`WatchEvent`/`SelectFolderResult` 类型（毗邻 `ExternalTranscodeProgress`） | 纯类型 |

> **已删除（v3.2 相对 v3.1）：**
> - ~~W8 `WatchModeSettings/index.tsx`~~（~190 行独立面板）→ **改为复用模式 B 的 `ElectronVideoUploader` 列表 UI**，监听检测到的文件自动入队到同一列表，行为与手动上传完全同构。
> - ~~W9 `VideoUploader/QueueRow.tsx`~~（~60 行共享组件抽取）→ 只有一份列表，无需抽取共享。
> - ~~W10 `ElectronVideoUploader/index.tsx` 小改~~ → 改为**可选小改**（若需在面板顶部嵌入监听开关+状态标签）；核心队列/进度逻辑零改动。

**新增/改造总量估算（详见第 3 章）：约 350–480 行**（v3.1 估 600–760，v3.2 删 W8 面板 ~190 + W9 QueueRow ~60 ≈ 减 250 行）。

### 2.4 接口契约（TypeScript 类型签名，仅签名 + JSDoc，不实现）

```ts
// ─── watch-mode/types.ts ────────────────────────────────────────────────
/** 监听模式选项 */
export interface WatchModeOptions {
  /** 是否在转码+上传成功后删除源视频文件（默认 false，防误删） */
  deleteSourceOnSuccess?: boolean;
  /** 源侧 awaitWriteFinish 稳定阈值(ms)，固定 5000（最稳，对应不强调即时性的取舍） */
  stabilityThresholdMs?: number;
  /** 扩展名白名单，默认 [mp4,mkv,mov,avi,webm,flv,wmv] */
  extensions?: string[];
}

/** 单个监听任务（一个源视频文件） */
export interface WatchJob {
  /** 源视频绝对路径 */
  path: string;
  /** 加入队列时间戳 */
  enqueuedAt: number;
}

/** 监听状态快照（getWatchStatus 返回） */
export interface WatchStatus {
  /** 是否正在监听 */
  active: boolean;
  /** 当前监听的目录（单目录） */
  folderPath: string;
  /** 排队中（未开始）的任务数 */
  queued: number;
  /** 正在处理（转码中）的文件路径或 null */
  processing: string | null;
}

/** 监听专属事件（main→renderer，驱动 UI 队列行状态机） */
export type WatchEvent =
  | { type: 'fileQueued'; path: string }
  | { type: 'fileStarted'; path: string }
  | { type: 'fileCompleted'; path: string }
  | { type: 'fileFailed'; path: string; error?: string };

/** 文件夹选择对话框结果 */
export interface SelectFolderResult {
  cancelled: boolean;
  folderPath?: string;
}

// ─── recorder 协调层新增/改造签名 ──────────────────────────────────────────
/**
 * 打开单目录选择对话框（类比 selectVideoFiles）。
 */
export function selectWatchFolder(): Promise<SelectFolderResult>;

/**
 * 启动"文件夹监听自动转码上传"模式（模式 B 的自动版）。
 * 监听 folderPath 下新增视频，串行调用既有 startExternalVideoTranscode 完成转码+上传。
 * @param roomId    当前房间 ID（上传 objectKey 需要）
 * @param authToken JWT
 * @param folderPath 用户指定的**单个**监控目录（源）
 * @param options   监听选项
 * @returns { error?: string } 启动失败原因
 */
export function startWatch(
  roomId: string,
  authToken: string,
  folderPath: string,
  options?: WatchModeOptions,
): Promise<{ error?: string }>;

/**
 * 停止监听：关闭源 watcher（不再捡新文件）；
 * 已排队/处理中的转码+上传项继续跑完（不丢数据，等同模式 B 未完成任务）。
 * 源文件留盘，供下次启动重捡。
 */
export function stopWatch(): Promise<{ error?: string }>;

/** 返回当前监听状态快照（供 UI 恢复）。 */
export function getWatchStatus(): WatchStatus;

/**
 * 外部视频转码编排（既有函数，仅扩展 onJobDone 钩子，手动上传器不传该参数→行为不变）。
 * 内部已含：建 temp/cowatch-ext/<uuid> 输出目录 → initUploader(disableThrottle) →
 * startExternalTranscode → finish → 清理临时目录。
 * @param onJobDone 可选；该文件转码+上传+finish 全部完成后回调（ok=true）或失败回调（ok=false）
 */
export function startExternalVideoTranscode(
  roomId: string,
  authToken: string,
  inputPath: string,
  onJobDone?: (ok: boolean, errMsg?: string) => void,
): Promise<{ error?: string }>;

// ─── preload 桥新增（electron/preload.ts） ─────────────────────────────────
declare const recorderBridge = {
  /** 打开单目录选择对话框，返回选定目录路径 */
  selectWatchFolder: () => Promise<SelectFolderResult>;
  /** 启动监听模式 */
  startWatch: (roomId: string, authToken: string, folderPath: string, options?: WatchModeOptions) => Promise<{ error?: string }>;
  /** 停止监听模式（已排队任务继续跑完） */
  stopWatch: () => Promise<{ error?: string }>;
  /** 查询监听状态 */
  getWatchStatus: () => Promise<WatchStatus>;
  /** 注册监听专属事件回调（fileQueued/fileStarted/fileCompleted/fileFailed） */
  onWatchModeEvent: (cb: (e: WatchEvent) => void) => void;
  /** 注销监听事件回调 */
  offWatchModeEvent: () => void;
  // —— 以下为既有、直接复用 ——
  transcodeExternal: (roomId: string, authToken: string, filePath: string) => Promise<{ error?: string }>;
  onExternalTranscodeProgress: (cb: (info: ExternalTranscodeProgress) => void) => void;
  offExternalTranscodeProgress: () => void;
};
```

---

## 3. 开发成本（新增/修正，明确数字）

### 3.1 涉及文件数与行数估算

| 类别 | 文件 | 估算行数 | 说明 |
|---|---|---|---|
| **新增** | W1 `watch-mode/index.ts` | **~180–200** | 单目录 watcher（ignoreInitial + 源侧 awaitWriteFinish{2000,5000} + 扩展名白名单 + 内存 Set）+ 串行泵 pump()（已删 change 状态机，省约 120–150 行） |
| **新增（纯类型）** | W2 `watch-mode/types.ts` | ~70 | WatchModeOptions/WatchJob/WatchStatus/WatchEvent/SelectFolderResult |
| **新增** | W3 `watch-mode/ipc.ts` | **~50–70** | `registerWatchHandlers()`：4 个 IPC 注册 + selectWatchFolder 对话框实现 + 调用 W1 引擎函数 |
| **小改** | W4 `recorder/index.ts` | **+~20–30** | onJobDone 钩子(5行) + 一行 registerWatchHandlers 调用 + [phase2] 注释锚点；**IPC 注册体不内联**（已拆到 W3） |
| **小改** | W5 `preload.ts` | +~25 | 6 个桥方法 |
| **小改（纯类型）** | W6 `global.d.ts` | +~15 | recorder 桥类型声明 |
| **小改（纯类型）** | W7 `types/recorder.ts` | +~15 | 监听类型（毗邻 ExternalTranscodeProgress） |

- **文件数**：**7 个**（3 新增 watch-mode 自包含三文件 + 4 小改；其中 **2 个纯类型** W6/W7）。（v3.1 为 9 个，删除 W8 面板 + W9 QueueRow 抽取。）
- **总新增/改造行数**：**≈ 350–480 行**（v3.1 估 600–760，v3.2 删 W8 ~190 + W9 ~60 ≈ 减 250 行）。
  - v2 估算为 950–1100 行；累计削减：change 状态机(~120-150) + manifest(~100) + watcherError UI/modeState(~20) + 独立面板+QueueRow(~250) ≈ 总减 **55–60%**。
- **前端改动极小**：仅监听开关+目录选择器+状态标签（≤30 行 JSX），可嵌入既有 ElectronVideoUploader 面板顶部或设置区，**无需新页面/新路由**。

### 3.2 模块划分

| 层 | 文件 | 职责 |
|---|---|---|
| 源监听与调度层 | W1 `watch-mode/index.ts` | 单目录 watcher + 两层去重 + 串行泵 pump() |
| 类型契约层 | W2, W6, W7 | 前后端类型契约（含纯类型 2 个） |
| IPC 注册层 | W3 `watch-mode/ipc.ts` | 4 个 watch IPC 注册 + selectWatchFolder 对话框（从 recorder/index.ts 拆出，防臃肿） |
| 协调层 | W4 | onJobDone 钩子(1行) + registerWatchHandlers 调用(1行) + [phase2] 注释锚点 |
| 桥层 | W5 | IPC 透传 |
| UI 层 | **嵌入既有 ElectronVideoUploader** | 监听开关 + 目录选择器 + 状态标签（≤30 行 JSX）；**不新建面板/页面/路由** |

> 改动面集中在**新增文件**，绝不触碰 `external-transcode`/`upload` 单例内部、不对旧有臃肿文件做架构优化（满足"本轮功能按正确结构组织、不增加后续架构变更负担"原则）。

---

## 4. 测试成本（新增/修正，明确数字）

### 4.1 需覆盖的测试场景（约 9–10 个）

| # | 场景 | 验证点 |
|---|---|---|
| 1 | **add 触发转码** | 单目录新增视频文件 → 经 awaitWriteFinish 稳定后触发一次转码 |
| 2 | **同文件多次 add 去重** | 运行期内存 Set 命中 → 同一文件只处理一次 |
| 3 | **ignoreInitial 忽略旧文件** | 启动前已存在的视频不触发 |
| 4 | **半写文件 awaitWriteFinish** | stabilityThreshold 内（5000ms）不触发；稳定后才触发（不转码截断文件） |
| 5 | **扩展名过滤** | 非白名单（.tmp/.part/.txt）被忽略 |
| 6 | **单目录边界** | 一个 chokidar 实例监听单目录；子目录不递归误捡；目录被删/移 → watcher `error` 事件触发，仅静默终止监听（log + close，不崩、无 UI） |
| 7 | **停止监听后继续跑完** | stopWatch 后不再捡新文件，但已 pending/inProgress 任务跑完、数据不丢 |
| 8 | **pollInterval 不影响发现及时性** | pollInterval=2000 仅影响写完判定采样，新文件由 FS 事件即时发现 |
| 9 | **phase1 已知限制验收** | OBS 暂停>5s 后半段不上传（文档标注，非自动测试；属已知限制，非 bug） |

### 4.2 测试代码量与难度

- **测试代码量**：约 **400–550 行**（vitest）。其中：
  - 单元：mock `chokidar`（手动 `emit('add')`）+ mock `fs`（fake timers 模拟 `stabilityThreshold`）+ stub `startExternalVideoTranscode`（校验每任务新 uuid），覆盖场景 1–6、8，约 350–450 行。
  - 集成：1 个 IPC 集成测试（`startWatch`→`stopWatch`→已排队跑完，场景 7），约 80–100 行。
- **难度**：**中等**。
  - 难点 1：文件写入时序（`awaitWriteFinish` 的 `pollInterval`/`stabilityThreshold`）需 fake timers 精确控制。
  - 难点 2：`external-transcode`/`upload` 为**进程级单例**，多个用例间需重置模块状态（`vi.resetModules()`）。
  - 难点 3：跨进程 IPC（场景 7）需启动真实 Electron main 上下文或较重 mock，集成测试成本中等。
- **建议**：优先穷尽单测（场景 1–6、8，纯逻辑、易 mock），集成测试仅覆盖最关键的"stopWatch 继续跑完"（场景 7）。

---

## 5. 任务分解（有序，含依赖关系）

> 依赖：T1 → T2 → T3 → T4 → T5 → T6。（v2 的 T_change 已随方案 B 删除）

- **T1 源监听器 + 两层去重（W1+W2 + `selectWatchFolder` 对话框）**
  - 内容：新增 `watch-mode/index.ts`（**单目录** chokidar 源监听：ignoreInitial + 源侧 `awaitWriteFinish{2000,5000}` + 扩展名白名单 + 内存 Set）、`types.ts`；`ipc.ts` 内加 `selectWatchFolder` 对话框实现（类比 `selectVideoFiles`，`recorder/index.ts:704-711`）。
  - 涉及文件：W1, W2, W3(部分), W7(部分)
  - 依赖前置：无
  - 验收：① 启动后旧文件不触发（ignoreInitial）；② 新增文件触发；③ 同一文件多次 add 只处理一次（Set）；④ 非白名单扩展名被忽略；⑤ 单目录、子目录不误捡。

- **T2 串行调度器 + 协调层完成钩子（关键）**
  - 内容：在 `watch-mode/index.ts` 实现 `pump()` 串行队列；协调层给 `startExternalVideoTranscode` 加 `onJobDone?` 形参并回灌到 `handleExternalTranscodeComplete`/`Error`（`recorder/index.ts:822,834` 后）；调度器逐任务 await。
  - 涉及文件：W1, W4(部分)
  - 依赖前置：T1
  - 验收：① 连续丢多个视频→逐个处理；② 同一时刻仅 1 个 FFmpeg/NVENC；③ 每任务获唯一 `temp/cowatch-ext/<uuid>` 输出目录；④ 任一任务失败不阻塞后续；⑤ 成功后通过 `onJobDone` 回调通知调度器。

- **T3 IPC glue（W3+W4+W5+W6+W7 剩余）**
  - 内容：`watch-mode/ipc.ts` 注册 `startWatch/stopWatch/getWatchStatus` 与 `watchMode:event` 发送（`stopWatch`=关 watcher + `pump` 继续）；`recorder/index.ts` 的 `registerRecorderHandlers()` 末尾加一行 `registerWatchHandlers(mainWindow)` 调用；preload 暴露桥方法；global.d.ts 补类型；recorder.ts 补类型。
  - 涉及文件：W3, W4(部分), W5, W6, W7
  - 依赖前置：T2
  - 验收：① 渲染进程可启/停/查状态；② `watchMode:event` 准确发射；③ `stopWatch` 后已排队任务继续跑完。

- **T4 监听开关 + 目录选择器（极小前端，≤30 行 JSX）**
  - 内容：在 `ElectronVideoUploader` 面板顶部（或房间设置区）嵌入：① 监听模式 Switch 开关（enable/disable → 调 `startWatch`/`stopWatch`）；② "选择监控目录"按钮（调 `selectWatchFolder`）；③ 状态文本标签（"🔴 监听中 · D:\Recordings" / "⚪ 已停止"）。**不新建页面/路由/面板/组件文件。**
  - 涉及文件：`ElectronVideoUploader/index.tsx`（或其父容器），**无新增文件**
  - 依赖前置：T3
  - 验收：① 开关启停调 IPC 成功；② 目录选择对话框弹出并返回路径；③ 状态标签实时反映监听状态；④ 检测到的文件自动出现在下方既有上传列表中（行为与手动选择一致）。

- **T5 错误/持久化/清理收尾（W1 + W4 增强）**
  - 内容：源 watcher `error` 事件（目录被删/移→**仅静默 crash guard**：挂 `error` 监听器 log + `watcher.close()`，不弹 UI、不存状态、不优雅停止流程，R5-sub）；记住"监听目录 + 开关状态"跨重启（userData 小 JSON，**非** dedup manifest）；可选 `deleteSourceOnSuccess` 实现；确认临时输出目录清理（现有 finish/error 路径已含）。
  - 涉及文件：W1, W4
  - 依赖前置：T3, T4
  - 验收：① 监听目录被删→watcher `error` 被捕获、主进程不崩溃、监听静默停止（无 UI 提示）；② 重启后开关/目录自动恢复；③ 成功删除源（开启时）且临时目录已清。

- **T6 集成验证**
  - 内容：将 OBS/ShadowPlay 输出指向监听目录 → 生成一段回放 → 确认自动转码+上传+**文件出现在既有「上传视频」列表中**；验证大文件不半写、串行 NVENC、停止后已排队跑完、目录被删→监听静默停止不崩溃。
  - 涉及文件：全部
  - 依赖前置：T5
  - 验收：端到端跑通；上述 9 个测试场景全部通过。

---

## 6. 风险评估（一期精简）

| ID | 风险 | 机理/证据 | 缓解（落地动作） | 严重度（一期处置） |
|---|---|---|---|---|
| **R1** | **半写文件**：回放还在写就被捡起转码 → 损坏/截断 | 大视频顺序写入，chokidar 在创建瞬间即可能触发 `add` | 源侧 `awaitWriteFinish{stabilityThreshold:5000, pollInterval:2000}` + 扩展名白名单（排除 `.tmp/.part`）（T1） | **KEEP（必须配置项，零成本）** |
| **R5-sub** | **监听目录被删/移 → 仅静默 crash guard** | 用户主动删/移正在监听的目录（异常行为）；或录屏软件自清理输出目录。目录消失时 chokidar 发 `error` 事件，若不挂监听器会变成 Node 未捕获异常导致主进程崩溃 | 挂 `watcher.on('error', e => { log(e); watcher.close(); })` 仅 ~2–3 行，**不弹 UI、不存状态、不做优雅停止流程**（该行为不符合正常逻辑，直接终止监听即可）；仅本地 NTFS 盘有效 | **KEEP（低，仅 crash guard，无 UI/无状态）** |
| R_change | 暂停恢复 change 事件监听复杂度与幂等 | 详见 v2 §2.2c；一期方案 B 忽略 change | **DROP（方案 B）**：回 v1 忽略 change；OBS 长暂停后半段丢失已明文记为 phase1 已知限制（§2.2c），非静默 bug | 方案 B |
| R_dup | 重复上传产生多个独立 recording 需手动清理 | 暂停恢复 = 开发重复上传（v2 方案） | **DROP（随 R_change）**：一期不重转码，R_dup 不发生 | 随 R_change |
| R_stability | stabilityThreshold 误触发 | 录制中正常停顿被误判"写完" | **DEMOTE**：5000ms 固定最稳；删 change 后无兜底但误触发窗口已极小，记为已知限制 | DEMOTE |
| R2 | 重启重复处理 | ignoreInitial 仅挡启动瞬间 | **DROP**：ignoreInitial:true 已挡掉启动瞬间所有已存在文件的 add，manifest 与之完全重复 | DROP |
| R3 | NVENC 并发上限 | GeForce 消费卡 3~5 路 | **DROP（已设计消除）**：串行 pump + isExternalTranscoding 守卫=同时仅 1 路 | DROP |
| R4 | 磁盘空间 | 源视频 + 分段同盘堆积 | **DROP（移出登记册）**：堆积属用户/录屏软件责任；CoWatch 临时目录 finish/error 即 fs.rm 清理（已复用） | DROP |
| R5-main | 特殊文件系统（FAT/exFAT/SMB/UNC） | 对 ReadDirectoryChangesW 支持差 | **DROP**：限本地 NTFS，不在 scope；仅保留目录被删的静默 crash guard（R5-sub） | DROP |
| R6 | 分段名冲突 | 两视频并发到同 outputDir | **DROP**：每任务唯一 temp/cowatch-ext/<uuid> + 串行已天然规避 | DROP |
| R7 | 与模式 1/模式 B NVENC 争抢 | 模式1(WGC)也走 NVENC | **DROP（前提：phase2 才做互斥）**：本期内测靠人为告知用户不要混用多模式缓解；phase2 统一做互斥（届时实现方式再定，**本期不预留 `modeState` 之类的中间状态**） | DROP（phase2） |
| R8 | manifest 损坏/竞态 | JSON 写一半进程退出 | **DROP（随 R2）**：manifest 已删 | DROP |

**风险分布**：登记 **11 条** → 一期**存活 2 条**（R1 必须配置项 + R5-sub 低），削减 9 条（1 DROP 方案B / 1 随 R_change / 1 DEMOTE / 6 DROP）。风险面从「1 高 + 6 中 + 4 低」压缩到「1 必须配置 + 1 低」。无阻塞项。

---

## 7. IS_PASS: YES

**修订后方案整体可落地，不阻塞。** 核心转码+上传链路（模式 B）已在仓库中存在且验证可用（`external-transcode/index.ts`、`upload/index.ts`、`recorder/index.ts:713-846` 实地复核），监听模式仅缺"单目录源触发器 + 两层去重 + 串行泵 + 极小前端开关（嵌入既有 UI）+ 协调层一个完成回调小钩子"。

**必须处理项（不阻塞，但落地时须落实）：**
1. **R1（必须配置项）**：源侧 `awaitWriteFinish{stabilityThreshold:5000, pollInterval:2000}` + 扩展名白名单必须到位，否则会转码截断/损坏文件（确定性数据损坏）。
2. **R5-sub（低）**：监听目录被删/移 → 仅静默 crash guard（`watcher.on('error')` log + close，不弹 UI、不存状态、不优雅停止），目的仅为避免未捕获异常崩主进程（T5）。
3. **R7（phase2）**：模式互斥（一次只跑一种）phase2 才做；phase1 内测靠人为告知用户不要混用多模式（避免并发撞 NVENC 致转码失败）。**本期不预留 `modeState` 之类的中间状态**（互斥届时实现方式再定，可能在既有模式入口前置拦截）。
4. **phase1 已知限制（OBS 长暂停后半段丢失）**：已在 §2.2c 明文标注，非静默 bug。
5. **UI 复用模式 B 列表**（v3.2 新增）：监听检测到的文件必须自动入队到 `ElectronVideoUploader` 既有列表（与手动上传同构），**不建独立面板、不抽取 QueueRow**。前端改动收敛到 ≤30 行 JSX（开关+选目录+状态标签）。

改动面集中在新增文件（`watch-mode/` 三文件自包含），**绝不触碰 `external-transcode` / `upload` 单例内部、不对旧有臃肿文件做架构优化**，满足"本轮功能按正确结构组织、不增加后续架构变更负担"原则。

---

## 附录：类图与序列图

见同目录 `class-diagram.mermaid` 与 `sequence-diagram.mermaid`。（注：序列图若仍含暂停恢复 change → 重新转码的数据流，需同步简化；本期不实现 change 重转码）

## 证据索引（实地 Read 复核）

| 文件 | 关键行 | 印证点 |
|---|---|---|
| `electron/handlers/recorder/external-transcode/index.ts` | 41–53, 74–100, 182–184, 273–289 | 模块级单例（`ffmpegProcess`/`watcher`/`detectedFiles`）；输出侧 chokidar `awaitWriteFinish{stabilityThreshold:500, pollInterval:100}`；`getExternalTranscodeState()` 仅暴露 `active`；末段补扫 `scanRemainingSegments` |
| `electron/handlers/recorder/upload/index.ts` | 71–83, 87–113, 114–162, 164–182, 188–192, 231–246 | 模块级单例（`uploadQueue`/`pendingQueue`/`isUploading`/`segmentKeys`/`activeUploads` 等）；串行 `processUploadQueue`；`enqueueUpload`/`getSegmentKeys`/`getUploadedCount`/`waitForUploadQueue`/`cleanupUploader`；objectKey 需 `roomId/sessionId` |
| `src/pages/Lobby/ElectronVideoUploader/index.tsx` | 1–30, 36–123, 127–171 | 队列自驱（queued→processing→completed/error）；`transcodeExternal` IPC；`onExternalTranscodeProgress`；**监听模式文件自动入队到此既有列表** |
| `electron/handlers/recorder/index.ts` | 134–138, 704–711, 713–846, 850–935 | `detectedEncoder`/`isSoftwareEncoder`/`isExternalTranscoding` 模块变量；`selectVideoFiles`(704–711)；`startExternalVideoTranscode` 建 `temp/cowatch-ext/<uuid>`(724–726)+initUploader+startExternalTranscode+finish+rm(823–837)；`isExternalTranscoding` 守卫(718,721,822,834)；IPC 注册(912–934) |
| `electron/preload.ts` | 88–102 | `recorder.*` 桥结构（`selectVideoFiles`/`transcodeExternal`/`onExternalTranscodeProgress`/`offExternalTranscodeProgress`）——新增 IPC 结构照搬 |
| `src/types/recorder.ts` | 52–59 | `ExternalTranscodeProgress` 类型（phase/uploaded/estimated）——新增监听类型毗邻此定义 |
