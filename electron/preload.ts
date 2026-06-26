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

  /**
   * 后端 origin，格式如 'http://localhost:3002' 或 'https://cowatch.daibao.site'。
   * app:// 协议的 host 不含端口，无法从 window.location 推断真实后端地址，
   * 由此字段补全，供 env.ts 的 apiOrigin 使用（WS 地址推断等场景）。
   */
  apiOrigin: process.env.ELECTRON_API_ORIGIN || 'http://localhost:3002',

  // ─── 录制相关（阶段2实现）见 ./handlers/recorder.ts ──────────────────────
  // recorder: recorderHandlers,

  // ─── 本地存储（阶段1实现）见 ./handlers/store.ts ─────────────────────────
  // store: storeHandlers,
});
