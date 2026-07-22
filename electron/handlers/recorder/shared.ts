/**
 * 录制链路公共模块：FFmpeg 路径解析、共享常量。
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import ffmpegPath from 'ffmpeg-static';

/** 每个 HLS 切片的目标时长（秒）——与后端 hlsService.ts 保持一致 */
export const HLS_SEGMENT_DURATION = 10;

/**
 * 解析 FFmpeg 可执行文件路径。
 * Windows：优先用项目自带的 ffmpeg.exe（确保 ddagrab/gfxcapture 支持）。
 */
/**
 * 跨进程连续时间轴锚点（方案2a · window 模式 pause/resume 续录）。
 *
 * window 模式捕获源在 pause 时被整体终止（exe + ffmpeg-mux），resume 时以
 * -start_number 续号重建，并登记锚点把续录会话映射到全局输出时间轴，
 * 保证 HLS 切片序号与时间戳连续（与 T01 实验版同构）。
 */
export interface SessionAnchor {
  /** 续录会话的起始切片序号（ffmpeg-mux -start_number）。 */
  startSegmentNumber: number;
  /** 续录会话在输出时间轴上的偏移（秒）。 */
  startOffsetSeconds: number;
  /** 锚点登记时间戳。 */
  registeredAt: number;
}

const sessionAnchors = new Map<string, SessionAnchor>();

export function registerSessionAnchor(key: string, anchor: SessionAnchor): void {
  sessionAnchors.set(key, anchor);
}

export function resetSessionAnchors(): void {
  sessionAnchors.clear();
}

export function getSessionAnchor(key: string): SessionAnchor | undefined {
  return sessionAnchors.get(key);
}

/** 取某锚点的输出时间轴偏移（秒）；无锚点返回 0。 */
export function getOutputTsOffset(key: string): number {
  return sessionAnchors.get(key)?.startOffsetSeconds ?? 0;
}

export function getFfmpegPath(): string {
  if (process.platform === 'win32') {
    const binName = 'ffmpeg.exe';
    if (app.isPackaged) {
      const bundledPath = path.join(process.resourcesPath ?? '', 'bin', binName);
      if (fs.existsSync(bundledPath)) return bundledPath;
    } else {
      // 开发/预览模式：优先使用源码目录 electron/bin/ 下的 ffmpeg.exe
      // 该目录与 electron-builder.yml 的 extraResources.from 保持一致，
      // 避免 preview 模式因未走 electron-builder 而找不到正确版本。
      const sourceBinPath = path.join(app.getAppPath(), 'electron', 'bin', binName);
      if (fs.existsSync(sourceBinPath)) return sourceBinPath;

      // 兼容旧路径：项目根目录 bin/ffmpeg.exe
      const legacyBinPath = path.join(__dirname, '..', '..', 'bin', binName);
      if (fs.existsSync(legacyBinPath)) return legacyBinPath;
    }
  }

  // 其他平台 / 降级：用 ffmpeg-static
  let raw = ffmpegPath as string;
  if (app.isPackaged) {
    return raw.replace('app.asar', 'app.asar.unpacked');
  }
  return raw;
}
