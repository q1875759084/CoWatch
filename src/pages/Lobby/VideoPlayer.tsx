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
   * 远端同步：跳转 + 播放。
   * 若当前正在播放，seek 会产生隐式 pause，提前预留名额；
   * play() 本身也需要一个名额，一并预留，防止回环广播。
   */
  syncSeekAndPlay: (time: number) => void;
  /**
   * 远端同步：跳转 + 暂停。
   * 正在播放时 seek 的浏览器事件序列：
   *   pause（seeking）→ seeking → seeked → play（自动恢复）
   * 需在 seeked 后显式 pause 才能真正停住，中间所有事件均预留名额。
   */
  syncSeekAndPause: (time: number) => void;
  /**
   * 仅跳转进度，不改变播放状态（用于 SYNC_PROGRESS）。
   * 若正在播放，seek 会触发隐式 pause，提前预留名额。
   */
  syncSeek: (time: number) => void;
  /** 读取当前视频时间（供外部做偏差阈值判断） */
  getCurrentTime: () => number;
  /**
   * 初始化播放状态（新成员加入时同步当前进度）。
   * 若视频尚未就绪（readyState < 3），等待 canplay 后再执行。
   * isPlaying=true 时先静音播放（绕过自动播放策略），等用户首次点击后取消静音。
   */
  initPlayback: (isPlaying: boolean, currentTime: number) => void;
}

interface VideoPlayerProps {
  src: string;
  disabled: boolean;
  onProgressChange: (currentTime: number) => void;
  onPlayStateChange: (isPlaying: boolean, currentTime: number) => void;
  /** 视频元数据加载完毕时回调，返回视频总时长（秒） */
  onDurationChange?: (duration: number) => void;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, disabled, onProgressChange, onPlayStateChange, onDurationChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    /**
     * 远端操作保护计数器。
     *
     * 规则：
     *   每次预期浏览器会因远端操作触发一个"不该广播"的 play/pause 事件时，提前 +1；
     *   handlePlay / handlePause 被触发时，若计数 > 0，则 -1 并跳过广播。
     *
     * 用计数器而非 boolean 的原因：
     *   播放中 seek 触发隐式 pause（消耗 1），随后 seeked 后浏览器自动 play（消耗 1），
     *   再加手动 pause（消耗 1），三个事件需要独立的名额，boolean 无法区分。
     */
    const remotePendingRef = useRef(0);

    /**
     * 标记视频正处于"静音自动播放"状态，等待用户首次交互后取消静音。
     * Chrome 不允许有声视频自动播放，但允许静音视频自动播放；
     * unmute 本身需要用户手势，因此在用户点击页面时执行。
     */
    const unmutePendingRef = useRef(false);

    useImperativeHandle(ref, () => ({
      syncSeekAndPlay: (time: number) => {
        const video = videoRef.current;
        if (!video) return;
        if (!video.paused) remotePendingRef.current += 1; // 保护 seek 触发的隐式 pause
        remotePendingRef.current += 1;                    // 保护即将触发的 play 事件
        video.currentTime = time;
        video.play().catch(() => {
          // play() 被浏览器拒绝，收回多余名额
          remotePendingRef.current = Math.max(0, remotePendingRef.current - 1);
        });
      },

      syncSeekAndPause: (time: number) => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) {
          // 已暂停：seek 不产生隐式 pause 事件，只需为 pause() 预留一个名额
          remotePendingRef.current += 1;
          video.currentTime = time;
          // video 已暂停，pause() 不会触发 pause 事件，此处调用只是确保语义一致
          video.pause();
        } else {
          // 播放中 seek 的完整浏览器事件序列：
          //   pause（seeking 开始）→ seeking → seeked → play（浏览器自动恢复播放）
          // 不能依赖隐式 pause 实现暂停，seeked 后视频会自动恢复，必须在 seeked 后显式 pause。
          remotePendingRef.current += 1; // 保护 seek 触发的隐式 pause
          remotePendingRef.current += 1; // 保护 seeked 后浏览器自动触发的 play
          remotePendingRef.current += 1; // 保护我们手动调用的 pause()
          video.currentTime = time;
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            video.pause();
          };
          video.addEventListener('seeked', onSeeked);
        }
      },

      syncSeek: (time: number) => {
        const video = videoRef.current;
        if (!video) return;
        if (!video.paused) remotePendingRef.current += 1; // 保护 seek 触发的隐式 pause
        video.currentTime = time;
      },

      getCurrentTime: () => videoRef.current?.currentTime ?? 0,

      initPlayback: (isPlaying: boolean, currentTime: number) => {
        const video = videoRef.current;
        if (!video) return;

        const doInit = () => {
          video.currentTime = currentTime;
          if (!isPlaying) return;

          // seeked 后再 play，确保从目标帧开始播放
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            remotePendingRef.current += 1; // 保护即将触发的 play 事件
            // 静音播放绕过 Chrome 自动播放策略，等用户首次点击时取消静音
            video.muted = true;
            unmutePendingRef.current = true;
            video.play().catch(() => {
              unmutePendingRef.current = false;
              video.muted = false;
              remotePendingRef.current = Math.max(0, remotePendingRef.current - 1);
            });
          };
          video.addEventListener('seeked', onSeeked);
        };

        // readyState >= 3（HAVE_FUTURE_DATA）表示已有足够数据，可直接操作
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

    // throttle 200ms，避免拖动进度条时消息过频。
    // 用 useRef 固定 throttle 实例（整个组件生命周期只创建一次），
    // 再用 useMemoizedFn 提供稳定的调用引用。
    const stableOnProgressChange = useMemoizedFn(onProgressChange);
    const throttledProgressChangeRef = useRef(throttle((time: number) => stableOnProgressChange(time), 200));

    const handleTimeUpdate = useMemoizedFn(() => {
      const video = videoRef.current;
      if (!video) return;
      throttledProgressChangeRef.current(video.currentTime);
    });

    const handlePlay = useMemoizedFn(() => {
      const video = videoRef.current;
      if (!video) return;
      if (remotePendingRef.current > 0) {
        remotePendingRef.current -= 1;
        return;
      }
      onPlayStateChange(true, video.currentTime);
    });

    const handlePause = useMemoizedFn(() => {
      const video = videoRef.current;
      if (!video) return;
      if (remotePendingRef.current > 0) {
        remotePendingRef.current -= 1;
        return;
      }
      onPlayStateChange(false, video.currentTime);
    });

    const handleLoadedMetadata = useMemoizedFn(() => {
      const video = videoRef.current;
      if (!video || !onDurationChange) return;
      onDurationChange(video.duration);
    });

    const handleClick = useMemoizedFn(() => {
      // 用户首次点击时，若视频正处于静音自动播放状态，取消静音
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
          controls={!disabled}
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
