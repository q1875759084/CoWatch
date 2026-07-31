/**
 * 录制层：负责启动/停止捕获与编码进程，管理临时目录。
 *
 * 模式分支（方案2a 终态）：
 *   - window 源：spawn `window_capture.exe`（WGC + NVENC DX11 直送 + 内嵌 AAC + 内嵌 HLS 封装）
 *     → 等 READY → exe 直接写本地 HLS `.ts` 切片，由上传层 chokidar 监听目录进 upload 层
 *     （**去除 ffmpeg-mux 外部封装**，编码+封装都在 exe 内一体完成，无回读）。
 *   - screen 源：保持 feat 基线原样（ddagrab + audio_capture.exe 双进程 + 转码层），不改动。
 *
 * pause/resume/stop + crash 重启 + 时间轴锚点沿用实验版语义；窗口模式 pause 即整体终止
 * exe（Windows 不支持 SIGSTOP），resume 以 -start_number 续号重建。
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';

import { startWindowWatcher, isWindowAlive } from '../window-watch';
import {
  getFfmpegPath,
  HLS_SEGMENT_DURATION,
  registerSessionAnchor,
  getOutputTsOffset,
} from '../shared';
import type { PauseReason } from './types';
import {
  buildExeArgs,
  type CaptureProfile,
  type EncodeProfile,
  type MuxProfile,
} from './profiles';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface WindowCaptureConfig {
  capture: CaptureProfile;
  encode: EncodeProfile;
  mux: MuxProfile;
  audio: boolean;
  audioDevice?: string;
  muxTarget: 'pipe' | 'file' | 'null';
  stats: boolean;
  /** 码率控制模式：cqp=质量优先（默认），cbr=恒定码率上限，vbr_ceil=弹性封顶 VBR（强制 900p、默认 6000kbps 封顶）。其余参数走 exe 默认值。 */
  rcMode?: 'cqp' | 'cbr' | 'vbr_ceil';
  /** 分辨率：720p（1280×720，默认）或 900p（1600×900），传给 window_capture.exe 的 --width/--height */
  resolution?: '720p' | '900p';
}

export interface RecordingConfig {
  sessionId: string;
  sourceId: string;
  displayTitle: string;
  tmpDir: string;
  detectedEncoder: string;
  isSoftwareEncoder: boolean;
  /** window 模式注入的捕获/编码/封装 Profile 集合（方案2a 主进程注入）。 */
  windowCapture?: WindowCaptureConfig;
  /** 仅录制模式：跳过上传、切片持久化到本地（可选透传，当前由录制协调层控制，录制层无需使用）。 */
  recordOnly?: boolean;
}

