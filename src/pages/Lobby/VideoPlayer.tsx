import {
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from 'react';
import Hls from 'hls.js';
import { useMemoizedFn } from 'ahooks';
import { throttle } from '@/utils/throttle';
import { getAccessToken } from '@/utils/token';
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
  /**
   * m3u8 API 路径，如 /api/rooms/{roomId}/videos/{videoId}/m3u8。
   * hls.js 直接加载此 URL，通过 xhrSetup 钩子注入 Bearer Token。
   */
  src: string;
  disabled: boolean;
  onProgressChange: (currentTime: number) => void;
  onPlayStateChange: (isPlaying: boolean, currentTime: number) => void;
  onDurationChange?: (duration: number) => void;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, disabled, onProgressChange, onPlayStateChange, onDurationChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);

    /**
     * 非主控侧：记录当前处理中的最新 seq（后端分配，单调递增）。
     * syncSeekAndPause 播放中分支会注册异步 onSeeked 回调，
     * 若在 seeked 触发之前又收到了更新的指令（seq 更大），
     * onSeeked 执行时发现 lastSyncSeqRef.current > 自己的 seq，直接丢弃。
     */
    const lastSyncSeqRef = useRef(0);

    /**
     * 标记视频正处于"静音自动播放"状态，等待用户首次交互后取消静音。
     */
    const unmutePendingRef = useRef(false);

    // ── hls.js 生命周期管理 ──────────────────────────────────────────────────

    useEffect(() => {
      const videoEl = videoRef.current;
      if (!videoEl) return;

      // 销毁旧实例
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      if (!src) return;

      /**
       * 直接将 m3u8 API 路径（/api/rooms/.../m3u8）传给 hls.js，由 hls.js 自行请求。
       *
       * 为什么不用 Blob URL：
       *   以前的方案是先 fetch m3u8 文本再转 Blob URL，但 hls.js 用 Blob URL 作为 base
       *   解析 m3u8 里的相对路径（如 /uploads/...），会拼出非法的 blob:http:/uploads/...。
       *   直接传真实 URL，hls.js 以 http://host/api/... 为 base，相对路径解析完全正确，
       *   本地模式（/uploads/）和 COS 模式（https://...）行为一致。
       *
       * Bearer Token 注入：
       *   hls.js 默认用 XMLHttpRequest 请求，通过 xhrSetup 钩子为每个请求注入 Authorization 头。
       *   Token 在每次请求时实时读取，无感刷新后也能正确携带新 Token。
       */
      const hls = new Hls({
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        xhrSetup: (xhr) => {
          const token = getAccessToken();
          if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          }
        },
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        console.error('[VideoPlayer] hls fatal error:', data);
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          console.warn('[VideoPlayer] 尝试恢复媒体错误...');
          hls.recoverMediaError();
        } else {
          hls.destroy();
          hlsRef.current = null;
        }
      });

      hls.loadSource(src);
      hls.attachMedia(videoEl);
      hlsRef.current = hls;

      console.log('[VideoPlayer] hls.js 加载完成:', src);

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }, [src]);

    // ── imperative handle ────────────────────────────────────────────────────

    /**
     * 尝试播放，若被 Autoplay Policy 拒绝则静音后重试。
     */
    const tryPlay = (video: HTMLVideoElement) => {
      video.play().catch(() => {
        video.muted = true;
        unmutePendingRef.current = true;
        video.play().catch(() => {
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
          video.currentTime = time;
        } else {
          video.currentTime = time;
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
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
          if (!isPlaying) {
            // 目标状态是暂停：确保视频停止播放（视频可能当前正在播放）
            video.pause();
            return;
          }

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

    // ── 事件处理 ─────────────────────────────────────────────────────────────

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
          onTimeUpdate={handleTimeUpdate}
          onPlay={handlePlay}
          onPause={handlePause}
          onLoadedMetadata={handleLoadedMetadata}
          controls
          style={{
            // disabled 时设 pointer-events:none：
            //   - 非主控跟随模式：禁止用户操作视频控件
            //   - 主控绘制模式：防止绘制点击穿透到视频
            // 同时连带压制了 Shadow DOM 内的手型光标（无法被外部 CSS 覆盖的问题）
            pointerEvents: disabled ? 'none' : 'auto',
          }}
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
