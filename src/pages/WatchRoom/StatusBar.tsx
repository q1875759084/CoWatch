import type { ControlMode } from '@/types/room';
import styles from './StatusBar.module.scss';

interface StatusBarProps {
  roomId: string;
  onlineCount: number;
  controlMode: ControlMode;
}

export default function StatusBar({ roomId, onlineCount, controlMode }: StatusBarProps) {
  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.label}>房间码</span>
        <span className={styles.roomCode}>{roomId}</span>
      </div>
      <div className={styles.right}>
        <span className={styles.badge}>
          🟢 {onlineCount} 人在线
        </span>
        <span className={`${styles.badge} ${controlMode === 'free' ? styles.free : styles.designated}`}>
          {controlMode === 'free' ? '🔓 自由模式' : '🎯 指定模式'}
        </span>
      </div>
    </div>
  );
}
