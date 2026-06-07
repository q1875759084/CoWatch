import { useRef, useCallback, useEffect, type MutableRefObject } from 'react';
import { useParams } from 'react-router-dom';
import { useUser } from '@/context/UserContext';
import { getAccessToken } from '@/utils/token';
import { useRoom } from '@/context/RoomContext';
import { useRoomWs } from '@/hooks/useRoomWs';
import { getRoomInfoApi, getVideosApi } from '@/api/room';
import LoadingSpinner from '@/components/LoadingSpinner';
import VideoPlayer, { type VideoPlayerHandle } from '@/pages/WatchRoom/VideoPlayer';
import ControlPanel from '@/pages/WatchRoom/ControlPanel';
import VideoUploader from './VideoUploader';
import VideoList from './VideoList';
import styles from './index.module.scss';

/**
 * SYNC_PROGRESS 进度同步阈值（秒）。
 *
 * 收到 SYNC_PROGRESS 时，若本地进度与远端偏差在此范围内，浏览器自然追上，无需 seek。
 * 只有偏差超过阈值（真正失步）时才执行 seek，避免频繁 seek 打断缓冲。
 * 游戏复盘场景对同步精度要求高，设为 0.5s。
 */
const SEEK_THRESHOLD_SEC = 0.5;

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { userInfo } = useUser();
  const { roomState, initRoom, setActiveVideoUrl } = useRoom();

  /**
   * 暂存 ROOM_STATE 下发的播放初始化参数。
   * ROOM_STATE（WS）和 HTTP 初始化是并行的异步路径，VideoPlayer 挂载时机不确定；
   * 用 ref 暂存，在 VideoPlayer 挂载时（callback ref 触发）立即消费。
   */
  const pendingInitRef = useRef<{ isPlaying: boolean; currentTime: number } | null>(null);
  const videoRef = useRef<VideoPlayerHandle>(null);

  /**
   * Callback ref：VideoPlayer 每次挂载时触发，消费暂存的初始化参数。
   * 比 useEffect([activeVideoUrl]) 更可靠，因为它直接响应组件挂载事件。
   */
  const setVideoRef = useCallback((handle: VideoPlayerHandle | null) => {
    (videoRef as MutableRefObject<VideoPlayerHandle | null>).current = handle;
    if (handle && pendingInitRef.current) {
      const { isPlaying, currentTime } = pendingInitRef.current;
      pendingInitRef.current = null;
      // rAF 确保 video 元素完成首次渲染后再操作
      requestAnimationFrame(() => {
        handle.initPlayback(isPlaying, currentTime);
      });
    }
  }, []);

  // 初始化房间状态 + 视频列表
  useEffect(() => {
    if (!roomId) return;
    Promise.all([
      getRoomInfoApi(roomId),
      getVideosApi(roomId),
    ]).then(([info, videosData]) => {
      initRoom({
        roomId: info.roomId,
        roomName: info.roomName,
        activeVideoUrl: info.videoUrl,
        videos: videosData.videos.map((v) => ({
          id: v.id,
          videoUrl: v.videoUrl,
          fileName: v.fileName,
          uploaderId: v.uploaderId,
          createdAt: v.createdAt,
        })),
        members: info.members,
        controlMode: info.controlMode,
        controllerId: info.controllerId,
        playbackState: { currentTime: 0, isPlaying: false },
      });
    });
  }, [roomId]);

  /**
   * 收到 SYNC_PROGRESS：偏差超过阈值才 seek，避免频繁 seek 打断缓冲。
   */
  const handleSyncProgress = useCallback((currentTime: number) => {
    const handle = videoRef.current;
    if (!handle) return;
    if (Math.abs(handle.getCurrentTime() - currentTime) >= SEEK_THRESHOLD_SEC) {
      handle.syncSeek(currentTime);
    }
  }, []);

  /**
   * 收到 SYNC_STATE（播放/暂停 + 时间）：全员同步执行。
   */
  const handleSyncState = useCallback((isPlaying: boolean, currentTime: number) => {
    if (isPlaying) {
      videoRef.current?.syncSeekAndPlay(currentTime);
    } else {
      videoRef.current?.syncSeekAndPause(currentTime);
    }
  }, []);

  /**
   * 收到 ROOM_STATE：保存播放初始化参数，等 VideoPlayer 就绪后执行。
   */
  const handleRoomState = useCallback((isPlaying: boolean, currentTime: number) => {
    if (videoRef.current) {
      videoRef.current.initPlayback(isPlaying, currentTime);
    } else {
      pendingInitRef.current = { isPlaying, currentTime };
    }
  }, []);

  const { sendMessage } = useRoomWs({
    roomId: roomId!,
    token: getAccessToken() ?? '',
    onRoomState: handleRoomState,
    onSyncProgress: handleSyncProgress,
    onSyncState: handleSyncState,
  });

  // 点击视频列表中的"播放"按钮：广播 SWITCH_VIDEO，自己也立即切换
  const handlePlayVideo = useCallback((videoUrl: string, videoId: string) => {
    setActiveVideoUrl(videoUrl);
    sendMessage('SWITCH_VIDEO', { videoUrl, videoId });
  }, [sendMessage, setActiveVideoUrl]);

  if (!roomState) {
    return <LoadingSpinner fullPage text="加载房间..." />;
  }

  const isAdmin = roomState.members.find((m) => m.userId === userInfo?.userId)?.isAdmin ?? false;
  const isController = roomState.controllerId === userInfo?.userId;

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        {/* 左侧主内容区 */}
        <main className={styles.main}>
          {/* 播放器区域 */}
          <div className={styles.playerArea}>
            <div className={styles.playerRatio}>
              {roomState.activeVideoUrl ? (
                <VideoPlayer
                  ref={setVideoRef}
                  src={roomState.activeVideoUrl}
                  disabled={!isController}
                  onProgressChange={(currentTime) => {
                    sendMessage('SYNC_PROGRESS', { currentTime });
                  }}
                  onPlayStateChange={(isPlaying, currentTime) => {
                    sendMessage('SYNC_STATE', { isPlaying, currentTime });
                  }}
                />
              ) : (
                <div className={styles.noVideo}>
                  <span className={styles.noVideoIcon}>🎬</span>
                  <p>从下方选择或上传视频开始复盘</p>
                </div>
              )}
            </div>
          </div>
          {/* 上传区（仅管理员可见） */}
          {isAdmin && (
            <div className={styles.uploaderSection}>
              <VideoUploader roomId={roomId!} />
            </div>
          )}
          {/* 视频列表 */}
          <div className={styles.videoListSection}>
            <VideoList
              videos={roomState.videos}
              activeVideoUrl={roomState.activeVideoUrl}
              onPlay={handlePlayVideo}
            />
          </div>
        </main>

        {/* 右侧控制面板 */}
        <aside className={styles.panel}>
          <ControlPanel
            roomId={roomState.roomId}
            roomName={roomState.roomName}
            members={roomState.members}
            controllerId={roomState.controllerId}
            isAdmin={isAdmin}
            currentUserId={userInfo?.userId ?? ''}
            onTransferControl={(targetUserId) => {
              sendMessage('TRANSFER_CONTROL', { targetUserId });
            }}
          />
        </aside>
      </div>
    </div>
  );
}
