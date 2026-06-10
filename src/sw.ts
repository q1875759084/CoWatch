/**
 * CoWatch Service Worker
 *
 * 缓存策略：完整文件缓存 + ReadableStream 流式切片
 *
 * Cache API 只能存储 200 响应，不支持 206（Partial）响应。
 * 因此：
 *   - 首次遇到视频请求时，发起无 Range 头的完整请求，将 200 响应存入缓存
 *   - 后续的 Range 请求：从缓存响应的 ReadableStream 中流式跳过前 N 字节，
 *     只传输目标区间的数据，构造 206 响应返回给播放器
 *   - 流式切片避免了将整个文件读入 ArrayBuffer（V1 方案的性能陷阱）
 *
 * 缓存时机：
 *   - 按需缓存（play-through caching）：SW fetch 拦截器在首次请求时自动缓存整个文件
 *   - 不做预缓存：播放哪个视频才缓存哪个，避免进房间就下载全部视频
 */

// @ts-nocheck — sw.ts 使用 WebWorker lib，与主应用的 dom lib 冲突，
// 类型检查由 tsconfig.sw.json 单独负责，IDE 的主 tsconfig 跳过此文件
/// <reference lib="webworker" />

const CACHE_NAME = 'cowatch-video-v1';

/** 动态注入的外部视频域名（COS / CDN），通过 postMessage 添加 */
const VIDEO_ORIGINS: string[] = [];
const VIDEO_PATH_PREFIX = '/uploads/';

function isVideoRequest(request: Request): boolean {
  const url = new URL(request.url);
  // 同域：本地存储模式，路径以 /uploads/ 开头
  if (url.origin === self.location.origin && url.pathname.startsWith(VIDEO_PATH_PREFIX)) {
    return true;
  }
  // 跨域：COS / CDN 域名，由前端通过 postMessage 动态注入到 VIDEO_ORIGINS
  return VIDEO_ORIGINS.some((origin) => url.origin === origin);
}

/** 解析 Range 请求头，返回 { start, end } 或 null */
function parseRange(
  rangeHeader: string,
  totalSize: number,
): { start: number; end: number } | null {
  const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
  if (start > end || start >= totalSize) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}

/**
 * 从缓存的完整响应（200）中流式切出 Range 区间，返回 206 响应。
 *
 * 使用 ReadableStream + TransformStream 实现字节级流式跳过，
 * 避免将整个文件读入 ArrayBuffer（V1 的性能问题）。
 */
function buildRangeResponseFromStream(
  cachedResponse: Response,
  range: { start: number; end: number },
  totalSize: number,
  contentType: string,
): Response {
  const { start, end } = range;
  const chunkSize = end - start + 1;

  // 用 TransformStream 实现字节级流式跳过
  let bytesSkipped = 0;   // 已跳过的字节数（start 之前的部分）
  let bytesSent = 0;      // 已发送的字节数

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // 当前 chunk 在整个响应流中的起止位置
      const chunkStart = bytesSkipped + bytesSent;
      const chunkEnd = chunkStart + chunk.byteLength - 1;

      // 完全在目标区间之前 → 跳过整个 chunk
      if (chunkEnd < start) {
        bytesSkipped += chunk.byteLength;
        return;
      }

      // 完全在目标区间之后 → 终止流
      if (chunkStart > end) {
        controller.terminate();
        return;
      }

      // 部分或全部在目标区间内 → 切片后发送
      const sliceFrom = Math.max(0, start - chunkStart);
      const sliceTo = Math.min(chunk.byteLength, end - chunkStart + 1);
      const slice = chunk.slice(sliceFrom, sliceTo);
      bytesSkipped = Math.min(bytesSkipped + sliceFrom, start);
      bytesSent += slice.byteLength;
      controller.enqueue(slice);

      // 已发送够了 → 终止流
      if (bytesSent >= chunkSize) {
        controller.terminate();
      }
    },
  });

  // 将缓存响应的 body 管道到 TransformStream
  cachedResponse.clone().body!.pipeTo(writable).catch(() => {
    // pipeTo 在 terminate 后会抛 AbortError，属于正常情况，忽略
  });

  return new Response(readable, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(chunkSize),
      'Accept-Ranges': 'bytes',
    },
  });
}

// ─── message：运行时动态注入视频域名 ─────────────────────────────────────────
//
// 视频存储在 COS / CDN 时，URL 的 origin 与页面域名不同，SW 无法通过编译时硬编码。
// 前端拿到视频 URL 后提取 origin，通过 postMessage 告知 SW 动态添加到白名单。
//
self.addEventListener('message', (event) => {
  const { type, origin } = event.data ?? {};
  if (type === 'ADD_VIDEO_ORIGIN' && origin && !VIDEO_ORIGINS.includes(origin)) {
    VIDEO_ORIGINS.push(origin);
    console.log('[SW] 已添加视频 origin 白名单：', origin);
  }
});

// ─── install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', () => {
  console.log('[SW] install');
  self.skipWaiting();
});

// ─── activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] activate');
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ─── fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!isVideoRequest(request)) return;

  const rangeHeader = request.headers.get('Range');

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 缓存 key 统一为不带 Range 头的请求，确保所有分段请求命中同一条目
      const cacheKey = new Request(request.url, { headers: {} });
      const cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        console.log('[SW] 缓存命中：', request.url, rangeHeader ?? '(完整请求)');
        if (!rangeHeader) {
          return cachedResponse.clone();
        }
        // 从 Content-Length 获取文件总大小
        const totalSize = parseInt(cachedResponse.headers.get('Content-Length') || '0', 10);
        const contentType = cachedResponse.headers.get('Content-Type') || 'video/mp4';
        if (!totalSize) {
          // 没有 Content-Length，退化为直接返回完整响应
          return cachedResponse.clone();
        }
        const range = parseRange(rangeHeader, totalSize);
        if (!range) {
          return cachedResponse.clone();
        }
        return buildRangeResponseFromStream(cachedResponse, range, totalSize, contentType);
      }

      // 未命中：发起完整请求（去掉 Range 头）
      console.log('[SW] 缓存未命中，发起完整请求：', request.url);
      let fullResponse: Response;
      try {
        fullResponse = await fetch(new Request(request.url, {
          method: 'GET',
          headers: { 'Cache-Control': 'no-cache' },
          credentials: request.credentials,
        }));
      } catch (err) {
        console.error('[SW] 网络请求失败：', err);
        return fetch(request);
      }

      if (!fullResponse.ok) {
        console.warn('[SW] 响应异常，不缓存：', fullResponse.status, request.url);
        return fullResponse;
      }

      // 存入缓存（clone 一份留给缓存，原始用于返回）
      event.waitUntil(
        cache.put(cacheKey, fullResponse.clone()).then(() => {
          console.log('[SW] 已缓存：', request.url);
        }),
      );

      // 如果原始请求带了 Range，从刚拉到的响应里流式切片返回
      if (rangeHeader) {
        const totalSize = parseInt(fullResponse.headers.get('Content-Length') || '0', 10);
        const contentType = fullResponse.headers.get('Content-Type') || 'video/mp4';
        if (totalSize) {
          const range = parseRange(rangeHeader, totalSize);
          if (range) {
            return buildRangeResponseFromStream(fullResponse, range, totalSize, contentType);
          }
        }
      }

      return fullResponse.clone();
    })(),
  );
});
