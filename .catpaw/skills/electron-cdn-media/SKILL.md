---
name: electron-cdn-media
description: Electron 中加载来自第三方 CDN 的鉴权媒体资源（视频、音频、HLS 切片）时的跨域处理规范。当 hls.js / video 元素直接请求 CDN 绝对 URL 导致 CORS 报错、或需要决定媒体资源 URL 是直链还是后端代理时激活。覆盖根因分析、三方案对比、后端 segment 代理接口实现模板、SW cache key 简化。
---

# Electron 中加载 CDN 鉴权媒体资源

## 问题根因

Electron 使用 `app://` 自定义协议，`protocol.handle` **只拦截** `app://` scheme 的请求。

当 m3u8 / playlist 中写的是 CDN **绝对 URL**（如 `https://cdn.xxx.com/seg000.ts?sign=...`），hls.js 会直接发出 `https://` 请求，**完全绕过 `protocol.handle`**，由 Chromium 直连 CDN。

此时请求的 `Origin` 为 `app://localhost`，CDN 不在 CORS 白名单，preflight OPTIONS 被拒，媒体无法播放。

```
hls.js 请求 https://cdn.xxx.com/seg000.ts?sign=...
  ↓
Chromium 直连 CDN（不经过 protocol.handle）
  ↓
CDN: Origin: app://localhost → CORS 拒绝 ❌
```

---

## 三方案对比

| 方案 | 改动位置 | 代价 | 推荐度 |
|------|---------|------|--------|
| **CDN 加 CORS 头** | CDN 控制台 | 最小，但 OPTIONS preflight 可能与防盗链规则冲突；允许所有 Origin 则降低安全性 | ❌ 不推荐 |
| **后端代理路径 + segment 接口** | 后端新增接口，m3u8 改为相对路径 | 中等，架构最干净，Web / Electron 行为统一 | ✅ **首选** |
| **Electron 层拦截 m3u8 替换 URL** | `protocol.handle` 或 `cache.ts` | 改动最小，但逻辑分散在 Electron 层，维护成本高 | ⚠️ 短期应急可用 |

---

## 首选方案：后端代理路径

### 核心思路

m3u8 / playlist 中的切片 URL 改为**后端相对路径**，后端接口完成鉴权后 302 重定向到 CDN 签名 URL。

```
# 旧（CDN 直链，Electron 跨域）
https://cdn.xxx.com/cowatch/{roomId}/{videoId}/seg000.ts?sign=...

# 新（后端代理路径，无跨域）
/api/rooms/{roomId}/videos/{videoId}/segments/seg000.ts
```

请求链路变化：
```
hls.js 请求 /api/rooms/.../segments/seg000.ts
  ↓
app://localhost/api/rooms/.../segments/seg000.ts
  ↓
protocol.handle（isBackendPath: /api/ 前缀）
  ↓
net.fetch → 后端鉴权 → 302 → CDN 签名 URL
  ↓
net.fetch 自动跟随 302 → CDN 响应
  ↓
hls.js 拿到切片数据 ✅
```

后端**不传输视频数据**，只做鉴权 + 302 redirect，服务器带宽不受影响。

### 后端实现模板

```ts
// routes/rooms/index.ts
router.get(
  '/:roomId/videos/:videoId/segments/:segmentName',
  roomAuthMiddleware,
  requireRoomActive(),
  (req, res) => RoomsController.getSegment(req, res),
);

// controllers/rooms/index.ts
async getSegment(req: Request, res: Response): Promise<void> {
  const { roomId, videoId, segmentName } = req.params;

  // 防目录穿越：必须以 .ts 结尾，不含 / 或 ..
  if (!segmentName.endsWith('.ts') || segmentName.includes('/') || segmentName.includes('..')) {
    fail(res, 400, '非法的 segmentName');
    return;
  }

  const video = await getRoomVideoById(videoId);
  if (!video || video.room_id !== roomId) {
    fail(res, 404, '视频不存在');
    return;
  }
  if (!video.hls_prefix) {
    fail(res, 404, '视频切片不存在');
    return;
  }

  const objectKey = `${video.hls_prefix}${segmentName}`;

  if (isOnlineMode()) {
    // 线上：生成短时效 CDN 签名 URL（10 分钟足够，单次请求远小于此值）
    const signedUrl = await getHlsSegmentSignedUrl(objectKey, 10 * 60);
    res.redirect(302, signedUrl);
  } else {
    // 本地：指向 /uploads 静态服务
    res.redirect(302, `/uploads/${objectKey}`);
  }
},
```

