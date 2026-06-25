import { contextBridge } from 'electron';

/**
 * contextBridge 将受控 API 暴露给 renderer（React 页面）
 *
 * renderer 通过 window.electronBridge 访问这些 API
 * 不暴露 ipcRenderer 本身，防止 renderer 直接发送任意 IPC 消息
 *
 * ─── 新增模块时的导入方式 ────────────────────────────────────────────────────
 * 业务逻辑统一写在 ./handlers/ 目录下，preload.ts 只做聚合和暴露：
 *
 *   import { recorderHandlers } from './handlers/recorder';  // 阶段2
 *   import { storeHandlers } from './handlers/store';        // 阶段1
 *
 *   contextBridge.exposeInMainWorld('electronBridge', {
 *     isElectron: true as const,
 *     recorder: recorderHandlers,
 *     store: storeHandlers,
 *   });
 * ────────────────────────────────────────────────────────────────────────────
 */
contextBridge.exposeInMainWorld('electronBridge', {
  /** 标识当前运行在 Electron 环境中，供 src/ 里的环境判断使用 */
  isElectron: true as const,

  // ─── 录制相关（阶段2实现）见 ./handlers/recorder.ts ──────────────────────
  // recorder: recorderHandlers,

  // ─── 本地存储（阶段1实现）见 ./handlers/store.ts ─────────────────────────
  // store: storeHandlers,
});
