/**
 * 上传限速模块：创建节流的 Web ReadableStream，按固定速率从磁盘读块并 enqueue。
 *
 * 原理：
 *   - net.fetch 接收 ReadableStream 作为 body 时，会等待每个 chunk 入队后才发送
 *   - 在 pull() 中读完一块后 setTimeout 延迟，控制下一个 chunk 的入队时机
 *   - 从而在应用层实现上传速率限制，不依赖 OS 级 TC/TOS 控制
 *
 * 自适应限速策略（队列感知 + 固定步长，硬顶封死）：
 *   - 无积压（队列 ≤ 1 片）：bps=0，不限速，让 TCP 背压自然控制
 *   - 有积压（队列 > 1 片）：bps=SAFE_FLOOR~HARD_CEILING 之间的自适应值
 *   - 上调（保守）：连续 STABLE_COUNT 次稳定上传 → base + STEP_UP（硬顶截断）
 *   - 下调（瞬时）：单次 actualBps < base × 85% → base = max(actualBps, SAFE_FLOOR)
 *   - 上传失败 → base = max(base × 0.5, SAFE_FLOOR)
 *   - 硬顶 HARD_CEILING = 7Mbps（70% 上行占用），永不超过——游戏永远有 30% 头room
 *   - 上调只在积压期间发生，不限速期间不参与调整
 *
 * 假设：用户上行 10 Mbps（100Mbps 套餐下行，典型上行 1/5~1/10）
 *   - 3 Mbps 硬底：波动最差时的安全点（30% 上行，游戏有 7 Mbps 头room）
 *   - 5 Mbps 起步：50% 上行，保守
 *   - 7 Mbps 硬顶：70% 上行，永远留 3 Mbps 给游戏
 *   - 4 分钟从 3 恢复到 7（8 轮 × 3 次确认 × 10s 片长）
 *
 * 注意：
 *   - ReadableStream 是一次性的，pRetry 每次重试需创建新 stream
 *   - 文件句柄在 cancel/error/EOF 时自动关闭
 *   - controller.error() 用 try/catch 包裹，避免 cancel 后调用抛 TypeError
 */

import fs from 'fs';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 每次读取的块大小（256KB） */
const CHUNK_SIZE = 256 * 1024;

/** 硬底：3 Mbps（30% 上行占用，波动最差时留 7 Mbps 给游戏 + 波动） */
const SAFE_FLOOR_BPS = (3 * 1024 * 1024) / 8;

/** 初始基准：5 Mbps（50% 上行占用，保守起步） */
const START_BASE_BPS = (5 * 1024 * 1024) / 8;

/** 硬顶：7 Mbps（70% 上行占用，永远留 30% = 3 Mbps 给游戏） */
const HARD_CEILING_BPS = (7 * 1024 * 1024) / 8;

/** 上调步长：0.5 Mbps（保守，每次只多占 5% 上行） */
const STEP_UP_BPS = (0.5 * 1024 * 1024) / 8;

/** 连续 N 次稳定上传才执行一次上调 */
const STABLE_COUNT = 3;

/** actualBps < baseBps × 85% → 判定为网络波动（容忍 15% 抖动） */
const DECREASE_TRIGGER_RATIO = 0.85;

// ─── 模块级状态 ─────────────────────────────────────────────────────────────

/** 当前上传限速基准（bytes/sec） */
let baseBps = START_BASE_BPS;

/** 连续稳定上传计数（限速期间有效，不限速期间不参与调整） */
let stableStreak = 0;

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 获取当前上传限速（bytes/sec）。
 */
export function getUploadBps(): number {
  return baseBps;
}

/**
 * 获取当前上传限速（Mbps），用于日志输出。
 */
export function getUploadMbps(): number {
  return (baseBps * 8) / (1024 * 1024);
}

/**
 * 根据上传结果更新限速基准。
 *
 * 上调（保守）：连续 STABLE_COUNT 次稳定上传 → baseBps += STEP_UP（硬顶截断）
 * 下调（瞬时）：单次 actualBps < baseBps × DECREASE_TRIGGER_RATIO → baseBps = max(actualBps, SAFE_FLOOR)
 * 上传失败 → baseBps = max(baseBps × 0.5, SAFE_FLOOR)
 *
 * 注意：下调可以触发多次（从 7→5→3.5→3），但永不低于 SAFE_FLOOR。
 *       上调步长固定 0.5 Mbps，从 3 恢复到 7 约需 8 轮 × 3 次 ≈ 4 分钟（10s 片长）。
 *
 * @param fileSize 文件大小（bytes）
 * @param uploadDurationMs 上传耗时（ms）
 * @param success 是否上传成功
 */
