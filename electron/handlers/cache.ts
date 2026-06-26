/**
 * Electron HLS 片段文件缓存
 *
 * 职责：在 Main 进程层拦截 HLS .ts 片段请求，实现 cache-first 策略，
 * 替代浏览器环境下的 Service Worker（SW 在 app:// 协议下无法注册）。
 *
 * 与 sw.ts 的业务逻辑共享同一个工具模块 src/utils/hlsSegment.ts，
 * 但存储层（Cache API vs fs）和网络层（fetch vs net.fetch）各自独立实现。
 *
 * 缓存目录：userData/hls-cache/{cacheKey}
 *   - userData 是 Electron 提供的用户数据目录（各平台路径不同）
 *   - cacheKey 取自剥离签名后的 URL pathname，去掉前导 /，/ 替换为 _
 *
 * ─── 新格式切片（后端代理路径）处理流程 ─────────────────────────────────────
 *
 * 自 refactor-hls-segment-proxy 变更后，m3u8 中切片 URL 改为：
 *   /api/rooms/{roomId}/videos/{videoId}/segments/{segmentName}.ts
 *
 * 在 Electron 中，此请求以 app://localhost/api/rooms/... 发出，流程如下：
 *   1. main.ts protocol.handle 先判断 isHlsSegment → true（含 /segments/）
 *   2. 进入 handleHlsSegment
 *   3. realUrl 替换 app://localhost → apiOrigin
 *      → http://backend/api/rooms/{roomId}/videos/{videoId}/segments/{segmentName}.ts
 *   4. net.fetch(realUrl) → 后端校验权限 → 302 重定向到 CDN 签名 URL
 *   5. net.fetch 自动跟随 302，获取 CDN 响应
 *   6. 写入本地 cache（cache key = pathname，无签名参数，可复用）
 *   7. parseSegmentMeta(realUrl) 解析 roomId/videoId/segmentName（新格式 regex 已支持）
 *   8. extractUserId(realUrl) 返回 'anonymous'（后端代理路径无 uid 参数，可接受）
 */

import fs from 'fs';
import path from 'path';
import { app, net } from 'electron';
import {
  isHlsSegment,
  stripSignature,
  parseSegmentMeta,
  extractUserId,
  SegmentViewItem,
  REPORT_QUEUE_MAX,
  REPORT_FLUSH_DELAY,
} from '../../src/utils/hlsSegment';

export { isHlsSegment };

// ─── 缓存目录初始化 & 老化清理 ────────────────────────────────────────────────

let cacheDir: string;

/** 缓存文件最大存活天数：从写入之日起超过此天数后在下次启动时删除 */
const CACHE_TTL_DAYS = 7;

/**
 * 清理写入时间超过 TTL 天数的 .ts 缓存文件。
 * 在 initHlsCache 末尾异步执行，不阻塞启动流程。
 *
 * 使用 mtime（写入时间）而非 atime（最后访问时间）：
 *   - Windows 默认禁用 atime 更新（NtfsDisableLastAccessUpdate），
 *     atime 永远停在文件创建时刻，不可靠。
 *   - cache-first 策略下缓存一旦写入就不会被重新下载，mtime 从不更新，
 *     因此 mtime 就等于"写入时间"，TTL 效果是：缓存文件最多存活 7 天。
 */
function evictStaleCacheFiles(): void {
  const cutoff = Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  fs.readdir(cacheDir, (err, files) => {
    if (err) return;
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const filePath = path.join(cacheDir, file);
      fs.stat(filePath, (statErr, stat) => {
        if (statErr) return;
        if (stat.mtimeMs < cutoff) {
          fs.unlink(filePath, () => {
            // 删除失败静默忽略（文件可能已被其他进程删除）
          });
        }
      });
    }
  });
}

