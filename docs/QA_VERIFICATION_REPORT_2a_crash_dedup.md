# 方案2a 窗口录制 — crash 上报去重收口复验

> 验证人：QA 严过关 ｜ 轮次：闭环收尾（crash 双触发全路径去重）｜ 环境：沙箱（无法编译，纯静态复核）
> 对象：software-engineer 针对 KI 跟进项旁注（spawn `error` 极稀有双 onCrash）的主动收口
> 配套：QA_VERIFICATION_REPORT_2a.md / _round2.md / _ki_followup.md

---

## 复验结论

**PASS。** 工程师以单一 `crashNotified` 标志位收口 window 模式全部 4 处 `onCrash`，使**单次启动尝试内任何来源的 crash 仅上报 1 次 `restartRecording`**，既不级联也不漏崩。与既有 10 原修复 + 2 KI 修复无冲突、无回归。

| 核对点 | 位置 | 结论 |
|---|---|---|
| 模块级标志 | recording/index.ts:90 `let crashNotified = false;` | PASS |
| 每次启动重置 | recording/index.ts:166 `crashNotified = false;`（startWindowRecording 开头） | PASS |
| 配置缺失 | recording/index.ts:169 `if (!crashNotified) { crashNotified=true; cbs.onCrash?.(...); }` | PASS |
| 未找到 exe | recording/index.ts:181 同构守卫 | PASS |
| close code≠0 | recording/index.ts:210 同构守卫 | PASS |
| spawn `error` | recording/index.ts:215 同构守卫（覆盖此前旁注的极稀有双触发） | PASS |
| screen 路径 | recording/index.ts:649 `callbacks.onCrash?.(currentWindowTitle);` **保持原样未改** | PASS（属 feat 基线，非 window 闭环） |

---

## 正确性论证

- **不漏崩**：`restartRecording` → 重新进入 `startWindowRecording` → 重置 `crashNotified=false`，新一轮启动尝试仍可上报一次 crash。故连续崩溃每轮各报 1 次，且 `crashRestartCount` 按真实崩溃次数递增（受 `MAX_CRASH_RESTARTS=3` 上限）。
- **不级联**：单次尝试内，close 与 error 双触发（或 KI-1 前的 ERROR 行 + close）只会命中首个守卫、置位后其余被吞；恰好 1 次 `onCrash` → 1 次 `restartRecording`。
- **与 KI-1 协同**：KI-1 已从根源去掉 ERROR 行单独 `onCrash`；本次 `crashNotified` 余下覆盖 spawn `error`/close(null) 等极稀有路径，二者互补、不重叠、不冗余。
- **scope 正确**：screen 路径（line 649）未触碰，符合"window 闭环"约定；其 crash 重启逻辑沿用 feat 基线原样。

---

## 护栏回归复核

无全帧回读 / CMake 不链 avformat / screen 零改动 / null 模式 fd=-1 不阻塞 / stdout·stderr 分流 / 管道 fd 闭环 / 退出码对齐——全部仍 PASS。10 原修复 + 2 KI 修复 + 本次去重，代码层完整闭环。

---

## 真机 build 状态

- 沙箱仍无 MSVC/CMake/网络/显示，**无法编译**。以上为静态复核。
- 真机验收清单可补一条：注入 spawn 失败（如临时改名 window_capture.exe）+ 注入 NVENC 连续失败，观察 `crashRestartCount` 各仅 +1（单来源单重启），且无孤儿 exe。

---

*方案2a 窗口录制代码层修复完整闭环：10 原修复 + KI-1 + KI-2 + crash 去重，全数静态确认就绪。未 commit、未改任何实现代码。*
