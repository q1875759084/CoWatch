/**
 * CoWatch Service Worker — HLS 片段 cache-first
 *
 * 缓存策略：cache-first for HLS .ts 片段
 *
 * 背景：
 *   原 sw.ts 实现（~300 行）为了解决 Cache API 不支持 206 Partial 的问题，
 *   使用 TransformStream 流式切片 + inFlight 去重 Map，复杂度高且存在并发 bug。
 *
 *   HLS 架构下，每个 .ts 片段本身就是一个完整的 200 响应（通常 ~7MB），
 *   Cache API 原生支持，无需任何 Range 切片逻辑。
 *   SW 退化为标准 cache-first，代码量从 ~300 行降到 ~80 行，所有并发 bug 自然消除。
 *
 * 缓存范围：
 *   - 拦截：pathname 包含 /cowatch/ 且以 .ts 结尾的 GET 请求（HLS 片段）
 *   - 不拦截：.m3u8 请求（由后端动态生成，含实时签名，不适合缓存）
 *
 * cache key：
 *   - 剥离 CDN TypeA 签名（sign 参数）和 COS 直连签名（q-sign-* 参数）
 *   - 同一片段无论签名如何轮换，始终命中同一缓存条目
 *
 * 缓存收益：
 *   - 第二次播放同一视频：所有 .ts 片段均从 Cache Storage 返回，0 网络流量
 *   - seek 到已播放区域：从缓存立即返回，无需等待网络
 */

// @ts-nocheck — sw.ts 使用 WebWorker lib，与主应用的 dom lib 冲突，
// 类型检查由 tsconfig.sw.json 单独负责，IDE 的主 tsconfig 跳过此文件
/// <reference lib="webworker" />

const CACHE_NAME = 'cowatch-hls-v1';

/**
 * 判断是否为需要 SW 缓存的 HLS 片段请求。
 *
 * 基于路径特征：
 *   - pathname 包含 /cowatch/（匹配 COS/CDN 和本地 /uploads/cowatch/ 两种模式）
 *   - pathname 以 .ts 结尾（HLS 片段，非 .m3u8）
 */
function isHlsSegment(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname.includes('/cowatch/') && pathname.endsWith('.ts');
}

/**
 * 剥离时效签名 query 参数，返回纯路径 URL（用作 cache key）。
 *
 * 兼容两种签名模式：
 *   - CDN TypeA 鉴权：sign={timestamp}-{rand}-{uid}-{md5}，剥离 sign 参数
 *   - COS 直连签名（本地开发 / 未配置 CDN 鉴权）：q-sign-* 系列参数，一并剥离
 */
function stripSignature(url: string): string {
  const u = new URL(url);
  // CDN TypeA 鉴权参数
  u.searchParams.delete('sign');
  // COS 直连签名参数
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

// ─── install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', () => {
  console.log('[SW] install (HLS cache-first)');
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
            .map((key) => {
              console.log('[SW] 清理旧缓存:', key);
              return caches.delete(key);
            }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ─── fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!isHlsSegment(event.request)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // cache key：剥离签名参数，同一片段无论签名轮换始终命中同一条目
    const cacheKeyUrl = stripSignature(event.request.url);
    const cacheKey = new Request(cacheKeyUrl, { headers: {} });

    // 命中缓存：直接返回
    const cached = await cache.match(cacheKey);
    if (cached) {
      console.log('[SW] 缓存命中：', cacheKeyUrl);
      return cached;
    }

    // 未命中：发起网络请求并存入缓存
    console.log('[SW] 缓存未命中，发起请求：', cacheKeyUrl);
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        // 仅缓存 200 响应（HLS 片段均为完整 200，无需处理 206）
        await cache.put(cacheKey, response.clone());
        console.log('[SW] 已缓存：', cacheKeyUrl);
      }
      return response;
    } catch (err) {
      console.error('[SW] 网络请求失败：', cacheKeyUrl, err);
      // 网络失败时透传错误（不降级到旧缓存，避免使用过期片段）
      throw err;
    }
  })());
});
