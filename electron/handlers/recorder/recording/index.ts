/**
 * 录制层：负责启动/停止 FFmpeg，管理临时目录。
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { app, desktopCapturer } from 'electron';

import { startWindowWatcher, isWindowAlive } from '../window-watch';
import { getFfmpegPath, HLS_SEGMENT_DURATION } from '../shared';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface RecordingConfig {
  sessionId: string;
  sourceId: string;
  displayTitle: string;
  tmpDir: string;
  detectedEncoder: string;
  isSoftwareEncoder: boolean;
  cachedAvfIndex: number;
}

export interface RecordingCallbacks {
  onCrash?: (displayTitle: string) => void;
  onShouldStop?: () => void;
  onLog?: (msg: string) => void;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const MAX_CRASH_RESTARTS = 3;

// ─── 模块级状态 ─────────────────────────────────────────────────────────────

let ffmpegProcess: ChildProcess | null = null;
let audioCaptureProcess: ChildProcess | null = null;
let tmpDir = '';
let detectedEncoder = 'libx264';
let isSoftwareEncoder = false;
let cachedAvfIndex = -1;
let isUserStopped = false;
let crashRestartCount = 0;
let windowWatcher: { stop: () => void } | null = null;
let currentSourceId = '';
let currentWindowTitle = '';
let callbacks: RecordingCallbacks = {};

// ─── 公开 API ─────────────────────────────────────────────────────────────────

export function setEncoderInfo(encoder: string, soft: boolean): void {
  detectedEncoder = encoder;
  isSoftwareEncoder = soft;
}

export function getTmpDir(): string {
  return tmpDir;
}

export function isRecording(): boolean {
  return ffmpegProcess !== null && !isUserStopped;
}

export async function startRecording(
  cfg: RecordingConfig,
  cbs: RecordingCallbacks,
): Promise<void> {
  callbacks = cbs;
  isUserStopped = false;
  crashRestartCount = 0;
  tmpDir = cfg.tmpDir;
  detectedEncoder = cfg.detectedEncoder;
  isSoftwareEncoder = cfg.isSoftwareEncoder;
  cachedAvfIndex = cfg.cachedAvfIndex;
  currentSourceId = cfg.sourceId;
  currentWindowTitle = cfg.displayTitle;

  if (process.platform === 'darwin' && cachedAvfIndex < 0) {
    await resolveAvfIndex(cfg.sourceId);
  }

  ffmpegProcess = spawnFfmpeg();
  attachFfmpegHandlers();

  if (currentSourceId.startsWith('window:')) {
    windowWatcher = startWindowWatcher(
      currentSourceId,
      currentWindowTitle,
      () => { cbs.onShouldStop?.(); },
      () => isUserStopped,
    );
  }

  cbs.onLog?.(`[recording] FFmpeg 启动成功，tmpDir=${tmpDir}`);
}

export async function stopRecording(): Promise<void> {
  if (isUserStopped) return;
  isUserStopped = true;

  return new Promise((resolve) => {
    if (ffmpegProcess) {
      if (process.platform === 'win32') {
        if (audioCaptureProcess) {
          try { audioCaptureProcess.kill('SIGINT'); } catch (_) { /* ignore */ }
          audioCaptureProcess = null;
        }
        setTimeout(() => {
          ffmpegProcess?.stdin?.write('q');
          ffmpegProcess?.stdin?.end();
        }, 200);
      } else {
        ffmpegProcess.kill('SIGTERM');
        if (audioCaptureProcess) {
          try { audioCaptureProcess.kill('SIGTERM'); } catch (_) { /* ignore */ }
          audioCaptureProcess = null;
        }
      }

      ffmpegProcess.on('close', () => {
        ffmpegProcess = null;
        resolve();
      });
      setTimeout(() => {
        try { ffmpegProcess?.kill('SIGKILL'); } catch (_) { /* ignore */ }
        ffmpegProcess = null;
        resolve();
      }, 15_000);
    } else {
      if (audioCaptureProcess) {
        try {
          audioCaptureProcess.kill(process.platform === 'win32' ? 'SIGINT' : 'SIGTERM');
        } catch (_) { /* ignore */ }
        audioCaptureProcess = null;
      }
      resolve();
    }
  });
}

