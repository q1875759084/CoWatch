# CoWatch 监听模式 · 一期（phase 1）风险登记册削减/降级 · 权威判定

> 评审人：高见远（software-architect）
> 依据文档：`docs/watch-mode-design.md` v2（第 2.2a/2.2c/第5章 任务分解/第6章 风险评估）
> 范围：对 11 条风险（R1–R8 + R_change/R_dup/R_stability）逐条做一期「削减/降级」判定，并回答两个关键设计决策。
> 结论基调：**初版（v2）确实过度设计了**——R_change 状态机是唯一的 HIGH 项且为窄场景买单；manifest 在 `ignoreInitial:true` 已存在的前提下基本冗余。但凡「删除会导致真实数据丢失」的项，本文一律标红、不模糊。

---

## 1. 11 条风险 · 一期权威判定（逐条）

| ID | 风险 | 一期判定 | 一句话理由 | ⚠️ 数据丢失警示 |
|---|---|---|---|---|
| **R1** | 半写文件（回放还在写就被捡起转码→截断/损坏） | **KEEP** | `awaitWriteFinish{5000,2000}` 是挡住「录制第 1 秒就捡空/半截文件」的唯一配置屏障，且只是配置项、近乎零成本 | **删除 = 确定性数据损坏**（转码出截断视频）。必须保留，无任何削减空间 |
| **R2** | 重启重复处理（manifest 去重） | **DROP** | `ignoreInitial:true` 已在启动瞬间挡掉所有「已存在文件」的 `add`，manifest 与之完全重复 | **删除不新增数据丢失**；但「崩溃中途文件」丢失是 `ignoreInitial` 固有行为、原 manifest 也救不了（见 §2b） |
| **R3** | NVENC 并发上限（GeForce 3~5 路） | **DROP（已设计消除）** | 串行 `pump()` + `isExternalTranscoding` 守卫 = 同时仅 1 路，架构已保证不撞上限，无需单独缓解代码 | 删除无数据丢失；串行本身就是缓解 |
| **R4** | 磁盘空间堆积 | **DROP（移出 CoWatch 登记册）** | 堆积源于录屏软件输出 + 用户保留源文件；CoWatch 自身临时目录 `finish/error` 即 `fs.rm` 清理（已复用），低磁盘告警只是可选 UX | 删除告警**不造成数据丢失**；唯一真实动作（临时目录清理）已是免费复用 |
| **R5** | 特殊文件系统（FAT/exFAT/SMB/UNC） | **DEMOTE** | 砍掉 FAT/exFAT/SMB/UNC 子项（限本地 NTFS）；但「监听目录被删/移→优雅停止」在本地盘仍有效，须保留 | 砍特殊 FS 子项**无数据丢失**；保留的「目录被删优雅停止」是防崩非防丢 |
| **R6** | 分段名冲突 | **DROP** | `startExternalVideoTranscode` 每调用建唯一 `temp/cowatch-ext/<uuid>`，串行进一步保证，冲突在复用层已不可能 | 删除无数据丢失；uuid 目录是既有复用 |
| **R7** | 与模式 1/模式 B NVENC 争抢 | **DROP（前提：互斥已落实）** | 若后续强制模式互斥（一次只跑一种），监听不会与模式 1/B 并发，争抢不成立 | 删除**前提**是「互斥确已落实」；若互斥未做则该条 revert 为 **KEEP**（会撞 NVENC 致转码失败） |
| **R8** | manifest 损坏/竞态（原子写） | **DROP（随 R2）** | 随 R2 的 manifest 一起删除；原子写仅服务于已删的 manifest | 同 R2 |
| **R_change** | 暂停恢复 change 事件状态机（HIGH） | **见 §2a 决策** | 高复杂度换取窄场景（OBS 长暂停）正确性，详见 A/B 对比 | 若选 **B（忽略 change）** 会丢失「OBS 暂停 >5s」的后半段（**真实数据丢失，须明文记为 phase1 已知限制**） |
| **R_dup** | 多 recording 需用户手动清理 | **随 R_change** | 是 R_change 的产品副作用；R_change 去则 R_dup 去 | 同 R_change 决策 |
| **R_stability** | stabilityThreshold 误触发 | **随 R_change DEMOTE** | 5000ms 已是安全定值；保留 change 则它作兜底，删 change 则它退化为「前半段早触发 + 后半段丢失」 | 删 change 后 R_stability **反而更糟**（无兜底），故与 R_change 联动决策 |

**一期存活风险仅 2 条**：R1（必须，配置项）、R5 的「目录被删优雅停止」子项（低，防崩）。其余 9 条全部 DROP/DEMOTE。

