/**
 * 上传层：管理切片上传队列，best-effort 指数退避，网络差不停止录制。
 *
 * 职责：
 *   - 串行上传队列（一次 1 个）
 *   - 指数退避 + 随机 jitter（1s → 2s → 4s → ... → 60s 上限）
 *   - 上传成功后删除本地文件
 *   - 上传失败后进入 pendingQueue，等待补录
 *   - 不感知录制层状态，网络差时只降速不停止
 *
 * 与旧代码的区别：
 *   - 移除 MAX_PENDING / MAX_FAIL_ROUNDS 中止逻辑（录制永不因网络停止）
 *   - 移除 abortRecording 调用
 *   - stop 时 pendingQueue 积压 >5 片则持久化，≤5 片 flush 后残余也持久化兜底
 */

import fs from 'fs';
import path from 'path';

import { net } from 'electron';
import pRetry from 'p-retry';

import type { RecordingProgress } from '../../../../src/types/recorder';
import { createThrottledStream, getUploadBps, getUploadMbps, calculateUploadTimeout, updateBpsOnUploadResult, resetUploadBps } from './throttle';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface UploadConfig {
  /** 房间 ID */
  roomId: string;
  /** 会话 ID */
  sessionId: string;
  /** JWT token */
  authToken: string;
  /** API origin */
  apiOrigin: string;
}

export interface UploadCallbacks {
  /** 上传成功，更新进度 */
  onProgress?: (info: RecordingProgress) => void;
  /** 日志输出 */
  onLog?: (msg: string) => void;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** pRetry 首次上传重试次数（共 2 次尝试 = 1 首发 + 1 retry） */
const UPLOAD_MAX_RETRIES = 2;

/** 补录队列：每次补录最多处理的切片数 */
const RETRY_BATCH = 5;

/** 补录退避基础时间（ms），指数退避：1s, 2s, 4s, 8s, 16s, 32s, 60s（上限） */
const RETRY_BASE_MS = 1000;

/** 上传退避最大延迟（ms） */
const RETRY_MAX_MS = 60_000;

// ─── 模块级状态 ─────────────────────────────────────────────────────────────

let config: UploadConfig | null = null;
let callbacks: UploadCallbacks = {};
let uploadQueue: string[] = [];
let pendingQueue: string[] = [];
let isUploading = false;
let isRetryScheduled = false;
let consecutiveFailRounds = 0;
let isUserStopped = false;
let segmentKeys: string[] = [];
let uploadedCount = 0;
let retryTimerRef: ReturnType<typeof setInterval> | null = null;
let activeUploads = new Set<Promise<void>>();
let queuedFileNames = new Set<string>();

// ─── 公开 API ─────────────────────────────────────────────────────────────────

export function initUploader(
  cfg: UploadConfig,
  cbs: UploadCallbacks,
): void {
  config = cfg;
  callbacks = cbs;
  uploadQueue = [];
  pendingQueue = [];
  consecutiveFailRounds = 0;
  isUserStopped = false;
  segmentKeys = [];
  uploadedCount = 0;
  activeUploads.clear();
  queuedFileNames.clear();

  // 启动补录定时器：每 30s 检查一次
  retryTimerRef = setInterval(() => {
    if (isRetryScheduled) return;
    void triggerRetryQueue();
  }, 30_000);

  // 重置限速为初始基准（5 Mbps）
  resetUploadBps();

  cbs.onLog?.('[upload] 上传层初始化完成');
}

export function enqueueUpload(filePath: string): void {
  const fileName = path.basename(filePath);
  if (queuedFileNames.has(fileName)) return;
  queuedFileNames.add(fileName);

  uploadQueue.push(filePath);
  processUploadQueue();
}

export function enqueueRawUpload(filePath: string): void {
  // 转码失败后的降级：直接上传原始切片
  // 与 enqueueUpload 逻辑相同，只是记录日志区分
  const fileName = path.basename(filePath);
  callbacks.onLog?.(`[upload] 上传原始切片（转码失败降级）：${fileName}`);
  enqueueUpload(filePath);
}

/**
 * 串行上传队列处理：一次只上传一个切片，完成后自动处理下一个。
 * 通过 isUploading 标志防止并发，确保上传串行执行。
 */
async function processUploadQueue(): Promise<void> {
  if (isUploading || uploadQueue.length === 0) return;

  isUploading = true;
  const filePath = uploadQueue.shift()!;
  const fileName = path.basename(filePath);

  const uploadPromise = doUpload(filePath)
    .then(() => {
      callbacks.onProgress?.(getProgress());
    })
    .catch(() => {
      if (isUserStopped) return;
      callbacks.onLog?.(`[upload] 上传失败，加入 pendingQueue：${fileName}`);
      pendingQueue.push(filePath);
      callbacks.onProgress?.(getProgress());
    })
    .finally(() => {
      activeUploads.delete(uploadPromise);
      isUploading = false;
      // 自动处理队列中的下一个切片
      processUploadQueue();
    });

  activeUploads.add(uploadPromise);
}

export function getActiveUploads(): Set<Promise<void>> {
  return activeUploads;
}

export function getQueuedFileNames(): Set<string> {
  return queuedFileNames;
}

export function getPendingQueue(): string[] {
  return pendingQueue;
}

export function getSegmentKeys(): string[] {
  return segmentKeys;
}

export function getUploadedCount(): number {
  return uploadedCount;
}

/**
 * 等待上传队列完全排空（stop 时调用）。
 * 队列为空且没有正在上传的切片时返回。
 */
export async function waitForUploadQueue(): Promise<void> {
  while (uploadQueue.length > 0 || isUploading) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * stop 时补传临时目录中遗漏的切片。
 */
export function enqueueMissingFiles(tmpDir: string): void {
  try {
    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      if (f.endsWith('.ts') && !queuedFileNames.has(f)) {
        const filePath = path.join(tmpDir, f);
        callbacks.onLog?.(`[upload] 补传遗漏切片：${f}`);
        enqueueUpload(filePath);
      }
    }
  } catch (err) {
    callbacks.onLog?.(`[upload] 扫描遗漏切片失败：${(err as Error).message}`);
  }
}

/**
 * stop 时最后一轮直接补传 pendingQueue（绕过退避）。
 */
export async function flushPendingQueue(maxRounds = 2): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    if (pendingQueue.length === 0) break;
    callbacks.onLog?.(`[upload] flush 第 ${round + 1} 轮，剩余 ${pendingQueue.length} 片`);
    const batch = pendingQueue.splice(0, pendingQueue.length);
    for (const filePath of batch) {
      try {
        await doUpload(filePath);
        callbacks.onProgress?.(getProgress());
      } catch {
        pendingQueue.push(filePath);
      }
    }
  }
}

