/** desktopCapturer 返回的单个录制源（窗口或整屏） */
export interface RecorderSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  /** 'window' = 应用窗口，'screen' = 整屏 */
  sourceType: 'window' | 'screen';
}

/** 录制上传进度 */
export interface RecordingProgress {
  /** 已成功上传的切片数 */
  uploaded: number;
  /** 上传失败、等待补传的切片数（网络异常时 > 0） */
  pending: number;
}

/**
 * 录制控件状态机：
 *   idle → detecting → ready → recording → finishing → idle
 *                                 ↓（abortRecording）
 *                                ready（异常中止后回到可重录状态）
 */
export type RecorderState = 'idle' | 'detecting' | 'ready' | 'recording' | 'finishing';

/** 主进程 abortRecording 推送的错误事件 payload */
export interface RecorderError {
  reason: string;
}

/**
 * 录制时的音频选项（仅 Windows 生效，macOS 暂不支持系统音频录制）
 *
 * withSystemAudio：
 *   - 窗口录制（gfxcapture）：通过 WGC capture_audio=1 捕获该窗口进程的音频输出
 *   - 全屏录制（ddagrab）：通过 WASAPI loopback 捕获整个系统的混音输出
 *   - 两种方式均为零额外依赖，无需安装第三方驱动
 *
 * withMic：
 *   - 通过 dshow 捕获默认麦克风输入，与系统音频做 amix 混音后合并为一轨
 *   - 仅在 withSystemAudio=true 时有效（无系统音频时不单独录麦克风）
 *
 * isWasapiAvailable：
 *   由主进程 detectEncoder 顺带探测并回传，告知前端当前环境是否支持音频录制；
 *   为 false 时 UI 应灰化音频选项并展示提示
 */
export interface AudioOptions {
  withSystemAudio: boolean;
  withMic: boolean;
}

/** detectEncoder 返回的扩展结果，增加音频可用性信息 */
export interface EncoderDetectResult {
  /** 实际使用的编码器名称，如 'h264_nvenc' / 'libx264' */
  encoder: string;
  /** true = 软件编码（libx264），会占用 CPU，自动降分辨率 */
  isSoftware: boolean;
  /**
   * Windows 下 WASAPI loopback 是否可用（探测方式：ffmpeg -f wasapi -list_devices true）。
   * macOS 始终为 false（不支持系统音频录制）。
   * false 时 UI 灰化音频选项并展示原因提示。
   */
  isAudioAvailable: boolean;
}