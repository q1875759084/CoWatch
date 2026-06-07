import { Outlet, useParams } from 'react-router-dom';
import { TopBar } from './TopBar';
import { RoomList } from './RoomList';
import styles from './index.module.scss';

/**
 * Dashboard 三栏布局
 *
 * ┌──────────────── TopBar ────────────────────────────┐
 * │ CoWatch                         用户昵称  [退出]   │
 * ├────────────┬───────────────────────────────────────┤
 * │  RoomList  │               <Outlet>                │
 * │  (左侧栏)  │   Lobby / WatchRoom 内容渲染于此      │
 * └────────────┴───────────────────────────────────────┘
 *
 * 路由结构：
 *   /                        → Dashboard（content 区展示占位）
 *   /room/:roomId/lobby      → Dashboard + Lobby
 *   /room/:roomId/watch      → Dashboard + WatchRoom
 */
export default function Dashboard() {
  const { roomId } = useParams<{ roomId?: string }>();

  return (
    <div className={styles.layout}>
      <TopBar />
      <div className={styles.body}>
        <RoomList />
        <main className={styles.content}>
          {roomId ? (
            <Outlet />
          ) : (
            <div className={styles.placeholder}>
              <p>👈 选择一个房间，或点击 + 创建/加入</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
