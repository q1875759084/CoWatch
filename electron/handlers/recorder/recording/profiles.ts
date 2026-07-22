/**
 * profiles.ts — 捕获 / 编码 / 封装 配置集中注入（方案2a §1.5）
 *
 * 主进程（coordinator）集中维护 CaptureProfile / EncodeProfile / MuxProfile，
 * 按硬件/模式下发给 window_capture.exe 与 ffmpeg-mux（仅封装），
 * 不写死、不开放终端用户。本文件提供：
 *   - 三套 Profile 类型
 *   - buildExeArgs()：展开为 window_capture.exe CLI
 *   - buildMuxArgs()：展开为 ffmpeg-mux（-c copy 封装）CLI
 *   - makeDefaultProfiles()：按检测结果产出默认配置
 *
 * 与 OBS「UI 改参、CoWatch 由主进程注入」一致。所有质量/码率均来自此处，exe 不硬编码。
 */

import path from 'path';

import { HLS_SEGMENT_DURATION } from '../shared';

export type CaptureCodec = 'h264_nvenc' | 'hevc_nvenc';

/** 窗口定位（优先级：pid > hwnd > title，exe 内部执行）。 */
export interface CaptureProfile {
  pid?: number;
  hwnd?: number;
  title?: string;
  windowIndex?: number;
  fps: number;
  w?: number;
  h?: number;
  cursor?: boolean;
}

/** 视频编码（NVENC，DX11 直送，不回读）。 */
export interface EncodeProfile {
  codec: CaptureCodec;
  bitrate: number; // bps（CBR）
  bf: number;
  rcLookahead: number;
  preset: string; // p1..p7
  gop: number; // = hls_time × fps
}

/** 封装（ffmpeg-mux 仅封装压缩流）。 */
export interface MuxProfile {
  outDir: string;
  seg: number; // 秒
  startNumber: number; // 续录续号
  codec: CaptureCodec; // 决定 ffmpeg -f h264/hevc
  hasAudio: boolean;
}

export interface WindowSpawnOptions {
  muxTarget: 'pipe' | 'file' | 'null';
  stats: boolean;
  audio: boolean;
  audioDevice?: string;
}

/**
 * 展开为 window_capture.exe 参数。
 * 窗口定位优先级 pid > hwnd > title（与 exe 内部一致；此处仅展开，由 exe 最终裁决）。
 */
export function buildExeArgs(
  cap: CaptureProfile,
  enc: EncodeProfile,
  mux: MuxProfile,
  opts: WindowSpawnOptions,
): string[] {
  const args: string[] = [];

  if (cap.pid != null) {
    args.push('--pid', String(cap.pid), '--window-index', String(cap.windowIndex ?? 0));
  } else if (cap.hwnd != null) {
    args.push('--hwnd', String(cap.hwnd));
  } else if (cap.title) {
    args.push('--title', cap.title);
  }

  args.push('--fps', String(cap.fps));
  if (cap.w != null) args.push('--w', String(cap.w));
  if (cap.h != null) args.push('--h', String(cap.h));
  if (cap.cursor) args.push('--cursor');

  args.push(
    '--codec', enc.codec,
    '--bitrate', String(enc.bitrate),
    '--bf', String(enc.bf),
    '--rc-lookahead', String(enc.rcLookahead),
    '--preset', enc.preset,
    '--gop', String(enc.gop),
  );

  if (opts.audio) args.push('--audio');
  if (opts.audio && opts.audioDevice) args.push('--audio-device', opts.audioDevice);

  args.push('--out', mux.outDir, '--seg', String(mux.seg));
  args.push('--mux-target', opts.muxTarget);
  if (opts.stats) args.push('--stats');

  return args;
}

/**
 * 展开为 ffmpeg-mux 参数（仅封装，零重编码）。
 * 视频走 pipe:3（压缩 NAL），音频走 pipe:4（AAC ADTS，hasAudio 时）。
 * 切片直接命名为 seg%03d_opt.ts，与 screen 转码产物同构，可直接进 upload 层。
 */
export function buildMuxArgs(mux: MuxProfile): string[] {
  const vfmt = mux.codec.startsWith('hevc') ? 'hevc' : 'h264';
  const args: string[] = [
    '-y', '-fflags', '+genpts',
    '-f', vfmt, '-i', 'pipe:3',
  ];
  if (mux.hasAudio) {
    args.push('-f', 'aac', '-i', 'pipe:4');
  }
  args.push(
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', String(mux.seg),
    '-hls_list_size', '0',
    '-start_number', String(mux.startNumber),
    '-hls_segment_filename', path.join(mux.outDir, 'seg%03d_opt.ts').replace(/\\/g, '/'),
    path.join(mux.outDir, 'index.m3u8').replace(/\\/g, '/'),
  );
  return args;
}

/**
 * 按检测结果产出 window 模式默认 Profile 集合。
 * @param detectedEncoder 主进程检测的编码器（h264_nvenc/hevc_nvenc/...）
 * @param tmpDir           HLS 输出目录
 * @param title           窗口标题（默认定位方式）
 * @param fps             目标帧率
 */
export function makeDefaultProfiles(
  detectedEncoder: string,
  tmpDir: string,
  title: string,
  fps = 30,
): { capture: CaptureProfile; encode: EncodeProfile; mux: MuxProfile } {
  const codec: CaptureCodec = detectedEncoder.includes('hevc')
    ? 'hevc_nvenc'
    : 'h264_nvenc';

  return {
    capture: {
      title,
      fps,
      cursor: true,
    },
    encode: {
      codec,
      bitrate: 8_000_000, // 8 Mbps CBR（可承受上行，应用层 throttle 限速）
      bf: 2, // 窗口模式编码在 GPU 内，可安全用 B 帧
      rcLookahead: 20,
      preset: 'p4',
      gop: HLS_SEGMENT_DURATION * fps, // 关键帧对齐切片
    },
    mux: {
      outDir: tmpDir,
      seg: HLS_SEGMENT_DURATION,
      startNumber: 0,
      codec,
      hasAudio: true,
    },
  };
}
