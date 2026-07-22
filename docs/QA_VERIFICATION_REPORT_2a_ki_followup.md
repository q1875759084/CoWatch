# 方案2a 窗口录制 — KI-1/KI-2 跟进项复验

> 验证人：QA 严过关 ｜ 轮次：Known Issue 跟进（Round 2 复验后的小闭环）｜ 环境：沙箱（无法编译，纯静态复核）
> 对象：software-engineer 针对初报 Round 2 Known Issue 的 2 项修复
> 配套：QA_VERIFICATION_REPORT_2a.md / QA_VERIFICATION_REPORT_2a_round2.md

---

## 复验结论

**KI-1、KI-2 两项均已在源码层落实且正确（PASS），无回归。** Round 2 复验报告的 10 项原修复未受影响。

| # | 修复项 | 核实点 | 结论 |
|---|---|---|---|
| KI-1 | ERROR 行不再单独 onCrash | recording/index.ts:236-241 ERROR 分支仅 `cbs.onLog`，已删除 `cbs.onCrash` | PASS |
| KI-2 | stop() 释放 m_context 持锁 | winrt_capture.cpp:153-156 `std::lock_guard<m_texMutex>` 作用域内 `m_context->Release(); m_context=nullptr;` | PASS |

---

## KI-1 安全性论证（关键）

移除 ERROR 行 `onCrash` 后，崩溃重启是否仍只触发一次、且不漏报？

- 静态核查 `main.cpp` 全部 9 处 `emitError` 调用，**其后进程必以非 0 退出**：
  - 解析/定位失败 → `return 2`（main.cpp:183/189）
  - D3D11 / WGC init/start、no-frame、NVENC init、mux init 失败 → `return 1`（main.cpp:200/213/217/231/254/279）
  - NVENC 连续失败 → `emitError(2,…)` + `exitCode=2` + `break` → `return exitCode`（main.cpp:346/370-373）
- 因此任何 ERROR JSON 行落地后，进程终将以非 0 退出，`captureProc.on('close')`（recording/index.ts:206-209 `code!==0` 分支）**必触发一次 `cbs.onCrash` → `restartRecording`**。
- 结论：单崩溃现仅 **1 次** restartRecording，不再级联 2 次、不再更快耗尽 `MAX_CRASH_RESTARTS=3`；无漏崩路径。

> 注（非回归、非本次范围）：`captureProc.on('error')`（spawn 失败，exe 不存在）仍会 `onCrash`（recording/index.ts:211-214），且 spawn 失败时 `close` 或带 `code=null` 再触发一次——属极稀有路径（前置 /MD+Redist 缺失才会），非 KI-1 引入、非本次修复回归，按需可后续去重，不在本闭环内。

---

## KI-2 安全性论证

- `stop()`（winrt_capture.cpp:134-156）先 revoke `m_closedRevoker`/`m_frameArrivedRevoker`（已保证无在途回调），再在 `m_texMutex` 锁内释放 `m_context` 并置 `nullptr`。
- 与 `onFrameArrived`（winrt_capture.cpp:203 `lock_guard(m_texMutex)` 下 `m_context->CopyResource`）、`copyLatestInto`（:161 同）访问 `m_context` 对称持锁，彻底消除"stop 释放 vs 回调使用"的极窄并发窗口；`m_context=nullptr` 额外防御重复 stop。
- 正常关闭/停止路径（优雅退出、窗口关闭 sentinel、暂停终止）不受影响。

---

## 护栏回归复核（与 Round 2 一致）

无全帧回读 / CMake 不链 avformat / screen 零改动 / null 模式 fd=-1 不阻塞 / stdout·stderr 分流 / 管道 fd 释放闭环——全部仍 PASS。

---

## 真机 build 状态

- 沙箱仍无 MSVC/CMake/网络/显示，**无法编译**。以上为静态复核。
- 真机重点验收（用户按初报 §2 清单）：
  1. KI-1 后注入 NVENC 连续失败，观察 `crashRestartCount` 仅 +1（单崩溃单重启）。
  2. KI-2 后窗口正常关闭 / 停止 / 暂停恢复路径无竞态告警或死锁。

---

*KI 跟进项闭环完成。方案2a 代码层（10 原修复 + 2 KI 修复）全部静态确认就绪，等待真机 build 验收。未 commit、未改任何实现代码。*
