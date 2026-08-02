# CoWatch 知识沉淀

> 记录项目中踩过的坑、定型的模式与底层原理，避免重复造轮子和回退已修复的缺陷。

---

## Electron IPC 监听器管理

### removeAllListeners 互相踩踏

**问题场景**：多个组件订阅同一个 IPC channel 时，任一方调用 `ipcRenderer.removeAllListeners(channel)` 会清掉该 channel 上**所有** listener，导致其他订阅者的回调静默失效。

**典型踩踏链**（CoWatch 实例）：

```
recorder:progress channel 上同时挂载两个 listener：
  T1: Recorder 组件 onProgress(cb_A)        → 推 finishing 态进度条
  T2: PendingUploads 组件 onProgress(cb_B)  → 推补传列表进度

T3: PendingUploads 卸载 → offProgress() → removeAllListeners
    listeners = []  ← cb_A 被无辜清掉

T4: 主进程推 progress → Recorder 的 finishing 进度条永久卡住
```

更隐蔽的是 `useEffect` 依赖变化导致重注册时的竞态：A 组件重注册的瞬间，B 组件恰好卸载并调用 `removeAllListeners`，会把 A 刚注册的 listener 也清掉。

**根因**：`removeAllListeners(channel)` 是全局操作，不区分调用方。Electron 官方文档明确指出："Removes all listeners, or those of the specified eventName."

### 正确模式：on 返回 unsubscribe 函数

preload 层封装包装函数并返回按引用摘除的闭包：

```typescript
// electron/preload.ts
onProgress: (cb: (info: RecordingProgress) => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, info: RecordingProgress) => cb(info);
  ipcRenderer.on('recorder:progress', wrapped);
  return () => ipcRenderer.removeListener('recorder:progress', wrapped);
},
// 不再提供 offProgress 方法
```

调用方在 `useEffect` cleanup 中直接返回 unsubscribe：

```typescript
// React 组件
useEffect(() => {
  const unsub = bridge.recorder.onProgress((info) => setProgress(info));
  return unsub;
}, []);
```

**为什么是这个形态**：

| 方案 | 评价 |
|------|------|
| `removeAllListeners(channel)` | ✗ 全局清空，多订阅者互相踩踏 |
| `off(cb)` 调用方传 cb | ✗ preload 内部包了 wrapped 函数，cb ≠ wrapped，需要维护映射表，复杂易错 |
| `on(cb) → unsubscribe` | ✓ 闭包封装 wrapped 引用，调用方零成本拿到精确摘除函数，不可能误删别人 |

### CoWatch 落地清单

- **preload.ts**：6 个 `on*` 方法（onTick / onProgress / onError / onPendingUpdate / onExternalTranscodeProgress / onWatchFileDetected）统一返回 `() => void` unsubscribe，删除对应的 6 个 `off*` 方法
- **global.d.ts**：声明 `type ElectronUnsubscribe = () => void`，6 个 `on*` 返回类型同步更新
- **调用方**：Recorder、PendingUploads、ElectronVideoUploader 三个组件的 `useEffect` 改为 `return unsub`

### 通用规则（适用所有 Electron 项目）

1. **preload 层禁止暴露 `removeAllListeners`**，除非该 channel 语义上就是单订阅者
2. **on* 方法一律返回 unsubscribe 函数**，调用方在 `useEffect` cleanup 中直接 `return unsub`
3. **多组件订阅同一 channel 是合法场景**，IPC 层不应假设单订阅者
4. **TS 类型层面收敛**：定义 `type Unsubscribe = () => void`，所有 `on*` 返回此类型，从源码层面禁止 `void` 返回值的写法

### 排查手法

发现"某组件 IPC 回调偶发性失效、重启后恢复"类问题时，按以下顺序排查：

1. `grep removeAllListeners` 看是否有调用方清空了共享 channel
2. 检查同一 channel 是否有多个组件订阅（`grep ipcRenderer.on` 或 `bridge.recorder.on*`）
3. 看 `useEffect` 依赖数组，频繁变化的依赖会导致重注册时机交错，触发竞态踩踏
