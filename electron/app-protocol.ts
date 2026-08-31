import { protocol, net } from 'electron';
import path from 'path';
import { URL } from 'url';
import { isHlsSegment, handleHlsSegment } from './handlers/cache';

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
//        → 拼接真实后端地址 apiOrigin，用 net.fetch 发出真实 HTTP 请求
//        → 转发前删除 Origin 头（原值为 app://localhost，后端 CORS 不认）
//      - 静态资源路径（JS/CSS/图片等）
//        → 从本地 dist 目录读取（file:// 协议）
//
//   3. net.fetch 底层仍是 Chromium C++ 网络栈，DNS/TCP/TLS 由 Chromium 处理，
//      我们只做 URL 映射，无需手动实现任何网络协议。
//
// 注意：registerSchemesAsPrivileged 必须在 app.whenReady() 之前调用。
//       此处在模块加载时即执行（main.ts import 本文件时），早于 whenReady。
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

/**
 * 注册 app:// 协议的请求处理器。需在 app.whenReady() 之后调用。
 * @param apiOrigin 后端真实地址，由 main.ts 统一计算后传入
 */
export function registerAppProtocol(apiOrigin: string): void {
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
      const backendUrl = `${apiOrigin}${pathname}${reqUrl.search}`;
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
