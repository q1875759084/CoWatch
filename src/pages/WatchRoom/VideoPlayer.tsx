import {
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type MutableRefObject,
} from 'react';
import { throttle } from '@/utils/throttle';
import styles from './VideoPlayer.module.scss';

export interface VideoPlayerHandle {
  seekTo: (time: number) => void;
  play: () => void;
  pause: () => void;
}

interface VideoPlayerProps {
  src: string;
  disabled: boolean;
  isSyncingRef: MutableRefObject<boolean>;
  onProgressChange: (currentTime: number) => void;
  onPlayStateChange: (isPlaying: boolean, currentTime: number) => void;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, disabled, isSyncingRef, onProgressChange, onPlayStateChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    // 暴露给父组件的命令式 API
    useImperativeHandle(ref, () => ({
      seekTo: (time: number) => {
        if (videoRef.current) {
          videoRef.current.currentTime = time;
        }
      },
      play: () => {
        videoRef.current?.play().catch(() => {});
      },
      pause: () => {
        videoRef.current?.pause();
      },
    }));

    // throttle 200ms 避免进度条拖动时消息过频
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const throttledProgressChange = useCallback(
      throttle((time: unknown) => onProgressChange(time as number), 200),
      [onProgressChange],
    );

    const handleTimeUpdate = useCallback(() => {
      const video = videoRef.current;
      if (!video || isSyncingRef.current) return;
      throttledProgressChange(video.currentTime);
    }, [isSyncingRef, throttledProgressChange]);

    const handlePlay = useCallback(() => {
      const video = videoRef.current;
      if (!video || isSyncingRef.current) return;
      onPlayStateChange(true, video.currentTime);
    }, [isSyncingRef, onPlayStateChange]);

    const handlePause = useCallback(() => {
      const video = videoRef.current;
      if (!video || isSyncingRef.current) return;
      onPlayStateChange(false, video.currentTime);
    }, [isSyncingRef, onPlayStateChange]);

    return (
      <div className={styles.wrapper}>
        <video
          ref={videoRef}
          className={styles.video}
          src={src}
          onTimeUpdate={handleTimeUpdate}
          onPlay={handlePlay}
          onPause={handlePause}
          // 禁用原生控制条，使用自定义控制栏
          controls={!disabled}
          // 非控制者：禁止拖动进度条和播放操作
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
