import { app, BrowserWindow, protocol, net } from 'electron';
import path from 'path';
import { URL } from 'url';
import { initHlsCache, setApiOrigin, isHlsSegment, handleHlsSegment } from './handlers/cache';
import { registerRecorderHandlers, setApiOriginForRecorder } from './handlers/recorder/index';

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
// 优先级：编译时注入(__API_ORIGIN__) > 运行时环境变量(ELECTRON_API_ORIGIN) > 默认值
//   - npm run electron:pack:test 传入 ELECTRON_API_ORIGIN → 编译进 bundle
//   - electron:preview 手动设环境变量 → 运行时读取
//   - 都没有 → localhost:3002
const API_ORIGIN = (__API_ORIGIN__ as string) || process.env.ELECTRON_API_ORIGIN || 'http://localhost:3002';

// ─── 注册 app:// 自定义协议 ──────────────────────────────────────────────────
// 背景：
//   打包后无法直接用 file:// 加载页面——file:// 没有 origin，业务代码里所有
//   相对路径（/api/xxx）会被补全为 file:///api/xxx，不走网络，全部失败。
//
// 方案：自定义 app:// 协议作为中间层
//   1. win.loadURL('app://localhost/index.html')
//      → 页面 origin 变为 app://localhost
//      → 相对路径 /api/xxx 补全为 app://localhost/api/xxx
//      → 由 protocol.handle 拦截，业务代码无需修改
//
//   2. protocol.handle 充当反向代理：
//      - 后端路径（/api/、/socket、/uploads/、/avatar/）
//        → 拼接真实后端地址 API_ORIGIN，用 net.fetch 发出真实 HTTP 请求
//        → 转发前删除 Origin 头（原值为 app://localhost，后端 CORS 不认）
//      - 静态资源路径（JS/CSS/图片等）
//        → 从本地 dist 目录读取（file:// 协议）
//
//   3. net.fetch 底层仍是 Chromium C++ 网络栈，DNS/TCP/TLS 由 Chromium 处理，
//      我们只做 URL 映射，无需手动实现任何网络协议。
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

    // ── HLS 片段 → 文件系统 cache-first ──────────────────────────────────
    if (isHlsSegment(request.url)) {
      return handleHlsSegment(request);
    }

    if (isBackendPath) {
      const backendUrl = `${API_ORIGIN}${pathname}${reqUrl.search}`;
      // Origin 头值为 app://localhost，后端 CORS 白名单里没有该 scheme，会直接拒绝。
      // 反向代理的标准做法是不透传浏览器 Origin（nginx 同理），删掉即可。
      // 后端 cors 中间件收不到 Origin 时默认放行，不影响功能。
      const headers = new Headers(request.headers);
      headers.delete('origin');
      // GET / HEAD 不能带 body；有 body 时需要加 duplex: 'half'
      // （Electron net.fetch 底层是 Node.js undici，发送 body 时必须声明此选项；
      //   标准浏览器 fetch 不需要）
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      return net.fetch(backendUrl, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit);
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

  if (!app.isPackaged && !isPreview) {
    // dev 模式：webpack-dev-server 自带 proxy，直接加载 HTTP URL
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    // preview / packaged 模式：通过 app:// 协议加载本地 dist 产物
    win.loadURL('app://localhost/index.html');
    // preview 模式和 packaged 模式都开 DevTools，用于调试打包问题
    if (isPreview) win.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  initHlsCache();
  setApiOrigin(API_ORIGIN);
  setApiOriginForRecorder(API_ORIGIN);
  registerRecorderHandlers();
  registerAppProtocol();
  createWindow();

});
app.on('window-all-closed', () => {
  app.quit();
});

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

// ─── 录制 IPC 处理器已通过 registerRecorderHandlers() 注册（见上方 whenReady）────