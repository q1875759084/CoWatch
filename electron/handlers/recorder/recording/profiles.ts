/**
 * profiles.ts — 捕获 / 编码 / 封装 配置集中注入（方案2a §1.5）
 *
 * 主进程（coordinator）集中维护 CaptureProfile / EncodeProfile / MuxProfile，
 * 按硬件/模式下发给 window_capture.exe（exe 内一体编码 + HLS 封装），
 * 不写死、不开放终端用户。本文件提供：
 *   - 三套 Profile 类型
 *   - buildExeArgs()：展开为 window_capture.exe CLI
 *   - makeDefaultProfiles()：按检测结果产出默认配置
 *
 * 与 OBS「UI 改参、CoWatch 由主进程注入」一致。所有质量/码率均来自此处，exe 不硬编码。
 */

import { HLS_SEGMENT_DURATION } from '../shared';

export type CaptureCodec = 'h264_nvenc' | 'hevc_nvenc';

/** 窗口定位（优先级：hwnd > window > pid，exe 内部裁决；title 仅用于 crash 日志，不进 CLI）。 */
export interface CaptureProfile {
  pid?: number; // 兜底（documented-lossy）
  hwnd?: number | string; // 主选择器（十进制 HWND；string 或 number 均可，下传时 String()）
  window?: string; // "title:class:exe" 直传 OBS
  windowPriority?: 'class' | 'title' | 'exe';
  title?: string; // 仅 crash 日志使用，不进 CLI
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
  /** 码率控制模式：cqp=质量优先（默认），cbr=恒定码率上限，vbr_ceil=弹性封顶 VBR（CoWatch 侧显式注入 1920×1080 对齐直播姬，均值 6000kbps，复杂场景弹性超发至峰值默认 9000kbps）。其余参数走 exe 默认值。 */
  rcMode?: 'cqp' | 'cbr' | 'vbr_ceil';
}

/**
 * 展开为 window_capture.exe 参数。
 * 窗口定位优先级 hwnd > window > pid（与 exe 内部裁决一致；此处仅展开，由 exe 最终裁决）。
 */
export function buildExeArgs(
  cap: CaptureProfile,
  enc: EncodeProfile,
  mux: MuxProfile,
  opts: WindowSpawnOptions,
): string[] {
  // enc 字段预留给后续按 GPU 占用单独调参的入口；当前录制质量一律走 exe 默认值，不下传。
  const args: string[] = [];

  // 窗口定位（三选一必填，无默认值；hwnd > window > pid）
  if (cap.hwnd != null) {
    args.push('--hwnd', String(cap.hwnd));
  } else if (cap.window) {
    args.push('--window', cap.window); // exe 默认 class 裁决，不再下传 --window-priority
  } else if (cap.pid != null) {
    args.push('--pid', String(cap.pid)); // 兜底 lossy
  }

  // 封装 / 输出（必填）：watcher 按 --out 目录 watch *.ts 切片
  args.push('--mux-target', opts.muxTarget);
  args.push('--out', mux.outDir);

  // 码率控制模式：cqp=质量优先（exe 默认），cbr=恒定码率上限，vbr_ceil=弹性封顶 VBR；CoWatch 侧显式下传 1920×1080 覆盖 exe 默认，其余参数走 exe 默认。
  args.push('--rc-mode', opts.rcMode ?? 'cqp');

  // VBR_CEIL 模式：对齐直播姬推流实际分辨率，显式覆盖 exe 默认 1440×810 为 1920×1080
  if (opts.rcMode === 'vbr_ceil') {
    args.push('--width', '1920');
    args.push('--height', '1080');
  }

  // 诊断（可选）：capture/encode/gpu 占用，供后续按 GPU 调参
  if (opts.stats === true) args.push('--stats');

  // 音频：exe 默认录系统 loopback；关闭才传 --no-audio
  if (opts.audio === false) args.push('--no-audio');

  return args;
}

/**
 * 按检测结果产出 window 模式默认 Profile 集合。
 * @param detectedEncoder 主进程检测的编码器（h264_nvenc/hevc_nvenc/...）
 * @param tmpDir           HLS 输出目录
 * @param hwnd            目标窗口 HWND（十进制，主契约；string 或 number 皆可）
 * @param fps             目标帧率
 */
export function makeDefaultProfiles(
  detectedEncoder: string,
  tmpDir: string,
  hwnd: number | string,
  fps = 30,
): { capture: CaptureProfile; encode: EncodeProfile; mux: MuxProfile } {
  const codec: CaptureCodec = detectedEncoder.includes('hevc')
    ? 'hevc_nvenc'
    : 'h264_nvenc';

  return {
    capture: {
      hwnd,
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
