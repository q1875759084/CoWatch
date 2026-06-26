# Electron 开发踩坑记录

---

## 踩坑记录

### 编译时常量 `__IS_DEV__` 语义混用

**现象：** 本地执行 `electron:pack:mac` 打包后，双击 .dmg 运行，应用仍尝试连接 `localhost:3001`（dev server）而非加载本地 dist 产物。

**根因：** `__IS_DEV__` 由 `webpack.electron.js` 的 `DefinePlugin` 在编译时注入，值取决于 `DEPLOY_ENV` 是否存在。本地打包没有 CI 环境，`DEPLOY_ENV` 为空，导致 `__IS_DEV__=true`，打包产物里仍走 `loadURL(devServerUrl)` 分支。同一个常量同时承担了"webpack mode"和"是否连 dev server"两个语义，本地打包时两者冲突。

**解决：** 删除 `__IS_DEV__` 常量，改用 Electron 内置的运行时属性 `app.isPackaged`：
- `electron .` 直接运行 → `app.isPackaged === false` → 连 dev server
- 打包后运行 → `app.isPackaged === true` → 加载本地 dist

不依赖任何编译时注入，本地打包和 CI 打包行为完全一致。

---

### webpack 数组配置并行编译时 `clean: true` 导致产物互删

**现象：** `electron:pack:mac` 报错 `Application entry file "dist-electron/main.js" does not exist`，但 webpack 编译日志显示 `main.ts` 编译成功。检查 `dist-electron/` 目录，只有 `preload.js`，`main.js` 消失。

**根因：** `webpack.electron.js` 导出数组配置（`[preloadConfig, mainConfig]`），webpack 并行运行两个 compiler。`preloadConfig` 设置了 `clean: true`，其触发时机不确定——可能在 `mainConfig` 输出 `main.js` 之后才执行清理，把 `main.js` 删除。

**解决：** 两个 config 均设 `clean: false`，在配置文件顶层用 `fs.rmSync` 同步清理输出目录，早于任何 compiler 启动前执行，保证时序：

```js
const outDir = path.resolve(__dirname, 'dist-electron');
fs.rmSync(outDir, { recursive: true, force: true });
```

---

### macOS 打包 DMG 需要 python，且版本有限制

**现象：** `electron:pack:mac` 报错 `Exit code: 1. Command failed: which python`，随后改用 python3.14 后报 `ImportError: Symbol not found: _XML_SetAllocTrackerActivationThreshold`。

**根因：** `dmg-builder` 依赖一个 Python 脚本（`dmgbuild/core.py`）生成 DMG 格式，这是 macOS 打包特有的依赖，Windows 打包（NSIS）无此问题。macOS 新系统只提供 `python3` 命令，没有 `python` 软链接。Python 3.14 与 macOS 系统 `libexpat` 存在符号不兼容（`_XML_SetAllocTrackerActivationThreshold` 未找到）。

**解决：** 将 `python` 软链接指向 Python 3.9：
```bash
ln -sf /opt/homebrew/bin/python3.9 /opt/homebrew/bin/python
```
不能用 3.14（libexpat 符号冲突），用系统 `python3.9` 或 Homebrew 的 `python@3.9` 均可。

---

### Electron 加载本地产物时相对路径 API/WS/静态资源请求失效

**现象：** Electron 下登录请求变为 `file:///api/auth/login`，DevTools 显示 "Provisional headers are shown"，请求未发出。WS 因 `window.location.host` 为空拼成 `ws:///socket`。头像等静态资源被解析为 `file:///avatar/...`，全部 404。

**根因：** 相对路径补全依赖页面 origin。Web 下 `/api` → `https://cowatch.daibao.site/api`，正确。`file://` 没有 origin，`/api` → `file:///api`，不走网络。

**最终解法：** 用 Electron 自定义协议 `app://` 替代 `file://` 加载页面，在 Main 进程 `protocol.handle` 里统一拦截转发，业务代码零修改：

