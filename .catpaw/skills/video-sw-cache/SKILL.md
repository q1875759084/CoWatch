---
name: video-sw-cache
description: Service Worker 视频缓存通用指南。解决 SW 缓存视频时的核心问题：Cache API 只能存储 200 响应（不支持 206）、Range 请求必须由 SW 手动切片返回、缓存 key 不能带 Range 头或 # fragment。包含 TransformStream 流式切片实现、tsconfig/webpack 配置、DevTools 验证方法。当需要实现 Service Worker 视频缓存、处理 Range 请求拦截、排查 cache.put 失败或缓存未命中时激活。
---

# Service Worker 视频缓存

## 为什么视频 SW 缓存比普通资源复杂

视频播放器不会一次性请求整个文件，而是通过多个 `Range` 请求分段拉取（如 `Range: bytes=0-65535`）。这带来两个特有问题：

1. **Cache API 不支持存储 206 响应** → 不能直接缓存每个 Range 片段
2. **相同 URL 的 Range 请求因请求头不同无法直接命中缓存** → 缓存 key 必须统一

---

## 方案演进（先读结论）

| 方案 | 思路 | 为什么不可用 |
|------|------|------------|
| V1 | 缓存完整文件 + `arrayBuffer()` 切片 | 每次 Range 请求把整个文件读入内存，SW 线程阻塞，画面卡顿 |
| V2 | 以 `URL + Range头` 为 key，缓存各片段 | `cache.put` 直接抛异常：**Cache API 不支持存储 206 响应** |
| **V3** ✅ | 缓存完整文件 + `ReadableStream` 流式切片 | — |

**结论：唯一可行方案是 V3。**

---

## 三个关键规则

### 规则 1：缓存 key 必须去掉所有请求头

```ts
// ✅ 正确：统一用无头的 URL 作为 key，所有 Range 请求命中同一条目
const cacheKey = new Request(request.url, { headers: {} });

// ❌ 错误：带 # fragment → Cache API 规范禁止，cache.put 静默失败，Cache Storage 始终为空
`${request.url}#range=${rangeHeader}`

// ❌ 错误：直接用原始 request → Range 头不同导致各片段独立存储，命中率为 0
cache.match(request)
```

### 规则 2：只缓存 200 响应，绝不尝试缓存 206

```ts
// ❌ 运行时抛异常：TypeError: Partial response (status code 206) is unsupported
await cache.put(key, response206);

// ✅ 正确：发无 Range 头的完整请求，拿到 200 再存
const fullRes = await fetch(new Request(url, { headers: {} }));
await cache.put(cacheKey, fullRes.clone());
```

### 规则 3：用 TransformStream 流式切片，不用 arrayBuffer()

```ts
// ❌ V1 的性能陷阱：300MB 文件每次 Range 请求都全量读入内存
const buf = await cachedResponse.clone().arrayBuffer();
return buf.slice(start, end + 1);

