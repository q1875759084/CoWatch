import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { initHlsCache, setApiOrigin } from './handlers/cache';
import { registerRecorderHandlers, setApiOriginForRecorder } from './handlers/recorder/index';
import { registerSettingsHandlers } from './handlers/settings-store';
import { registerAppProtocol } from './app-protocol';
import { createSettingsWindow } from './windows/settings-window';

const DEV_SERVER_URL = 'http://localhost:3001';
const isPreview = process.env.ELECTRON_PREVIEW === 'true';

// ─── 后端地址 ────────────────────────────────────────────────────────────────
// 优先级：编译时注入(__API_ORIGIN__) > 运行时环境变量(ELECTRON_API_ORIGIN) > 默认值
//   - npm run electron:pack:test 传入 ELECTRON_API_ORIGIN → 编译进 bundle
//   - electron:preview 手动设环境变量 → 运行时读取
//   - 都没有 → localhost:3002
const API_ORIGIN = (__API_ORIGIN__ as string) || process.env.ELECTRON_API_ORIGIN || 'http://localhost:3002';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow = win;

  if (!app.isPackaged && !isPreview) {
    // app.isPackaged 是 Electron 内置运行时属性，不依赖任何编译时注入的常量。
    // dev 模式：webpack-dev-server 自带 proxy，直接加载 HTTP URL
    win.loadURL(DEV_SERVER_URL);
  } else {
    // preview / packaged 模式：通过 app:// 协议加载本地 dist 产物
    win.loadURL('app://localhost/index.html');
  }
}

// ─── 主窗口实例 ───────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

/**
 * requestSingleInstanceLock：OS层面建立一把命名锁。
 * 进程 A（首启）：requestSingleInstanceLock() → true  → 建锁成功 → 正常 whenReady 启动
 * 进程 B（再点）：requestSingleInstanceLock() → false → 锁已被占 → 应 app.quit(), 同时会把 B 的 argv 发给 A
 * 进程 A 收到 'second-instance' 事件（带 B 的 argv）→ A 负责 restore+show+focus 自己的窗口
 */
const gotLock = app.requestSingleInstanceLock();
if(!gotLock){
  /**
   * app.quit() 在 ready 之前调用是不可靠的。它只是"请求退出"。
   * 这会导致第二次启动时，主进程启动，执行ready阶段代码，创建一个窗口，屏幕上短暂出现，然后quit。表现为一次闪烁。
   */
  // app.quit();
  app.exit(0); // 同步硬杀,whenReady 不会触发,createWindow 不执行 → 无窗口闪
}

// ready作为一次性事件，且通常需要处理异步任务。采用promise写法，使用whenReady
// 等价于 app.on('ready')
app.whenReady().then(() => {
  initHlsCache();
  setApiOrigin(API_ORIGIN);
  setApiOriginForRecorder(API_ORIGIN);
  registerRecorderHandlers();
  registerSettingsHandlers();
  registerAppProtocol(API_ORIGIN);
  createWindow();

  // 自定义应用菜单
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '查看',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '设置',
      submenu: [
        {
          label: '录制设置',
          click: () => createSettingsWindow(mainWindow, 'recording'),
        },
        {
          label: '转码设置',
          click: () => createSettingsWindow(mainWindow, 'transcode'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
});

app.on('second-instance',(event,argv)=>{
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
})

// ─── TODO: before-quit 优雅停止录制 ─────────────────────────────────────────
//
// 目标：用户正常退出 CoWatch 时（关窗、Cmd+Q、任务栏退出），若录制进行中，
//       弹窗告知用户并让其决定是否丢弃未上传切片后退出。
//
// 交互设计：
//   1. app.on('before-quit') 触发时，检查是否正在录制（需暴露 isRecording() 函数）
//   2. 若正在录制：
//      a. event.preventDefault() 阻止立即退出
//      b. 向渲染进程发送 IPC 消息 'recorder:quit-while-recording'
//      c. 渲染进程弹出 Dialog：
//           "录制进行中，xxx 片段尚未上传，确认退出将丢弃这部分内容。"
//           [取消] / [确认退出]
//      d. 用户点"确认退出"：
//           - 调用 stop()（丢弃 pendingQueue，但已成功上传的片段不受影响）
//           - 后端定时任务会在 3~6 分钟后对已上传片段自动收尾生成视频
//           - app.quit() 真正退出
//      e. 用户点"取消"：无事发生，继续录制
//
// 注意事项：
//   - 进程崩溃/强杀不触发 before-quit，由后端超时自动收尾（方案B）兜底
//   - stop() 内有网络请求，需设超时（建议 10s），防止网络故障导致永远无法退出
//   - isRecording() 需从 recorder/index.ts 导出
app.on('before-quit',(event)=>{

})

app.on('window-all-closed', () => {
  app.quit();
});
