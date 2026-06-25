import { ipcRenderer } from 'electron';

/**
 * 录制相关 IPC 调用（阶段2实现）
 *
 * 实现时取消注释，并在 preload.ts 中导入：
 *   import { recorderHandlers } from './handlers/recorder';
 */

// export const recorderHandlers = {
//   start: (windowId: string) => ipcRenderer.invoke('recorder:start', windowId),
//   stop: () => ipcRenderer.invoke('recorder:stop'),
//   onProgress: (cb: (pct: number) => void) => {
//     ipcRenderer.on('recorder:progress', (_event, pct) => cb(pct));
//   },
// };
