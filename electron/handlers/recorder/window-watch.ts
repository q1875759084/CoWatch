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
 *   - 连续 3 次检测不到才判定为消失（避免短暂消失导致误判）
 *   - 支持窗口标题模糊匹配作为备用检测手段
 */

import { desktopCapturer } from 'electron';

const POLL_INTERVAL_MS = 5000;
const MAX_CONSECUTIVE_MISSES = 5;  // 连续 5 次（25 秒），容忍 desktopCapturer 对游戏窗口的间歇性误报

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

/**
 * 启动窗口存活检测轮询。
 *
 * @param sourceId    目标窗口的 desktopCapturer source id（必须以 "window:" 开头）
 * @param windowTitle 目标窗口的标题（可选，用于模糊匹配备用检测）
 * @param onGone      目标窗口消失时的回调（仅触发一次）
 * @param isStopped   外部停止守卫，返回 true 时跳过检测（防止与主动停止竞争）
 * @returns           WindowWatcher，调用 stop() 可提前终止轮询
 */
export function startWindowWatcher(
  sourceId: string,
  windowTitle: string | undefined,
  onGone: () => void,
  isStopped: () => boolean,
): WindowWatcher {
  let consecutiveMisses = 0;
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
      
      // 检测窗口是否存在（优先 id 匹配，备用标题匹配）
      const alive = sources.some((s) => {
        // 精确匹配 sourceId
        if (s.id === sourceId) return true;
        
        // 备用：标题模糊匹配
        if (windowTitle) {
          const normalizedSource = s.name.toLowerCase();
          const normalizedTitle = windowTitle.toLowerCase();
          return normalizedSource.includes(normalizedTitle);
        }
        
        return false;
      });
      
      if (!alive) {
        consecutiveMisses++;
        console.log(`[window-watch] 窗口未找到（${sourceId}），连续失败次数：${consecutiveMisses}/${MAX_CONSECUTIVE_MISSES}`);
        
        if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
          console.log(`[window-watch] 目标窗口消失（${sourceId}），触发优雅停止`);
          if (timer !== null) { clearInterval(timer); timer = null; }
          onGone();
        }
      } else {
        // 重置连续失败计数
        if (consecutiveMisses > 0) {
          console.log(`[window-watch] 窗口恢复（${sourceId}），连续失败次数已重置`);
        }
        consecutiveMisses = 0;
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