// ✅ V3：TransformStream 流式跳过，只传输目标区间
function buildRangeResponseFromStream(cachedResponse, { start, end }, totalSize, contentType) {
  let bytesSkipped = 0, bytesSent = 0;
  const chunkSize = end - start + 1;

  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      const chunkStart = bytesSkipped + bytesSent;
      const chunkEnd = chunkStart + chunk.byteLength - 1;
      if (chunkEnd < start)  { bytesSkipped += chunk.byteLength; return; }  // 区间前，跳过
      if (chunkStart > end)  { controller.terminate(); return; }            // 区间后，终止
      const from = Math.max(0, start - chunkStart);
      const to   = Math.min(chunk.byteLength, end - chunkStart + 1);
      const slice = chunk.slice(from, to);
      bytesSkipped = Math.min(bytesSkipped + from, start);
      bytesSent += slice.byteLength;
      controller.enqueue(slice);
      if (bytesSent >= chunkSize) controller.terminate();
    },
  });

  // terminate 后 pipeTo 抛 AbortError 是正常现象，忽略
  cachedResponse.clone().body.pipeTo(writable).catch(() => {});

  return new Response(readable, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(chunkSize),
      'Accept-Ranges': 'bytes',
    },
  });
}
```

---

## fetch 拦截骨架

```ts
self.addEventListener('fetch', (event) => {
  if (request.method !== 'GET' || !isVideoRequest(request)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = new Request(request.url, { headers: {} }); // ← key 统一去头
    const cached = await cache.match(cacheKey);

    if (cached) {
      // 命中缓存：按需切片
      if (!rangeHeader) return cached.clone();
      const totalSize = parseInt(cached.headers.get('Content-Length') || '0', 10);
      const range = parseRange(rangeHeader, totalSize);
      return range ? buildRangeResponseFromStream(cached, range, totalSize, contentType)
                   : cached.clone();
    }

    // 未命中：拉完整文件，存缓存，按需切片返回
    const fullRes = await fetch(new Request(request.url, {
      headers: { 'Cache-Control': 'no-cache' }, // ← 去掉 Range 头
    }));
    if (!fullRes.ok) return fullRes;

    event.waitUntil(cache.put(cacheKey, fullRes.clone())); // ← 异步存，不阻塞响应

    if (rangeHeader) {
      const totalSize = parseInt(fullRes.headers.get('Content-Length') || '0', 10);
      const range = parseRange(rangeHeader, totalSize);
      if (range) return buildRangeResponseFromStream(fullRes, range, totalSize, contentType);
    }
    return fullRes.clone();
  })());
});
```

---

## 跨域视频（COS / CDN）的特殊处理

### 问题根因

SW 的 `fetch` 事件**只能拦截与注册页面同源的请求**，COS / CDN 视频 URL 的 origin 与页面不同，SW 收不到这些请求，`isVideoRequest` 永远返回 `false`，缓存永远为空。

> **误区**：修改 `isVideoRequest` 里的判断逻辑没有意义——SW 根本就收不到跨域请求，连判断的机会都没有。

### 解决方案：postMessage 动态注入 origin

SW 可以拦截页面向跨域 URL 发起的请求——但**前提是页面通过 `fetch` 发出的请求**，而视频播放器（`<video>`）的 Range 请求是浏览器内部行为，不经过 SW。

因此正确方案是：**让页面提前告诉 SW 视频的 origin，SW 在已知白名单内主动 `fetch` 完整文件并缓存，后续播放命中缓存由 SW 切片返回。**

```
页面                              SW
 ├─ 设置 activeVideoUrl
 ├─ 提取 videoOrigin
 ├─ postMessage({ type: 'ADD_VIDEO_ORIGIN', origin })  →  存入 VIDEO_ORIGINS[]
 ├─ 播放器发出 Range 请求  ─────────────────────────────→  拦截
                                                           ├─ isVideoRequest 用 VIDEO_ORIGINS 判断
                                                           └─ 缓存完整文件 + 流式切片返回
```

### SW 端实现

```ts
// 跨域 origin 白名单，由前端通过 postMessage 动态注入
const VIDEO_ORIGINS: string[] = [];

self.addEventListener('message', (event) => {
  const { type, origin } = event.data ?? {};
  if (type === 'ADD_VIDEO_ORIGIN' && origin && !VIDEO_ORIGINS.includes(origin)) {
    VIDEO_ORIGINS.push(origin);
  }
});