### generateM3u8 改造要点

```ts
// 新增 roomId 参数，不再生成 CDN 签名 URL
export async function generateM3u8(
  videoId: string,
  roomId: string,       // ← 新增
  uploadsDir?: string,
  // userId 参数移除（不再需要写入 CDN uid）
): Promise<string> {
  // ...列举切片文件名...

  // 切片 URL 统一为后端代理路径
  const segmentUrls = segmentNames.map(
    (name) => `/api/rooms/${roomId}/videos/${videoId}/segments/${name}`,
  );
  // ...拼装 m3u8...
}
```

---

## SW cache key 简化

旧架构（CDN 直链）：cache key 必须剥离签名参数（`stripSignature`），否则同一切片因签名轮换每次缓存未命中。

新架构（后端代理路径）：URL 无签名参数，cache key 直接就是路径，`stripSignature` 调用无副作用（保留为向下兼容即可）。

```ts
// 新格式 URL 无签名，stripSignature 调用不影响结果
const cacheKeyUrl = stripSignature(event.request.url);
// 等价于：const cacheKeyUrl = event.request.url;
```

---

## isHlsSegment 适配

同时兼容旧格式（CDN 直链）和新格式（后端代理路径）：

```ts
export function isHlsSegment(url: string): boolean {
  const { pathname } = new URL(url);
  if (!pathname.endsWith('.ts')) return false;
  // 旧格式：/cowatch/{roomId}/{videoId}/seg.ts 或 /uploads/cowatch/...
  // 新格式：/api/rooms/{roomId}/videos/{videoId}/segments/seg.ts
  return pathname.includes('/cowatch/') || pathname.includes('/segments/');
}
```

---

## parseSegmentMeta 适配

```ts
export function parseSegmentMeta(url: string): SegmentMeta | null {
  try {
    const { pathname } = new URL(url);

    // 新格式：/rooms/{roomId}/videos/{videoId}/segments/{name}.ts
    const newMatch = pathname.match(/\/rooms\/([^/]+)\/videos\/([^/]+)\/segments\/([^/]+\.ts)$/);
    if (newMatch) return { roomId: newMatch[1], videoId: newMatch[2], segmentName: newMatch[3] };

    // 旧格式：/cowatch/{roomId}/{videoId}/{name}.ts（含 /uploads/ 前缀）
    const oldMatch = pathname.match(/\/cowatch\/([^/]+)\/([^/]+)\/([^/]+\.ts)$/);
    if (oldMatch) return { roomId: oldMatch[1], videoId: oldMatch[2], segmentName: oldMatch[3] };

    return null;
  } catch {
    return null;
  }
}
```

---

## Electron cache-first 在新架构下的行为

`handleHlsSegment` 中 `realUrl` 替换逻辑对新格式同样成立：

```ts
// app://localhost/api/rooms/.../segments/seg000.ts
// → http://backend/api/rooms/.../segments/seg000.ts
// → 后端 302 → CDN
// net.fetch 自动跟随 302，CDN 响应写入本地文件缓存
const realUrl = request.url.replace(/^app:\/\/[^/]+/, apiOrigin);
```

`extractUserId(realUrl)` 在新格式下返回 `'anonymous'`（后端代理路径无 `uid` 参数），流量归因降级为匿名，可接受。

---

## 通用原则

> 凡是需要在 Electron 中加载来自第三方 CDN 的**鉴权资源**（视频、音频等），
> **默认使用后端代理路径**而非直接写 CDN 绝对 URL，
> 以保证 Web / Electron 行为一致，兼顾可扩展性与安全性。

纯 Web 端同样可用此架构，性能影响可忽略（每切片多一次 302 跳转 ~10~50ms，hls.js 预加载机制抵消）。