---

## 2. 两个关键设计决策

### (a) R_change 三维状态机（stabilized / inProgress / lastEnqueueSize）一期是否值得做？

**问题本质**：OBS 支持「暂停→恢复」。默认 `awaitWriteFinish` 只包裹 `add`——文件首次稳定后发一次 `add` 并转码；若用户恢复录制，文件继续变大触发的是 `change` 事件。v2 用三维状态机识别「稳定后再次变大 = 暂停恢复」→ 对该文件重新转码 → 产生新独立 recording。

#### 若一期直接忽略 change 事件（回到 v1 行为），代价与收益

**代价（数据正确性损失的具体场景）：**
- OBS 用户「**暂停录制 > 5s**」→ `awaitWriteFinish` 在第 5s 稳定时**误发 `add`** → 前半段被转码上传；恢复录制后文件继续增大触发 `change`，但被忽略 → **后半段永不转码上传 = 真实数据丢失**。
- 影响范围极窄：**仅 OBS 且暂停超过 5 秒**这一个用户动作；ShadowPlay 无暂停概念 → 零影响；短暂停（<5s）→ `awaitWriteFinish` 不会误触发 → 零影响。

**收益（省下的量）：**
- 删去 W1 中 ~120–150 行三维状态机（`stabilized`/`inProgress`/`lastEnqueueSize` 三集合 + 判定链）+ W3 的 `resume`/状态类型 ~10 行 + W8 的多 recording 提示 ~25 行 + R_dup/R_stability 联动复杂度。
- **去掉唯一的高（HIGH）风险项 R_change**，复杂度大幅下降。
- 总省 ~**180–200 行**，并顺带消除 R_dup（手动清理负担）。

#### 可选方案 A / B 对比

| 维度 | **方案 A（保留 change 状态机，v2 设计）** | **方案 B（忽略 change，回 v1 行为）** |
|---|---|---|
| 正确性 | OBS 暂停恢复完整（前半+后半均上传，早期片段用户手动删） | OBS 暂停 >5s → **后半段静默丢失** |
| 新增行数 | +120–150（W1 状态机） | 0（直接不监听 change） |
| 风险登记 | 保留 R_change（HIGH）+ R_dup（中）+ R_stability（中） | 删除 R_change/R_dup；R_stability 退化为「已知限制」 |
| 数据丢失 | 无（仅冗余条目，UX 可清理） | **有，但仅 OBS 长暂停这一窄场景，须明文标注** |
| 适用 | 必须支持 OBS 暂停恢复的场景 | phase1 MVP、以 ShadowPlay 为主、接受「录制中不暂停」约束 |

**权威建议：倾向方案 B（契合用户「少数场景不划算」的判断）。**
但 B 必须以**产品已知限制**形式明文记录，而非静默 bug：

> ⚠️ **phase1 已知限制**：监听模式不处理 OBS「暂停→恢复」产生的文件二次增长；OBS 用户录制中请勿暂停超过 5 秒，或改用 ShadowPlay（无暂停概念）。违反此约束将导致该次录制后半段不上传。

此为**有意的数据丢失权衡**（窄场景、可文档化、非设计缺陷），不是含糊带过。若后续想要「低成本正确性」，可做 **方案 C（简化 change 处理）**：仅保留 `seenAdd` + `lastEnqueueSize` + `inProgress` 三标记的最简版（约 40–60 行，而非 120–150 行），既规避 B 的数据丢失、又砍掉 v2 过度防御——建议放 phase2，不在本期。

---

### (b) 持久化 manifest（R2/R8）一期是否值得做？

**用户质疑成立。** 给定 `ignoreInitial:true` 已挡掉重启重处理，下面列出 manifest 真正能覆盖、`ignoreInitial`+内存 `Set` 覆盖不了的 1–2 个具体场景——结论是：**找不到。**

**场景拆解：**
1. **同一次运行内 chokidar 对同一文件重复发 `add`**（写后改名 / 临时名→正名）→ 由**运行期内存 `Set`** 覆盖，manifest 不必须。
2. **崩溃中途文件重启后重捡** → `ignoreInitial` 挡掉所有已存在文件（包括它），manifest（仅成功才写）也不含它 → **两者都救不了** → manifest 无效。
3. 优雅重启后「已处理文件不重处理」→ `ignoreInitial` 单独已等价实现，manifest 冗余。

**唯一理论边角**：用户想「跨重启记住哪些已处理，以便将来统一重传/审计」——这是**产品诉求**（房间级重传），不是技术防丢，phase1 可不做。

