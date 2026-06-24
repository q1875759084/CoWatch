/** 默认画笔颜色 */
export const DEFAULT_DRAW_COLOR = '#ffffff';

/**
 * SYNC_PROGRESS 是主控的实时进度广播，非主控收到后的处理原则：
 *   - 偏差在阈值内：不 seek，各自自然播放即可
 *   - 偏差超出阈值：说明发生了严重失步，才执行兜底 seek 纠偏
 *
 * 阈值设为 0.5s：精确对齐主控进度，网络延迟通常远小于此值。
 * 现在根本原因（sync 保护窗口吞掉 play 事件）已修复，恢复 0.5s。
 */
export const SYNC_PROGRESS_THRESHOLD_SEC = 0.5;

/**
 * SYNC_STATE 收到后判断是否需要 seek 的阈值。
 *   - isPlaying=true 且偏差 < 阈值 → 只 play，不 seek（缓冲区完整，避免打断）
 *   - isPlaying=true 且偏差 >= 阈值 → seek + play（追上主控进度）
 *   - isPlaying=false → 始终 seek + pause（暂停必须精确对帧）
 */
export const SYNC_STATE_SEEK_THRESHOLD_SEC = 0.5;
