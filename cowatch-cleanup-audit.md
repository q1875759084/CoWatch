# CoWatch Electron 端 · 清洁与架构审计清单

> 合并自：`temp/代码清洁列表.md` 与 `cowatch-frontend-audit-2026-08-02.md`（2026-08-03 合并）
> 评审基线：`feat/obs-wgc-capture` 分支
> 文档性质：**living checklist**——已修项直接删除，勿当历史快照读

## 背景

CoWatch 录制链路经历 v1（单 FFmpeg 直出）→ v2（双 FFmpeg 三层）→ v3（window_capture.exe + upload 两层）三次架构演进。转码层已彻底废弃，window/screen 两模式统一走 window_capture.exe。经多轮重构后存在架构冗余与死代码残留，本清单跟踪剩余待处理项。

## 已确认的关键约束

- **window_capture.exe 实际行为**：stdout JSON 协议只有 `READY`/`STATS`/`ERROR`/`EXIT` 四种，**无 CLOSED 消息**
- **OBS wc_tick 重连机制**：HWND 失效时每 1 秒按 title/class/exe 重试查找，窗口回来则自动重新挂钩，期间 HLS 切片停增长（画面定格，非黑屏）
- **sentinel 机制保留**：作为窗口事件监听基建保留，后续可在此插入埋点/日志上报。当前 coordinator 的 `onStop`/`onNotFound`/`onExit`/`onLog` 回调均为空实现（仅注释说明），不主动介入窗口生命周期
- **切片命名契约统一**：v3 唯一权威为 `seq%05d.ts`（capture_session.cpp:775 定义）。三方调用 `shared/segment-naming.ts` 共享模块：persistence 用 `parseSegmentIndex` 解析、external-transcode 用 `SEGMENT_PATTERN` 生成。v2 的 `seg%03d_opt.ts` 历史切片上传到 COS 后与旧 m3u8 配套，无需新解析器兼容
- **IPC 监听器契约**：preload 层 `on*` 方法一律返回 unsubscribe 函数（`ElectronUnsubscribe = () => void`），调用方 `useEffect` cleanup 中 `return unsub`。禁止 `removeAllListeners`（多组件订阅同一 channel 时会互相踩踏）。详见 [docs/knowledge.md](file:///c:/Users/绝绝子/Desktop/Co/CoWatch/docs/knowledge.md)
- **window/screen 唯一差异**：`captureMode + hwnd` 两点，其余逻辑完全一致（已合并为单一分支）

## 已修项核销记录

- `P0-2 removeAllListeners 互相踩踏`（de05158）——6 个 `on*` 返回 unsubscribe 闭包按引用移除
- `offWatchModeEvent 错名`（de05158）——统一为 `offWatchFileDetected`，类型同步
- `切片命名三态并存`（8e7fb9d）——收敛为 `shared/segment-naming.ts` 单一事实源
- `window/screen 双分支重复`（b778552）——合并为单一分支，差异参数化 `captureMode + hwnd`
- `startWindowUploadWatcher 死参数 _cbs`（本轮）——删除死参数
- `PendingRecording 重复定义`（本轮）——persistence 改为 import type 自 src/types
- `formatSegmentName 孤儿导出`（本轮）——零调用方，YAGNI 删除

---

## 一、待清理清单

### A. 架构冗余（不合理分层）

| 编号 | 项 | 位置 | 风险 | 说明 |
|------|----|------|------|------|
| A2 | 协调层与录制层双份状态（isUserStopped/currentSourceId/currentWindowTitle/tmpDir） | recorder/index.ts vs recording/index.ts | 高 | 触及 stop/crash/pause 关键路径，需重新设计两层状态边界，回归成本高。等价于 audit P1-6 |

### D. 冗余导出（延后，对整体清洁影响不大）

| interface | 位置 |
|-----------|------|
| WindowCaptureConfig, RecordingConfig | recording/index.ts |
| UploadConfig, UploadCallbacks | upload/index.ts |
| ManifestSegment, Manifest | persistence/index.ts |
| ExternalTranscodeConfig, ExternalTranscodeCallbacks | external-transcode/index.ts |
| WatchModeDeps | watch-mode/index.ts |
| WindowSpawnOptions | profiles.ts |
| SentinelCallbacks | sentinel-client.ts |

### F. 待决策项

| 编号 | 项 | 位置 | 决策依赖 |
|------|----|------|----------|
| F5 | `handleCaptureLine` 的 `CLOSED` 分支（exe 侧） | 已确认 window_capture.exe 无 CLOSED 消息，recording 层的 CLOSED 解析分支已删除；exe 侧 main.cpp 是否仍发 CLOSED 需确认 | 独立，可单独处理 |

---

## 二、契约漂移（audit 遗留，未修）

### P0（必须修）

| # | 问题 | 位置 | 整改方向 |
|---|---|---|---|
| P0-5 | **类型闸门完全失效 —— 缺陷再生装置**。`npm run build` 用 babel-loader 只转译不查类型；`global.d.ts` 的 `start` 签名仍漏 `resolution` 第 7 参（`Recorder/index.tsx` TS2554 实测在报） | `global.d.ts:70-77`；构建配置 / CI | 把 `tsc --noEmit`（src 与 `-p tsconfig.electron.json` 两道）接入 build/CI（先接入允许分阶段清零存量报错），并让 `global.d.ts` 从 preload 导出的类型派生，取消手写第二事实来源 |

> **判 P0 理由**：它不坏功能，但是让缺陷得以上线的直接原因。不接闸门，下一个契约漂移照样上线。

### P1（建议修）

| # | 问题 | 位置 | 整改方向 |
|---|---|---|---|
| P1-1 | **录制侧 finish 仍无 401 重试，token 过期会静默丢播放列表**（05566a8 只给外部转码侧加了重试，两侧仍不对称） | 录制侧 `recorder/index.ts:430-456`（仅 console.error）vs 外部侧 `:660-685`（401→`refreshTokenFromMainProcess()`→重试） | 抽公共 `finishAndRetry()` 收口到 upload/backend-client 域，两条路径共用。**若线上 401 非罕见，此条应即刻升 P0** — 请团队确认 token 过期实际发生率后定档 |
| P1-2 | **watch-mode watcher error 静默自停，不通知渲染端**（UI 卡死症状已缓解：已改 `getWatchStatus` 驱动，不再只在挂载时拉一次） | `watch-mode/index.ts:94-98` 仍不发事件 | 自停时补推 `watchMode:error` 事件。随主题③一并解决 |
| P1-3 | **`transcodeExternal:cancel` 无调用入口，用户误点转码后无法取消** | `recorder/index.ts:814-820` 注册；preload 无桥 | 补桥 + UI 取消按钮，或明确删除该 handler。**二选一，不要继续悬空** |
| P1-4 | **协调层越权解析 HWND** | `recorder/index.ts:296`（合并后行号） | 下沉至 `sentinel-client`，协调层不认识 windowId 格式 |
| P1-5 | **upload 细节裸露在协调层 stop()** | `recorder/index.ts` stop() 内 5 连调（enqueueMissingFiles/getPendingQueue/getSegmentKeys/cleanupUploader/persistRecording） | upload 导出 `finalizeSession()` 用例级接口 |
| P1-7 | **进度推送三份 + chokidar 配置三处重复** | `recorder/index.ts:157`、`:710`、`persistence/index.ts:261`；`recorder/index.ts:620-624`、`external-transcode:74-78`、watch-mode | 各收敛为一处工具函数 |
| P1-8 | **`setEncoderInfo` 写入无人读取的模块变量**：`recording/index.ts:81-83` 确有实装，协调层 `:194`/`:203` 确有调用；但 recording 层内两变量随后被 `startRecording` 的 `cfg` 覆写（`:98-99`），setter 写入值从无读取方 → 效果等同空操作，且构成 A2 双份状态之一 | `recording/index.ts:81-83,98-99`；`recorder/index.ts:194,203` | 删除 setter，改由 `startRecording` 的 `cfg` 单向传入。**注意：不要按"纯 no-op"直接删调用点，它与状态所有权归位是同一件事** |

> P1-6 已与清洁列表的 A2 合并，不再单列。

### P2（清洁度，可后续一次性清理）

- **纯死代码删除**：`segOrder`（external-transcode:51/84/281）、`parseTime`（:256-265）、`getExternalTranscodeState().outputDir`（:183）、多余 export `startExternalVideoTranscode`（recorder/index.ts:662）、`handleFfmpegCrash` 命名/日志全称 ffmpeg（实为 exe）（:494,575,582-583,590）
- **死配置/死字段**：`RecordingConfig.recordOnly`（recording/index.ts:55，录制层从不读取）、`CaptureProfile.fps`（profiles.ts:21）
- **无生产者的配置旋钮（不能照删）**：`UploadConfig.disableThrottle`（`upload/index.ts:38` 声明，`:291` `cfg.disableThrottle ? 0 : ...` **有读取**）、`UploadConfig.recordOnly`（`:40` 声明，`:116` `if (config?.recordOnly) return` **有读取**）。二者参与运行时决策，只是全仓无处传入 → 恒 `undefined`，等价于"开限流 + 不跳过"。**处置：要么补上生产者，要么连同读取点一起删；直接删字段会改变运行时分支语义**
- **双向皆死的 IPC**：`onPendingUpdate/offPendingUpdate`（preload.ts:85-92、global.d.ts:90-93）
- **渲染端**：`WindowPicker.onConfirm` 第 2 参 sourceType（WindowPicker.tsx:11,38 / Recorder/index.tsx:143）、`isPreview` 死 prop、永久 disabled 的 CQP/CBR 三选一（:92-94，建议改为展示当前模式或补齐功能）
- **类型重复**：`rcMode`/`resolution` 联合类型三处字面重复（recorder/index.ts:242-243、recording/index.ts:42-44、profiles.ts:37-39）→ 提取共享类型
- **过期注释**：detectEncoder「含 ddagrab」（recorder/index.ts:180）、upload/index.ts:11-14、external-transcode:194、`[phase2] modeGuard()`（recorder/index.ts:575）
- **未建模能力**：cursor 开关（exe 有 `--no-capture-cursor`，buildExeArgs 不发）——若产品不需要则连同 profile 字段一起明确标注"不支持"，不要留空白

---

## 三、分层腐化（audit §2 评估结论，未变）

### 现状

- **协调层 `recorder/index.ts`** 已从"编排者"退化为"什么都做的中枢"：同时承担 IPC 注册、生命周期编排、HWND 字符串解析、编码器探测、上传收尾全部细节、finish 接口第二份实现、chokidar watcher 桥接、进度推送，以及与 recording 层重复的模块级状态。判定：**已越过临界点成为上帝对象**。最硬证据是 finish 接口在同文件内出现两份行为不一致的实现。
- **recording 层** 退化为"带包袱的 spawn 器"：真实价值只剩构建 exe 参数 + 拉起/守护进程，连自己领域内的状态都不掌握（权威副本在协调层）。
- **upload 层封装泄漏**：导出一堆细粒度动词，却没导出"会话收尾"用例级入口，导致协调层必须知道 upload 内部编排顺序。还保留两个有读取点但无生产者的配置旋钮（`disableThrottle`/`recordOnly`）。
- **watch-mode 与 external-transcode 构成 main→renderer→main 回环**：唯一一处结构性错误。渲染端在这条链路上没做任何用户决策，纯转发器。
- **渲染端**：`RecorderContext.recorderState` 与 `Recorder/index.tsx` 的 `localState` 两份录制状态。

### 理想收敛目标

```
协调层 recorder/index.ts → 只做三件事：IPC 注册 · 会话生命周期编排 · 跨域事件分发
recording 域             → exe 进程生命周期 / CLI 参数构建 / 编码器信息（状态所有权归此）
upload 域                → 对外只暴露 startSession / finalizeSession / abortSession
media-pipeline 域        → external-transcode ⊕ watch-mode 合并（mode: 'manual' | 'watch'）
sentinel-client          → 窗口归属与 HWND 解析（唯一懂 windowId 格式的地方）
segment-naming（已落地） → format / parse 单一事实来源
```

---

## 四、整改路线

### 主题 A · IPC 契约治理与类型闸门（第一批，必须先做）

- **范围**：P0-5、P1-3、P2 中的死 IPC
- **核心动作**：① 接入 `tsc --noEmit` 打存量错误清单 → ② 补 `resolution` 第 7 参 / 改 `global.d.ts` 从 preload 派生 → ③ 转 CI 强制拦截；④ `transcodeExternal:cancel` 定去留；⑤ `pendingUpdate` 删除
- **进度**：`removeAllListeners` 踩踏已修（de05158）。剩余部分未动
- **风险**：低（剩余部分为类型声明与死 IPC 清理，无运行时行为变更）
- **顺手项**：`Recorder/index.tsx:78-103` effect deps `[bridge, localState]` 中 `localState` 是伪依赖，建议改 `[bridge]`

### 主题 B · finish 接口合并（第二批）

- **范围**：P1-1
- **核心动作**：抽公共 `finishAndRetry()` 收口到 upload 域，两条路径共用
- **风险**：中，涉及上传收尾逻辑

### 主题 C · 分层收敛（第三批，规模最大）

- **范围**：P1-4/5/7、A2、watch-mode 并入 media-pipeline 消除回环、P1-2、渲染端状态机合并
- **执行顺序**：① watch-mode 合并（收益最集中）→ ② upload `finalizeSession` 抽取 → ③ HWND 下沉 sentinel → ④ 状态所有权归位 → ⑤ 进度推送/chokidar 配置收敛 → ⑥ 渲染端状态机合并
- **风险**：中高，但改动性质是"搬运"而非"改逻辑"，在主题 A 类型闸门下相对可控

### 主题 D · 死代码与过期注释大扫除（可穿插，建议紧跟 A 之后）

- **范围**：全部 P2 + P1-8
- **风险**：极低，建议独立成不含任何行为变更的 PR
- **⚠️ 不含** `UploadConfig.disableThrottle` / `UploadConfig.recordOnly`：有读取点，不能照删

**总体建议顺序：A → D → B → C。** A 提供保障，D 净化视野且零风险，B 处理数据正确性，C 规模最大放最后。

---

## 五、落地前必须先确认的未决问题

1. **`transcodeExternal:cancel` 与 CQP/CBR 三选一，产品侧要补齐还是要下线？** —— 产品决策非技术决策，需 PM 确认后才能定 P1-3 与对应 P2 处理方式
2. **token 过期实际发生率？** —— 决定 P1-1（finish 合并）是 P1 还是 P0
3. **F5：window_capture.exe 的 main.cpp 是否仍发 CLOSED 消息？** —— 需查 C++ 源码确认

---

## 六、风险分级速查

### ✅ 低风险纯删除（可放心先清，建议独立 PR）

`segOrder` · `parseTime` · `outputDir` 字段 · `startExternalVideoTranscode` 多余 export · `RecordingConfig.recordOnly` · `CaptureProfile.fps` · `onPendingUpdate/offPendingUpdate` · `WindowPicker` 的 `sourceType` 第 2 参与 `isPreview` 死 prop · 全部过期注释 · `handleFfmpegCrash` 命名/日志

### ⚠️ 需回归测试的高风险改动

| 改动 | 波及面 | 必测场景 |
|---|---|---|
| **finish 合并（主题 B）** | 播放列表提交 | ① token 过期场景下 401 重试生效、播放列表不丢；② 录制侧与外部转码侧行为一致 |
| **watch-mode 合并进 media-pipeline（主题 C）** | 监听模式全链路 | ① 监听→检测→转码→上传全链路；② watch 自停时 UI 正确反映；③ 监听来源与手动上传共用队列串行约束仍生效 |
| **状态所有权归位 / 渲染端状态机合并（主题 C）** | 录制生命周期各状态转换 | 完整状态机遍历：idle→recording→stopping→idle |

### ❗ 无生产者配置旋钮（不能照删）

`UploadConfig.disableThrottle` / `UploadConfig.recordOnly`：在 `upload/index.ts:291`/`:116` 有读取点，参与运行时分支判断，只是全仓无传入方 → 恒 `undefined`。须连同生产者或读取点一起处置，直接删字段会改变运行时语义。

---

## 七、正面结论（勿误伤）

- 监听模式检测文件后复用手动上传同一队列（ElectronVideoUploader:133-143），渲染端串行约束同时约束两来源避免并发撞 NVENC，复用干净。**主题 C 重构中必须保留此设计**
- 渲染端无越界：零 `ipcRenderer` 直连、零 CLI 拼装、零 `captureMode` 参与。preload 纯透传无业务逻辑。分层大方向正确，问题集中在**类型声明层与文档层跟不上实现层**
- 切片命名契约已收敛为 `shared/segment-naming.ts` 单一事实源
- window/screen 双分支已合并为单一分支，差异仅参数化 `captureMode + hwnd`
