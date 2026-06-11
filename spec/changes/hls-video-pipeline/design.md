# HLS 视频切片流水线 技术设计

## 1. 功能概述

将当前"全量 mp4 直传 + SW TransformStream 切片"方案替换为"后端 ffmpeg 流复制切片 + hls.js 播放"。
废弃白名单 COS 直传优势，所有上传统一经后端中转，后端 ffmpeg `-c copy` 切片（无重编码），彻底消除
SW Range 缓存竞争问题，同时大幅简化 SW 逻辑。

面向场景：长视频（30min–2h）复盘，用户反复 seek 至任意片段，每次只需下载目标 15s 片段（~15MB），
无需等待整文件下载完成。

---

## 2. 涉及模块

### 后端（`CoWatch-backend`）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/services/hlsService.ts` | 🆕 新建 | ffmpeg 切片核心逻辑、临时目录管理、`.ts` 批量上传 COS |
| `src/services/ossService.ts` | 🔄 迭代 | 新增 `uploadHlsSegment()` 上传单个 `.ts` 片段到 COS |
| `src/controllers/rooms/index.ts` | 🔄 迭代 | `proxyUpload` 完成后触发 HLS 切片；`getUploadUrl` 废弃白名单直传分支 |
| `src/routes/rooms/index.ts` | 🔄 迭代 | 新增 `GET /:roomId/videos/:videoId/m3u8` 动态 m3u8 接口 |
| `src/ws/wsServer.ts` | 🔄 迭代 | `toPlayUrl` 改为调用 `hlsService.getM3u8Content()`；SWITCH_VIDEO 下发 m3u8 URL |
| `src/middleware/uploadGuard.ts` | 🔄 迭代 | 移除白名单豁免逻辑，所有用户统一走流量计算 |

### 前端（`CoWatch`）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/pages/Lobby/VideoPlayer.tsx` | 🔄 迭代 | 引入 hls.js，src 改为 m3u8 URL，处理 hls 生命周期 |
| `src/pages/Lobby/VideoUploader.tsx` | 🔄 迭代 | 移除 OSS 直传分支（白名单），统一走 proxy；新增切片等待状态 |
| `src/sw.ts` | 🔄 迭代 | 完全重写：轻量 cache-first，拦截 `.ts` 片段请求 |
| `src/api/room.ts` | 🔄 迭代 | 移除 `confirmVideoUploadApi`；新增 `getVideoM3u8Api` |
| `src/types/api.ts` | 🔄 迭代 | `UploadUrlResponse` 移除 OSS 直传相关字段 |

---

## 3. 页面 / 模块设计

### 3.1 上传流程（VideoUploader）

#### 功能描述

所有用户上传视频均走后端中转接口（`POST /api/rooms/:roomId/upload-proxy`）。
上传完成后，后端异步执行 ffmpeg 切片并上传片段到 COS，完成后通过 WS 广播 `VIDEO_ADDED`。
前端新增"切片中"状态，等待 `VIDEO_ADDED` 消息后才标记完成。

#### 交互流程

```
When 用户选择文件，
  the system shall 校验视频格式（validateVideoFile），
  Then 展示上传进度条，POST 文件到 /upload-proxy，
  Then 收到 200 响应后切换到"切片中"状态（转圈 + "服务器切片中，请稍候..."）
  Then 收到 WS VIDEO_ADDED 后切换到"已完成"状态

When 上传或切片失败，
  the system shall 显示错误信息，回到 idle 状态
```

#### 状态机

```
idle → uploading → slicing → done
              ↘              ↗
               error ←──────
```

新增 `'slicing'` 状态（上传完成但等待 WS VIDEO_ADDED）。

---

### 3.2 播放器（VideoPlayer）

#### 功能描述

引入 `hls.js`，`<video>` 不再直接设置 `src` 为 mp4 URL，改为通过 hls.js 加载 m3u8 URL。
原有的 `syncPlay` / `syncSeekAndPause` / `initPlayback` 等 imperative handle 接口完全保留，
hls.js 对上层透明（上层仍操作原生 `<video>` element）。

#### hls.js 接入策略

目标浏览器：Chrome、Edge、360浏览器（Chromium 内核）—— 均支持 `Hls.isSupported()`，全部走 hls.js。
不做 Safari 原生 HLS 降级（用户群为 Windows 游戏玩家，macOS/Safari 占比可忽略）。

**浏览器兼容性检测在应用入口（`src/index.tsx`）统一拦截**，不在 VideoPlayer 内部判断。
`VideoPlayer` 组件内部无任何 `Hls.isSupported()` 判断，逻辑无分支，保持组件纯粹。

```
When 应用启动（src/index.tsx），
  the system shall 检测 Hls.isSupported()，
  若为 false：直接替换 document.body 内容为"请使用 Chrome 或 Edge 浏览器访问"提示，终止 React 渲染

When src（m3u8 URL）变化，
  the system shall 销毁旧 Hls 实例（hls.destroy()），
  Then 创建新实例 hls.loadSource(src) + hls.attachMedia(videoEl)

When hls ERROR 级别事件（网络/解码错误），
  the system shall 尝试 hls.recoverMediaError() 一次，失败后 destroy 并展示错误提示
```

