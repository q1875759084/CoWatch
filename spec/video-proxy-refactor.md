# 视频地址逻辑路径改造

## 背景与问题

### 当前架构（有问题）

```
上传流程：
  前端 GET /api/rooms/:roomId/upload-url
  → 后端生成 objectKey = `cowatch/{roomId}/{uuid}-{fileName}`
  → 调用 getVideoUrl(objectKey) 返回 COS 真实地址
  → 数据库存储 COS 真实地址（如 https://xxx.cos.ap-guangzhou.myqcloud.com/cowatch/...）
  → 前端收到 videoUrl = COS 真实地址

播放流程：
  <video src="https://xxx.cos.ap-guangzhou.myqcloud.com/cowatch/room1/abc.mp4">
  → 跨域请求，Service Worker fetch 事件收不到
  → SW 缓存失效
```

### 两个核心问题

1. **SW 缓存失效**：`<video>` 的 Range 请求是浏览器媒体管道行为，跨域时完全不经过 SW 的 `fetch` 事件。`isVideoRequest` 的判断逻辑再怎么改也无效——SW 根本没有机会执行。

2. **COS 地址泄露**：bucket 名、region、完整路径结构直接暴露给前端，存在安全隐患。

---

## 改造目标

数据库和前端只存**逻辑路径**，真实存储位置由后端屏蔽：

```
数据库 video_url 字段：/videos/cowatch/{roomId}/{uuid}-{fileName}
前端 <video src="/videos/cowatch/room1/abc.mp4">  ← 同源请求，SW 天然生效
后端内部根据环境决定从哪里取：本地读文件 / COS 取流
```

---

## 涉及文件

- `CoWatch-backend/src/services/ossService.ts`
- `CoWatch-backend/src/app.ts`
- `CoWatch-backend/src/controllers/rooms/index.ts`（可能不需要改）
- `CoWatch/nginx.conf`（前端容器）
- `CoWatch/src/sw.ts`（清理无效的跨域逻辑）
- `CoWatch/src/pages/Lobby/index.tsx`（清理无效的 postMessage 逻辑）

---

## 改动详情

### 1. `ossService.ts`：`getVideoUrl` 改为返回逻辑路径

```ts
// 改前
export function getVideoUrl(objectKey: string): string {
  const baseUrl = (process.env.COS_BASE_URL ?? '').replace(/\/$/, '');
  if (baseUrl) return `${baseUrl}/${objectKey}`;
  const bucket = process.env.COS_BUCKET!;
  const region = process.env.COS_REGION!;
  return `https://${bucket}.cos.${region}.myqcloud.com/${objectKey}`;
}

// 改后
export function getVideoUrl(objectKey: string): string {
  return `/videos/${objectKey}`;
}

