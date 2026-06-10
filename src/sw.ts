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
 *
 * 视频识别策略：
 *   - 基于路径特征判断（pathname 以 /cowatch/ 开头且以 .mp4 结尾）
 *   - 不依赖域名白名单，因此对 COS 默认域名、CDN 自定义域名、本地 /uploads 均统一生效
 *   - 无需 postMessage 动态注入域名，消除了时序竞态问题
 *
 * 时效签名兼容：
 *   - COS 私有读模式下，videoUrl 携带时效签名 query 参数（q-sign-*）
 *   - cache key 统一剥离签名参数，以纯路径作为 Cache Storage key
 *   - 签名轮换后同一视频仍能命中缓存，缓存有效期不受签名过期影响
 */

// @ts-nocheck — sw.ts 使用 WebWorker lib，与主应用的 dom lib 冲突，
// 类型检查由 tsconfig.sw.json 单独负责，IDE 的主 tsconfig 跳过此文件
/// <reference lib="webworker" />

const CACHE_NAME = 'cowatch-video-v2';

/**
 * 判断是否为需要 SW 缓存的视频请求。
 *
 * 基于路径特征：pathname 以 /cowatch/ 开头且以 .mp4 结尾。
 * objectKey 格式固定为 cowatch/{roomId}/{uuid}-{fileName}.mp4，
 * 无论域名如何（COS 默认域名 / CDN 自定义域名 / 本地 /uploads），路径特征不变。
 */
function isVideoRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname.startsWith('/cowatch/') && pathname.endsWith('.mp4');
}

/**
 * 剥离腾讯云 COS / CDN 时效签名 query 参数，返回纯路径 URL（用作 cache key）。
 *
 * COS 签名参数：q-sign-algorithm, q-ak, q-sign-time, q-key-time, q-header-list,
 *               q-url-param-list, q-signature
 * 剥离后 URL 仅保留 scheme + host + pathname，与签名无关，同一视频始终命中同一缓存条目。
 */
function stripCosSignature(url: string): string {
  const u = new URL(url);
  [
    'q-sign-algorithm',
    'q-ak',
    'q-sign-time',
    'q-key-time',
    'q-header-list',
    'q-url-param-list',
    'q-signature',
  ].forEach((p) => u.searchParams.delete(p));
  return u.toString();
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

  let bytesSkipped = 0;
  let bytesSent = 0;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const chunkStart = bytesSkipped + bytesSent;
      const chunkEnd = chunkStart + chunk.byteLength - 1;

      if (chunkEnd < start) {
        bytesSkipped += chunk.byteLength;
        return;
      }

      if (chunkStart > end) {
        controller.terminate();
        return;
      }

      const sliceFrom = Math.max(0, start - chunkStart);
      const sliceTo = Math.min(chunk.byteLength, end - chunkStart + 1);
      const slice = chunk.slice(sliceFrom, sliceTo);
      bytesSkipped = Math.min(bytesSkipped + sliceFrom, start);
      bytesSent += slice.byteLength;
      controller.enqueue(slice);

      if (bytesSent >= chunkSize) {
        controller.terminate();
      }
    },
  });

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

      // cache key：剥离时效签名参数，同一视频始终命中同一缓存条目
      const cacheKeyUrl = stripCosSignature(request.url);
      const cacheKey = new Request(cacheKeyUrl, { headers: {} });
      const cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        console.log('[SW] 缓存命中：', cacheKeyUrl, rangeHeader ?? '(完整请求)');
        if (!rangeHeader) {
          return cachedResponse.clone();
        }
        const totalSize = parseInt(cachedResponse.headers.get('Content-Length') || '0', 10);
        const contentType = cachedResponse.headers.get('Content-Type') || 'video/mp4';
        if (!totalSize) {
          return cachedResponse.clone();
        }
        const range = parseRange(rangeHeader, totalSize);
        if (!range) {
          return cachedResponse.clone();
        }
        return buildRangeResponseFromStream(cachedResponse, range, totalSize, contentType);
      }

      // 未命中：用原始带签名的 URL 发完整请求（有权限访问 COS），去掉 Range 头
      console.log('[SW] 缓存未命中，发起完整请求：', cacheKeyUrl);
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
        console.warn('[SW] 响应异常，不缓存：', fullResponse.status, cacheKeyUrl);
        return fullResponse;
      }

      // 以剥离签名后的 URL 为 key 存入缓存
      event.waitUntil(
        cache.put(cacheKey, fullResponse.clone()).then(() => {
          console.log('[SW] 已缓存：', cacheKeyUrl);
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