```ts
// win.loadURL host 固定为 localhost（无端口），app:// 自定义协议不支持带端口的 host
win.loadURL('app://localhost/index.html');

protocol.handle('app', async (request) => {
  const reqUrl = new URL(request.url);
  const pathname = reqUrl.pathname;

  if (isBackendPath(pathname)) {
    const headers = new Headers(request.headers);
    // 删除 Origin 头：原值 app://localhost 不在后端 CORS 白名单，会被拒绝
    // 反向代理标准做法是不透传浏览器 Origin（nginx 同理）
    headers.delete('origin');
    // GET/HEAD 不能带 body；有 body 时必须加 duplex: 'half'
    // （Node.js undici 规范要求，标准浏览器 fetch 不需要）
    const hasBody = method !== 'GET' && method !== 'HEAD';
    return net.fetch(`${API_ORIGIN}${pathname}${reqUrl.search}`, {
      method, headers,
      body: hasBody ? request.body : undefined,
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  }
  // 有扩展名 → 本地 dist 文件；否则 → index.html（SPA 路由兜底）
  return net.fetch(`file://${distDir}${hasExt ? pathname : '/index.html'}`);
});
```

**废弃方案：** 用 `DefinePlugin` 注入 `__IS_ELECTRON__` / `__ELECTRON_API_ORIGIN__`，在 `request.ts`、`useRoomWs.ts`、各 API 文件里条件切换 URL。每新增一个相对路径就要改一次，业务层感知运行环境，违反分层原则，代码快速腐化。

**`API_ORIGIN` 注入时机：** Main 进程运行时通过 `process.env.ELECTRON_API_ORIGIN` 读取（不是编译时），本地默认 `http://localhost:3002`，发布时由启动命令传入。

**webpack publicPath 必须为 `/`：** `webpack.electron-renderer.js` 里 `output.publicPath` 必须设为 `'/'`，不能用 `'./'`。`app://` 注册了 `standard: true`，Chromium 视其为标准协议，绝对路径 `/bundle.js` 会被正确解析为 `app://localhost/bundle.js`。用 `'./'` 会导致图片等资源 URL 变为相对路径，在 `/room/2XWEVD/` 路由下被拼接为 `/room/2XWEVD/hash.webp`，全部 404。

**net.fetch 转发的三个约束（均为 Node.js undici 与 HTTP 规范要求）：**

1. **删除 `Origin` 头**：`net.fetch` 默认原样透传 `Origin: app://localhost`，后端 CORS 白名单里没有该 scheme 会直接拒绝（DevTools 显示 "Provisional headers are shown"）。删掉后，后端 cors 中间件收不到 Origin 时默认放行。
2. **GET / HEAD 不传 body**：HTTP 规范不允许 GET/HEAD 带 body，`net.fetch` 遇到时抛 `ERR_UNEXPECTED`。需判断方法后条件传入。
3. **有 body 时加 `duplex: 'half'`**：Electron 内部使用 Node.js `undici` 实现 fetch，发送带 body 的请求（POST/PUT/PATCH）时必须显式声明该选项，否则抛 `TypeError: RequestInit: duplex option is required when sending a body`。标准浏览器 fetch 不需要此选项。

---

### build 模式出错无法调试 + dev 无法模拟 file:// 行为

**现象：** 打包后运行出错，没有 DevTools，无法定位问题。`electron:dev` 走 `http://localhost:3001`，无法复现 `file://` 协议下的资源加载问题（如 `publicPath` 错误、SW 注册路径变化等）。

**根因：** 最初只设计了两种模式（dev 连 dev server / packaged 加载 dist），缺少"本地构建产物 + DevTools"的中间态。

**解决：** 新增 `electron:preview` 模式，三个分支通过运行时属性区分，不依赖编译时注入：

| 模式 | 触发条件 | 加载方式 | DevTools |
|------|---------|---------|---------|
| dev | `app.isPackaged=false` 且无 `ELECTRON_PREVIEW` | `http://localhost:3001` | ✅ |
| preview | `app.isPackaged=false` 且 `ELECTRON_PREVIEW=true` | `app://<apiHost>/index.html` | ✅ |
| packaged | `app.isPackaged=true` | `app://<apiHost>/index.html` | ❌ |

```bash
# 运行 preview 模式
npm run electron:preview
# 等价于：npm run electron:build && cross-env ELECTRON_PREVIEW=true electron .
```

这是 Electron 开发的标准实践，electron-vite / electron-forge 模板均有此模式，应在工程搭建初期就设计好。

---

### `protocol.handle` 内部调用 `net.fetch` 传入 `app://` URL 导致无限递归崩溃

**现象：** Electron 启动后进程因 `SIGTRAP` 崩溃退出，页面无法加载，视频始终在转圈。无明显 JS 报错，只有系统级 `SIGTRAP` 信号。

**根因：** 在 `protocol.handle('app', ...)` 的处理函数内部，对 `app://` 协议的 URL 调用 `net.fetch(request.url)`。`net.fetch` 触发的请求同样走 `app://` scheme，再次进入 `protocol.handle`，产生无限递归，进程栈溢出后以 `SIGTRAP` 崩溃。

典型错误场景：

```ts
protocol.handle('app', async (request) => {
  // ❌ request.url 是 app://localhost/uploads/cowatch/seg001.ts
  // net.fetch 会再次触发 protocol.handle → 无限递归
  const response = await net.fetch(request.url);
});
```

