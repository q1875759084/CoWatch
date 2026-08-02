/**
 * 外部视频转码模块：将用户自有视频文件转码为 HLS 分段，边转边上传。
 *
 * 职责：
 *   - 构建 FFmpeg 命令（编码器自适应，参数与 transcoding 层对齐，见 design.md §4.1）
 *   - spawn FFmpeg，输出 HLS 分段（seq%05d.ts）到指定目录
 *   - chokidar 监听输出目录，新分段出现时回调 onSegmentReady → 对接 upload 层
 *   - 解析 FFmpeg stderr 获取时长/进度 → 回调 onProgress
 *
 * 不负责：文件对话框、上传层初始化、/recording/finish 调用。这些由 coordinator（index.ts）处理。
 */

import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

import chokidar from 'chokidar';

import { getFfmpegPath, HLS_SEGMENT_DURATION } from '../shared';
import { SEGMENT_PATTERN } from '../shared/segment-naming';
import type { ExternalTranscodeProgress } from '../../../../src/types/recorder';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface ExternalTranscodeConfig {
  inputPath: string;
  outputDir: string;
  detectedEncoder: string;
  isSoftwareEncoder: boolean;
}

export interface ExternalTranscodeCallbacks {
  onSegmentReady?: (filePath: string) => void;
  onProgress?: (info: ExternalTranscodeProgress) => void;
  onComplete?: () => void;
  onError?: (message: string) => void;
  onLog?: (msg: string) => void;
}

// ─── 模块级状态 ─────────────────────────────────────────────────────────────

let ffmpegProcess: ChildProcess | null = null;
let watcher: chokidar.FSWatcher | null = null;
let isCancelled = false;
let inputDurationSec = 0;
let uploadedCount = 0;
let outputDir = '';
let callbacks: ExternalTranscodeCallbacks = {};
/** 已被 chokidar 检测到的文件集合，用于 stop 时补扫去重 */
const detectedFiles = new Set<string>();
/** 分段编号 → 文件名映射，用于排序上传 */
const segOrder: string[] = [];
/** FFmpeg 启动壁钟时间（ms），用于计算转码速率 */
let transcodeStartMs = 0;

// ─── 公开 API ─────────────────────────────────────────────────────────────────

export function startExternalTranscode(
  cfg: ExternalTranscodeConfig,
  cbs: ExternalTranscodeCallbacks,
): void {
  callbacks = cbs;
  isCancelled = false;
  inputDurationSec = 0;
  uploadedCount = 0;
  outputDir = cfg.outputDir;
  detectedFiles.clear();
  segOrder.length = 0;
  transcodeStartMs = 0;

  // 确保输出目录存在
  fs.mkdirSync(cfg.outputDir, { recursive: true });

  // ① 启动 chokidar 监听（先于 FFmpeg，避免竞态丢失首批分段）
  watcher = chokidar.watch(cfg.outputDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('add', (filePath: string) => {
    if (!filePath.endsWith('.ts') || !/^seq\d+\.ts$/.test(path.basename(filePath))) return;
    if (detectedFiles.has(filePath)) return;
    detectedFiles.add(filePath);
    segOrder.push(filePath);
    uploadedCount++;

    // 转码速率日志：每片都记，方便区分瓶颈在转码还是上传
    const wallElapsedSec = ((Date.now() - transcodeStartMs) / 1000).toFixed(1);
    const videoProcessedSec = uploadedCount * HLS_SEGMENT_DURATION;
    const speedX = transcodeStartMs > 0
      ? (videoProcessedSec / ((Date.now() - transcodeStartMs) / 1000)).toFixed(1)
      : '?';
    cbs.onLog?.(
      `[external-transcode] 分段 ${path.basename(filePath)} — ` +
      `壁钟 ${wallElapsedSec}s | 视频 ${videoProcessedSec}s | 速率 ${speedX}x`,
    );

    cbs.onProgress?.(buildProgress('transcoding'));
    cbs.onSegmentReady?.(filePath);
  });

  // ② 构建 FFmpeg 参数并 spawn
  const args = buildFfmpegArgs(cfg);
  const ffmpegPath = getFfmpegPath();
  cbs.onLog?.(`[external-transcode] 启动 FFmpeg：${ffmpegPath} ${args.join(' ')}`);

  transcodeStartMs = Date.now();
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpegProcess = proc;

  // ③ 解析 stderr：提取时长 → 进度 → 错误
  let stderrAcc = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderrAcc += text;

    // 提取时长（仅首次出现时）
    if (inputDurationSec === 0) {
      const dur = parseDuration(text);
      if (dur !== null && dur > 0) {
        inputDurationSec = dur;
        cbs.onProgress?.(buildProgress('transcoding'));
      }
    }

    // 提取当前转码时间
    const curTime = parseTime(text);
    if (curTime !== null) {
      // 进度已在 chokidar add 事件中通过 uploadedCount 推送，此处不重复
      // 仅用 stderr 做内部追踪，实际进度以分段产出数为准
    }
  });

  // ④ close 处理
  proc.on('close', (code: number | null) => {
    ffmpegProcess = null;

    if (isCancelled) {
      cbs.onLog?.('[external-transcode] 用户取消，FFmpeg 已终止');
      return;
    }

    if (code !== 0) {
      const errTail = stderrAcc.slice(-300);
      cbs.onError?.(`FFmpeg 转码异常退出（code=${code}）：${errTail}`);
      return;
    }

    // ⑤ FFmpeg 正常退出：补扫可能被 chokidar 遗漏的末段
    scanRemainingSegments(cfg.outputDir);

    // 关闭 watcher
    void (async () => {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      cbs.onComplete?.();
    })();
  });

  proc.on('error', (err: NodeJS.ErrnoException) => {
    ffmpegProcess = null;
    cbs.onError?.(`FFmpeg 进程启动失败：${err.message}`);
  });
}