export async function restartRecording(displayTitle: string): Promise<void> {
  if (isUserStopped) return;
  crashRestartCount++;
  if (crashRestartCount > MAX_CRASH_RESTARTS) {
    callbacks.onLog?.(`[recording] ffmpeg 已连续崩溃 ${crashRestartCount} 次，放弃重启`);
    return;
  }

  callbacks.onLog?.(`[recording] ffmpeg 崩溃，第 ${crashRestartCount} 次重启...`);
  if (audioCaptureProcess) {
    try {
      audioCaptureProcess.kill(process.platform === 'win32' ? 'SIGINT' : 'SIGTERM');
    } catch (_) { /* ignore */ }
    audioCaptureProcess = null;
  }
  ffmpegProcess = spawnFfmpeg();
  attachFfmpegHandlers();
  callbacks.onLog?.(`[recording] FFmpeg 重启完成`);
}

export async function checkWindowAlive(sourceId: string): Promise<boolean> {
  return isWindowAlive(sourceId);
}

// ─── FFmpeg 参数构造 ──────────────────────────────────────────────────────────

/**
 * 扫描 tmpDir 中已有的 segNNN.ts 文件，返回下一个可用的切片序号。
 * crash 重启时调用，避免覆盖已有切片。
 */
function getNextSegmentNumber(): number {
  try {
    const files = fs.readdirSync(tmpDir);
    let maxNum = -1;
    for (const f of files) {
      const match = f.match(/^seg(\d+)\.ts$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
    return maxNum + 1;
  } catch {
    return 0;
  }
}

function getAudioCapturePath(): string | null {
  if (process.platform !== 'win32') return null;
  const binName = 'audio_capture.exe';
  if (app.isPackaged) {
    const bundledPath = path.join(process.resourcesPath, 'bin', binName);
    if (fs.existsSync(bundledPath)) return bundledPath;
  } else {
    const localPath = path.join(__dirname, '..', '..', '..', 'bin', binName);
    if (fs.existsSync(localPath)) return localPath;
  }
  return null;
}

async function resolveAvfIndex(sourceId: string): Promise<number> {
  const ffmpeg = getFfmpegPath();
  const screenRank = sourceId.startsWith('screen:')
    ? parseInt(sourceId.split(':')[1] || '0', 10)
    : 0;
  const fallback = screenRank;

  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn(ffmpeg, ['-list_devices', 'true', '-f', 'avfoundation', '-i', 'dummy'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', () => {
      const videoSection = stderr.split(/AVFoundation audio devices/i)[0] || stderr;
      const pattern = /\[(\d+)\]\s+Capture screen\s+(\d+)/gi;
      let match;
      while ((match = pattern.exec(videoSection)) !== null) {
        const avfIdx = parseInt(match[1], 10);
        const screenNum = parseInt(match[2], 10);
        if (screenNum === screenRank) {
          cachedAvfIndex = avfIdx;
          resolve(avfIdx);
          return;
        }
      }
      cachedAvfIndex = fallback;
      resolve(fallback);
    });
    proc.on('error', () => { cachedAvfIndex = fallback; resolve(fallback); });

    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch (_) { /* ignore */ }
      cachedAvfIndex = fallback;
      resolve(fallback);
    }, 5000);
    proc.on('close', () => clearTimeout(killTimer));
    proc.on('error', () => clearTimeout(killTimer));
  });
}