export interface RecordingCallbacks {
  onCrash?: (displayTitle: string) => void;
  onShouldStop?: () => void;
  onLog?: (msg: string) => void;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const MAX_CRASH_RESTARTS = 3;

// ─── 模块级状态（screen 路径，保留不改）────────────────────────────────────
let ffmpegProcess: ChildProcess | null = null;
let audioCaptureProcess: ChildProcess | null = null;
let tmpDir = '';
let detectedEncoder = 'libx264';
let isSoftwareEncoder = false;
let isUserStopped = false;
let crashRestartCount = 0;
let windowWatcher: { stop: () => void } | null = null;
let currentSourceId = '';
let currentWindowTitle = '';
let callbacks: RecordingCallbacks = {};

// ─── 模块级状态（window 路径，方案2a 新增）──────────────────────────────────
let captureProc: ChildProcess | null = null; // window_capture.exe
let muxProc: ChildProcess | null = null;      // ffmpeg-mux（window 模式的 liveFfmpeg）
let currentMuxProfile: MuxProfile | null = null;
let lastCfg: RecordingConfig | null = null;
let m_paused = false;
let muxReady = false;
let crashNotified = false; // window 模式：单次启动尝试内去重 crash 上报（防 close/error 双触发）
let recordedSecondsAtPause = 0;
let startOffsetForNextSession = 0;

// ─── 公开 API ─────────────────────────────────────────────────────────────────

export function setEncoderInfo(encoder: string, soft: boolean): void {
  detectedEncoder = encoder;
  isSoftwareEncoder = soft;
}

export function getTmpDir(): string {
  return tmpDir;
}

export function isRecording(): boolean {
  if (isUserStopped) return false;
  return ffmpegProcess !== null || captureProc !== null || muxProc !== null;
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
  currentSourceId = cfg.sourceId;
  currentWindowTitle = cfg.displayTitle;

  if (currentSourceId.startsWith('window:')) {
    // 窗口模式（方案2a）：spawn exe + 等 READY + spawn ffmpeg-mux
    await startWindowRecording(cfg, cbs);
  } else {
    // screen 模式（feat 基线，原样保留）
    ffmpegProcess = spawnFfmpeg();
    attachFfmpegHandlers();
  }

  if (currentSourceId.startsWith('window:')) {
    // 窗口模式由 sentinel 接管窗口检测，禁用 5s 轮询-stop 避免双重检测冲突。
    windowWatcher = startWindowWatcher(
      currentSourceId,
      currentWindowTitle,
      () => { cbs.onShouldStop?.(); },
      () => isUserStopped,
      { enablePollingStop: false },
    );
  }

  cbs.onLog?.(`[recording] 录制启动成功，tmpDir=${tmpDir}`);
}

// ─── window 模式实现（方案2a）────────────────────────────────────────────────

function getCaptureExePath(): string | null {
  const binName = 'window_capture.exe';
  // 新 exe 部署在独立子目录 electron/bin/window_capture/（DLL 隔离，避免与 screen 模式 ffmpeg 冲突）。
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath ?? '', 'bin', 'window_capture', 'bin', '64bit', binName);
    if (fs.existsSync(bundled)) return bundled;
  } else {
    const dev = path.join(app.getAppPath(), 'electron', 'bin', 'window_capture', 'bin', '64bit', binName);
    if (fs.existsSync(dev)) return dev;
  }
  return null;
}

async function startWindowRecording(cfg: RecordingConfig, cbs: RecordingCallbacks): Promise<void> {
  crashNotified = false; // 新一次启动尝试：允许本次崩溃上报一次（防 close/error 双触发）
  if (!cfg.windowCapture) {
    cbs.onLog?.('[recording] 缺少 windowCapture 配置');
    if (!crashNotified) { crashNotified = true; cbs.onCrash?.(cfg.displayTitle); }
    return;
  }
  lastCfg = cfg;
  const { capture, encode, mux, audio, audioDevice, muxTarget, stats, rcMode, resolution } = cfg.windowCapture;
  currentMuxProfile = { ...mux };
  m_paused = false;
  muxReady = false;

  const exePath = getCaptureExePath();
  if (!exePath) {
    cbs.onLog?.('[recording] 未找到 window_capture.exe');
    if (!crashNotified) { crashNotified = true; cbs.onCrash?.(cfg.displayTitle); }
    return;
  }

  const exeArgs = buildExeArgs(capture, encode, currentMuxProfile, { muxTarget, stats, audio, audioDevice, rcMode, resolution });
  captureProc = spawn(exePath, exeArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  captureProc.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleCaptureLine(line, cfg, cbs);
    }
  });
  captureProc.stderr?.on('data', (chunk: Buffer) => {
    cbs.onLog?.(`[capture:stderr] ${chunk.toString().trim()}`);
  });
  captureProc.on('close', (code: number | null) => {
    captureProc = null;
    if (isUserStopped) return;
    if (code === 0) {
      cbs.onLog?.(`[recording] window_capture 干净退出 code=${code}`);
      // 窗口关闭类干净退出 → 触发收尾（sentinel 亦会 STOP，stop() 有重入保护）
      cbs.onShouldStop?.();
    } else {
      cbs.onLog?.(`[recording] window_capture 异常退出 code=${code}`);
      if (!crashNotified) { crashNotified = true; cbs.onCrash?.(cfg.displayTitle); }
    }
  });
  captureProc.on('error', (err: Error) => {
    cbs.onLog?.(`[recording] window_capture spawn 失败：${err.message}`);
    if (!crashNotified) { crashNotified = true; cbs.onCrash?.(cfg.displayTitle); }
  });

  cbs.onLog?.(`[recording] window_capture 启动：${exeArgs.join(' ')}`);
}

