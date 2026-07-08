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

/** 待补传的持久化录制摘要 */
export interface PendingRecording {
  sessionId: string;
  roomId: string;
  createdAt: string;
  totalSegments: number;
  uploadedCount: number;
  totalSize: number;
  displayName: string;
  durationSeconds: number;
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

/** detectEncoder 返回结果 */
export interface EncoderDetectResult {
  /** 实际使用的编码器名称，如 'h264_nvenc' / 'libx264' */
  encoder: string;
  /** true = 软件编码（libx264），会占用 CPU，自动降分辨率 */
  isSoftware: boolean;
}

/** 外部视频转码进度（Electron 客户端对用户自有视频文件做转码时的 IPC 推送） */
export interface ExternalTranscodeProgress {
  /** 当前阶段 */
  phase: 'transcoding' | 'uploading' | 'completed' | 'failed';
  /** 已上传分段数 */
  uploaded: number;
  /** 预估总分段数（-1 = 尚无法估算） */
  estimated: number;
}