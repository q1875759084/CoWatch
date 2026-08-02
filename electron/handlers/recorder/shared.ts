/**
 * 录制链路公共模块：FFmpeg 路径解析、共享常量。
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/** 每个 HLS 切片的目标时长（秒）——与后端 hlsService.ts 保持一致 */
export const HLS_SEGMENT_DURATION = 10;

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