export async function stopExternalTranscode(): Promise<void> {
  isCancelled = true;

  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }

  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}

export function getExternalTranscodeState(): { active: boolean; outputDir: string } {
  return { active: ffmpegProcess !== null, outputDir };
}

// ─── FFmpeg 参数构建 ──────────────────────────────────────────────────────────

function buildFfmpegArgs(cfg: ExternalTranscodeConfig): string[] {
  const encoder = cfg.detectedEncoder;
  const isSoft = cfg.isSoftwareEncoder;
  const segPattern = path.join(cfg.outputDir, SEGMENT_PATTERN).replace(/\\/g, '/');
  const m3u8Path = path.join(cfg.outputDir, 'index.m3u8').replace(/\\/g, '/');

  // 视频编码参数（与 transcoding/index.ts 对齐）
  let videoArgs: string[];
  if (isSoft) {
    videoArgs = ['-c:v', encoder, '-crf', '30', '-preset', 'medium'];
  } else if (encoder === 'h264_nvenc') {
    videoArgs = [
      '-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', '30', '-b:v', '0',
      '-preset', 'p5', '-bf', '2', '-rc-lookahead', '20',
    ];
  } else if (encoder === 'h264_qsv') {
    videoArgs = [
      '-c:v', 'h264_qsv', '-global_quality', '30', '-look_ahead', '20', '-b:v', '0',
    ];
  } else {
    // AMF / 其他硬件编码器兜底
    videoArgs = ['-c:v', encoder, '-quality', 'quality'];
  }

  const args = [
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-i', cfg.inputPath,
    '-map', '0:v',
    '-map', '0:a?',
    '-vf', "scale=w='min(iw,1600)':h=-2,format=yuv420p",
    ...videoArgs,
    '-c:a', 'aac', '-b:a', '128k',
    '-vsync', 'cfr', '-r', '30',
    '-g', '300',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_DURATION),
    '-hls_list_size', '0',
    '-start_number', '0',
    '-hls_segment_filename', segPattern,
    m3u8Path,
  ];

  return args;
}

// ─── 进度工具 ─────────────────────────────────────────────────────────────────

function buildProgress(phase: ExternalTranscodeProgress['phase']): ExternalTranscodeProgress {
  const estimated = inputDurationSec > 0
    ? Math.ceil(inputDurationSec / HLS_SEGMENT_DURATION)
    : -1;
  return { phase, uploaded: uploadedCount, estimated };
}

// ─── Stderr 解析 ──────────────────────────────────────────────────────────────

function parseDuration(text: string): number | null {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) return null;
  return (
    parseInt(match[1], 10) * 3600 +
    parseInt(match[2], 10) * 60 +
    parseInt(match[3], 10) +
    parseInt(match[4], 10) / 100
  );
}

function parseTime(text: string): number | null {
  const match = text.match(/time=\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) return null;
  return (
    parseInt(match[1], 10) * 3600 +
    parseInt(match[2], 10) * 60 +
    parseInt(match[3], 10) +
    parseInt(match[4], 10) / 100
  );
}

// ─── 末段补扫 ─────────────────────────────────────────────────────────────────

/**
 * FFmpeg 正常退出后，扫描输出目录中未被 chokidar 检测到的 seq*.ts 文件。
 * 处理场景：FFmpeg 写入最后一段后立即退出，chokidar awaitWriteFinish 可能尚未触发。
 */
function scanRemainingSegments(dir: string): void {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!/^seq\d+\.ts$/.test(f)) continue;
      const filePath = path.join(dir, f);
      if (detectedFiles.has(filePath)) continue;
      detectedFiles.add(filePath);
      segOrder.push(filePath);
      uploadedCount++;
      callbacks.onProgress?.(buildProgress('transcoding'));
      callbacks.onSegmentReady?.(filePath);
    }
  } catch (err) {
    callbacks.onLog?.(`[external-transcode] 补扫分段失败：${(err as Error).message}`);
  }
}
