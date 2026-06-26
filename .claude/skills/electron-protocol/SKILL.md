---
name: electron-protocol
description: Electron 自定义协议加载本地产物规范。将已有 Web 项目嵌入 Electron、需要加载本地 dist 产物时激活。覆盖为什么不能用 file://、app:// 协议注册配置、protocol.handle 实现（含 Origin 头清洗、GET body 限制、duplex 选项三个约束）、win.loadURL host 规则、publicPath 必须为 '/'、WebSocket 地址推断（ws:// 不经过 protocol.handle，需 preload + env.ts 解决）。当需要实现 Electron 本地产物加载、编写或修改 protocol.handle、排查 ERR_UNEXPECTED / duplex 错误 / CORS 被拒 / WS 连接失败时激活。
---

# Electron 自定义协议加载本地产物

## ⚠️ 不能用 file:// 加载页面

`file://` 没有 origin，所有相对路径会被补全为 `file:///api/xxx`，不走网络，全部失败。**必须用自定义协议。**

---

## 标准实现模板

### 1. 注册协议（必须在 app.whenReady() 之前调用）

```ts
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,       // 允许相对路径解析（关键，缺少则相对路径不补全）
      secure: true,         // 视为安全源，允许 fetch / XHR / Cookie
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,         // 支持流式响应（m3u8、视频等）
    },
  },
]);
```

### 2. 实现 protocol.handle

```ts
function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const reqUrl = new URL(request.url);
    const pathname = reqUrl.pathname;

    const isBackendPath =
      pathname.startsWith('/api/') ||
      pathname.startsWith('/socket') ||
      pathname.startsWith('/uploads/') ||
      pathname.startsWith('/avatar/');

    if (isBackendPath) {
      const backendUrl = `${API_ORIGIN}${pathname}${reqUrl.search}`;

      // ⚠️ 约束 1：必须删除 Origin 头
      const headers = new Headers(request.headers);
      headers.delete('origin');

      // ⚠️ 约束 2 + 3：GET/HEAD 不传 body；有 body 时加 duplex: 'half'
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      return net.fetch(backendUrl, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit);
    }

    // 静态资源：有扩展名读文件，否则返回 index.html（SPA history 路由兜底）
    const distDir = path.join(__dirname, '../dist');
    const hasExt = path.extname(pathname) !== '';
    return net.fetch(`file://${path.join(distDir, hasExt ? pathname : 'index.html')}`);
  });
}
```

### 3. 加载页面

```ts
// ✅ 正确：host 固定为 localhost，无端口
win.loadURL('app://localhost/index.html');

// ❌ 错误：不能带端口，Chromium 会将端口解析为路径前缀
win.loadURL('app://localhost:3002/index.html');
// 结果：window.location.host === 'localhost'，pathname === '/3002/index.html'
```

---

## net.fetch 三个约束——违反时的报错

| 约束 | ❌ 违反时的报错 | ✅ 修法 |
|---|---|---|
| 删除 `Origin` 头 | DevTools "Provisional headers are shown"，后端 CORS 拒绝 | `headers.delete('origin')` |
| GET/HEAD 不传 body | `net::ERR_UNEXPECTED` | `hasBody` 条件判断 |
| 有 body 时加 `duplex: 'half'` | `TypeError: RequestInit: duplex option is required when sending a body` | `...(hasBody ? { duplex: 'half' } : {})` |

---

## ⚠️ WebSocket 地址推断——protocol.handle 拦截不到 ws://

`protocol.handle` 只拦截以注册 scheme（如 `app://`）发起的请求。WS 连接使用 `ws://` 或 `wss://`，**不经过 protocol.handle，直接走 Chromium 原生 WebSocket 实现**。

**问题根因：**
```
win.loadURL('app://localhost/index.html')
  → window.location.host === 'localhost'（无端口）
  → ws:// + localhost + /socket = ws://localhost/socket（默认 80 端口）
  → 后端在 3002 → ERR_CONNECTION_REFUSED
```

**正确做法——preload 注入 + env.ts 统一暴露，业务代码不感知：**

```ts
// electron/preload.ts
contextBridge.exposeInMainWorld('electronBridge', {
  isElectron: true as const,
  apiOrigin: process.env.ELECTRON_API_ORIGIN || 'http://localhost:3002',
});

// src/utils/env.ts（基础设施层，唯一允许读取 electronBridge 的地方）
export const apiOrigin: string =
  window.electronBridge?.apiOrigin ?? window.location.origin;

// src/hooks/useRoomWs.ts（业务层，不感知 Electron）
import { apiOrigin } from '@/utils/env';
const { protocol: originProtocol, host } = new URL(apiOrigin);
const wsProtocol = originProtocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${host}/socket?...`;
```

**分层原则：**
| 层 | 文件 | 是否感知 Electron |
|---|---|---|
| Electron 层 | `preload.ts` | ✅ 职责所在 |
| 基础设施层 | `src/utils/env.ts` | ✅ 允许，屏蔽平台差异 |
| 业务层 | hooks / pages | ❌ 不感知 |

---

## ⚠️ webpack publicPath 必须为 '/'

```js
// webpack.electron-renderer.js
output: { publicPath: '/' }  // ✅ 正确
output: { publicPath: './' } // ❌ 错误
```

`app://` 注册了 `standard: true`，Chromium 将其视为标准协议，绝对路径 `/bundle.js` 会被正确解析为 `app://localhost/bundle.js`。

用 `'./'` 的后果：图片等资源 URL 变成相对路径，在 `/room/2XWEVD/` 路由下被拼接为 `/room/2XWEVD/8815f2f....webp`，全部 404。

---

## ⚠️ protocol.handle 内部不能对 app:// URL 调用 net.fetch

`protocol.handle` 处理函数内的所有 `net.fetch` 调用，**必须使用 `http://` / `https://` / `file://` 协议 URL**，绝不能使用当前注册的自定义 scheme（`app://`）。

```ts
protocol.handle('app', async (request) => {
  // ❌ 无限递归：net.fetch(app://...) 再次触发 protocol.handle → SIGTRAP 崩溃
  const response = await net.fetch(request.url);

  // ✅ 替换为真实地址再 fetch
  const realUrl = request.url.replace(/^app:\/\/[^/]+/, API_ORIGIN);
  const response = await net.fetch(realUrl, { headers: request.headers });
});
```

崩溃现象是进程以 `SIGTRAP` 退出，无明显 JS 报错，不容易定位根因。记住这条规律即可避免。

---

## 不适用场景

- **Service Worker**：`app://` 不在 SW 支持的协议白名单，注册直接失败。Electron 环境需跳过 SW 注册逻辑。
- **新项目**：优先选 electron-vite / electron-forge，上述所有约束均已被社区处理。
