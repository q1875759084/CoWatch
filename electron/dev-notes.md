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

### Windows 游戏录制屏幕捕获 API 选型

**背景：** CoWatch 录制功能需要捕获游戏窗口并输出 HLS 切片。Windows 上存在多种捕获 API，选型直接影响游戏性能和录制兼容性。

**三类方案对比：**

| 方案 | CPU 开销 | GPU stall | 独占全屏 | 切片格式 | 代码改动 |
|------|:--------:|:---------:|:--------:|:--------:|:--------:|
| `gdigrab`（当前已放弃） | 高（软编）/中（硬编） | ⚠️ 有（BitBlt 同步） | ❌ 黑屏 | 直出 `.ts` | 最小 |
| `ddagrab`（最终选择） | ≈0%（GPU 零拷贝） | ✅ 无 | ✅ | 直出 `.ts` | 小（仅换 ffmpeg） |
| `MediaRecorder`（备选） | 低 | ✅ 无（WGC API） | ✅ | WebM（需改后端） | 大（重写管道） |

**gdigrab 放弃原因：**
- BitBlt 是同步 GDI 调用，强制 GPU pipeline flush，与编码器类型无关，硬编下依然卡顿
- 窗口模式对独占全屏游戏 100% 黑屏（DWM 被绕过）

**ddagrab 选型理由：**
- GPU 异步读取已完成帧副本，零 CPU 开销，不阻塞游戏渲染管线
- 窗口模式通过 DDA API 锁定窗口句柄而非标题字符串，更可靠
- 代码已就绪，只需替换 ffmpeg 二进制（ffmpeg-static 不含 ddagrab，需自编译）
- 分发时 `d3d11.dll`/`dxgi.dll` 是 Win10/11 标准系统组件，无需随包携带

**MediaRecorder 放弃原因：**
- 输出 WebM 容器，不是 `.ts`，HLS 播放链路（后端 generateM3u8 + 切片存储）全部要改
- `ondataavailable` 切片边界不保证关键帧，切片衔接可能花屏
- Renderer→Main 进程大量 IPC 传输（raw frames ≈250MB/s）性能极差；走 MediaRecorder 切片也要改后端

**独占全屏黑屏处理策略（对标 OBS）：**
- 独占全屏（DX12/Vulkan 接管 GPU）：即使 ddagrab 也可能失败，直接放弃，提示用户切无边框模式
- 无边框全屏（现代游戏默认）：ddagrab 完全兼容
- 全屏优化（FSE）：ddagrab 可捕获

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

### Windows 全屏模式分类与捕获 API 能力对照

**背景：** Windows 游戏有三种全屏模式，与屏幕捕获 API 的兼容性截然不同，是游戏录制选型的核心知识点。

| 模式 | 原理 | GDI BitBlt（gdigrab） | DXGI DDA（ddagrab/WGC） | 典型场景 |
|------|------|-----------------------|------------------------|---------|
| **独占全屏（Exclusive）** | GPU 直接输出到显示器，完全绕过 DWM | ❌ 黑屏 | ⚠️ DX11 可以，DX12 可能失败 | 老游戏、部分竞技游戏 |
| **无边框窗口全屏（Borderless Windowed）** | 仍是窗口，DWM 参与合成 | ✅（整屏模式） | ✅ | **现代游戏默认（LOL、Valorant、原神等）** |
| **全屏优化（FSO/FSE）** | Win10 引入，游戏认为自己独占但 DWM 仍在后台 | ⚠️ 不稳定 | ✅ | Win10/11 下大多数游戏 |

**关键推论：**
- `desktopCapturer`（Electron 用于获取窗口列表）底层用 WGC，能看到独占全屏窗口的缩略图，但 gdigrab 实际录制时黑屏——这导致 WindowPicker 里显示了游戏截图，用户选择后却录到黑屏，体验极差。
- 现代游戏（2020 年后发布）绝大多数默认无边框全屏，真正独占全屏的情况已越来越少。
- OBS 的处理策略：默认用 DXGI/WGC，遇到独占全屏弹窗提示用户切换无边框模式，不强制解决。CoWatch 采用相同策略。

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

---

## 踩坑记录

### HLS 切片 CDN 直链在 Electron 下跨域报错

