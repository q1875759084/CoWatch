/**
 * 录制层共享类型定义（内部）。
 *
 * 坐标空间约定（见增量设计 v2.2 §9）：
 *   - crop 方案已废弃（ddagrab+crop 被 OBS WGC 取代），相关裁剪类型已删除。
 *   - sentinel 现仅作为窗口事件探测器，不涉及坐标计算。
 *
 * 注（T01 / feat/obs-wgc-capture）：本文件为录制层内部类型，与渲染层
 * src/types/recorder.ts 中的 RecorderPauseReason / RecorderStopReason（UI 简化时曾删除）
 * 无关，切勿混淆，也不要改动 src/ 下的类型。
 */

/** 暂停原因（来自 sentinel PAUSE 协议）。 */
export type PauseReason = 'MINIMIZED' | 'FOREGROUND_LOST';

/** 自动结束原因（来自 sentinel STOP 协议；move/close → stop 收尾）。 */
export type StopReason = 'MOVED' | 'CLOSED';
