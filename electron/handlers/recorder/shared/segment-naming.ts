/**
 * 切片文件名共享契约模块。
 *
 * v3 唯一权威：window_capture.exe 录制产出 + 外部转码产出的切片统一使用
 * `seq%05d.ts`（定宽 5 位、1 起始，由 capture_session.cpp:775 定义）。
 *
 * 录制产出端（C++ 侧）：capture_session.cpp 硬编码 seq%05d.ts，本模块仅作
 *   TS 侧契约镜像，供解析使用。
 * 外部转码产出端（TS 侧）：使用 SEGMENT_PATTERN 作为 ffmpeg 输出模板。
 * 补传解析端（TS 侧）：使用 parseSegmentIndex 计算切片序号用于排序。
 *
 * 历史背景：v2 曾使用 seg%03d_opt.ts（外部转码）和 seg\d+（补传解析），
 * 三方命名不一致导致 parseSegmentIndex 永不匹配、补传切片排序失效。
 * v3 统一为 seq%05d.ts 后，补传不再重新解析文件名（直接读 manifest 数组），
 * 但 stop 时持久化仍需 parseSegmentIndex 计算 index 用于初始排序。
 */

/** v3 切片文件名格式（与 capture_session.cpp:775 对齐） */
export const SEGMENT_PATTERN = 'seq%05d.ts';

/**
 * 解析切片序号（仅 v3 格式）。
 */
export function parseSegmentIndex(fileName: string): number {
  const m = fileName.match(/^seq(\d+)\.ts$/);
  return m ? parseInt(m[1], 10) : 0;
}