**现象：** Electron preview 模式连接线上后端，hls.js 请求 m3u8 成功，但每个 `.ts` 切片请求均失败（DevTools 显示 CORS 错误），视频无法播放。后端 m3u8 内容里写的是完整 CDN 签名 URL（`https://cdn.cowatch.daibao.site/cowatch/...seg000.ts?sign=...`）。

**根因：** hls.js 在渲染进程里直接发出对 CDN 绝对 URL 的 HTTP 请求，该请求不经过 `protocol.handle`（只拦截 `app://` scheme），而是由 Chromium 直接发到 CDN。此时请求 Origin 为 `app://localhost`，CDN 不在 CORS 白名单里，preflight OPTIONS 被 CDN 拒绝。

**三种修复方案对比：**

| 方案 | 改动位置 | 代价 |
|------|---------|------|
| CDN 加 CORS 头 | CDN 控制台 | 最小，但需处理防盗链规则冲突，且 OPTIONS 请求本身会被访问控制逻辑拦截 |
| m3u8 改为相对路径 + 后端 segment 接口 | 后端 hlsService.ts + 新增接口 | 中等，架构更干净，Web/Electron 统一（**最终选择**） |
| Electron 层拦截 m3u8 响应替换 URL | cache.ts | 改动最小，但逻辑放在 Electron 层不够清晰 |

**解决（方案2——后端 segment 代理接口）：**

m3u8 切片 URL 改为后端相对路径：
```
/api/rooms/{roomId}/videos/{videoId}/segments/{segmentName}.ts
```

后端新增 `GET /:roomId/videos/:videoId/segments/:segmentName` 接口：鉴权通过后 302 重定向到 CDN 签名 URL（线上）或 `/uploads/...`（本地）。渲染进程请求该相对路径 → `app://localhost/api/rooms/...` → `protocol.handle` → 后端代理 → 302 → CDN，整个路径全程在 `app://` 内，无跨域。

**为什么当初的设计是合理的：** 原设计针对纯 Web 端——hls.js 直连 CDN 是行业主流做法（Netflix、B 站均类似架构），后端不参与切片传输，省带宽，SW 做 cache-first 二次播放零流量。Electron 的 `app://` 带来了新的 CORS 约束，是加入 Electron 后才出现的新需求，原设计没有义务提前考虑。

---

### 架构决策

### HLS 切片应通过后端代理路径分发，不直接在 m3u8 中暴露 CDN 签名 URL

**背景：** 评估 HLS 分发架构时有两种选择：①切片 URL 直接写 CDN 签名地址；②切片 URL 写后端代理路径，后端鉴权后 302 到 CDN。

**结论：** 选方案②——m3u8 切片 URL 统一为 `/api/rooms/.../segments/seg000.ts`，后端接口完成鉴权 + 302。

**方案②在纯 Web 端的影响分析：**

- **带宽**：后端只做鉴权 + 302，不传输视频数据，服务器带宽不受影响
- **延迟**：每个切片多一次 HTTP 302 跳转（~10~50ms），hls.js 有预加载机制，用户无感知
- **安全性提升**：切片访问需要有效登录态（JWT），比纯 URL 签名更标准——签名 URL 可被任意人复制在有效期内使用
- **SW cache key 简化**：cache key 变为 `/api/rooms/.../segments/seg000.ts`，无签名参数，不再需要 `stripSignature` 逻辑（当前代码保留为向下兼容，新格式实际上无需剥离）
- **Electron 兼容**：切片请求走 `app://` → `protocol.handle` → 后端，完全规避跨域

**通用原则：** 今后凡是需要从 CDN 获取鉴权资源（视频、音频等），默认用后端代理路径而非直接写 CDN 绝对 URL，以保证 Web/Electron 行为一致，兼顾可扩展性。

---

### ffmpeg 停止后尾片（最后一段 HLS 切片）丢失

**现象：** 点击"停止录制"后，录制结果缺少最后几秒内容——最后一个 `.ts` 切片（通常不足 `hls_time` = 10s）未上传到服务端。

**根因：** `stop()` 流程先关闭 chokidar watcher，再向 ffmpeg 发 `SIGTERM`。ffmpeg 收到信号后仍会继续将内存帧 flush 写入磁盘（可能需要数秒），但 watcher 已经关闭，新写入的切片无法触发 `add` 事件，无法进入上传队列。

