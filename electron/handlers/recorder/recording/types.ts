/**
 * 录制层共享类型定义（内部）。
 *
 * 坐标空间约定（见增量设计 v2.2 §9）：
 *   - crop 由 sentinel 进程计算（DWMWA 物理像素 − 主屏物理原点），Node 侧原样透传，禁止 TS 侧 DPI 换算。
 *   - RECT 协议字段顺序：RECT <x> <y> <w> <h>，crop 直接取用。
 *
 * 注（T01 / feat/obs-wgc-capture）：本文件为录制层内部类型，与渲染层
 * src/types/recorder.ts 中的 RecorderPauseReason / RecorderStopReason（UI 简化时曾删除）
 * 无关，切勿混淆，也不要改动 src/ 下的类型。
 */

/** 裁剪矩形：物理像素，相对主屏左上角 (0,0)。output_idx 固定 0（单屏）。 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 暂停原因（来自 sentinel PAUSE 协议）。 */
export type PauseReason = 'MINIMIZED' | 'FOREGROUND_LOST';

/** 自动结束原因（来自 sentinel STOP 协议；move/close → stop 收尾）。 */
export type StopReason = 'MOVED' | 'CLOSED';