function handleCaptureLine(line: string, cfg: RecordingConfig, cbs: RecordingCallbacks): void {
  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    cbs.onLog?.(`[capture] ${line}`);
    return;
  }
  if (msg.type === 'READY') {
    cbs.onLog?.(`[recording] capture READY w=${msg.w} h=${msg.h} fps=${msg.fps} codec=${msg.codec} hasAudio=${String(msg.hasAudio)}`);
    // 以 exe 实际音频能力为准更新 mux profile（仅用于 crash 续录锚点续号，不影响 exe 内封装）。
    if (currentMuxProfile) currentMuxProfile.hasAudio = !!msg.hasAudio;
  } else if (msg.type === 'CLOSED') {
    cbs.onLog?.(`[recording] capture CLOSED reason=${msg.reason}`);
    if (msg.reason === 'window_closed') cbs.onShouldStop?.();
  } else if (msg.type === 'ERROR') {
    cbs.onLog?.(`[recording] capture ERROR code=${msg.code} msg=${msg.msg}`);
    // KI-1：不再单独 onCrash——exe 在 emitError 后必以非 0 退出，captureProc.on('close')
    // 会统一上报 crash（restartRecording）。此处若也 onCrash 会级联 2 次 restartRecording，
    // 更快耗尽 MAX_CRASH_RESTARTS=3。仅日志，避免双重触发。
  } else {
    cbs.onLog?.(`[capture] ${line}`);
  }
}