**结论：phase1 删除 manifest**（删 W2 + 从 T1/T5 移除相关逻辑）。

**诚实边界（必须说清）：**
- 删除 manifest 后，「app 崩溃时正在转码的文件」确实会丢（被 `ignoreInitial` 挡掉不再捡）——但这是 `ignoreInitial` 的**固有行为**，原 manifest（仅成功才写）也救不了，故**删除不引入新丢失**。
- 若产品将来要求「崩溃续传」，属 phase2 另做方案：**启动重扫源目录 + 比对轻量记录**（而非当前 manifest 的「成功才写」语义）。本期不做。

> 补充澄清（用户点 2 之 R_dup 疑问）：**R2/R8 的 manifest 去重 ≠ R_dup。**
> - **R2/R8（文件级去重）**：防止「同一个源视频文件被重复转码/上传」（技术层，靠 `path+mtime+size`）。
> - **R_dup（房间记录级冗余）**：OBS 暂停恢复导致同一文件被**故意**重转码成多个独立 recording 条目（前半段 + 后半段都进房间），早期不完整那个需用户手动删。这是「功能副作用」，**不是文件没去重**。
> - 二者正交：manifest 解决「文件被处理两次（bug）」，R_dup 是「文件被处理两次（故意保全数据）后房间里出现两条记录需清理」。命名相近纯属巧合，逻辑无关。

---

## 3. 修订后 · 一期精简风险登记表

| ID | 风险 | 严重度 | 处置 |
|---|---|---|---|
| **R1** | 半写文件 | 高（必须配置） | **KEEP** — `awaitWriteFinish{5000,2000}` + 扩展名白名单，T1 落地 |
| **R5-sub** | 监听目录被删/移 → 优雅停止 | 低 | **KEEP（R5 仅保留此子项）** — watcher `error` 事件 → UI 提示 + 优雅停止，T5 落地 |
| R_change | 暂停恢复 change 状态机 | — | **DROP（方案 B）** — 回 v1 忽略 change；明文标注「OBS 长暂停后半段丢失」已知限制 |
| R_dup | 多 recording 手动清理 | — | **DROP（随 R_change）** |
| R_stability | stabilityThreshold 误触发 | — | **DEMOTE** — 5000ms 固定；随 R_change 退化为已知限制说明 |
| R2 | 重启重复处理（manifest） | — | **DROP** — `ignoreInitial` 已等价覆盖 |
| R3 | NVENC 并发上限 | — | **DROP** — 串行架构已消除 |
| R4 | 磁盘空间 | — | **DROP（移出登记册）** — 临时目录已自动清理；堆积属用户/录屏软件责任 |
| R5-main | 特殊文件系统（FAT/exFAT/SMB） | — | **DROP** — 限本地 NTFS，不在 scope |
| R6 | 分段名冲突 | — | **DROP** — uuid 输出目录已天然规避 |
| R7 | 与模式 1/B NVENC 争抢 | — | **DROP（前提：模式互斥已落实）** |
| R8 | manifest 损坏/竞态 | — | **DROP（随 R2）** |

**存活 2 条 / 削减 9 条。** 一期风险面从「1 高 + 6 中 + 4 低」压缩到「1 必须配置（R1）+ 1 低（R5-sub）」。

---

## 4. 一期修订任务列表（删 R_change 状态机 + 删 manifest）

> 行数估算对比：原 **950–1100 行**（含 change +150–200、manifest ~100）。

### 任务变动总览

| 原任务 | 一期处置 | 说明 |
|---|---|---|
| **T_change** | **删除（整个任务消失）** | change 状态机（W1 三维集合 + W3 resume 类型 + W8 多 recording 提示）随方案 B 移除 |
| **T1** 源监听器 + 三层去重 | **收缩** | 去 W2（manifest 删除）、去 W1 中三维状态机；保留 W1（watcher + 内存 `Set` + `awaitWriteFinish`）、W3（基础类型）、W4（selectWatchFolder）、W7（基础类型） |
| **T2** 串行调度器 + onJobDone 钩子 | **保留（简化）** | `pump()` 不再处理 change 重入队；串行 + `onJobDone` 仍必须 |
| **T3** IPC glue | **保留（简化）** | `watchMode:event` 类型去掉 `resume`；`startWatch/stopWatch/getWatchStatus` 保留 |
| **T4** 设置 UI | **保留（简化）** | 去「多 recording 手动清理提示」「低磁盘告警」；保留开关/选目录/状态/进度 + 共享 `QueueRow` 抽取 |
| **T5** 错误/持久化/清理收尾 | **收缩** | 去 manifest 增强（W2 删）、去低磁盘告警（R4 删）；**保留**「目录被删优雅停止」（R5-sub）、「记住监听目录+开关跨重启」（app settings 小 JSON，**非** dedup manifest）、可选 `deleteSourceOnSuccess` |
| **T6** 集成验证 | **保留（简化验收）** | 去掉「暂停恢复多 recording」测试、去掉「重启 manifest 去重」测试；保留端到端转码上传、半写防护、串行 NVENC、停止后跑完 |

