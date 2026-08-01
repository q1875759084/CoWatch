/**
 * sentinel-client.ts — Electron 主进程侧的窗口哨兵客户端。
 *
 * 职责：
 *   - 定位并拉起 Python 哨兵（electron/bin/window_sentinel.exe）
 *   - 解析其 stdout 行协议（STOP / NOT_FOUND）
 *   - 将协议事件分发到协调层回调
 *   - exe 缺失 / spawn 失败 → 触发 onNotFound 兜底（绝不阻塞录制流程）
 *
 * 行协议（哨兵越权整改后，仅 DESTROY 探测）：
 *   STOP CLOSED             → 窗口关闭 / 销毁 → 干净结束
 *   NOT_FOUND               → 未找到目标窗口 → 兜底
 *   进程退出码 0 正常
 *
 * 注（T01 / feat/obs-wgc-capture）：本文件自 exp/ddagrab-crop-window 移植。
 * sentinel 仅作为「窗口事件探测器」与捕获源解耦——它只负责检测窗口销毁
 * 并发出回调，捕获源启动（OBS WGC exe）留待 T06 实现。
 * 注：RECT/crop 协议已随 ddagrab+crop 方案废弃删除（被 OBS WGC 方案取代）。
 *   PAUSE/RESUME/STOP MOVED 协议已随哨兵越权整改删除（2026-08-01），
 *   最小化/失焦/移动由 OBS wc_tick 原生处理，CoWatch 不再 kill+restart exe。
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';

import type { StopReason } from './recording/types';

/** 哨兵事件回调集合。 */
export interface SentinelCallbacks {
  /** 收到 STOP CLOSED → 干净结束录制。 */
  onStop?: (reason: StopReason) => void;
  /** 未匹配窗口 / exe 缺失 / 启动失败 → 走 gfxcapture 兜底。 */
  onNotFound?: () => void;
  /** 进程退出（主动 stopSentinel 后不会触发）。 */
  onExit?: (code: number | null) => void;
  /** 日志转发。 */
  onLog?: (msg: string) => void;
}

/**
 * 定位 window_sentinel.exe：
 *   - 开发/预览：<appPath>/electron/bin/window_sentinel.exe
 *   - 打包后：<resourcesPath>/bin/window_sentinel.exe
 * 与 audio_capture.exe 的定位约定保持一致。
 */
function getSentinelPath(): string | null {
  const binName = 'window_sentinel.exe';
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath ?? '', 'bin', binName);
    if (fs.existsSync(bundled)) return bundled;
  } else {
    const devPath = path.join(app.getAppPath(), 'electron', 'bin', binName);
    if (fs.existsSync(devPath)) return devPath;
  }
  return null;
}

let sentinelProc: ChildProcess | null = null;
let stopped = false;
let callbacks: SentinelCallbacks = {};

/**
 * 启动哨兵并监听其 stdout 行协议。
 * @param hwnd 目标窗口 HWND（十进制，字符串或数字均可；下传时 String()）。CoWatch 从 sourceId 中段直取。
 * @param cbs 事件回调。
 */
export function startSentinel(
  hwnd: number | string,
  cbs: SentinelCallbacks,
): void {
  callbacks = cbs;
  stopped = false;

  const exePath = getSentinelPath();
  if (!exePath) {
    // 找不到 exe → 直接兜底，绝不阻塞录制
    callbacks.onLog?.('[sentinel] 未找到 window_sentinel.exe，走 gfxcapture 兜底');
    callbacks.onNotFound?.();
    callbacks.onExit?.(null);
    return;
  }

  let proc: ChildProcess;
  try {
    proc = spawn(exePath, [String(hwnd)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // 同步 spawn 失败（极少见）→ 兜底
    sentinelProc = null;
    callbacks.onLog?.(`[sentinel] 启动失败：${(err as Error).message}`);
    callbacks.onNotFound?.();
    callbacks.onExit?.(null);
    return;
  }
  sentinelProc = proc;

  // ── stdout 按行解析协议 ──
  let buffer = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nlIndex: number;
    while ((nlIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nlIndex).replace(/\r$/, '').trim();
      buffer = buffer.slice(nlIndex + 1);
      if (line.length > 0) handleLine(line);
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) callbacks.onLog?.(`[sentinel:stderr] ${msg}`);
  });

  proc.on('error', (err) => {
    // 异步 ENOENT 等 → 兜底，不阻塞录制
    callbacks.onLog?.(`[sentinel] 进程错误：${err.message}`);
    stopped = true; // 防止 close 事件重复触发 onExit
    callbacks.onNotFound?.();
    callbacks.onExit?.(null);
  });

  proc.on('close', (code: number | null) => {
    sentinelProc = null;
    if (!stopped) {
      callbacks.onExit?.(code);
    }
  });
}

/**
 * 停止哨兵进程（先 SIGTERM，1s 内未退出则 SIGKILL）。
 * 标记 stopped，使其后的 close 事件不再触发 onExit 后续动作。
 */
export function stopSentinel(): void {
  stopped = true;
  const proc = sentinelProc;
  sentinelProc = null;
  if (proc) {
    try {
      proc.kill('SIGTERM');
    } catch (_) { /* ignore */ }
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch (_) { /* ignore */ }
    }, 1000);
  }
}

/**
 * 解析单行协议并分发到对应回调。
 */
function handleLine(line: string): void {
  callbacks.onLog?.(`[sentinel] ${line}`);

  if (line.startsWith('STOP')) {
    // 哨兵越权整改后仅剩 STOP CLOSED（窗口销毁）；其余 STOP 细分已删除
    callbacks.onStop?.('CLOSED');
    return;
  }

  if (line.startsWith('NOT_FOUND')) {
    callbacks.onNotFound?.();
    return;
  }

  // 未知行忽略
}
