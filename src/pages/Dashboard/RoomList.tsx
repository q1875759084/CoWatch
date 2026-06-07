import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMyRooms } from '@/hooks/useMyRooms';
import { RoomModal } from './RoomModal';
import styles from './RoomList.module.scss';

const STATUS_LABEL: Record<string, string> = {
  waiting: '等待中',
  watching: '复盘中',
  closed: '已关闭',
};

/**
 * 左侧房间列表 + "+" 按钮（创建/加入房间弹窗入口）
 */
export function RoomList() {
  const { rooms, loading, refresh } = useMyRooms();
  const { roomId: activeRoomId } = useParams<{ roomId?: string }>();
  const [showModal, setShowModal] = useState(false);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <span>我的房间</span>
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => setShowModal(true)}
          title="创建或加入房间"
        >
          +
        </button>
      </div>

      <div className={styles.list}>
        {loading ? null : rooms.length === 0 ? (
          <p className={styles.empty}>还没有房间<br />点击 + 创建或加入</p>
        ) : (
          rooms.map((room) => (
            <Link
              key={room.room_id}
              to={`/room/${room.room_id}/lobby`}
              className={`${styles.roomItem} ${activeRoomId === room.room_id ? styles.active : ''}`}
            >
              <div className={styles.roomIcon}>{room.room_id.slice(0, 1).toUpperCase()}</div>
              <div className={styles.roomInfo}>
                <div className={styles.roomId}>{room.room_id}</div>
                <div className={styles.roomStatus}>{STATUS_LABEL[room.status] ?? room.status}</div>
                {room.is_admin === 1 && (
                  <div className={styles.adminBadge}>管理员</div>
                )}
              </div>
            </Link>
          ))
        )}
      </div>

      {showModal && (
        <RoomModal
          onClose={() => setShowModal(false)}
          onSuccess={() => { refresh(); setShowModal(false); }}
        />
      )}
    </aside>
  );
}
