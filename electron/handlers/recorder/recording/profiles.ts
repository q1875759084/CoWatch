/**
 * profiles.ts — 捕获 / 编码 / 封装 配置集中注入（方案2a §1.5）
 *
 * 主进程（coordinator）集中维护 CaptureProfile / MuxProfile，
 * 按硬件/模式下发给 window_capture.exe（exe 内一体编码 + HLS 封装），
 * 不写死、不开放终端用户。本文件提供：
 *   - 两套 Profile 类型
 *   - buildExeArgs()：展开为 window_capture.exe CLI
 *   - makeDefaultProfiles()：按检测结果产出默认配置
 *
 * 与 OBS「UI 改参、CoWatch 由主进程注入」一致。捕获/封装参数由主进程注入；录制质量（码率/预设/GOP）走 exe 默认值，不下传。
 */

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
}

/** 封装（exe 内 ffmpeg_muxer 直接写本地 HLS .ts；CoWatch 仅传输出目录）。 */
export interface MuxProfile {
  outDir: string;
}

export interface WindowSpawnOptions {
  muxTarget: 'file' | 'null';
  stats: boolean;
  audio: boolean;
  audioDevice?: string;
  /** 码率控制模式：cqp=质量优先（默认），cbr=恒定码率上限，vbr_ceil=弹性封顶 VBR。VBR 的均值/峰值按分辨率注入（见 buildExeArgs 内 vbrByRes），其余 VBR 参数（lookahead 深度、VBV 秒数）走 exe 默认。 */
  rcMode?: 'cqp' | 'cbr' | 'vbr_ceil';
  /** 分辨率：720p（1280×720，默认）或 900p（1600×900），传给 window_capture.exe 的 --width/--height，并决定 VBR 均值/峰值 */
  resolution?: '720p' | '900p';
  /** 捕获模式：window（默认，需传 hwnd）或 screen（全屏，不传 hwnd）。window_capture.exe 必填 CLI flag。 */
  captureMode?: 'window' | 'screen';
}

/**
 * 展开为 window_capture.exe 参数。
 * 窗口定位优先级 hwnd > window > pid（与 exe 内部裁决一致；此处仅展开，由 exe 最终裁决）。
 */
export function buildExeArgs(
  cap: CaptureProfile,
  mux: MuxProfile,
  opts: WindowSpawnOptions,
): string[] {
  const args: string[] = [];

  // 捕获模式（必填 CLI flag）：window（默认）或 screen（全屏，无 hwnd）
  args.push('--capture-mode', opts.captureMode ?? 'window');

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

  // 码率控制模式：cqp=质量优先（exe 默认），cbr=恒定码率上限，vbr_ceil=弹性封顶 VBR；分辨率由用户选择传入，覆盖 exe 默认 1440×810。
  const rcMode = opts.rcMode ?? 'vbr_ceil';
  args.push('--rc-mode', rcMode);

  // 分辨率：用户选择的分辨率（720p 或 900p），传给 exe 的 --width/--height；覆盖 exe 默认 1440×810
  const res = opts.resolution ?? '720p';
  if (res === '720p') {
    args.push('--width', '1280');
    args.push('--height', '720');
  } else {
    args.push('--width', '1600');
    args.push('--height', '900');
  }

  // VBR_CEIL 弹性封顶：均值/峰值随分辨率（像素量）收缩。
  // lookahead 深度与 VBV 秒数为分辨率无关的时域/弹性旋钮，走 exe 默认（16/6）；
  // 绝对缓冲池 = max × vbv-seconds 随峰值自动收缩，无需单独调 vbv-seconds。
  if (rcMode === 'vbr_ceil') {
    const vbrByRes: Record<'720p' | '900p', { bitrate: number; maxBitrate: number }> = {
      '720p': { bitrate: 4000, maxBitrate: 6000 }, // 均值 4Mbps，峰值 1.5× 均值（弹性封顶）
      '900p': { bitrate: 6000, maxBitrate: 9000 }, // 对齐直播姬推流（原 1080p 码率，分辨率降为 900p 后不变）
    };
    const vbr = vbrByRes[res];
    args.push('--vbr-bitrate', String(vbr.bitrate));
    args.push('--vbr-max-bitrate', String(vbr.maxBitrate));
  }

  // 诊断（可选）：capture/encode/gpu 占用，供后续按 GPU 调参
  if (opts.stats === true) args.push('--stats');

  // 音频：exe 默认录系统 loopback；关闭才传 --no-audio
  if (opts.audio === false) args.push('--no-audio');

  return args;
}

/**
 * 按检测结果产出 window 模式默认 Profile 集合。
 * @param tmpDir           HLS 输出目录
 * @param hwnd            目标窗口 HWND（十进制，主契约；string 或 number 皆可）
 * @param fps             目标帧率
 */
export function makeDefaultProfiles(
  tmpDir: string,
  hwnd?: number | string,
  fps = 30,
): { capture: CaptureProfile; mux: MuxProfile } {
  return {
    capture: {
      ...(hwnd != null ? { hwnd } : {}),
      fps,
    },
    mux: {
      outDir: tmpDir,
    },
  };
}