**解决：** ffmpeg 进程彻底退出（`close` 事件）后，执行一次手动目录扫描：
```ts
const files = fs.readdirSync(sessionTmpDir).filter(f => f.endsWith('.ts'));
for (const f of files) {
  if (!queuedFileNames.has(f)) {
    // 补入上传队列
    uploadSegment(path.join(sessionTmpDir, f), ...);
  }
}
```
通过 `queuedFileNames` Set 去重，避免重复上传 watcher 已处理的切片。

---

### generateM3u8 最后一片 #EXTINF 硬编码导致短录制时长显示错误

**现象：** Electron 录制 3~13 秒的视频（只有 1 个切片），后端生成的 m3u8 里写 `#EXTINF:10.000000`，播放器据此计算总时长为 10s，但实际视频流只有几秒，进度条和时长均显示异常。

**根因：** `generateM3u8` 对所有切片一律写固定值 `HLS_SEGMENT_DURATION=10`，没有区分录制型视频（最后一片可能不足 10s）和普通上传视频。

**解决：**
1. 新增 `migrations/004_video_duration.sql`：为 `room_videos` 表加 `duration_seconds INTEGER` 字段（nullable，不影响旧数据）
2. `recordingFinish` 接口写入 `durationSeconds` 到 DB
3. `generateM3u8` 当 `video.duration_seconds` 有值时，最后一片 `#EXTINF` 改为 `totalDuration - 10 × (n-1)`

旧视频和手动上传视频 `duration_seconds` 为 NULL，走原有逻辑，完全向后兼容。

---

### Windows gdigrab 窗口录制黑屏 + 任意录制模式下游戏卡顿

**现象：** Windows 下选择游戏窗口录制，ffmpeg 不报错但录制内容全为黑屏。改为整屏录制可以捕获到画面，但游戏出现明显卡顿——即使编码器检测为硬编（h264_nvenc/qsv），未降级到 480p，卡顿依然存在。

**根因（两个独立问题）：**

1. **黑屏**：`gdigrab -i title=窗口名` 使用 GDI BitBlt，依赖 DWM（Desktop Window Manager）合成层。游戏进入独占全屏后直接接管 GPU 输出，绕过 DWM，GDI 读到的 framebuffer 没有游戏内容，返回黑帧。整屏模式（`-i desktop`）内部切换为 DXGI，可以绕过此限制，但窗口选择场景无解。

2. **硬编下依然卡顿**：BitBlt 是同步调用，执行时必须等 GPU 完成当前帧写入 framebuffer（GPU pipeline flush）。这在渲染管线中插入了一个同步等待点，导致游戏帧提交被短暂阻塞，表现为微卡顿。这与 CPU 编码负担无关，硬编消除了编码开销但消除不了捕获层的 GPU stall。

**最终解决方案：两种场景分别使用不同的 GPU 零拷贝 filter**

gdigrab 整体废弃，改为 ddagrab + gfxcapture。两者均为 ffmpeg **filter**（非 input device），必须通过 `-f lavfi -i '...'` 语法驱动，不能用 `-f ddagrab`。

**全屏录制 → `ddagrab`（Desktop Duplication API / DXGI）**

```
-f lavfi -i 'ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra,scale=w=min(iw\,1600):h=-2,format=yuv420p'
```

- `output_idx`：显示器序号（0 = 主屏）
- `hwdownload,format=bgra`：将 GPU 帧转为 CPU 可见的 BGRA 格式
- `scale=w='min(iw,W)':h=-2`：等比缩放，限制最大宽度，`-2` 保证高度为偶数（H.264 要求）；**不能用 `-s W×H`**，`-s` 对 lavfi filter graph 输出无效
- 兼容性：Windows 8.1+ / Win10 1803+，DX11 显卡

**窗口录制 → `gfxcapture`（Windows.Graphics.Capture API / WGC）**

```
-f lavfi -i 'gfxcapture=window_title=<窗口标题正则>:max_framerate=30,fps=30,hwdownload,format=bgra,scale=...,format=yuv420p'
```