**解决：** 在 `protocol.handle` 内部，凡是需要向后端或 CDN 发起真实网络请求，必须先将 `app://` 前缀替换为真实地址：

```ts
// ✅ 替换为真实后端地址，net.fetch 走 http://，不再触发 protocol.handle
const realUrl = request.url.replace(/^app:\/\/[^/]+/, API_ORIGIN);
const response = await net.fetch(realUrl, { headers: request.headers });
```

**规律：** `protocol.handle` 处理函数内，所有对外的 `net.fetch` 调用必须使用 `http://` / `https://` / `file://` 协议 URL，绝不能使用当前注册的自定义 scheme（`app://`）。

---

## 架构决策

### Electron 环境差异应在 Main 进程边界处理，不应渗透业务代码

**背景：** 将 Web 应用嵌入 Electron 时，会遇到一系列"Web 假设"失效的问题（`file://` 无 origin、`window.location.host` 为空、WS 推断错误、静态资源 404 等）。容易的做法是在每个出问题的地方加 `if (isElectron)` 判断，用编译时常量或运行时变量分支处理。

**为什么这是错的：** 业务代码的职责是描述业务逻辑，不是管理运行环境。每让一处业务代码感知 Electron，就埋下一个"下次有新业务代码时要记得再加判断"的隐患，代码会持续腐化。

**正确边界：** Electron 环境的适配应完全封装在 Main 进程层，Renderer（业务代码）完全不知道自己跑在哪里：

```
Renderer（React 业务代码）
  → 发请求 /api/xxx，跟 Web 完全一样
  ↓
Main 进程（Electron 层）
  → protocol.handle 拦截 app:// 请求，按路径分发：
      后端路径 → net.fetch 转发到真实后端
      前端路径 → net.fetch 读本地 dist 文件
```

**实现要点：**
1. `protocol.registerSchemesAsPrivileged` 赋予 `app://` 与 `https://` 相同的安全权限
2. `app://` 的 host 取自后端真实地址（`API_ORIGIN`），令 `window.location.host` 天然等于后端 host
3. `API_ORIGIN` 由 Main 进程运行时读取（`process.env`），不是 Renderer 编译时注入

**推论：** webpack 配置里不应出现 `__IS_ELECTRON__` 之类注入到 Renderer 的环境标识常量。如果发现业务代码里有环境判断，说明有东西该移到 Main 进程。

**例外——WebSocket：** `ws://` 不经过 `protocol.handle`，无法在 Main 进程拦截。`app://localhost` 的 host 不含端口，`window.location.host === 'localhost'`，WS 地址推断会拼出 `ws://localhost/socket`（默认 80 端口），连接失败。解法是 preload 注入 `apiOrigin` → `src/utils/env.ts` 统一暴露 → 业务 hook import，业务层仍不感知 Electron。`src/utils/env.ts` 是唯一允许读取 `window.electronBridge` 的地方。

---

### 从零搭 Electron 工程 vs 用脚手架的选型

**背景：** 将已有 Web 项目嵌入 Electron 时，有两条路：

**路线 A：electron-vite / electron-forge 等脚手架**
- 开箱内置自定义协议、dev/preview/pack 三模式、HMR、代码分割等
- 本文档里所有踩坑（`Origin` 头、GET body、`duplex`、webpack 并行清理……）均已被社区处理，不会遇到
- 新项目应优先选择

**路线 B：从零手写（本项目的选择）**
- 完全手动控制 webpack + protocol + 打包配置
- 上述坑全部需要自己踩，且几乎在官方文档里找不到，只能运行时发现
- **适用场景**：项目已有成熟的 webpack 体系，迁移到脚手架的改动成本高于手写适配代码
- **代价兜底**：踩过的坑写进 dev-notes，后续不重复踩

---

## 工具与概念

### Electron 自定义协议（`app://`）与 Chromium 的关系

**背景：** Electron 内嵌了完整的 Chromium 引擎，本质上就是一个可编程的浏览器。真实浏览器的 `http://`、`https://`、`file://` 等协议是在 Chromium 内核的协议注册表里预置的，Electron 主进程可以通过 API 向同一张注册表写入自定义条目。

**类比：**

| | 真实浏览器 | Electron |
|---|---|---|
| 引擎 | Chromium | Chromium（内嵌同一引擎）|
| 内置协议 | `http://`、`https://`、`file://` | 相同，均有 |
| 自定义协议 | 普通网页无法自定义 | 主进程可注册任意 scheme |
| 协议处理函数 | 操作系统网络栈 / DNS / TCP | `protocol.handle('app', fn)` |

**完整请求流程对比：**

