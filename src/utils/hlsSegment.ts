/**
 * HLS 片段 URL 工具函数
 *
 * 纯函数，仅依赖 Web 标准 URL API，在以下环境均可直接使用：
 *   - 浏览器 Service Worker（sw.ts）
 *   - Electron 主进程 Node.js（electron/handlers/cache.ts）
 *
 * ⚠️ 不包含缓存实现和上报队列——两者依赖各自环境的网络 API（fetch vs net.fetch），
 * 不在此共享。
 */

// ─── 类型 ──────────────────────────────────────────────────────────────────────

export interface SegmentMeta {
  roomId: string;
  videoId: string;
  segmentName: string;
}

export interface SegmentViewItem extends SegmentMeta {
  userId: string;
  bytes: number;
}

// ─── 常量 ──────────────────────────────────────────────────────────────────────

/** 批量上报：队列满多少条立即 flush */
export const REPORT_QUEUE_MAX = 10;
/** 批量上报：最长等待多少毫秒后 flush */
export const REPORT_FLUSH_DELAY = 3000;

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 判断是否为需要缓存的 HLS 片段请求。
 *
 * 兼容两种 URL 格式：
 *   1. 旧格式（CDN 直链 / 本地 /uploads）：pathname 含 /cowatch/ 且以 .ts 结尾
 *   2. 新格式（后端代理路径）：pathname 含 /segments/ 且以 .ts 结尾
 *      → /api/rooms/{roomId}/videos/{videoId}/segments/{segmentName}.ts
 */
export function isHlsSegment(url: string): boolean {
  const { pathname } = new URL(url);
  if (!pathname.endsWith('.ts')) return false;
  return pathname.includes('/cowatch/') || pathname.includes('/segments/');
}

/**
 * 剥离时效签名 query 参数，返回纯路径 URL（用作 cache key）。
 *
 * 兼容两种签名模式：
 *   - CDN TypeA 鉴权：sign 参数
 *   - COS SDK 签名：q-sign-* 系列参数
 *
 * 同时剥离 uid（流量归因参数），避免同一片段因不同用户产生多条独立缓存。
 */
export function stripSignature(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('sign');
  u.searchParams.delete('uid');
  ['q-sign-algorithm', 'q-ak', 'q-sign-time', 'q-key-time', 'q-header-list', 'q-url-param-list', 'q-signature']
    .forEach((p) => u.searchParams.delete(p));
  return u.toString();
}

/**
 * 从 HLS 片段 URL 路径中解析 roomId、videoId、segmentName。
 *
 * 支持两种路径格式：
 *   旧格式（CDN 直链）：  /cowatch/{roomId}/{videoId}/{segmentName}.ts
 *   旧格式（本地上传）：  /uploads/cowatch/{roomId}/{videoId}/{segmentName}.ts
 *   新格式（后端代理）：  /api/rooms/{roomId}/videos/{videoId}/segments/{segmentName}.ts
 *                         （或 app://localhost/api/rooms/...）
 *
 * 返回 null 表示解析失败（不上报）。
 */
export function parseSegmentMeta(url: string): SegmentMeta | null {
  try {
    const { pathname } = new URL(url);

    // 新格式：/api/rooms/{roomId}/videos/{videoId}/segments/{segmentName}.ts
    const newMatch = pathname.match(/\/rooms\/([^/]+)\/videos\/([^/]+)\/segments\/([^/]+\.ts)$/);
    if (newMatch) {
      return { roomId: newMatch[1], videoId: newMatch[2], segmentName: newMatch[3] };
    }

    // 旧格式：/cowatch/{roomId}/{videoId}/{segmentName}.ts（含 /uploads/ 前缀）
    const oldMatch = pathname.match(/\/cowatch\/([^/]+)\/([^/]+)\/([^/]+\.ts)$/);
    if (oldMatch) {
      return { roomId: oldMatch[1], videoId: oldMatch[2], segmentName: oldMatch[3] };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 从 URL 的 uid query 参数中读取 userId。
 * 若参数不存在（本地模式）返回 'anonymous'。
 */
export function extractUserId(url: string): string {
  try {
    return new URL(url).searchParams.get('uid') ?? 'anonymous';
  } catch {
    return 'anonymous';
  }
}