// 新增：内部使用，获取 COS 真实地址（用于后端代理取流）
export function getCosUrl(objectKey: string): string {
  const baseUrl = (process.env.COS_BASE_URL ?? '').replace(/\/$/, '');
  if (baseUrl) return `${baseUrl}/${objectKey}`;
  const bucket = process.env.COS_BUCKET!;
  const region = process.env.COS_REGION!;
  return `https://${bucket}.cos.${region}.myqcloud.com/${objectKey}`;
}
```

### 2. `app.ts`：新增 `/videos/*` 路由

需要在 `app.use('/api', routes)` **之前**注册，避免被 API 路由拦截。

```ts
import { videosProxyHandler } from './controllers/videos/index.js';

// 本地模式：/videos → uploads 目录（静态文件服务）
// COS 模式：/videos/* → 从 COS 取流（代理）
// 两种模式在 handler 内部根据 isOssEnabled() 分支处理
app.get('/videos/*', videosProxyHandler);
```

> **注意**：本地模式原来是 `app.use('/uploads', express.static(uploadsDir))`，
> 改造后本地存储路径也需要同步调整——见下方 `uploadLocal` 改动。

### 3. 新建 `controllers/videos/index.ts`

处理 `/videos/*` 请求，根据环境决定取流来源：

```ts
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { isOssEnabled, getCosUrl } from '../../services/ossService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, '../../../../uploads');

export function videosProxyHandler(req: Request, res: Response): void {
  // req.path 示例：/videos/cowatch/room1/abc.mp4
  // 去掉前缀 /videos/ 得到 objectKey
  const objectKey = req.path.replace(/^\/videos\//, '');
  if (!objectKey) { res.status(400).end(); return; }

  if (isOssEnabled()) {
    // COS 模式：向 COS 发请求，透传 Range 头，pipe 响应流给前端
    const cosUrl = getCosUrl(objectKey);
    const cosReq = https.get(cosUrl, {
      headers: req.headers.range ? { Range: req.headers.range } : {},
    }, (cosRes) => {
      res.status(cosRes.statusCode ?? 200);
      // 透传必要响应头
      ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges'].forEach((h) => {
        const v = cosRes.headers[h.toLowerCase()];
        if (v) res.setHeader(h, v);
      });
      cosRes.pipe(res);
    });
    cosReq.on('error', () => res.status(502).end());
  } else {
    // 本地模式：从 uploads 目录读文件
    const filePath = path.join(uploadsDir, objectKey);
    if (!fs.existsSync(filePath)) { res.status(404).end(); return; }

    const stat = fs.statSync(filePath);
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      // 手动处理 Range 请求，返回 206
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
        res.status(206).set({
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1),
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.status(200).set({
      'Content-Length': String(stat.size),
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}
```

### 4. `controllers/rooms/index.ts`：`uploadLocal` 存储路径调整

本地上传后存的 videoUrl 需要从 `/uploads/...` 改为 `/videos/...`，同时本地存储目录结构要与 objectKey 对齐：

```ts
// 改前
const videoUrl = `/uploads/${roomId}/${savedName}`;

// 改后（与 COS 的 objectKey 格式对齐）
const objectKey = `cowatch/${roomId}/${savedName}`;
const videoUrl = `/videos/${objectKey}`;  // = /videos/cowatch/{roomId}/{savedName}

// 存储目录也需要对应调整
const dest = path.join(uploadsDir, 'cowatch', roomId);
```

### 5. `nginx.conf`（前端容器）：更新代理路径

```nginx
# 改前
location /uploads/ {
    proxy_pass http://backend:3002;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Host $host;
}

# 改后
location /videos/ {
    proxy_pass http://backend:3002;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Host $host;
    # 视频文件可能很大，关闭 proxy buffer 避免内存积压
    proxy_buffering off;
}
```

### 6. `sw.ts`：清理无效的跨域 origin 逻辑

以下内容在改造后不再需要，可以删除或简化：

```ts
// 删除：VIDEO_ORIGINS 相关
const VIDEO_ORIGINS: string[] = [];

// 删除：message 事件监听
self.addEventListener('message', ...);

// 简化 isVideoRequest：只需判断同源路径
function isVideoRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.origin === self.location.origin && url.pathname.startsWith('/videos/');
}
```

同时 `VIDEO_PATH_PREFIX` 常量从 `/uploads/` 改为 `/videos/`。

### 7. `Lobby/index.tsx`：清理 postMessage 逻辑

删除 `activeVideoUrl` 变化时向 SW 发送 `ADD_VIDEO_ORIGIN` 的 `useEffect` 逻辑（约第 202-229 行中的 postMessage 部分）。

---

## 改造后的完整流程

### 上传（白名单用户 COS 直传）

```
前端 GET /api/rooms/:roomId/upload-url
  → 后端：objectKey = `cowatch/{roomId}/{uuid}-{fileName}`
  → 返回：{ uploadUrl: "COS预签名PUT URL", videoUrl: "/videos/cowatch/...", fileName }
前端 PUT {uploadUrl}（直传 COS，后端不参与）
前端 PUT /api/rooms/:roomId/video，body: { videoUrl: "/videos/cowatch/...", fileName }
  → 后端写数据库：video_url = "/videos/cowatch/..."
  → 广播 VIDEO_ADDED
```

### 上传（非白名单用户，后端代理）

```
前端 GET /api/rooms/:roomId/upload-url
  → 后端返回：{ uploadUrl: "/api/rooms/.../upload-proxy?objectKey=...", videoUrl: "/videos/cowatch/...", mode: 'proxy' }
前端 PUT /api/rooms/:roomId/upload-proxy（文件流经后端中转到 COS）
  → 后端写数据库：video_url = "/videos/cowatch/..."
  → 广播 VIDEO_ADDED
```

### 上传（本地模式）

```
前端 GET /api/rooms/:roomId/upload-url
  → 后端返回：{ uploadUrl: "/api/rooms/.../upload?...", videoUrl: "", mode: 'local' }
前端 PUT /api/rooms/:roomId/upload（文件流直传后端，写 uploads/cowatch/{roomId}/）
  → 后端写数据库：video_url = "/videos/cowatch/{roomId}/{savedName}"
  → 广播 VIDEO_ADDED
```

### 播放

```
<video src="/videos/cowatch/room1/abc.mp4">
  → 同源请求 → SW fetch 事件触发 ✅
  → 首次：SW 向 /videos/... 发完整 GET 请求
           → nginx 转发到后端 backend:3002
           → 后端 /videos/* handler：
               本地模式 → 读 uploads/cowatch/... 文件，返回 200
               COS 模式  → 向 COS 取流，透传 Range，返回 200/206
  → SW 收到 200，存入 Cache Storage
  → 后续：SW 命中缓存，流式切片返回 206
```

---

## 注意事项

1. **本地开发迁移**：已有数据库里存的是旧的 `/uploads/...` 路径，改造后这些旧记录的视频将无法访问。本地开发重置数据库即可（`rm *.db` 或清空数据）。

2. **生产环境迁移**：数据库里已有的 COS 真实地址记录，改造上线后同样失效。需要提前考虑数据迁移（写一次性脚本，将 `https://xxx.cos.../cowatch/...` 转换为 `/videos/cowatch/...`）或接受上线后旧视频需要重新上传。

3. **COS 模式代理带宽**：改造后 COS 视频流量全部经过后端服务器，会增加服务器出口带宽消耗。如果流量很大，可以考虑：COS 开启防盗链 + 后端先鉴权再 302 重定向到带时效签名 URL（但这样 SW 又失效了，需要权衡）。

4. **Range 请求透传**：后端代理时必须正确透传 `Range` 请求头，否则视频 seek 会失效（视频播放器无法跳转到任意时间点）。