```
── 真实浏览器（https）──────────────────────────────────────────
  fetch('/api/login')
    → 页面 origin 是 https://example.com
    → 补全为 https://example.com/api/login
    → Chromium 内置 https handler（C++ 网络栈）
        → DNS 解析 example.com → IP
        → TCP 三次握手
        → TLS 握手
        → HTTP 请求/响应
    → 页面拿到响应

── 我们的 Electron（app://）─────────────────────────────────────
  fetch('/api/login')
    → 页面 origin 是 app://localhost（因为 loadURL('app://localhost/index.html')）
    → 补全为 app://localhost/api/login
    → 我们写的 protocol.handle('app', fn) 接管（不走 DNS/TCP）
        → fn 判断 pathname 是后端路径
        → 调用 net.fetch('http://localhost:3002/api/login')
            → net.fetch 底层还是 Chromium C++ 网络栈
            → DNS → TCP → HTTP（Chromium 帮做，我们不碰）
        → 把真实响应包成 Response 对象返回给页面
    → 页面拿到响应
```

**关键点——`net.fetch` 不需要手动实现握手：**
handler 函数内部调用的是 Electron 提供的 `net.fetch()`，底层仍是 Chromium 网络栈。三次握手、TLS 全由 Chromium 处理，我们只做了一件事：**把虚假 URL `app://localhost/api/login` 映射到真实 URL `http://localhost:3002/api/login`**。

**相对路径补全的本质：**
`fetch('/api/xxx')` 中的相对路径由浏览器（Chromium）根据**当前页面 origin** 补全，不是补 `http`，而是补"当前协议 + host"。
- 页面在 `https://cowatch.daibao.site` → `/api/xxx` → `https://cowatch.daibao.site/api/xxx`
- 页面在 `app://localhost` → `/api/xxx` → `app://localhost/api/xxx` → 走 handler

这是"业务代码用相对路径写死、Electron 层用 protocol 拦截"方案得以工作的基础。

**与 nginx 反向代理的类比：** `protocol.handle` 函数承担的角色和 nginx 的 `location` 块完全相同——根据路径决定将请求代理到哪里。区别在于 nginx 运行在操作系统网络层，`protocol.handle` 运行在 Electron 主进程的 JS 层。

**CORS 含义：** Chromium 的 CORS 机制基于 Origin（协议 + 域名 + 端口）。自定义协议 `app://localhost` 是一个独立的 Origin，与 `http://localhost:3001` 完全不同。`net.fetch` 转发请求时如果原样携带 `Origin: app://localhost`，后端 CORS 白名单里没有这个值，请求被拒绝（DevTools 显示 "Provisional headers are shown"）。修复方式：在 `net.fetch` 调用前从请求头里删除 `Origin`，让后端看不到 `app://` 来源。

---

### DevTools Network 面板的观测层位

**背景：** 在 `protocol.handle` 里实现了 HLS 片段的 `cache-first`（命中时 `net.fetch('file://...')`，未命中时 `net.fetch('http://...')`），验证时发现：无论是否命中缓存，DevTools Network 面板里该请求都显示为 `app://localhost/uploads/.../seg001.ts 200`，无法直接区分。

**根因：** DevTools Network 面板的观测点在**渲染进程**与 `protocol.handle` 之间，记录的是"渲染进程认为自己发出了什么请求"，对 `protocol.handle` 内部的实际行为一无所知。

```
渲染进程（Chromium）
  └─ 发出请求: app://localhost/uploads/.../seg001.ts
       ↓
  ← DevTools Network 在此处观测 →
       ↓
主进程 protocol.handle('app', handler)
  ├─ HIT → net.fetch('file:///hls-cache/seg001.ts')   ← 零网络 I/O，Network 面板不可见
  └─ MISS → net.fetch('http://localhost:3002/...')     ← 真实网络请求，Network 面板不可见
```

两条路径对渲染进程都是透明的 `app://` 200 响应，Response Headers 也是由 `net.fetch` 返回的（命中时是 `file://` 的头，未命中时是后端真实头），但渲染进程无法感知来源。

**结论：在 `protocol.handle` 内部是否命中缓存，无法通过 DevTools Network 面板判断，唯一方式是在 `protocol.handle` 内部打 `console.log`。**

```ts
// 临时验证用，确认缓存生效后删除
if (fs.existsSync(filePath)) {
  console.log('[cache] HIT ', path.basename(filePath));  // 在主进程 Terminal 里可见
  return net.fetch(`file://${filePath}`);
}
console.log('[cache] MISS', path.basename(filePath));
```

**WS 是例外：** `ws://` 不经过 `protocol.handle`，直接走 Chromium 原生 WebSocket 实现，Network 面板里的 WS 连接是真实的，状态反映真实网络行为。