- `window_title`：正则匹配，中文等特殊字符需转义（`displayTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`）
- `fps=30`：WGC 帧率由 DWM 决定，不是严格等间隔，**必须加 `fps=30` 重新生成 PTS**，否则编码器时间戳错误，视频表现为轻微卡顿
- 兼容性：Windows 10 1803+

**关于 ffmpeg 二进制：**

`ffmpeg-static` npm 包**不含** ddagrab/gfxcapture filter。需从 [gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/) 下载 `ffmpeg-release-full.7z`，解压取 `bin/ffmpeg.exe` 放入 `electron/bin/`，无需自编译。`electron-builder.yml` 的 `extraResources` 配置会将其打包到 `resources/bin/`。

**gdigrab 时代参数备忘（对照参考）：**

```
整屏：-f gdigrab -framerate 30 -i desktop
窗口：-f gdigrab -framerate 30 -i title=<窗口标题>
缩放：-s 1600x900（独立参数，对 lavfi 无效，切换到 ddagrab 后必须改为 filter 内 scale）
```

gdigrab 在 f23a95c 提交时通过 Windows 真机测试，录制画质/帧率均正常，可作为回退基准对比。

---

### Windows 录制音频方案选型与实现

**背景：** CoWatch 录制功能最初仅捕获视频，无音频。需要支持：a) 录制用户当时听到的全部系统声音；b) 可选同时录制麦克风输入。

**核心挑战：** ddagrab（全屏）和 gfxcapture（窗口）均为纯视频 filter，需要分别搭配不同的音频输入源，且混流时流索引不同。

**各场景音频方案：**

| 场景 | 视频来源 | 系统音频来源 | 麦克风混入 |
|------|---------|------------|---------|
| 全屏（ddagrab） | lavfi 输入 0（仅 0:v） | `-f wasapi -loopback true -i default`（输入 1:a） | `-f dshow -i audio=...`（输入 2:a） |
| 窗口（gfxcapture） | lavfi 输入 0（0:v + 0:a） | `capture_audio=1` 参数内嵌，无需额外输入源 | `-f dshow -i audio=...`（输入 1:a） |

**amix 混流流索引差异（重要）：**

```
全屏 + 麦克风：-filter_complex '[1:a][2:a]amix=inputs=2:normalize=0[amix]'
窗口 + 麦克风：-filter_complex '[0:a][1:a]amix=inputs=2:normalize=0[amix]'
```

两者写法相同但流索引不同，必须按 `sourceId.startsWith('screen:')` 分支处理，不能用统一写法。

**WASAPI 可用性探测：**

```ts
// -list_devices true 会向 stderr 输出设备列表后以非零码退出（属正常行为）
// 只要 stderr 含 [wasapi] 字样即判定可用
spawn(ffmpeg, ['-f', 'wasapi', '-list_devices', 'true', '-i', 'dummy'])
```

探测在 `detectEncoder` 完成后顺带执行，结果通过 `EncoderDetectResult.isAudioAvailable` 返回给前端，Windows 10+ 通常均可用（极少数无声卡或远程桌面场景返回 false），探测加 5s 超时保护。

**UI 设计：**
- `WindowPicker` 底部加两个 Checkbox：「录制系统声音」（默认勾选）和「同时录制麦克风输入」（依赖前者开启）
- `isAudioAvailable=false` 时 Checkbox 置灰，Tooltip 说明原因
- `AudioOptions` 类型从 Renderer 透传到主进程 `start()`，crash 重启时通过 `currentAudioOptions` 模块变量复用

**无音频时加 `-an`：** 用户未勾选系统声音时，显式加 `-an` 参数，避免 HLS muxer 因无音频流输出警告。

---

### 主进程异步清理时模块变量已被重置（竞态陷阱）

**现象：** 偶发：第二次录制开始后，第一次录制的临时目录 `tmp/cowatch-rec/<sessionId-1>/` 未被清理，残留在磁盘。日志显示 `fs.rm` 回调里 `tmpDir` 为空字符串。

**根因：** `stop()` 结束时调用 `fs.rm(tmpDir, ...)` 异步删除临时目录，随后立即将模块变量 `tmpDir = ''` 重置。当用户在清理完成前就开始第二次录制时，`start()` 会将 `tmpDir` 设为新路径；`fs.rm` 的回调执行时读到的是新路径，原本该删的目录被跳过。