export function updateBpsOnUploadResult(
  fileSize: number,
  uploadDurationMs: number,
  success: boolean,
): void {
  if (!success) {
    // 上传失败 — 直接减半，不低于硬底
    const prev = getUploadMbps();
    baseBps = Math.max(baseBps * 0.5, SAFE_FLOOR_BPS);
    stableStreak = 0;
    console.log(`[upload] 上传失败，限速 ${prev.toFixed(1)} → ${getUploadMbps().toFixed(1)} Mbps`);
    return;
  }

  const actualBps = (fileSize / uploadDurationMs) * 1000;

  if (actualBps < baseBps * DECREASE_TRIGGER_RATIO) {
    // 网络波动 — 瞬时降到实际能力（不低于硬底）
    const prev = getUploadMbps();
    baseBps = Math.max(actualBps, SAFE_FLOOR_BPS);
    stableStreak = 0;
    const actualMbps = (actualBps * 8) / (1024 * 1024);
    console.log(`[upload] 网络波动（actual=${actualMbps.toFixed(1)} < ${prev.toFixed(1)}×85%），限速 ${prev.toFixed(1)} → ${getUploadMbps().toFixed(1)} Mbps`);
    return;
  }

  // 稳定 — 累积计数
  stableStreak += 1;
  if (stableStreak >= STABLE_COUNT) {
    if (baseBps >= HARD_CEILING_BPS) {
      // 已达硬顶，不再上调
      stableStreak = 0;
      return;
    }
    const prev = getUploadMbps();
    baseBps = Math.min(baseBps + STEP_UP_BPS, HARD_CEILING_BPS);
    stableStreak = 0;
    console.log(`[upload] 连续 ${STABLE_COUNT} 次稳定上传，限速 ${prev.toFixed(1)} → ${getUploadMbps().toFixed(1)} Mbps`);
  }
}

/**
 * 重置限速为初始基准（每次录制开始时调用）。
 */
export function resetUploadBps(): void {
  baseBps = START_BASE_BPS;
  stableStreak = 0;
}

/**
 * 创建节流上传流。
 *
 * @param filePath 本地文件路径
 * @param bytesPerSecond 限速（bytes/sec），0 表示不限速
 * @returns Web ReadableStream，可直接传给 net.fetch 作为 body
 */
export function createThrottledStream(
  filePath: string,
  bytesPerSecond: number,
): ReadableStream<Uint8Array> {
  const delayMs = bytesPerSecond > 0
    ? (CHUNK_SIZE / bytesPerSecond) * 1000
    : 0;

  let position = 0;
  let fileHandle: fs.promises.FileHandle | null = null;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!fileHandle) {
          fileHandle = await fs.promises.open(filePath, 'r');
        }

        const buf = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fileHandle.read(buf, 0, CHUNK_SIZE, position);

        if (bytesRead === 0) {
          // EOF
          await fileHandle.close();
          fileHandle = null;
          controller.close();
          return;
        }

        position += bytesRead;
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));

        // 节流：等待延迟后再允许下一次 pull
        if (delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      } catch (err) {
        // 读取出错或文件句柄被 cancel 关闭
        if (fileHandle) {
          try { await fileHandle.close(); } catch (_) { /* already closed */ }
          fileHandle = null;
        }
        // cancel() 可能已将 stream 标记为 closed，
        // 此时 controller.error() 会抛 TypeError → 用 try/catch 吞掉
        try { controller.error(err); } catch (_) { /* stream already closed/cancelled */ }
      }
    },

    async cancel() {
      // fetch abort 或消费者停止读取时调用
      if (fileHandle) {
        try { await fileHandle.close(); } catch (_) { /* already closed */ }
        fileHandle = null;
      }
    },
  });
}

/**
 * 根据文件大小和限速计算动态超时时间。
 *
 * @param fileSize 文件大小（bytes）
 * @param bytesPerSecond 限速（bytes/sec）
 * @returns 超时时间（ms），30s~120s 之间，含 50% 余量 + 10s 固定缓冲
 */
export function calculateUploadTimeout(
  fileSize: number,
  bytesPerSecond: number,
): number {
  if (bytesPerSecond <= 0) return 120_000; // 不限速时 2 分钟兜底
  const expectedMs = (fileSize / bytesPerSecond) * 1000;
  // 下限 30s，上限 120s（大文件降级上传时不会卡太久）
  return Math.min(120_000, Math.max(30_000, Math.ceil(expectedMs * 1.5) + 10_000));
}