function spawnFfmpeg(): ChildProcess {
  const ffmpeg = getFfmpegPath();
  const maxWidth = isSoftwareEncoder ? 854 : 1280;
  const segPattern = path.join(tmpDir, 'seg%03d.ts').replace(/\\/g, '/');
  const m3u8Path = path.join(tmpDir, 'index.m3u8').replace(/\\/g, '/');
  const winScaleFilter = `scale=w='min(iw\\,${maxWidth})':h=-2,format=yuv420p`;

  let inputArgs: string[];
  if (process.platform === 'darwin') {
    const screenSeq = currentSourceId.startsWith('screen:')
      ? parseInt(currentSourceId.split(':')[1] || '0', 10)
      : 0;
    const avfIndex = cachedAvfIndex >= 0 ? cachedAvfIndex : screenSeq + 1;
    inputArgs = [
      '-f', 'avfoundation',
      '-framerate', '60',
      '-capture_cursor', '1',
      '-i', `${avfIndex}:none`,
    ];
  } else {
    if (currentSourceId.startsWith('screen:')) {
      const screenIdx = parseInt(currentSourceId.split(':')[1] || '0', 10);
      inputArgs = [
        '-f', 'lavfi',
        '-i', `ddagrab=output_idx=${screenIdx}:framerate=60,hwdownload,format=bgra,${winScaleFilter}`,
      ];
    } else {
      const escapedTitle = currentWindowTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      inputArgs = [
        '-f', 'lavfi',
        '-i', `gfxcapture=window_title=${escapedTitle}:max_framerate=60,hwdownload,format=bgra,${winScaleFilter}`,
      ];
    }
  }

  let audioInputArgs: string[] = [];
  let audioStreamArgs: string[] = [];
  let audioEncodeArgs: string[] = ['-an'];
  let mapArgs: string[] = [];
  const audioCaptureBin = getAudioCapturePath();

  if (audioCaptureBin) {
    audioCaptureProcess = spawn(audioCaptureBin, [
      '--sample-rate', '48000',
      '--channels', '2',
      '--bit-depth', '16',
      '--chunk-duration', '0.1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    audioCaptureProcess.stderr?.on('data', (data: Buffer) => {
      callbacks.onLog?.(`[audio_capture] ${data.toString().trim()}`);
    });
    audioCaptureProcess.on('close', (code: number | null) => {
      if (!isUserStopped && code !== 0) {
        callbacks.onLog?.('[recording] audio_capture 异常退出，后续录制静音');
      }
    });

    audioInputArgs = ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0'];
    audioStreamArgs = ['-af', 'aresample=async=1:min_hard_comp=0.100:first_pts=0'];
    audioEncodeArgs = ['-c:a', 'aac', '-b:a', '128k', '-strict', '-2'];
    mapArgs = ['-map', '0:a', '-map', '1:v'];
  }

  let encodeArgs: string[];
  if (isSoftwareEncoder) {
    encodeArgs = ['-c:v', detectedEncoder, '-crf', '23', '-preset', 'veryfast'];
  } else if (detectedEncoder === 'h264_nvenc') {
    encodeArgs = ['-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', '23', '-b:v', '0',
                  '-preset', 'p4', '-tune', 'll', '-rc-lookahead', '0'];
    // 录制层用低 CQ（高质量）捕获源，给转码层留压缩空间
    // NVENC 硬件编码速度不受 CQ 影响，代价仅是中间文件更大（用完即删）
  } else if (detectedEncoder === 'h264_qsv') {
    encodeArgs = ['-c:v', 'h264_qsv', '-global_quality', '23', '-look_ahead', '1'];
  } else {
    encodeArgs = ['-c:v', detectedEncoder, '-quality', 'quality'];
  }

  let platformVfArgs: string[];
  if (process.platform === 'darwin') {
    platformVfArgs = ['-vf', `scale=w='min(iw\\,${maxWidth})':h=-2`, '-bf', '0'];
  } else {
    platformVfArgs = ['-bf', '0'];
  }

  const args = [
    ...audioInputArgs,
    ...inputArgs,
    ...platformVfArgs,
    ...audioStreamArgs,
    ...mapArgs,
    ...encodeArgs,
    ...audioEncodeArgs,
    '-vsync', 'cfr', '-r', '60',
    '-g', String(60 * HLS_SEGMENT_DURATION),
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_DURATION),
    '-hls_list_size', '0',
    '-start_number', String(getNextSegmentNumber()),
    '-hls_segment_filename', segPattern,
    m3u8Path,
  ];

  callbacks.onLog?.(`[recording] 启动 ffmpeg：${args.join(' ')}`);

  const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });

  if (audioCaptureProcess) {
    const stdout = audioCaptureProcess.stdout;
    if (stdout) {
      stdout.pipe(proc.stdin);
    }
    proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE' && !err.message.includes('ERR_STREAM_WRITE_AFTER_END')) {
        callbacks.onLog?.(`[recording] audio_capture pipe error: ${err.message}`);
      }
    });
  }

  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stdout.write('[ffmpeg] ' + chunk.toString());
  });

  return proc;
}

function attachFfmpegHandlers(): void {
  ffmpegProcess?.on('close', (code: number | null) => {
    if (isUserStopped) {
      callbacks.onLog?.(`[recording] ffmpeg 正常退出，code=${code}`);
      return;
    }
    callbacks.onLog?.(`[recording] ffmpeg 异常退出，code=${code}`);
    callbacks.onCrash?.(currentWindowTitle);
  });
}
