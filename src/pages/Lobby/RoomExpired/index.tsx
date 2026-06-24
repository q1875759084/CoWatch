import styles from './index.module.scss';

/**
 * 房间已过期（plan_level = 'free'）时展示的占位页。
 * 由 Lobby 在 initRoom 之后根据 planLevel 条件渲染。
 */
export default function RoomExpired() {
  return (
    <div className={styles.wrap}>
      <div className={styles.icon}>🔒</div>
      <div className={styles.title}>房间已过期</div>
      <div className={styles.desc}>请购买会员或房间续费包以恢复访问</div>
    </div>
  );
}