function gracefulQuitWindow(): Promise<void> {
  // 向 window_capture.exe 发 CTRL_C_EVENT（Node SIGINT 在 Windows 映射为
  // GenerateConsoleCtrlEvent(CTRL_C_EVENT)），exe 捕获后 flush 尾段并写 #EXT-X-ENDLIST 干净退出。
  return new Promise((resolve) => {
    if (!captureProc) return resolve();
    const t = setTimeout(() => {
      try { captureProc?.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 8000);
    captureProc.on('close', () => { clearTimeout(t); resolve(); });
    try { captureProc.kill('SIGINT'); } catch { /* 已退出 */ }
  });
}

// ─── 停止 / 重启 / 暂停 / 恢复 ──────────────────────────────────────────────────

export async function stopRecording(): Promise<void> {
  if (isUserStopped) return;
  isUserStopped = true;

  if (currentSourceId.startsWith('window:')) {
    await gracefulQuitWindow();
    if (windowWatcher) { windowWatcher.stop(); windowWatcher = null; }
    return;
  }

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
          audioCaptureProcess.kill('SIGINT');
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
    callbacks.onLog?.(`[recording] 捕获源已连续崩溃 ${crashRestartCount} 次，放弃重启`);
    return;
  }

  if (currentSourceId.startsWith('window:') && lastCfg) {
    const nextSeg = getNextSegmentNumber();
    if (currentMuxProfile) currentMuxProfile.startNumber = nextSeg;
    registerSessionAnchor('window', {
      startSegmentNumber: nextSeg,
      startOffsetSeconds: getOutputTsOffset('window'),
      registeredAt: Date.now(),
    });
    callbacks.onLog?.(`[recording] window 捕获源重启，第 ${crashRestartCount} 次（续号 ${nextSeg}）`);
    void startWindowRecording(lastCfg, callbacks);
    return;
  }

  // screen 路径（原样）
  callbacks.onLog?.(`[recording] ffmpeg 崩溃，第 ${crashRestartCount} 次重启...`);
  if (audioCaptureProcess) {
    try {
      audioCaptureProcess.kill('SIGINT');
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

/**
 * 暂停录制。
 *  - window 模式：整体终止 exe + ffmpeg-mux（Windows 不支持 SIGSTOP），记录续录偏移，保留会话。
 *  - screen 模式：SIGSTOP 挂起 ffmpeg（原样）。
 */
export function pauseRecording(reason: PauseReason): void {
  callbacks.onLog?.(`[recording] 暂停录制（${reason}）`);
  if (currentSourceId.startsWith('window:') && (captureProc || muxProc)) {
    recordedSecondsAtPause = getNextSegmentNumber() * (currentMuxProfile?.seg ?? HLS_SEGMENT_DURATION);
    void gracefulQuitWindow();
    m_paused = true;
    return;
  }
  if (ffmpegProcess) {
    try { ffmpegProcess.kill('SIGSTOP'); } catch (_) { /* ignore */ }
  }
}

/**
 * 恢复录制。
 *  - window 模式：以 -start_number 续号重建 exe + ffmpeg-mux（音频随 exe 一起重启）。
 *  - screen 模式：SIGCONT（原样）。
 */
export function resumeRecording(): void {
  if (!currentSourceId.startsWith('window:')) {
    if (ffmpegProcess) {
      try { ffmpegProcess.kill('SIGCONT'); } catch (_) { /* ignore */ }
    }
    return;
  }
  if (!m_paused || !lastCfg) return;
  callbacks.onLog?.('[recording] 恢复录制（重启 exe + mux）');
  const nextSeg = getNextSegmentNumber();
  if (currentMuxProfile) currentMuxProfile.startNumber = nextSeg;
  startOffsetForNextSession = recordedSecondsAtPause;
  registerSessionAnchor('window', {
    startSegmentNumber: nextSeg,
    startOffsetSeconds: recordedSecondsAtPause,
    registeredAt: Date.now(),
  });
  m_paused = false;
  void startWindowRecording(lastCfg, callbacks);
}

// ─── screen 路径实现（feat 基线，原样保留）────────────────────────────────────

/**
 * 扫描 tmpDir 中已有的 segNNN.ts 文件，返回下一个可用的切片序号。
 */
function getNextSegmentNumber(): number {
  try {
    const files = fs.readdirSync(tmpDir);
    let maxNum = -1;
    for (const f of files) {
      const match = f.match(/^seg(\d+)_opt\.ts$/);
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
  const binName = 'audio_capture.exe';
  if (app.isPackaged) {
    const bundledPath = path.join(process.resourcesPath, 'bin', binName);
    if (fs.existsSync(bundledPath)) return bundledPath;
  } else {
    // 开发/预览模式：使用项目源码目录 electron/bin/，与 getFfmpegPath 保持一致
    const sourceBinPath = path.join(app.getAppPath(), 'electron', 'bin', binName);
    if (fs.existsSync(sourceBinPath)) return sourceBinPath;
  }
  return null;
}

function spawnFfmpeg(): ChildProcess {
  const ffmpeg = getFfmpegPath();
  const maxWidth = isSoftwareEncoder ? 854 : 1280;
  const segPattern = path.join(tmpDir, 'seg%03d.ts').replace(/\\/g, '/');
  const m3u8Path = path.join(tmpDir, 'index.m3u8').replace(/\\/g, '/');
  const winScaleFilter = `scale=w='min(iw\\,${maxWidth})':h=-2,format=yuv420p`;

  let inputArgs: string[];
  if (currentSourceId.startsWith('screen:')) {
    const screenIdx = parseInt(currentSourceId.split(':')[1] || '0', 10);
    inputArgs = [
      '-f', 'lavfi',
      '-i', `ddagrab=output_idx=${screenIdx}:framerate=30,hwdownload,format=bgra,${winScaleFilter}`,
    ];
  } else {
    const escapedTitle = currentWindowTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    inputArgs = [
      '-f', 'lavfi',
      '-i', `gfxcapture=window_title=${escapedTitle}:max_framerate=30,hwdownload,format=bgra,${winScaleFilter}`,
    ];
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
    encodeArgs = ['-c:v', detectedEncoder, '-crf', '26', '-preset', 'veryfast'];
  } else if (detectedEncoder === 'h264_nvenc') {
    encodeArgs = ['-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', '26', '-b:v', '0',
                  '-preset', 'p4', '-tune', 'll', '-rc-lookahead', '0'];
    // CQ 26 录制源质量，给转码层（CQ 30）留压缩空间
    // NVENC 硬件编码速度不受 CQ 影响，代价仅是中间文件更大（用完即删）
  } else if (detectedEncoder === 'h264_qsv') {
    encodeArgs = ['-c:v', 'h264_qsv', '-global_quality', '26', '-look_ahead', '1'];
  } else {
    encodeArgs = ['-c:v', detectedEncoder, '-quality', 'quality'];
  }

  const platformVfArgs: string[] = ['-bf', '0'];

  const args = [
    ...audioInputArgs,
    ...inputArgs,
    ...platformVfArgs,
    ...audioStreamArgs,
    ...mapArgs,
    ...encodeArgs,
    ...audioEncodeArgs,
    '-vsync', 'cfr', '-r', '30',
    '-g', String(30 * HLS_SEGMENT_DURATION),
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