**解决：** `stop()` 入口处用局部常量固定当前路径，后续所有异步操作引用该常量，不读模块变量：
```ts
async function stop(...) {
  const sessionTmpDir = tmpDir;  // 固定当前会话路径
  tmpDir = '';                   // 立即重置模块变量，不影响 sessionTmpDir

  // ...所有后续操作（上传、清理）均用 sessionTmpDir...
  fs.rm(sessionTmpDir, { recursive: true, force: true }, () => {});
}
```
这是 Node.js 异步代码的通用陷阱：**模块级变量在异步操作期间可能已被外部修改**，凡是需要跨异步边界保持语义不变的状态，必须在进入异步前复制到局部变量。

---

### 外部视频转码：架构决策记录

**背景：** 桌面端内置 ffmpeg，自带录屏软件的用户可以直接客户端转码上传，跳过 Web 端的"下载 .bat → 手动转码 → 上传整段 MP4"流程。

**编码参数选择（与 .bat 对照）：**

| 参数 | .bat（libx264 only） | Electron（硬件优先） | 决策理由 |
|------|---------------------|---------------------|---------|
| 编码器 | `libx264` | NVENC > QSV > AMF > libx264 | 桌面端有 GPU，5–10x 加速 |
| 质量 | `-crf 30` | 硬编 `-cq 30` / 软编 `-crf 30` | 对齐转码层 |
| GOP | `-g 300 -keyint_min 300 -sc_threshold 0` | 仅 `-g 300` | 后端不依赖等长 GOP，场景检测提升 5–10% 压缩 |
| B 帧 | `b-adapt=0`（veryfast 默认） | 软编 `b-adapt=1` / 硬编 `-bf 2` | 自适应 B 帧节省 15–20% 码率 |
| Preset | `veryfast` | `medium` / NVENC `p5` | 桌面端有 GPU，时间换空间 |
| 音频 | `-c:a aac -b:a 128k`（重编码） | 同 .bat | 输入来源不可控，重编码保证兼容 |
| 输出格式 | MP4 + `-movflags faststart` | HLS 分段（mpegts） | 支持边转边传，总分耗时 ≈ max(转码, 上传) |
| 分辨率 | `min(iw,1600)` | 同 .bat（900p） | 对齐 |

**实测转码速率：** NVENC p5 + bf 2 + lookahead 20，900p 输入，稳定 11–12x。5 分钟视频约 25 秒转完。瓶颈在上传（自适应限速 5–7 Mbps），不是转码。

**上传限速豁免：** 外部转码场景用户没有在玩游戏，`UploadConfig.disableThrottle = true` 跳过自适应限速，全速上传。

**批量上传队列：** 串行模式（NVENC 有并发 session 数限制），`useEffect` 监听队列变化自动启动下一个，VIDEO_ADDED 作为唯一完成信号。支持处理中添加新文件。

**组件架构：** `Lobby` 层按 `isElectron` 分叉：`ElectronVideoUploader`（IPC 转码 + 队列 UI）vs `VideoUploader`（纯 Web `<input>` + HTTP 上传），两组件解耦互不污染。

---

### IPC/WS 跨通道竞态：`phase:completed` vs `VIDEO_ADDED`

**现象：** 队列中第三个文件显示"等待服务器确认"，但终端日志显示转码正在进行。

**根因：** 文件的"完成"被两个来源确认，走不同通道：

- `phase: 'completed'` → Electron IPC（`webContents.send`），主进程 → 渲染进程
- `VIDEO_ADDED` → WebSocket，后端广播 → 所有客户端

两条通道延迟不同。File 2 的 `phase: 'completed'` 晚到时，File 3 已启动（`videoAddedRef`、`waitingServer` 被重置），晚到事件被误应用到当前文件。

**解决：** 进度监听中，`transcoding` / `uploading` 阶段抵达时主动复位 `waitingServer = false`，而非仅依赖 `phase: 'completed'` 单次事件。即使旧文件的事件残留，下一批当前文件的进度事件立即覆盖。

**根本解：** 在 IPC 事件中携带 `sessionId`，让渲染进程匹配"完成的到底是哪个文件"。当前未实现，因为主动复位已覆盖场景。