export function initHlsCache(): void {
  cacheDir = path.join(app.getPath('userData'), 'hls-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  // 异步清理过期缓存，不阻塞启动
  evictStaleCacheFiles();
}

// ─── 缓存文件路径 ──────────────────────────────────────────────────────────────

/**
 * 将 cache key URL 转换为本地文件路径。
 * 取 pathname（剥离签名后），去掉前导 /，把 / 替换为 _。
 *
 * 示例：
 *   /cowatch/ROOM1/VIDEO1/seg001.ts → cowatch_ROOM1_VIDEO1_seg001.ts
 *   /uploads/cowatch/ROOM1/VIDEO1/seg001.ts → uploads_cowatch_ROOM1_VIDEO1_seg001.ts
 */
function toCacheFilePath(cacheKeyUrl: string): string {
  const { pathname } = new URL(cacheKeyUrl);
  const filename = pathname.replace(/^\//, '').replace(/\//g, '_');
  return path.join(cacheDir, filename);
}

// ─── 批量上报队列 ──────────────────────────────────────────────────────────────

/** API_ORIGIN 由 main.ts 在调用 initHlsCache 前通过 setApiOrigin 注入 */
let apiOrigin = 'http://localhost:3002';
export function setApiOrigin(origin: string): void {
  apiOrigin = origin;
}

const reportQueue: SegmentViewItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushReportQueue(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (reportQueue.length === 0) return;

  const items = reportQueue.splice(0, reportQueue.length);
  // net.fetch 在 Main 进程中携带 Electron session cookie，无需额外鉴权处理
  // ⚠️ 有 body 的请求必须加 duplex: 'half'（Node.js undici 规范要求）
  net.fetch(`${apiOrigin}/api/rooms/segment-view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
    duplex: 'half',
  } as RequestInit).catch(() => {
    // 上报失败静默忽略，不影响播放体验
  });
}

function enqueueReport(
  meta: { roomId: string; videoId: string; segmentName: string },
  userId: string,
  bytes: number,
): void {
  reportQueue.push({ ...meta, userId, bytes });
  if (reportQueue.length >= REPORT_QUEUE_MAX) {
    flushReportQueue();
  } else if (flushTimer === null) {
    flushTimer = setTimeout(flushReportQueue, REPORT_FLUSH_DELAY);
  }
}

// ─── 核心：cache-first 处理 ───────────────────────────────────────────────────

/**
 * 处理 HLS 片段请求，实现 cache-first 策略。
 *
 * 调用方（main.ts）负责判断 isHlsSegment 后再调用此函数。
 * 返回 net.fetch Response，供 protocol.handle 直接 return。
 */
export async function handleHlsSegment(request: Request): Promise<Response> {
  const cacheKeyUrl = stripSignature(request.url);
  const filePath = toCacheFilePath(cacheKeyUrl);

  // ── 命中缓存：直接从文件系统读取 ────────────────────────────────────────
  if (fs.existsSync(filePath)) {
    return net.fetch(`file://${filePath}`);
  }

  // ── 未命中：发起真实网络请求 ─────────────────────────────────────────────
  // ⚠️ request.url 是 app://localhost/api/rooms/...，不能直接传给 net.fetch，
  // 否则会递归触发 protocol.handle。必须替换为真实后端地址（http://...）。
  const realUrl = request.url.replace(/^app:\/\/[^/]+/, apiOrigin);
  const response = await net.fetch(realUrl, {
    headers: request.headers,
  });

  if (response.ok) {
    // 克隆响应，异步写入缓存（不阻塞返回）
    const arrayBuffer = await response.clone().arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFile(filePath, buffer, (err) => {
      if (err) console.error('[HLS cache] write error:', filePath, err);
    });

    // 上报真实 CDN 下载记录
    const meta = parseSegmentMeta(realUrl);
    if (meta) {
      const userId = extractUserId(realUrl);
      const bytes = parseInt(response.headers.get('content-length') ?? '0', 10) || buffer.byteLength;
      enqueueReport(meta, userId, bytes);
    }
  }

  return response;
}
