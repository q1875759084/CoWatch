/**
 * 窗口存活检测模块
 *
 * 职责：
 *   提供 isWindowAlive——通过 desktopCapturer 枚举当前窗口列表，
 *   单次检测目标 sourceId 是否仍然存在。
 *
 * 使用场景：
 *   ffmpeg crash 时的快速判断（handleFfmpegCrash 路径）：若窗口已消失，
 *   crash 属于预期行为，应跳过重启直接走 stop()，而不是无意义地重试 3 次再报错。
 *
 * 设计原则：
 *   - 不直接依赖 recorder.ts 的任何状态，纯函数式检测
 *   - thumbnailSize 设为 0×0 跳过截图，单次枚举开销约 1~5ms
 *   - 枚举失败不中断调用方，保守判断为"已消失"（返回 false）
 *   - 支持窗口标题模糊匹配作为备用检测手段
 */

import { desktopCapturer } from 'electron';

/**
 * 单次检测目标窗口是否仍然存在。
 *
 * 用于 ffmpeg crash 时的快速判断：若窗口已消失，crash 属于预期行为，
 * 应跳过重启直接走 stop()，而不是无意义地重试 3 次再报错。
 *
 * @param sourceId  目标窗口的 desktopCapturer source id
 * @param windowTitle  目标窗口的标题（可选，用于模糊匹配备用检测）
 * @returns         true = 窗口仍存在；false = 窗口已消失或枚举失败（保守判断为消失）
 */
export async function isWindowAlive(
  sourceId: string,
  windowTitle?: string,
): Promise<boolean> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });

    // 优先匹配 sourceId
    const byId = sources.some((s) => s.id === sourceId);
    if (byId) return true;

    // 备用：标题模糊匹配（如果提供了 windowTitle）
    if (windowTitle) {
      const byTitle = sources.some((s) => {
        // 精确匹配
        if (s.name === windowTitle) return true;
        // 模糊匹配：source.name 包含 windowTitle 的核心部分
        // 例如：windowTitle="Endfield" 可以匹配 "Endfield [60 FPS]"
        const normalizedSource = s.name.toLowerCase();
        const normalizedTitle = windowTitle.toLowerCase();
        return normalizedSource.includes(normalizedTitle);
      });
      if (byTitle) {
        console.log(`[window-watch] 窗口 id 匹配失败，但标题匹配成功：${windowTitle}`);
        return true;
      }
    }

    return false;
  } catch {
    // 枚举失败时保守判断为"已消失"，避免对不存在的窗口反复重启
    return false;
  }
}