function isVideoRequest(request: Request): boolean {
  const url = new URL(request.url);
  // 同域：本地存储模式（/uploads/）
  if (url.origin === self.location.origin && url.pathname.startsWith('/uploads/')) {
    return true;
  }
  // 跨域：COS / CDN，由前端 postMessage 动态注入
  return VIDEO_ORIGINS.some((o) => url.origin === o);
}
```

### 页面端实现

```ts
// 在 activeVideoUrl 变化时（useEffect / 事件回调中）
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  try {
    const videoOrigin = new URL(activeVideoUrl).origin;
    if (videoOrigin !== window.location.origin) {
      navigator.serviceWorker.controller.postMessage({
        type: 'ADD_VIDEO_ORIGIN',
        origin: videoOrigin,
      });
    }
  } catch {
    // URL 解析失败（相对路径）或同域时跳过
  }
}
```

### 注意事项

- `VIDEO_ORIGINS` 存在 SW 内存中，SW 重启（页面关闭后再开）会丢失，需要页面每次激活视频时重新发送
- `navigator.serviceWorker.controller` 在 SW 首次安装时为 `null`，需等 SW 激活后才能 `postMessage`；通常在视频激活时 SW 已就绪，可加非空判断即可
- 不要在 SW 内直接 `fetch` 跨域完整文件时附带 `credentials`，COS 通常不需要 cookie

---

## ⚠️ postMessage 方案的核心缺陷（适用场景受限）

上述 postMessage 方案在 **COS 私有读写 + 时效签名 URL** 场景下存在两个根本缺陷，不推荐使用：

### 缺陷 1：时序竞态（首个 Range 请求必然漏网）

```
SWITCH_VIDEO 消息到达
  → 前端更新 activeVideoUrl（React state 更新，异步）
    → useEffect 触发 postMessage（又是异步）
      → SW 收到并写入 VIDEO_ORIGINS
        → isVideoRequest 才能返回 true
```

而 `<video src=...>` 赋值后，浏览器**立即**发出第一个 Range 请求（获取文件头 / moov atom），这比 postMessage 整条链路快得多。结果：首个 Range 请求 SW 收不到，缓存完整文件的机会丢失，后续所有 seek 产生真实流量。

### 缺陷 2：与时效签名 URL 不兼容

COS 私有读写时，videoUrl 带签名 query 参数（`q-sign-*`），每次切换视频签名不同：
- 如果 cache key 跟签名走 → 同一视频每次签名不同，永远缓存未命中
- 如果 cache key 剥离签名 → 需要两套 URL（带签名的网络请求URL + 纯路径的 cache key），逻辑复杂

---

## 最终方案：路径特征判断 + 签名剥离（适用于 objectKey 路径固定的场景）

**前提：** objectKey 格式固定，如 `cowatch/{roomId}/{uuid}-{fileName}.mp4`，路径特征不依赖域名。

### isVideoRequest 改为路径判断

```ts
function isVideoRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  // pathname 特征不受域名（COS/CDN/本地）影响，零延迟
  return pathname.startsWith('/cowatch/') && pathname.endsWith('.mp4');
}
```

### stripCosSignature 剥离签名，以纯路径为 cache key

```ts
function stripCosSignature(url: string): string {
  const u = new URL(url);
  // CDN TypeA 鉴权参数（随签名轮换而变化）
  u.searchParams.delete('sign');
  // COS 直连签名参数列表（本地开发 / 无 CDN 回退路径）
  ['q-sign-algorithm','q-ak','q-sign-time','q-key-time',
   'q-header-list','q-url-param-list','q-signature'].forEach((p) => u.searchParams.delete(p));
  // 业务归因参数（如 uid）——不参与验签，但同样必须剥离：
  // 同一片段因请求用户不同会产生多条独立缓存，命中率归零
  u.searchParams.delete('uid');
  return u.toString();
}

