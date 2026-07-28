/**
 * 监听模式 IPC 注册（从 coordinator 拆出，避免其继续膨胀）。
 *
 * 注册以下 IPC：
 *  - recorder:watchMode:selectFolder → 打开单目录选择对话框
 *  - recorder:watchMode:start        → 启动监听（仅启 chokidar，检测到文件即广播路径）
 *  - recorder:watchMode:stop         → 停止监听
 *  - recorder:watchMode:getStatus    → 查询监听状态（供 UI 恢复开关标签）
 *
 * 事件发送（main → renderer）：
 *  - recorder:watchMode:fileDetected → 检测到的视频文件路径（渲染端按手动上传同构入队）
 */

import { dialog, BrowserWindow, ipcMain } from 'electron';

import { createWatchSource, type WatchSourceController } from './index';
import type { WatchFolderResult, WatchModeOptions, WatchStatus } from '../../../../src/types/recorder';

/** 单例控制器（registerWatchHandlers 内惰性创建一次） */
let controller: WatchSourceController | null = null;

/** 向所有渲染窗口广播检测到的文件路径 */
function emitFileDetected(filePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:watchMode:fileDetected', filePath);
  }
}

/**
 * 注册监听模式相关 IPC。在 coordinator 的 registerRecorderHandlers() 末尾调用。
 */
export function registerWatchHandlers(): void {
  if (!controller) {
    controller = createWatchSource({
      emitFileDetected,
      onLog: (msg) => console.log(msg),
    });
  }

  // 打开单目录选择对话框（类比 selectVideoFiles）
  ipcMain.handle('recorder:watchMode:selectFolder', async (): Promise<WatchFolderResult> => {
    const result = await dialog.showOpenDialog({
      title: '选择要监听的视频文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cancelled: false, folderPath: result.filePaths[0] };
  });

  // 启动监听：仅启 chokidar；检测到文件即广播路径给渲染端（渲染端按手动上传同构处理）
  ipcMain.handle('recorder:watchMode:start', async (
    _event,
    folderPath: string,
    options?: WatchModeOptions,
  ) => {
    try {
      return controller!.start(folderPath, options);
    } catch (err) {
      console.error('[watch-mode] start 异常：', (err as Error).message);
      return { error: (err as Error).message || '启动监听失败' };
    }
  });

  // 停止监听：关闭源 watcher，不再捡新文件
  ipcMain.handle('recorder:watchMode:stop', async () => {
    try {
      return controller!.stop();
    } catch (err) {
      console.error('[watch-mode] stop 异常：', (err as Error).message);
      return { error: (err as Error).message || '停止监听失败' };
    }
  });

  // 查询监听状态（供 UI 恢复开关标签）
  ipcMain.handle('recorder:watchMode:getStatus', async (): Promise<WatchStatus> => {
    return controller!.getStatus();
  });
}
