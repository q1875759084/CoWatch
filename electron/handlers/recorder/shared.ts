/**
 * 录制链路公共模块：FFmpeg 路径解析、共享常量。
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/** 每个 HLS 切片的目标时长（秒）——与后端 hlsService.ts 保持一致 */
export const HLS_SEGMENT_DURATION = 10;

/**
 * 跨进程连续时间轴锚点（方案2a · window 模式 crash 重启续录）。
 *
 * exe 崩溃重启时登记锚点，把续录会话映射到全局输出时间轴，
 * 保证 HLS 切片序号与时间戳连续（与 T01 实验版同构）。
 * 注：续号尚未下传 exe（exe 当前硬编码 start_number=1），待 --start-number 决策补全。
 */
export interface SessionAnchor {
  /** 续录会话的起始切片序号（待 --start-number 决策后下传 exe）。 */
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

/** 取某锚点的输出时间轴偏移（秒）；无锚点返回 0。 */
export function getOutputTsOffset(key: string): number {
  return sessionAnchors.get(key)?.startOffsetSeconds ?? 0;
}

export function getFfmpegPath(): string {
  const binName = 'ffmpeg.exe';
  if (app.isPackaged) {
    return path.join(process.resourcesPath ?? '', 'bin', binName);
  }
  // 开发/预览模式：优先使用源码目录 electron/bin/ 下的 ffmpeg.exe
  const sourceBinPath = path.join(app.getAppPath(), 'electron', 'bin', binName);
  if (fs.existsSync(sourceBinPath)) return sourceBinPath;
  // 兼容旧路径：项目根目录 bin/ffmpeg.exe
  return path.join(__dirname, '..', '..', 'bin', binName);
}
