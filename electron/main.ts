import { app, BrowserWindow, protocol, net } from 'electron';
import path from 'path';
import { URL } from 'url';

// ─── 三种运行模式 ────────────────────────────────────────────────────────────
//
// 1. electron:dev     → electron . 直接运行，ELECTRON_PREVIEW 未设置
//                       加载 webpack-dev-server（http://localhost:3001）
//                       DevTools 自动打开
//
// 2. electron:preview → electron . 直接运行，ELECTRON_PREVIEW=true
//                       加载本地 dist 产物（app:// 协议）
//                       DevTools 自动打开，用于验证 build 行为和调试打包问题
//
// 3. 打包后运行        → app.isPackaged === true
//                       加载本地 dist 产物（app:// 协议）
//                       不开 DevTools
//
// app.isPackaged 是 Electron 内置运行时属性，不依赖任何编译时注入的常量。
const DEV_SERVER_URL = 'http://localhost:3001';
const isPreview = process.env.ELECTRON_PREVIEW === 'true';

// ─── 后端地址 ────────────────────────────────────────────────────────────────
// 通过环境变量 ELECTRON_API_ORIGIN 在构建/启动时注入：
//   - 本地 preview：不传，默认 http://localhost:3002
//   - 发布生产包：ELECTRON_API_ORIGIN=https://cowatch.daibao.site electron-builder ...
const API_ORIGIN = process.env.ELECTRON_API_ORIGIN || 'http://localhost:3002';

// ─── 注册 app:// 自定义协议 ──────────────────────────────────────────────────
// 设计思路：
//   页面以 app://<apiHost>/index.html 加载，其中 apiHost 取自 API_ORIGIN
//   （如 localhost:3002 或 cowatch.daibao.site）。
//
//   这样 window.location.host === apiHost，所有业务代码里的相对路径推断
//   （包括 WebSocket 连接）都和 Web 环境行为一致，业务代码零修改。
//
//   protocol.handle 拦截 app:// 请求后：
//     - 后端路径（/api/、/socket、/uploads/、/avatar/）→ 转发到 API_ORIGIN
//     - 其余路径（前端 JS/CSS/图片等）→ 从本地 dist 目录读取
//
// 注意：registerSchemesAsPrivileged 必须在 app.whenReady() 之前调用。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,       // 允许相对路径解析
      secure: true,         // 视为安全源，允许 fetch / XHR
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,         // 支持流式响应（m3u8、视频等）
    },
  },
]);

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const reqUrl = new URL(request.url);
    const pathname = reqUrl.pathname;

    // ── 后端路径 → 转发到真实后端 ─────────────────────────────────────────
    const isBackendPath =
      pathname.startsWith('/api/') ||
      pathname.startsWith('/socket') ||
      pathname.startsWith('/uploads/') ||
      pathname.startsWith('/avatar/');

    if (isBackendPath) {
      const backendUrl = `${API_ORIGIN}${pathname}${reqUrl.search}`;
      return net.fetch(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }

    // ── 前端静态资源 → 从本地 dist 读取 ──────────────────────────────────
    const distDir = path.join(__dirname, '../dist');
    const hasExt = path.extname(pathname) !== '';
    const localPath = hasExt
      ? path.join(distDir, pathname)
      : path.join(distDir, 'index.html'); // SPA history 路由兜底
    return net.fetch(`file://${localPath}`);
  });
}

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

  // apiHost 取自 API_ORIGIN，如 'localhost:3002' 或 'cowatch.daibao.site'。
  // 用它作为 app:// 的 host，使得 window.location.host === apiHost，
  // WebSocket 连接（ws://${window.location.host}/socket）因此自动指向正确后端，
  // 业务代码无需任何修改。
  const apiHost = new URL(API_ORIGIN).host;

  if (app.isPackaged) {
    win.loadURL(`app://${apiHost}/index.html`);
  } else if (isPreview) {
    win.loadURL(`app://${apiHost}/index.html`);
    win.webContents.openDevTools();
  } else {
    // dev 模式：webpack-dev-server 自带 proxy，直接加载 HTTP URL
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools();
  }
}

// ─── 上线版（Windows 专用，目标用户为游戏玩家）────────────────────────────
// 上线前将下方"开发版"替换为此版本
//
// app.whenReady().then(() => {
//   registerAppProtocol();
//   createWindow();
// });
// app.on('window-all-closed', () => app.quit());

// ─── 开发版（兼容 macOS 开发机）─────────────────────────────────────────────
app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC 处理器占位（录制功能阶段再实现）────────────────────────────────────
// ipcMain.handle('recorder:start', async (_event, windowId: string) => { ... });
// ipcMain.handle('recorder:stop', async () => { ... });
