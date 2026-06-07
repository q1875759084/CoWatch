import { useNavigate } from 'react-router-dom';
import { useUser } from '@/context/UserContext';
import styles from './TopBar.module.scss';

/**
 * 顶栏
 * - 左：品牌名
 * - 右：当前登录用户昵称 + 退出登录按钮
 */
export function TopBar() {
  const navigate = useNavigate();
  const { userInfo, logout } = useUser();

  const handleLogout = () => {
    void logout().then(() => navigate('/auth', { replace: true }));
  };

  return (
    <header className={styles.topbar}>
      <span className={styles.brand}>CoWatch</span>
      {userInfo && (
        <div className={styles.user}>
          <span className={styles.nickname}>{userInfo.nickname}</span>
          <button type="button" className={styles.logoutBtn} onClick={handleLogout}>
            退出
          </button>
        </div>
      )}
    </header>
  );
}
