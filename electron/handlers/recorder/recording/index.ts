/**
 * 录制层：负责启动/停止捕获与编码进程，管理临时目录。
 *
 * 模式分支（方案2a 终态）：
 *   - window 源：spawn `window_capture.exe`（WGC + NVENC DX11 直送 + 内嵌 AAC + 内嵌 HLS 封装）
 *     → 等 READY → exe 直接写本地 HLS `.ts` 切片，由上传层 chokidar 监听目录进 upload 层
 *     （**去除 ffmpeg-mux 外部封装**，编码+封装都在 exe 内一体完成，无回读）。
 *   - screen 源：复用 window_capture.exe（--capture-mode screen，无 hwnd），直出 HLS → upload（无 transcode）。
 *
 * stop + crash 重启 + 时间轴锚点沿用实验版语义；窗口模式录制执行由
 * window_capture.exe + OBS wc_tick 原生处理（最小化/失焦/移动自动跳帧或照录）。
 * CoWatch 仅在窗口销毁（STOP CLOSED）或 exe 崩溃（crash 看门狗）时介入。
 * pause/resume 的 kill+restart 链路已随哨兵越权整改删除（2026-08-01）。
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';

import { isWindowAlive } from '../window-watch';
import {
  registerSessionAnchor,
  getOutputTsOffset,
} from '../shared';
import {
  buildExeArgs,
  type CaptureProfile,
  type MuxProfile,
} from './profiles';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface WindowCaptureConfig {
  capture: CaptureProfile;
  mux: MuxProfile;
  audio: boolean;
  audioDevice?: string;
  muxTarget: 'file' | 'null';
  stats: boolean;
  /** 码率控制模式：cqp=质量优先（默认），cbr=恒定码率上限，vbr_ceil=弹性封顶 VBR（强制 900p、默认 6000kbps 封顶）。其余参数走 exe 默认值。 */
  rcMode?: 'cqp' | 'cbr' | 'vbr_ceil';
  /** 分辨率：720p（1280×720，默认）或 900p（1600×900），传给 window_capture.exe 的 --width/--height */
  resolution?: '720p' | '900p';
  /** 捕获模式：window（默认）或 screen（全屏）。window_capture.exe 必填 CLI flag。 */
  captureMode?: 'window' | 'screen';
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

// ─── 模块级状态 ────────────────────────────────────────────────────────────────
let tmpDir = '';
let detectedEncoder = 'libx264';
let isSoftwareEncoder = false;
let isUserStopped = false;
let crashRestartCount = 0;
let currentSourceId = '';
let currentWindowTitle = '';
let callbacks: RecordingCallbacks = {};

// ─── 模块级状态（window 路径，方案2a 新增）──────────────────────────────────────
let captureProc: ChildProcess | null = null; // window_capture.exe
let lastCfg: RecordingConfig | null = null;
let crashNotified = false; // window 模式：单次启动尝试内去重 crash 上报（防 close/error 双触发）

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
  return captureProc !== null;
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

  if (cfg.windowCapture) {
    // window / screen 模式：spawn window_capture.exe（内嵌 HLS 封装，直接写本地 .ts 切片）
    await startWindowRecording(cfg, cbs);
  } else {
    cbs.onLog?.('[recording] 缺少 windowCapture 配置，无法启动录制');
    if (!crashNotified) { crashNotified = true; cbs.onCrash?.(cfg.displayTitle); }
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
  const { capture, mux, audio, audioDevice, muxTarget, stats, rcMode, resolution, captureMode } = cfg.windowCapture;

  const exePath = getCaptureExePath();
  if (!exePath) {
    cbs.onLog?.('[recording] 未找到 window_capture.exe');
    if (!crashNotified) { crashNotified = true; cbs.onCrash?.(cfg.displayTitle); }
    return;
  }

  const exeArgs = buildExeArgs(capture, mux, { muxTarget, stats, audio, audioDevice, rcMode, resolution, captureMode });
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

// ─── 停止 / 重启 ──────────────────────────────────────────────────────────────

export async function stopRecording(): Promise<void> {
  if (isUserStopped) return;
  isUserStopped = true;

  if (captureProc) {
    await gracefulQuitWindow();
    return;
  }
}

export async function restartRecording(displayTitle: string): Promise<void> {
  if (isUserStopped) return;
  crashRestartCount++;
  if (crashRestartCount > MAX_CRASH_RESTARTS) {
    callbacks.onLog?.(`[recording] 捕获源已连续崩溃 ${crashRestartCount} 次，放弃重启`);
    return;
  }

  if (lastCfg) {
    const nextSeg = getNextSegmentNumber();
    registerSessionAnchor('window', {
      startSegmentNumber: nextSeg,
      startOffsetSeconds: getOutputTsOffset('window'),
      registeredAt: Date.now(),
    });
    callbacks.onLog?.(`[recording] window 捕获源重启，第 ${crashRestartCount} 次（续号 ${nextSeg}）`);
    void startWindowRecording(lastCfg, callbacks);
    return;
  }
}

export async function checkWindowAlive(sourceId: string): Promise<boolean> {
  return isWindowAlive(sourceId);
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────────

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
