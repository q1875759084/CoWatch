import { ipcRenderer } from 'electron';

/**
 * 本地存储相关 IPC 调用（阶段1实现）
 * 用途：绕开浏览器 cookie sameSite 限制，持久化 token 等数据
 *
 * 实现时取消注释，并在 preload.ts 中导入：
 *   import { storeHandlers } from './handlers/store';
 */

// export const storeHandlers = {
//   get: (key: string) => ipcRenderer.invoke('store:get', key),
//   set: (key: string, value: string) => ipcRenderer.invoke('store:set', key, value),
//   delete: (key: string) => ipcRenderer.invoke('store:delete', key),
// };
