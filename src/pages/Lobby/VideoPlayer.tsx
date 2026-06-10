import {
  useRef,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { useMemoizedFn } from 'ahooks';
import { throttle } from '@/utils/throttle';
import styles from './VideoPlayer.module.scss';

export interface VideoPlayerHandle {
  /**
   * 远端同步：仅播放，不 seek。
   * 用于 SYNC_STATE(isPlaying=true) 且进度偏差在阈值内的情况。
   */
  syncPlay: (seq: number) => void;
  /** 远端同步：跳转 + 播放。 */
  syncSeekAndPlay: (time: number, seq: number) => void;
  /**
   * 远端同步：跳转 + 暂停。
   * 播放中 seek 需在 seeked 后显式 pause，onSeeked 执行前用 seq 判断是否已过期。
   */
  syncSeekAndPause: (time: number, seq: number) => void;
  /** 仅跳转进度，不改变播放状态（用于 SYNC_PROGRESS 兜底纠偏）。 */
  syncSeek: (time: number) => void;
  /** 读取当前视频时间（供外部做偏差阈值判断） */
  getCurrentTime: () => number;
  /**
   * 初始化播放状态（新成员加入时同步当前进度）。
   * isPlaying=true 时先静音播放（绕过自动播放策略），等用户首次点击后取消静音。
   */
  initPlayback: (isPlaying: boolean, currentTime: number) => void;
}

interface VideoPlayerProps {
  src: string;
  disabled: boolean;
  onProgressChange: (currentTime: number) => void;
  onPlayStateChange: (isPlaying: boolean, currentTime: number) => void;
  onDurationChange?: (duration: number) => void;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, disabled, onProgressChange, onPlayStateChange, onDurationChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    /**
     * 非主控侧：记录当前处理中的最新 seq（后端分配，单调递增）。
     *
     * 用途：syncSeekAndPause 播放中分支会注册异步 onSeeked 回调。
     * 若在 seeked 触发之前又收到了更新的指令（seq 更大），
     * onSeeked 执行时发现 lastSyncSeqRef.current > 自己的 seq，直接丢弃，
     * 不执行 pause，让更新的指令接管。
     *
     * 注意：这里不再承担"保护 handlePlay/handlePause 不广播"的职责。
     * 非主控的 disabled=true 导致 pointerEvents:none，用户根本触发不了
     * play/pause 事件，handlePlay/handlePause 里的事件全部来自远端指令，
     * 全部应该正常广播（主控会收到后发现是自己的回环，因为
     * SYNC_STATE 用 broadcastExcept 排除了主控，所以实际上不会回环）。
     */
    const lastSyncSeqRef = useRef(0);

    /**
     * 标记视频正处于"静音自动播放"状态，等待用户首次交互后取消静音。
     */
    const unmutePendingRef = useRef(false);

    /**
     * 尝试播放，若被 Autoplay Policy 拒绝则静音后重试。
     * 静音重试成功后设置 unmutePendingRef，等用户首次点击再取消静音。
     */
    const tryPlay = (video: HTMLVideoElement) => {
      video.play().catch(() => {
        // 非静音播放失败（Autoplay Policy），静音重试
        video.muted = true;
        unmutePendingRef.current = true;
        video.play().catch(() => {
          // 静音也失败，重置标志（不常见，网络异常等）
          unmutePendingRef.current = false;
          video.muted = false;
        });
      });
    };

    useImperativeHandle(ref, () => ({
      syncPlay: (seq: number) => {
        const video = videoRef.current;
        if (!video) return;
        lastSyncSeqRef.current = seq;
        tryPlay(video);
      },

      syncSeekAndPlay: (time: number, seq: number) => {
        const video = videoRef.current;
        if (!video) return;
        lastSyncSeqRef.current = seq;
        video.currentTime = time;
        tryPlay(video);
      },

      syncSeekAndPause: (time: number, seq: number) => {
        const video = videoRef.current;
        if (!video) return;
        lastSyncSeqRef.current = seq;
        if (video.paused) {
          // 已暂停：直接 seek，不产生 play/pause 事件
          video.currentTime = time;
        } else {
          // 播放中：seek 后在 seeked 里强制 pause
          video.currentTime = time;
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            // 有更新指令覆盖了本条（seq 更大），丢弃
            if (lastSyncSeqRef.current > seq) return;
            video.pause();
          };
          video.addEventListener('seeked', onSeeked);
        }
      },

      syncSeek: (time: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = time;
      },

      getCurrentTime: () => videoRef.current?.currentTime ?? 0,

      initPlayback: (isPlaying: boolean, currentTime: number) => {
        const video = videoRef.current;
        if (!video) return;

        const doInit = () => {
          video.currentTime = currentTime;
          if (!isPlaying) return;

          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            video.muted = true;
            unmutePendingRef.current = true;
            video.play().catch(() => {
              unmutePendingRef.current = false;
              video.muted = false;
            });
          };
          video.addEventListener('seeked', onSeeked);
        };

        if (video.readyState >= 3) {
          doInit();
        } else {
          const onCanPlay = () => {
            video.removeEventListener('canplay', onCanPlay);
            doInit();
          };
          video.addEventListener('canplay', onCanPlay);
        }
      },
    }));

    const stableOnProgressChange = useMemoizedFn(onProgressChange);
    const throttledProgressChangeRef = useRef(throttle((time: number) => stableOnProgressChange(time), 200));

    const handleTimeUpdate = useMemoizedFn(() => {
      const video = videoRef.current;
      if (!video) return;
      throttledProgressChangeRef.current(video.currentTime);
    });

    /**
     * 主控：play/pause 事件 = 用户操作，直接广播。
     * 非主控：disabled=true，pointerEvents:none，用户触发不了这两个事件；
     *   远端指令触发的 play/pause 同样走这里广播——但因为 SYNC_STATE 用
     *   broadcastExcept 排除了主控，非主控不是发送方，这里的广播实际上
     *   会发给服务端，服务端再 broadcastExcept 排除非主控自己……
     *
     * 等等：非主控调用了 video.play()，浏览器触发 play 事件，handlePlay 里
     * onPlayStateChange → sendMessage('SYNC_STATE') → 后端收到非主控的 SYNC_STATE
     * → canControl 检查失败（非主控不是 controller）→ 直接 return，不广播。
     *
     * 所以：非主控的 handlePlay/handlePause 发出去的消息后端会拦截，完全无害。
     * 不需要任何保护逻辑。
     */
    const handlePlay = useMemoizedFn(() => {
      const video = videoRef.current;
      if (!video) return;
      onPlayStateChange(true, video.currentTime);
    });

    const handlePause = useMemoizedFn(() => {
      const video = videoRef.current;
      if (!video) return;
      onPlayStateChange(false, video.currentTime);
    });

    const handleLoadedMetadata = useMemoizedFn(() => {
      const video = videoRef.current;
      if (!video || !onDurationChange) return;
      onDurationChange(video.duration);
    });

    const handleClick = useMemoizedFn(() => {
      if (unmutePendingRef.current && videoRef.current) {
        unmutePendingRef.current = false;
        videoRef.current.muted = false;
      }
    });

    return (
      <div className={styles.wrapper} onClick={handleClick}>
        <video
          ref={videoRef}
          className={styles.video}
          src={src}
          onTimeUpdate={handleTimeUpdate}
          onPlay={handlePlay}
          onPause={handlePause}
          onLoadedMetadata={handleLoadedMetadata}
          controls
          style={{ pointerEvents: disabled ? 'none' : 'auto' }}
          preload="metadata"
        />
        {disabled && (
          <div className={styles.disabledOverlay}>
            <span className={styles.disabledHint}>👁 观看模式</span>
          </div>
        )}
      </div>
    );
  },
);

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;
