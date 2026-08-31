import { app, BrowserWindow } from 'electron';
import path from 'path';

const isPreview = process.env.ELECTRON_PREVIEW === 'true';

// 设置窗口单例：已存在则 focus + 切 Tab，不新建
let settingsWindow: BrowserWindow | null = null;

/**
 * 打开设置窗口。复用主应用同一个 index.html + bundle.js，通过 React Router /settings 路由渲染。
 * 单例：已存在则 focus 并通过 IPC 通知切 Tab（不重新加载页面，避免闪烁和表单值丢失）。
 *
 * @param parent 主窗口实例，用作模态父窗口；可为 null（主窗口未创建时）
 * @param section 打开后默认展示的设置分区
 */
export function createSettingsWindow(
  parent: BrowserWindow | null,
  section: 'recording' | 'transcode'
): void {
  // 单例守卫：已存在则 focus + 通过 IPC 通知切 Tab（不重新加载页面，避免闪烁和表单值丢失）
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    settingsWindow.webContents.send('settings:switch-tab', section);
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 680,
    height: 560,
    title: '设置',
    parent: parent ?? undefined,
    modal: true,
    minimizable: false,
    maximizable: false,
    // 复用与主窗口相同的 preload（设置窗口需通过 electronBridge.settings 访问设置 IPC）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  // 设置窗口为对话框性质，移除应用菜单栏
  settingsWindow.setMenu(null);

  const url =
    app.isPackaged || isPreview
      ? `app://localhost/settings?section=${section}`
      : `http://localhost:3001/settings?section=${section}`;
  settingsWindow.loadURL(url);

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
  });

  settingsWindow.once('closed', () => {
    settingsWindow = null;
  });
}