#### 关键 Ref

| ref | 类型 | 用途 |
|-----|------|------|
| `videoRef` | `HTMLVideoElement` | 现有，保持不变 |
| `hlsRef` | `Hls \| null` | 持有当前 Hls 实例，src 变化时销毁重建 |

---

### 3.3 Service Worker（sw.ts）

#### 功能描述

完全重写为轻量 cache-first：
- 拦截 pathname 包含 `/cowatch/` 且以 `.ts` 结尾的请求（HLS 片段）
- 同样拦截 `.m3u8`？**不拦截**——m3u8 由后端动态生成且每次含签名，缓存意义不大
- cache key 剥离 CDN `sign` 参数（`.ts` 片段 URL 含签名）
- 首次未命中：fetch → cache.put（200 响应，Cache API 原生支持）→ 返回 response
- 命中：直接返回 cached response

#### 核心简化

| 旧 sw.ts | 新 sw.ts |
|---------|---------|
| ~300 行 | ~80 行 |
| TransformStream 流式切片 | 不需要 |
| inFlight 去重 Map | 不需要（每片独立，无并发爆炸） |
| parseRange / buildRangeResponseFromStream | 不需要 |
| 拦截 `.mp4` | 拦截 `.ts` |

---

## 4. 后端接口设计

### 4.1 上传接口变化

**`GET /api/rooms/:roomId/upload-url`**（迭代）

移除白名单直传分支，OSS 模式统一返回 `mode: 'proxy'`：

```typescript
// 响应（OSS 模式，原白名单 / 非白名单统一）
interface UploadUrlResponse {
  uploadUrl: string;   // /api/rooms/:roomId/upload-proxy?...
  objectKey: string;   // cowatch/{roomId}/{uuid}/{uuid}.mp4（切片前原始文件 key）
  fileName: string;
  mode: 'proxy' | 'local';
}
```

**`POST /api/rooms/:roomId/upload-proxy`**（迭代）

上传完成后不立即广播 `VIDEO_ADDED`，而是触发异步 HLS 切片任务。
切片完成后再广播 `VIDEO_ADDED`（携带 `m3u8ObjectKey`）。

```typescript
// VIDEO_ADDED WS 消息 data（迭代）
interface VideoAddedData {
  id: string;
  objectKey: string;       // 原始 mp4 objectKey（存库用，不直接播放）
  m3u8ObjectKey: string;   // HLS 目录前缀，如 cowatch/{roomId}/{uuid}/
  videoUrl: string;        // 后端动态生成的 m3u8 内容（dataURL 或 inline？不，见下方说明）
  fileName: string;
  uploaderId: string;
  createdAt: string;
}
```

> ⚠️ `videoUrl` 字段语义变化：原来是带签名的 mp4 URL，现在改为**后端 m3u8 接口的相对路径**，
> 如 `/api/rooms/{roomId}/videos/{videoId}/m3u8`。
> 前端拿到后请求此接口获得实时签名的 m3u8 文本内容，再通过 `URL.createObjectURL(blob)` 传给 hls.js。
>
> 补充：经权衡，`videoUrl` 直接改为 m3u8 API 路径（不含签名），每次切换视频时前端请求此接口获取最新 m3u8。

---

### 4.2 新增：动态 m3u8 接口

**`GET /api/rooms/:roomId/videos/:videoId/m3u8`**（新增）

后端实时签名所有 `.ts` 片段 URL，拼装 m3u8 内容，以 `text/plain` 返回。

```typescript
// 请求：无 body，鉴权通过 Authorization Bearer
// 响应：Content-Type: application/vnd.apple.mpegurl
// 响应 body 示例：
/*
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:15
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:15.000000,
https://cdn.example.com/cowatch/room1/uuid/seg000.ts?sign=xxx
#EXTINF:15.000000,
https://cdn.example.com/cowatch/room1/uuid/seg001.ts?sign=xxx
...
#EXT-X-ENDLIST
*/
```

片段签名有效期：**2 小时**（覆盖复盘 session，含跨天复盘场景需要刷新签名时重新请求此接口）。

---

### 4.3 数据库字段变化

`room_videos` 表新增字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hls_prefix` | `TEXT` | HLS 切片目录前缀，如 `cowatch/{roomId}/{uuid}/`；切片完成前为 NULL |
| `hls_status` | `TEXT` | `'pending' \| 'done' \| 'error'`；切片完成前为 `'pending'` |

> 本地模式：`hls_prefix` 为本地目录路径，`hls_status` 同样适用。

---

## 5. hlsService 设计

### 职责

```typescript
// src/services/hlsService.ts

/**
 * 将已上传到临时位置（或内存流）的 mp4 文件通过 ffmpeg -c copy 切片，
 * 生成 .ts 片段并上传到 COS（或本地目录），更新 room_videos.hls_* 字段。
 *
 * @param videoId     room_videos.id
 * @param objectKey   原始 mp4 在 COS 的 objectKey（COS 模式）
 *                    或本地文件绝对路径（本地模式）
 * @param hlsPrefix   切片输出目录前缀，如 cowatch/{roomId}/{uuid}/
 */
