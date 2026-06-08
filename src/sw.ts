/**
 * CoWatch Service Worker
 *
 * 职责：拦截视频资源请求（/uploads/ 和 CDN 域名），将完整响应缓存到
 * Cache Storage，后续 Range 请求直接从缓存切片返回，避免重复的网络请求。
 *
 * 缓存策略：
 *   - 视频文件（/uploads/ 或配置的 CDN origin）→ Cache-First + Range 重组
 *   - 其他请求 → 直接透传，不干预
 *
 * Range 请求处理逻辑：
 *   浏览器播放器会用 Range 请求分段拉取视频（如 bytes=0-65535）。
 *   SW 第一次遇到某个视频时，发起一次完整请求（不带 Range）将整个文件
 *   存入 Cache Storage；后续所有 Range 请求直接从缓存的 ArrayBuffer
 *   中切片返回 206 Partial Content，不再产生任何网络流量。
 */

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'cowatch-video-v1';

// 匹配需要缓存的视频路径前缀（本地开发 + 未来 CDN 域名都在这里配置）
// CDN 接入后在此追加对应 origin，如 'https://cdn.cowatch.example.com'
const VIDEO_ORIGINS: string[] = [
  // 本地开发：视频走 /uploads/ 路径
  // （SW 只能拦截同 origin 的请求，proxy 后 /uploads/ 属于同 origin，可拦截）
];
const VIDEO_PATH_PREFIX = '/uploads/';

/** 判断一个请求是否是需要被 SW 缓存的视频请求 */
function isVideoRequest(request: Request): boolean {
  const url = new URL(request.url);
  // 同 origin 下 /uploads/ 路径
  if (url.origin === self.location.origin && url.pathname.startsWith(VIDEO_PATH_PREFIX)) {
    return true;
  }
  // 配置的 CDN origin
  if (VIDEO_ORIGINS.some((origin) => url.origin === origin)) {
    return true;
  }
  return false;
}

/** 解析 Range 请求头，返回 { start, end } 或 null（表示请求整个文件）*/
function parseRange(rangeHeader: string | null, totalSize: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
  return { start, end };
}

/** 用缓存的完整响应 + Range 参数，构造 206 Partial Content 响应 */
async function buildRangeResponse(
  cachedResponse: Response,
  rangeHeader: string,
): Promise<Response> {
  const arrayBuffer = await cachedResponse.clone().arrayBuffer();
  const totalSize = arrayBuffer.byteLength;
  const range = parseRange(rangeHeader, totalSize);

  if (!range) {
    // Range 格式解析失败，返回完整内容
    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': cachedResponse.headers.get('Content-Type') || 'video/mp4',
        'Content-Length': String(totalSize),
      },
    });
  }

  const { start, end } = range;
  const slicedBuffer = arrayBuffer.slice(start, end + 1);

  return new Response(slicedBuffer, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cachedResponse.headers.get('Content-Type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(slicedBuffer.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

// ─── install：跳过等待，立即激活 ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] install');
  self.skipWaiting();
});

// ─── message：接收页面指令 ────────────────────────────────────────────────────
/**
 * 预缓存指令：PRECACHE_VIDEOS
 * 页面在拿到视频列表后通过 postMessage 发送此指令，SW 在后台逐个下载并缓存，
 * 确保用户播放前缓存已经就绪，解决"SW 激活晚于首次视频请求"导致的缓存miss问题。
 *
 * 消息格式：{ type: 'PRECACHE_VIDEOS', urls: string[] }
 */
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'PRECACHE_VIDEOS') return;

  const urls: string[] = event.data.urls ?? [];
  if (urls.length === 0) return;

  console.log('[SW] 收到预缓存指令，共', urls.length, '个视频：', urls);

  // 在后台逐个预缓存，不阻塞页面
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const url of urls) {
        // 跳过不属于我们管理的 URL
        if (!isVideoRequest(new Request(url))) {
          console.log('[SW] 预缓存跳过（非视频 URL）：', url);
          continue;
        }
        // 已缓存则跳过，不重复下载
        const cacheKey = new Request(url, { headers: {} });
        const existing = await cache.match(cacheKey);
        if (existing) {
          console.log('[SW] 预缓存跳过（已有缓存）：', url);
          continue;
        }
        try {
          console.log('[SW] 预缓存开始下载：', url);
          const response = await fetch(new Request(url, {
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache' },
          }));
          if (response.ok || response.status === 206) {
            await cache.put(cacheKey, response);
            console.log('[SW] 预缓存完成：', url);
          } else {
            console.warn('[SW] 预缓存失败（响应异常）：', url, response.status);
          }
        } catch (err) {
          console.warn('[SW] 预缓存失败（网络错误）：', url, err);
        }
      }
      console.log('[SW] 全部预缓存任务完成');
    })(),
  );
});

// ─── activate：清理旧版本缓存，接管所有页面 ────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] activate');
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log('[SW] 删除旧缓存：', key);
            return caches.delete(key);
          }),
      ),
    ).then(() => self.clients.claim()),
  );
});

// ─── fetch：核心拦截逻辑 ─────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只处理 GET 请求
  if (request.method !== 'GET') return;

  // 只处理视频请求
  if (!isVideoRequest(request)) return;

  const rangeHeader = request.headers.get('Range');

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // 构造无 Range 的缓存查找 key（缓存中存的是完整文件）
      const cacheKey = new Request(request.url, { headers: {} });
      const cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        // 命中缓存
        console.log('[SW] 缓存命中：', request.url, rangeHeader || '(完整请求)');
        if (rangeHeader) {
          return buildRangeResponse(cachedResponse, rangeHeader);
        }
        return cachedResponse.clone();
      }

      // 未命中缓存：发起完整请求（去掉 Range，拉取整个文件）
      console.log('[SW] 缓存未命中，发起完整请求：', request.url);
      const fullRequest = new Request(request.url, {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
        credentials: request.credentials,
      });

      let fullResponse: Response;
      try {
        fullResponse = await fetch(fullRequest);
      } catch (err) {
        console.error('[SW] 网络请求失败：', err);
        // 网络失败时直接透传原始请求，不做缓存
        return fetch(request);
      }

      if (!fullResponse.ok && fullResponse.status !== 206) {
        console.warn('[SW] 响应异常，不缓存：', fullResponse.status, request.url);
        return fullResponse;
      }

      // 将完整响应存入缓存（clone 一份，原始响应用于返回）
      const responseToCache = fullResponse.clone();
      event.waitUntil(
        cache.put(cacheKey, responseToCache).then(() => {
          console.log('[SW] 已缓存：', request.url);
        }),
      );

      // 如果原始请求带了 Range，从刚拉到的完整响应中切片返回
      if (rangeHeader) {
        return buildRangeResponse(fullResponse.clone(), rangeHeader);
      }

      return fullResponse;
    })(),
  );
});
