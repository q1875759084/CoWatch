import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUser } from '@/context/UserContext';
import { getAccessToken } from '@/utils/token';
import { useRoom } from '@/context/RoomContext';
import { useRoomWs } from '@/hooks/useRoomWs';
import { getRoomInfoApi } from '@/api/room';
import MemberList from '@/components/MemberList';
import LoadingSpinner from '@/components/LoadingSpinner';
import VideoUploader from './VideoUploader';
import StartButton from './StartButton';
import styles from './index.module.scss';

export default function LobbyPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { userInfo } = useUser();
  const { roomState, initRoom } = useRoom();
  const navigate = useNavigate();

  // 初始化房间状态
  useEffect(() => {
    if (!roomId) return;
    getRoomInfoApi(roomId).then((info) => {
      initRoom({
        roomId: info.roomId,
        videoUrl: info.videoUrl,
        members: info.members,
        controlMode: info.controlMode,
        controllerId: info.controllerId,
        playbackState: { currentTime: 0, isPlaying: false },
      });
    });
  }, [roomId]);

  // 从当前房间成员列表找到自己，判断是否管理员
  const isAdmin = roomState?.members.find((m) => m.userId === userInfo?.userId)?.isAdmin ?? false;

  const { sendMessage } = useRoomWs({
    roomId: roomId!,
    token: getAccessToken() ?? '',
    onRoomStarted: (_videoUrl) => {
      navigate(`/room/${roomId}/watch`);
    },
  });

  if (!roomState) {
    return <LoadingSpinner fullPage text="加载房间信息..." />;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.roomCode}>
          房间码：<span className={styles.code}>{roomId}</span>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.onlineCount}>
            {roomState.members.filter((m) => m.isOnline).length} 人在线
          </span>
        </div>
      </header>

      <div className={styles.content}>
        {/* 左侧：成员列表 */}
        <aside className={styles.sidebar}>
          <h3 className={styles.sectionTitle}>成员列表</h3>
          <MemberList
            members={roomState.members}
            controllerId={roomState.controllerId}
          />
        </aside>

        {/* 右侧：管理员操作区 / 等待提示 */}
        <main className={styles.main}>
          {isAdmin ? (
            <>
              <h2 className={styles.mainTitle}>准备复盘</h2>
              <p className={styles.mainDesc}>
                上传游戏录屏后，点击「开始复盘」通知所有成员
              </p>
              <VideoUploader
                roomId={roomId!}
              />
              <StartButton
                disabled={!roomState.videoUrl}
                onStart={() => sendMessage('START_WATCH')}
              />
            </>
          ) : (
            <div className={styles.waitingBox}>
              <div className={styles.waitingIcon}>⏳</div>
              <p className={styles.waitingText}>等待管理员上传录屏并开始复盘...</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
