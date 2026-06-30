/**
 * 窗口存活检测模块
 *
 * 职责：
 *   录制窗口模式下，每 5s 通过 desktopCapturer 枚举当前窗口列表，
 *   若目标 sourceId 消失则调用 onWindowGone 回调（由 recorder.ts 传入 stop）。
 *
 * 覆盖场景：
 *   - 被录制窗口用户正常关闭
 *   - 被录制进程崩溃
 *   - 被系统/任务管理器强杀
 *
 * 设计原则：
 *   - 不直接依赖 recorder.ts 的任何状态，通过回调解耦
 *   - thumbnailSize 设为 0×0 跳过截图，单次枚举开销约 1~5ms
 *   - 枚举失败不中断录制，静默等下一轮重试
 */

import { desktopCapturer } from 'electron';

const POLL_INTERVAL_MS = 5000;

export interface WindowWatcher {
  /** 停止轮询并清理定时器 */
  stop: () => void;
}

/**
 * 单次检测目标窗口是否仍然存在。
 *
 * 用于 ffmpeg crash 时的快速判断：若窗口已消失，crash 属于预期行为，
 * 应跳过重启直接走 stop()，而不是无意义地重试 3 次再报错。
 *
 * @param sourceId  目标窗口的 desktopCapturer source id
 * @returns         true = 窗口仍存在；false = 窗口已消失或枚举失败（保守判断为消失）
 */
export async function isWindowAlive(sourceId: string): Promise<boolean> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.some((s) => s.id === sourceId);
  } catch {
    // 枚举失败时保守判断为"已消失"，避免对不存在的窗口反复重启
    return false;
  }
}

/**
 * 启动窗口存活检测轮询。
 *
 * @param sourceId    目标窗口的 desktopCapturer source id（必须以 "window:" 开头）
 * @param onGone      目标窗口消失时的回调（仅触发一次）
 * @param isStopped   外部停止守卫，返回 true 时跳过检测（防止与主动停止竞争）
 * @returns           WindowWatcher，调用 stop() 可提前终止轮询
 */
export function startWindowWatcher(
  sourceId: string,
  onGone: () => void,
  isStopped: () => boolean,
): WindowWatcher {
  let timer: ReturnType<typeof setInterval> | null = setInterval(async () => {
    if (isStopped()) {
      // 外部已主动停止，清理自身
      if (timer !== null) { clearInterval(timer); timer = null; }
      return;
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const alive = sources.some((s) => s.id === sourceId);
      if (!alive) {
        console.log(`[window-watch] 目标窗口消失（${sourceId}），触发优雅停止`);
        if (timer !== null) { clearInterval(timer); timer = null; }
        onGone();
      }
    } catch (err) {
      // 枚举失败（如权限变更）不中断录制，等下一轮
      console.warn('[window-watch] desktopCapturer 枚举失败：', (err as Error).message);
    }
  }, POLL_INTERVAL_MS);

  return {
    stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    },
  };
}
