/**
 * 设置参数类型定义
 *
 * 录制与转码的 GPU 负载特征不同（录制与 3D 渲染竞争 SM，转码不竞争），
 * 因此分辨率等参数两层独立配置；仅帧率取值集合（Fps）两层共用，全局持久化（所有房间共享）。
 */

/** 录制分辨率选项 */
export type RecordingResolution = '720p' | '900p';

/** 帧率选项（录制与转码共用的取值集合：30 / 60） */
export type Fps = 30 | 60;

/**
 * 录制设置层
 * 在主进程启动录制时（start()）被读取，传递给 buildExeArgs()。
 */
export interface RecordingSettings {
  /** 分辨率：720p（1280×720）/ 900p（1600×900） */
  resolution: RecordingResolution;
  /** 帧率：30 / 60 */
  fps: Fps;
}

/**
 * 转码设置层
 * 在主进程启动转码时（startExternalVideoTranscode()）被读取，传递给 buildFfmpegArgs()。
 */
export interface TranscodeSettings {
  /** 帧率：30 / 60 */
  fps: Fps;
}

/** 完整应用设置（录制 + 转码两层） */
export interface AppSettings {
  recording: RecordingSettings;
  transcode: TranscodeSettings;
}

/** 设置段名（用于 settings:set IPC 的 section 参数） */
export type SettingsSection = 'recording' | 'transcode';

/**
 * 默认设置（首次启动无 settings.json 时使用）。
 * 录制：720p / 30fps（码率由 profiles.ts 按分辨率自适应，不暴露给用户）
 * 转码：30fps（质量参数硬编码在 buildFfmpegArgs，不暴露给用户）
 */
export const DEFAULT_SETTINGS: AppSettings = {
  recording: {
    resolution: '720p',
    fps: 30,
  },
  transcode: {
    fps: 30,
  },
};
