import { useRef, useCallback, useEffect } from 'react';
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

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { userInfo } = useUser();
  const { roomState, initRoom, setActiveVideoUrl } = useRoom();
  const videoRef = useRef<VideoPlayerHandle>(null);
  const isSyncingRef = useRef(false);

  // 初始化房间状态 + 视频列表
  useEffect(() => {
    if (!roomId) return;
    Promise.all([
      getRoomInfoApi(roomId),
      getVideosApi(roomId),
    ]).then(([info, videosData]) => {
      initRoom({
        roomId: info.roomId,
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

  const handleSyncProgress = useCallback((currentTime: number) => {
    isSyncingRef.current = true;
    videoRef.current?.seekTo(currentTime);
    requestAnimationFrame(() => { isSyncingRef.current = false; });
  }, []);

  const handleSyncState = useCallback((isPlaying: boolean, currentTime: number) => {
    isSyncingRef.current = true;
    videoRef.current?.seekTo(currentTime);
    if (isPlaying) {
      videoRef.current?.play();
    } else {
      videoRef.current?.pause();
    }
    requestAnimationFrame(() => { isSyncingRef.current = false; });
  }, []);

  const handleSwitchVideo = useCallback((videoUrl: string) => {
    // SWITCH_VIDEO 广播过来时，播放器 src 会因 activeVideoUrl 更新而重载
    // 无需手动操作 videoRef，React 重渲染会自动处理
    void videoUrl;
  }, []);

  const { sendMessage } = useRoomWs({
    roomId: roomId!,
    token: getAccessToken() ?? '',
    onSyncProgress: handleSyncProgress,
    onSyncState: handleSyncState,
    onSwitchVideo: handleSwitchVideo,
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
  const isController =
    roomState.controlMode === 'free' ||
    roomState.controllerId === userInfo?.userId;

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        {/* 左侧主内容区 */}
        <main className={styles.main}>
          {/* 播放器区域：外层约束最大高度，内层 playerRatio 保持 16:9 */}
          <div className={styles.playerArea}>
            <div className={styles.playerRatio}>
              {roomState.activeVideoUrl ? (
                <VideoPlayer
                  ref={videoRef}
                  src={roomState.activeVideoUrl}
                  disabled={!isController}
                  isSyncingRef={isSyncingRef}
                  onProgressChange={(currentTime) => {
                    if (!isSyncingRef.current) {
                      sendMessage('SYNC_PROGRESS', { currentTime });
                    }
                  }}
                  onPlayStateChange={(isPlaying, currentTime) => {
                    if (!isSyncingRef.current) {
                      sendMessage('SYNC_STATE', { isPlaying, currentTime });
                    }
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
            members={roomState.members}
            controllerId={roomState.controllerId}
            controlMode={roomState.controlMode}
            isAdmin={isAdmin}
            currentUserId={userInfo?.userId ?? ''}
            onTransferControl={(targetUserId) => {
              sendMessage('TRANSFER_CONTROL', { targetUserId });
            }}
            onModeChange={(mode) => {
              sendMessage('MODE_CHANGE', { mode });
            }}
          />
        </aside>
      </div>
    </div>
  );
}
