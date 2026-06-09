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
