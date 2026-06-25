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
// main.ts
protocol.handle('app', async (request) => {
  const { pathname } = new URL(request.url);
  if (isBackendPath(pathname)) {
    return net.fetch(`${API_ORIGIN}${pathname}${search}`); // 转发到后端
  }
  // 有扩展名 → 本地 dist 文件；否则 → index.html（SPA 路由兜底）
  return net.fetch(`file://${distDir}${hasExt ? pathname : '/index.html'}`);
});

// 用后端 host 作为 app:// 的 host，使 window.location.host === 'localhost:3002'
// WS（ws://localhost:3002/socket）和所有相对路径自动正确，与 Web 行为完全一致
win.loadURL(`app://${new URL(API_ORIGIN).host}/index.html`);
```

**关键设计——host 即后端地址：** `app://` 的 host 直接取自 `API_ORIGIN`（如 `localhost:3002` 或 `cowatch.daibao.site`），令 `window.location.host` 等于后端地址。这样所有业务代码里的相对路径和 WS 推断逻辑都无需修改，与 Web 版本完全一致。

**废弃方案：** 用 `DefinePlugin` 注入 `__IS_ELECTRON__` / `__ELECTRON_API_ORIGIN__`，在 `request.ts`、`useRoomWs.ts`、各 API 文件里条件切换 URL。每新增一个相对路径就要改一次，业务层感知运行环境，违反分层原则，代码快速腐化。

**`API_ORIGIN` 注入时机：** Main 进程运行时通过 `process.env.ELECTRON_API_ORIGIN` 读取（不是编译时），本地默认 `http://localhost:3002`，发布时由启动命令传入。

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