// fetch 拦截中的用法：
const cacheKeyUrl = stripCosSignature(request.url); // 纯路径，签名轮换不影响命中
const cacheKey = new Request(cacheKeyUrl, { headers: {} });
// 发网络请求时仍用原始带签名 URL（有权限访问 COS）
const fullRes = await fetch(new Request(request.url, { headers: { 'Cache-Control': 'no-cache' } }));
await cache.put(cacheKey, fullRes.clone());
```

> **规律：** cache key 参数剥离需区分两类，缺一不可：
> - **鉴权参数**（`sign`、`q-sign-*`）：随签名轮换，不剥离则同一视频每次签名后缓存未命中
> - **业务归因参数**（`uid` 等）：随请求用户不同，不剥离则同一片段产生 N 条缓存（N = 用户数）

**效果对比：**

| 场景 | postMessage 方案 | 路径判断方案 |
|------|-----------------|------------|
| 时序竞态 | ❌ 首个 Range 必然漏网 | ✅ 零延迟，pathname 直接判断 |
| 时效签名 URL | ❌ cache key 跟签名变化 | ✅ stripCosSignature 剥离签名 |
| 代码复杂度 | 中（需 message 监听器 + postMessage 调用） | 低（只需 isVideoRequest + stripCosSignature） |
| 适用场景 | objectKey 格式不固定 / 纯公开读场景 | objectKey 路径格式固定（推荐） |

---

## 工程配置

### TypeScript：sw.ts 必须独立 tsconfig

`dom` lib 与 `WebWorker` lib 冲突，不能共用 tsconfig：

```jsonc
// tsconfig.json（主应用）：排除 sw.ts
{ "exclude": ["src/sw.ts"] }

// tsconfig.sw.json（SW 专用）
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "lib": ["WebWorker", "ES2020"] },
  "include": ["src/sw.ts"],
  "exclude": []
}
```

在 `sw.ts` 顶部加（让 IDE 主 tsconfig 跳过类型检查）：
```ts
// @ts-nocheck
/// <reference lib="webworker" />
```

### Webpack：SW 必须作为独立 entry 输出到根路径

```js
entry: { main: './src/index.tsx', sw: './src/sw.ts' },
output: {
  filename: (pathData) => pathData.chunk?.name === 'sw' ? 'sw.js' : 'bundle.[contenthash].js',
  publicPath: '/',
},
```

SW 文件必须在根路径，否则 scope 只覆盖子路径，无法拦截所有页面请求。

---

## DevTools 验证

| 检查点 | 路径 | 预期 |
|--------|------|------|
| 视频已缓存 | Application → Cache Storage → 你的 CACHE_NAME | 看到视频 URL，`Content-Length` 与文件大小一致 |
| 缓存命中日志 | Application → Service Workers → 点击 `sw.js` → Console | 看到 `[SW] 缓存命中` |
| 请求经过 SW | Network → 大小列 | 显示 `(ServiceWorker)` |

**注意：** `(ServiceWorker)` ≠ 命中缓存，只代表请求经过了 SW。  
**真正命中缓存的响应头**只有 SW 自己构造的 4 个字段（`Content-Type`、`Content-Range`、`Content-Length`、`Accept-Ranges`），没有 `ETag`、`Server` 等服务端原生字段。

---

## 常见问题速查

| 现象 | 根因 | 解决 |
|------|------|------|
| Cache Storage 始终为空 | 缓存 key 带 `#fragment` | 改用 `new Request(url, { headers: {} })` |
| `cache.put` 抛异常 | 尝试存储 206 响应 | 改为存完整的 200 响应 |
| 缓存命中但画面卡顿 | `arrayBuffer()` 全量读入内存 | 改用 TransformStream 流式切片 |
| 无痕模式无法缓存大文件 | 无痕模式 Cache Storage 配额极低（通常 < 100MB） | 普通模式测试；这是浏览器限制，非 bug |
| SW 只拦截部分页面 | SW 文件不在根路径，scope 受限 | 确保 `sw.js` 输出到 `/`，注册时用 `/sw.js` |
| 跨域视频（COS/CDN）始终未缓存 | SW `fetch` 事件根本收不到跨域请求，`isVideoRequest` 再怎么改也无效 | 页面提取视频 `origin` 后 `postMessage({ type: 'ADD_VIDEO_ORIGIN', origin })` 给 SW；参见
