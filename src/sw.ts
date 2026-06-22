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
 *   - 剥离 CDN TypeA 签名（sign 参数）和 COS SDK 签名（q-sign-* 参数）
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
 * 后端上报地址（与主应用同源，SW 无法访问 localStorage，通过此接口写 DB）
 *
 * SW 运行在独立线程，拿不到 HttpOnly cookie，
 * 上报接口特意设计为无鉴权，安全风险在注释中说明。
 */
const REPORT_URL = '/api/rooms/segment-view';

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
 *   - 本地模式 COS SDK 签名：q-sign-* 系列参数，一并剥离
 */
function stripSignature(url: string): string {
  const u = new URL(url);
  // CDN TypeA 鉴权参数
  u.searchParams.delete('sign');
  // 流量归因参数（不参与验签，但需从 cache key 中剥离，否则同一片段因 uid 不同产生多条缓存）
  u.searchParams.delete('uid');
  // COS SDK 签名参数（本地模式）
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

/**
 * 从 URL 的 uid query 参数中读取 userId（后端生成 m3u8 时附加，不参与 CDN 签名）。
 *
 * 设计说明：
 *   CDN TypeA sign 的 uid 字段固定为 '0'，不承担业务语义。
 *   userId 作为独立的 &uid={userId} 参数附加在 URL 上，CDN 透传不干扰验签。
 *   SW 直接读取，逻辑清晰，无需任何字符串解析。
 *
 * 若参数不存在（本地模式）返回 'anonymous'。
 */
function extractUserId(url: string): string {
  try {
    return new URL(url).searchParams.get('uid') ?? 'anonymous';
  } catch {
    return 'anonymous';
  }
}

/**
 * 从 HLS 片段 URL 的路径中解析 roomId、videoId、segmentName。
 *
 * COS/CDN 路径格式：/cowatch/{roomId}/{videoId}/{segmentName}.ts
 * 本地路径格式：   /uploads/cowatch/{roomId}/{videoId}/{segmentName}.ts
 *
 * 返回 null 表示解析失败（不上报）。
 */
function parseSegmentMeta(url: string): {
  roomId: string;
  videoId: string;
  segmentName: string;
} | null {
  try {
    const { pathname } = new URL(url);
    // 匹配 /cowatch/{roomId}/{videoId}/{segmentName}.ts
    const match = pathname.match(/\/cowatch\/([^/]+)\/([^/]+)\/([^/]+\.ts)$/);
    if (!match) return null;
    return { roomId: match[1], videoId: match[2], segmentName: match[3] };
  } catch {
    return null;
  }
}

// ─── 批量上报队列 ─────────────────────────────────────────────────────────────

interface SegmentViewItem {
  roomId: string;
  videoId: string;
  segmentName: string;
  userId: string;
  bytes: number;
}

/**
 * 待上报队列，满 10 条或超过 3 秒自动 flush。
 *
 * 为什么批量上报：
 *   HLS 首次播放 / seek 时会短时间内连续触发多个片段请求，
 *   批量合并为单次 POST，减少数据库写入次数，
 *   对播放体验零影响（fire-and-forget）。
 */
const reportQueue: SegmentViewItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const QUEUE_MAX = 10;    // 满 10 条立即 flush
const FLUSH_DELAY = 3000; // 最长等待 3 秒

function flushReportQueue(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (reportQueue.length === 0) return;

  const items = reportQueue.splice(0, reportQueue.length);
  fetch(REPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  }).catch(() => {
    // 上报失败静默忽略，不影响播放体验
  });
}

/**
 * 将一条片段下载记录入队，达到阈值或超时后批量上报。
 */
function reportSegmentView(
  meta: { roomId: string; videoId: string; segmentName: string },
  userId: string,
  bytes: number,
): void {
  reportQueue.push({ ...meta, userId, bytes });

  if (reportQueue.length >= QUEUE_MAX) {
    // 队列已满，立即 flush
    flushReportQueue();
  } else if (flushTimer === null) {
    // 启动定时器，最多等待 FLUSH_DELAY 后 flush
    flushTimer = setTimeout(flushReportQueue, FLUSH_DELAY);
  }
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
        const cloned = response.clone();
        await cache.put(cacheKey, cloned);
        console.log('[SW] 已缓存：', cacheKeyUrl);

        // 上报真实 CDN 下载记录（fire-and-forget，不影响播放）
        const meta = parseSegmentMeta(event.request.url);
        if (meta) {
          // userId：从 URL 的 uid 参数读取（由后端生成 m3u8 时附加）
          const userId = extractUserId(event.request.url);
          // bytes：从 Content-Length 响应头读取（CDN 通常会返回此头）
          const bytes = parseInt(response.headers.get('content-length') ?? '0', 10);
          reportSegmentView(meta, userId, bytes);
        }
      }
      return response;
    } catch (err) {
      console.error('[SW] 网络请求失败：', cacheKeyUrl, err);
      // 网络失败时透传错误（不降级到旧缓存，避免使用过期片段）
      throw err;
    }
  })());
});