export function cleanupUploader(): void {
  isUserStopped = true;
  if (retryTimerRef) { clearInterval(retryTimerRef); retryTimerRef = null; }
  isRetryScheduled = false;
  pendingQueue = [];
  uploadQueue = [];
  isUploading = false;
  activeUploads.clear();
  queuedFileNames.clear();
}

/**
 * 更新上传层 JWT token（token 无感刷新后调用）。
 * 防止录制超过 token TTL（1h）时后续切片全部 401。
 */
export function updateAuthToken(token: string): void {
  if (config) config.authToken = token;
}

/**
 * 主进程自行刷新 accessToken（不依赖 renderer）。
 *
 * 录制期间 renderer 可能长时间无 HTTP 请求（用户切游戏窗口），
 * axios 拦截器的被动 401 → refresh 链不会触发。
 * 此函数在 Electron 主进程直接调用 /api/auth/refresh，
 * defaultSession 共享 renderer 的 HttpOnly refresh cookie。
 */
async function refreshTokenFromMainProcess(): Promise<string | null> {
  if (!config) return null;

  try {
    const response = await net.fetch(`${config.apiOrigin}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      callbacks.onLog?.('[upload] token 刷新失败：refresh 接口返回非 200');
      return null;
    }

    const data = await response.json();
    if (data.code !== 200 || !data.data?.accessToken) {
      callbacks.onLog?.('[upload] token 刷新失败：响应格式异常');
      return null;
    }

    const newToken = data.data.accessToken as string;
    config.authToken = newToken;
    callbacks.onLog?.('[upload] token 已刷新，后续上传使用新 token');
    return newToken;
  } catch (err) {
    callbacks.onLog?.(`[upload] token 刷新异常：${(err as Error).message}`);
    return null;
  }
}

// ─── 上传实现 ──────────────────────────────────────────────────────────────────

export async function doUpload(filePath: string): Promise<void> {
  if (!config) throw new Error('upload config not set');
  const cfg = config;

  const segmentName = path.basename(filePath);
  const objectKey = `cowatch/${cfg.roomId}/recordings/${cfg.sessionId}/${segmentName}`;

  // 自适应限速策略（队列感知 + 固定步长，硬顶封死）：
  // - 无积压（队列 ≤ 1 片）：bps=0，不限速
  // - 有积压（队列 > 1 片）：bps=SAFE_FLOOR~HARD_CEILING 之间的当前基准值
  //   → 连续稳定时缓慢上调（+0.5 Mbps/轮），波动时瞬时下调
  //   → 硬顶 7Mbps（70% 上行），游戏永远有 30% 头room
  const backlog = uploadQueue.length + pendingQueue.length;
  const bps = backlog > 1 ? getUploadBps() : 0;
  const fileSize = fs.statSync(filePath).size;
  const timeoutMs = calculateUploadTimeout(fileSize, bps);
  const startTime = Date.now();

  if (bps > 0) {
    callbacks.onLog?.(`[upload] 限速上传 ${segmentName}（积压 ${backlog} 片，${getUploadMbps().toFixed(1)}Mbps）`);
  }

  let tokenRefreshed = false;

  try {
    await pRetry(
      async () => {
        // 每次重试创建新的节流流（ReadableStream 是一次性的）
        const body = createThrottledStream(filePath, bps);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await net.fetch(
            `${cfg.apiOrigin}/api/rooms/${cfg.roomId}/recording/segment`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'video/MP2T',
                'X-Object-Key': objectKey,
                ...(cfg.authToken ? { 'Authorization': `Bearer ${cfg.authToken}` } : {}),
              },
              body,
              duplex: 'half',
              signal: controller.signal,
            } as RequestInit,
          );

          // 401 → 主进程自行刷新 token，不依赖 renderer
          if (response.status === 401 && !tokenRefreshed) {
            const newToken = await refreshTokenFromMainProcess();
            if (newToken) {
              tokenRefreshed = true;
              // config.authToken 已被 refreshTokenFromMainProcess 更新
              // throw 触发 pRetry 重试，回调闭包通过 cfg 引用读到新 token
              callbacks.onLog?.(`[upload] token 过期已刷新，重试上传：${segmentName}`);
              throw new Error(`Token expired, refreshed, retry: ${segmentName}`);
            }
            // 刷新失败 → 继续抛原始 401，走 pRetry 正常重试 / pendingQueue
          }

          if (!response.ok) {
            throw new Error(`上传失败 HTTP ${response.status}：${segmentName}`);
          }
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        retries: UPLOAD_MAX_RETRIES,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 8000,
        randomize: true,
        onFailedAttempt: (ctx) => {
          callbacks.onLog?.(`[upload] 上传失败，第 ${ctx.attemptNumber} 次：${segmentName}`);
        },
      },
    );
  } catch (err) {
    // 所有重试失败 — 反馈限速下调
    updateBpsOnUploadResult(fileSize, Date.now() - startTime, false);
    throw err;
  }

  // 上传成功 — 反馈限速（稳定累积 / 波动下调）
  updateBpsOnUploadResult(fileSize, Date.now() - startTime, true);

  segmentKeys.push(objectKey);
  uploadedCount = segmentKeys.length;
  try { fs.unlinkSync(filePath); } catch (err) {
    callbacks.onLog?.(`[upload] 删除临时文件失败：${filePath}，${(err as Error).message}`);
  }
}

// ─── 补录队列 ─────────────────────────────────────────────────────────────────

async function triggerRetryQueue(): Promise<void> {
  if (isUserStopped) return;
  if (pendingQueue.length === 0 && consecutiveFailRounds === 0) return;

  isRetryScheduled = true;

  try {
    // 指数退避 + 随机 jitter
    const jitter = Math.random() * 2000;
    const backoffMs = consecutiveFailRounds === 0
      ? 0
      : Math.min(RETRY_BASE_MS * Math.pow(2, consecutiveFailRounds - 1), RETRY_MAX_MS) + jitter;

    if (backoffMs > 0) {
      callbacks.onLog?.(`[upload] 补录退避 ${Math.round(backoffMs / 1000)}s（连续失败轮次：${consecutiveFailRounds}）`);
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }

    if (isUserStopped) return;

    const batch = pendingQueue.splice(0, RETRY_BATCH);
    if (batch.length === 0) return;

    callbacks.onLog?.(`[upload] 开始补录 ${batch.length} 个切片（队列剩余：${pendingQueue.length}）`);

    let batchHasSuccess = false;
    for (const filePath of batch) {
      if (isUserStopped) break;
      try {
        await doUpload(filePath);
        batchHasSuccess = true;
        callbacks.onLog?.(`[upload] 补录成功：${path.basename(filePath)}`);
        callbacks.onProgress?.(getProgress());
      } catch {
        pendingQueue.unshift(filePath);
        callbacks.onLog?.(`[upload] 补录失败（将重试）：${path.basename(filePath)}`);
      }
    }

    if (batchHasSuccess) {
      consecutiveFailRounds = 0;
    } else {
      consecutiveFailRounds += 1;
      callbacks.onLog?.(`[upload] 补录整批失败，连续失败轮次：${consecutiveFailRounds}`);
    }
  } finally {
    isRetryScheduled = false;
  }
}

function getProgress(): RecordingProgress {
  return {
    uploaded: uploadedCount,
    pending: pendingQueue.length,
  };
}