export async function transcodeToHls(
  videoId: string,
  objectKey: string,
  hlsPrefix: string,
): Promise<void>

/**
 * 动态生成 m3u8 内容（内存拼装，不存 COS）。
 * 查询 room_videos 得到 hls_prefix，列举 COS 对象（或本地目录），
 * 对每个 .ts 片段生成带签名 URL，拼装标准 HLS m3u8 格式返回。
 *
 * @param videoId  room_videos.id
 * @returns m3u8 文本内容
 */
export async function generateM3u8(videoId: string): Promise<string>
```

### ffmpeg 切片命令（COS 模式）

```bash
# 步骤 1：从 COS 下载原始文件到临时目录（或直接 pipe，取决于 ffmpeg 是否支持 HTTP 输入）
# COS 模式：ffmpeg 直接读取带签名的 COS URL（无需本地落盘）
ffmpeg -i "{cosSignedUrl}" \
  -c copy \
  -f hls \
  -hls_time 15 \
  -hls_list_size 0 \
  -hls_segment_filename "{tmpDir}/seg%03d.ts" \
  "{tmpDir}/index.m3u8"

# 步骤 2：将 tmpDir 中的所有 .ts 文件上传到 COS（hlsPrefix 前缀）
# 步骤 3：清理 tmpDir
```

### ffmpeg 切片命令（本地模式）

```bash
# 本地模式：输入输出均为本地路径
ffmpeg -i "{uploadsDir}/{objectKey}" \
  -c copy \
  -f hls \
  -hls_time 15 \
  -hls_list_size 0 \
  -hls_segment_filename "{hlsLocalDir}/seg%03d.ts" \
  "{hlsLocalDir}/index.m3u8"
# 无需上传，直接更新 DB
```

### 临时目录策略

- 切片输出到 `os.tmpdir()/cowatch-hls-{videoId}/`
- 上传完成后 `fs.rm(tmpDir, { recursive: true })` 清理
- 进程异常退出时 tmpDir 残留可接受（系统重启自动清理）

---

## 6. SW 新设计（cache-first for .ts）

```typescript
const CACHE_NAME = 'cowatch-hls-v1';

function isHlsSegment(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname.includes('/cowatch/') && pathname.endsWith('.ts');
}

function stripSignature(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('sign');
  // COS 直连签名（本地模式回退）
  ['q-sign-algorithm','q-ak','q-sign-time','q-key-time',
   'q-header-list','q-url-param-list','q-signature'].forEach(p => u.searchParams.delete(p));
  return u.toString();
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!isHlsSegment(event.request)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKeyUrl = stripSignature(event.request.url);
    const cacheKey = new Request(cacheKeyUrl, { headers: {} });

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const response = await fetch(event.request);
    if (response.ok) {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  })());
});
```

---

## 7. 类型定义变化

```typescript
// src/types/api.ts

// UploadUrlResponse：移除 OSS 直传字段
interface UploadUrlResponse {
  uploadUrl: string;
  objectKey: string;
  fileName: string;
  mode: 'proxy' | 'local';  // 移除 undefined（不再有直传模式）
}

// src/types/room.ts

// VideoAddedData：新增 m3u8ObjectKey
interface VideoAddedData {
  id: string;
  objectKey: string;
  m3u8ObjectKey?: string;  // 切片完成后有值；VIDEO_ADDED 广播时切片已完成，此字段必填
  videoUrl: string;        // m3u8 API 路径，如 /api/rooms/{roomId}/videos/{videoId}/m3u8
  fileName: string;
  uploaderId: string;
  createdAt: string;
}

// SwitchVideoData：videoUrl 语义变为 m3u8 API 路径
interface SwitchVideoData {
  objectKey: string;
  videoId?: string;
  videoUrl: string;  // /api/rooms/{roomId}/videos/{videoId}/m3u8
}
```

---

## 8. 权限控制

无变化：上传接口维持 `roomAuthMiddleware + adminAuthMiddleware`；
m3u8 接口使用 `roomAuthMiddleware`（所有房间成员可获取）。

---

## 9. 关键决策记录

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| 1 | 上传入口 | 废弃白名单直传，统一 proxy | 切片需在服务端执行，直传无法触发切片 |
| 2 | 切片粒度 | 15 秒/片 | seek 精度与请求数的平衡点 |
| 3 | m3u8 存储 | 不存 COS，后端动态生成 | 避免签名过期，跨天复盘重新请求即可刷新签名 |
| 4 | SW 去留 | 保留，重写为 cache-first | 缓存 .ts 片段，第二次播放 0 流量 |
| 5 | 本地模式 | 同样走 ffmpeg 切片 | 与生产行为一致，方便本地调试 hls.js |
| 6 | m3u8 传递方式 | videoUrl 字段改为 m3u8 API 路径 | 前端每次切换视频请求此接口获取实时签名的 m3u8 |
| 7 | ffmpeg 输入（COS 模式） | 直接读取 COS 签名 URL，无需本地落盘 | 避免临时存储大文件，但需要服务器有外网访问权限 |
