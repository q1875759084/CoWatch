import { useRef, useCallback, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useUser } from '@/context/UserContext';
import { getAccessToken } from '@/utils/token';
import { useRoom } from '@/context/RoomContext';
import { useRoomWs } from '@/hooks/useRoomWs';
import { getRoomInfoApi } from '@/api/room';
import LoadingSpinner from '@/components/LoadingSpinner';
import VideoPlayer, { type VideoPlayerHandle } from './VideoPlayer';
import ControlPanel from './ControlPanel';
import StatusBar from './StatusBar';
import styles from './index.module.scss';

export default function WatchRoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { userInfo } = useUser();
  const { roomState, initRoom } = useRoom();
  const videoRef = useRef<VideoPlayerHandle>(null);

  // 防回环标记：收到远端 SYNC 时置 true，同步完成后重置
  // 避免 video timeupdate 再次触发广播
  const isSyncingRef = useRef(false);

  // 初始化房间状态
  useEffect(() => {
    if (!roomId) return;
    getRoomInfoApi(roomId).then((info) => {
      initRoom({
        roomId: info.roomId,
        activeVideoUrl: info.videoUrl,
        videos: [],
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
    // 下一帧重置，确保 timeupdate 不触发广播
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

  const { sendMessage } = useRoomWs({
    roomId: roomId!,
    token: getAccessToken() ?? '',
    onSyncProgress: handleSyncProgress,
    onSyncState: handleSyncState,
  });

  if (!roomState) {
    return <LoadingSpinner fullPage text="加载复盘房间..." />;
  }

  const isController =
    roomState.controlMode === 'free' ||
    roomState.controllerId === userInfo?.userId;

  return (
    <div className={styles.page}>
      <StatusBar
        roomId={roomId!}
        onlineCount={roomState.members.filter((m) => m.isOnline).length}
        controlMode={roomState.controlMode}
      />

      <div className={styles.content}>
        {/* 视频播放器区域 */}
        <div className={styles.playerArea}>
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
              <p>等待视频加载...</p>
            </div>
          )}
        </div>

        {/* 右侧控制面板 */}
        <aside className={styles.panel}>
          <ControlPanel
            members={roomState.members}
            controllerId={roomState.controllerId}
            controlMode={roomState.controlMode}
            isAdmin={
              roomState?.members.find((m) => m.userId === userInfo?.userId)?.isAdmin ?? false
            }
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
