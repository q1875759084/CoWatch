/**
 * 转码层：监听录制层产出的原始切片，逐片转码为优化参数版本。
 *
 * 职责：
 *   - 通过 chokidar 监听临时目录，发现新 .ts 切片
 *   - 串行转码队列（一次 1 个），避免 CPU/GPU 过载
 *   - 转码完成后删除原始切片，通知上传层
 *
 * 不负责：FFmpeg 录制、网络上传。
 *
 * 转码参数（与录制参数分离）：
 *   - preset p5（质量优先）
 *   - bf 2（启用 B 帧，压缩率 ~30% 提升）
 *   - rc-lookahead 20（启用前瞻，码率分配更合理）
 *   - CQ 30（纯 CQ 模式，码率随内容复杂度自由波动）
 *
 * 注意：CQ 模式下 NVENC 会清零 vbvBufferSize，maxrate/bufsize 为死参数，已移除。
 * 录制不限码率 → 转码也不限码率 → 文件大小随内容复杂度波动，这是 feature 不是 bug。
 * 上传带宽控制由 upload/throttle.ts 在应用层处理，不在编码层做。
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import chokidar from 'chokidar';

import { getFfmpegPath, HLS_SEGMENT_DURATION } from '../shared';
import type { RecordingProgress } from '../../../../src/types/recorder';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface TranscodingConfig {
  tmpDir: string;
  detectedEncoder: string;
  isSoftwareEncoder: boolean;
}

export interface TranscodingCallbacks {
  onTranscodeComplete?: (transcodedPath: string) => void;
  onTranscodeFailed?: (rawPath: string) => void;
  onLog?: (msg: string) => void;
  onProgress?: (info: RecordingProgress) => void;
}

// ─── 模块级状态 ─────────────────────────────────────────────────────────────

let config: TranscodingConfig | null = null;
let callbacks: TranscodingCallbacks = {};
let watcher: chokidar.FSWatcher | null = null;
let transcodeQueue: string[] = [];
let isTranscoding = false;

// ─── 公开 API ─────────────────────────────────────────────────────────────────

export function startTranscodingWatcher(
  cfg: TranscodingConfig,
  cbs: TranscodingCallbacks,
): void {
  config = cfg;
  callbacks = cbs;

  watcher = chokidar.watch(cfg.tmpDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('add', (filePath: string) => {
    if (filePath.endsWith('.ts') && !filePath.includes('_opt.ts')) {
      enqueueTranscode(filePath);
    }
  });

  cbs.onLog?.(`[transcoding] chokidar 监听启动：${cfg.tmpDir}`);
}

export function stopTranscodingWatcher(): Promise<void> {
  if (watcher) {
    const w = watcher;
    watcher = null;
    return w.close();
  }
  return Promise.resolve();
}

/**
 * 等待转码队列完全排空（stop 时调用）。
 * 队列为空且没有正在转码的切片时返回。
 */
export async function waitForTranscodeQueue(): Promise<void> {
  while (transcodeQueue.length > 0 || isTranscoding) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

export function enqueueExistingRawFiles(tmpDir: string): void {
  try {
    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      if (f.endsWith('.ts') && !f.includes('_opt.ts')) {
        enqueueTranscode(path.join(tmpDir, f));
      }
    }
  } catch (err) {
    callbacks.onLog?.(`[transcoding] 扫描已有切片失败：${(err as Error).message}`);
  }
}

// ─── 转码队列 ─────────────────────────────────────────────────────────────────

function enqueueTranscode(filePath: string): void {
  if (transcodeQueue.includes(filePath)) return;
  transcodeQueue.push(filePath);
  callbacks.onLog?.(`[transcoding] 入队：${path.basename(filePath)}（队列长度：${transcodeQueue.length}）`);
  processQueue();
}

async function processQueue(): Promise<void> {
  if (isTranscoding || transcodeQueue.length === 0) return;

  isTranscoding = true;
  const filePath = transcodeQueue.shift()!;
  const fileName = path.basename(filePath);
  const transcodeName = fileName.replace('.ts', '_opt.ts');
  const transcodePath = path.join(config?.tmpDir ?? path.dirname(filePath), transcodeName);

  try {
    callbacks.onLog?.(`[transcoding] 开始转码：${fileName}`);
    await transcodeFile(filePath, transcodePath);
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    callbacks.onLog?.(`[transcoding] 转码完成：${transcodeName}`);
    callbacks.onTranscodeComplete?.(transcodePath);
  } catch {
    callbacks.onLog?.(`[transcoding] 转码失败，重试：${fileName}`);
    try {
      await transcodeFile(filePath, transcodePath);
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
      callbacks.onLog?.(`[transcoding] 转码重试成功：${transcodeName}`);
      callbacks.onTranscodeComplete?.(transcodePath);
    } catch {
      callbacks.onLog?.(`[transcoding] 转码重试仍失败，上传原始切片：${fileName}`);
      callbacks.onTranscodeFailed?.(filePath);
    }
  } finally {
    isTranscoding = false;
    processQueue();
  }
}

// ─── 转码实现 ──────────────────────────────────────────────────────────────────

function transcodeFile(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!config) { reject(new Error('transcoding config not set')); return; }

    const ffmpeg = getFfmpegPath();
    const encoder = config.detectedEncoder;
    const isSoft = config.isSoftwareEncoder;

    // 从文件名解析切片序号，计算绝对 PTS 偏移以恢复跨片连续时间轴
    // 录制层 seg000 = 0-10s, seg001 = 10-20s, ...
    const segMatch = path.basename(inputPath).match(/^seg(\d+)/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;
    const tsOffset = segIndex * HLS_SEGMENT_DURATION;

    let encodeArgs: string[];
    if (isSoft) {
      encodeArgs = ['-c:v', encoder, '-crf', '30', '-preset', 'medium'];
    } else if (encoder === 'h264_nvenc') {
      encodeArgs = ['-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', '30', '-b:v', '0',
                    '-preset', 'p5', '-bf', '2', '-rc-lookahead', '20'];
    } else if (encoder === 'h264_qsv') {
      encodeArgs = ['-c:v', 'h264_qsv', '-global_quality', '30', '-look_ahead', '20',
                    '-b:v', '0'];
    } else {
      encodeArgs = ['-c:v', encoder, '-quality', 'quality'];
    }

    const args = [
      '-fflags', '+genpts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-i', inputPath,
      ...encodeArgs,
      '-c:a', 'copy',
      '-output_ts_offset', String(tsOffset),
      '-vsync', 'cfr',
      '-r', '30',
      '-g', '300',
      '-f', 'mpegts',
      outputPath,
    ];

    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        try { fs.unlinkSync(outputPath); } catch (_) { /* ignore */ }
        reject(new Error(`transcode failed: ${stderr.slice(-200)}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}