### 依赖关系（修订后）

```
T1（源监听器+内存Set去重，无 manifest/无 change）
  └→ T2（串行泵 + onJobDone）
        └→ T3（IPC glue）
              └→ T4（设置 UI，简化）
                    └→ T5（错误/清理收尾，简化）
                          └→ T6（集成验证，简化验收）
```
（原 T_change 从依赖链中完全摘除。）

### 新行数估算（对比原 950–1100）

| 文件 | 原估算 | 一期估算 | 变动 |
|---|---|---|---|
| W1 `watch-source/index.ts` | ~320（含 change +120–150） | ~180–200 | 去 change 状态机 −120–150 |
| W2 `watch-source/manifest.ts` | ~100 | **0（删除）** | 整文件删除 −100 |
| W3 `watch-source/types.ts` | ~80 | ~70 | 去 resume/状态类型 −10 |
| W8 `WatchModeSettings/index.tsx` | ~230 | ~190 | 去多 recording 提示 + 低磁盘告警 −40 |
| W9 `VideoUploader/QueueRow.tsx` | ~60（抽取，净 0） | ~60 | 不变 |
| W4 `recorder/index.ts` | +~100 | +~80 | 去 manifest 写入/onJobDone 复杂钩子 −20 |
| W5 `preload.ts` | +~30 | +~25 | 去 resume 位 −5 |
| W6 `global.d.ts` | +~20 | +~20 | 不变 |
| W7 `types/recorder.ts` | +~20 | +~15 | 去 resume 类型 −5 |
| W10 `ElectronVideoUploader/index.tsx` | ~10 | ~10 | 不变 |
| **合计** | **950–1100** | **≈ 620–780** | **净减 ≈ 270–350 行（约 −30%）** |

**结论**：删除 R_change 状态机（方案 B）+ 删除 manifest 后，一期工程量从 950–1100 行降至 **约 620–780 行**，文件数从 10 个降至 **9 个**（W2 删除），唯一保留的「高风险」实质只剩 R1 的配置项（零成本），整体风险面与复杂度显著收敛，符合 phase1 MVP 定位。

---

## 附录：R1 澄清（用户点 2 之半写文件）

**「半写文件」指什么？**
源视频文件仍在被录屏软件**顺序写入**（字节从 0 涨到数 GB）的过程中，CoWatch 的 watcher 就把它当作「已写完」捡起来送 FFmpeg 转码 → 转码出**截断/损坏**的视频（只含前半段），或 FFmpeg 读到文件末尾时录制其实还没结束 → 输出不完整。

**为什么 chokidar 不包 `awaitWriteFinish` 会捡到正在写入的文件？**
chokidar 的 `add` 事件在**文件系统条目被创建**的那一刻就触发（Windows 上 `ReadDirectoryChangesW` 的 `FILE_ACTION_ADDED` 在文件被以写入方式打开/创建时就上报），**而不是「文件内容写完」时才触发**。录屏软件「开始录制」= 创建文件并持续写入，这个「创建」动作发生在录制最开头（第 1 秒）。所以不带 `awaitWriteFinish` 时，CoWatch 会在录制第 1 秒就把空/半截文件送去转码。`awaitWriteFinish` 的意义就是：不立即信任 `add`，改为轮询文件大小，连续 `stabilityThreshold`（5000ms）不变才确认为「写完」——这正是 R1 的缓解手段，必须保留。

---

## 附录：R7 澄清（用户点 2 / 点 3 之互斥）

用户「之后会限制模式（互斥）」→ 若互斥确已落实（一次只激活一种模式），则监听模式不会与模式 1（WGC 也走 NVENC）/ 模式 B 并发 → NVENC 争抢不成立，**R7 一期 DROP 成立**。
⚠️ **前提警示**：此 DROP 依赖「互斥已落实」。若 phase1 实际未做互斥（v2 决策 #7 明确「本期不强制互斥」），则 R7 必须 **revert 为 KEEP**——否则监听与其他模式同时跑会撞 GeForce NVENC 上限导致转码失败。请在排期时确认互斥的落地阶段。
