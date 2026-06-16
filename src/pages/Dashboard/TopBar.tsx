import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Popover, Divider, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useUser } from '@/context/UserContext';
import { uploadAvatarApi, updateNicknameApi } from '@/api/auth';
import { saveUserInfo } from '@/utils/storage';
import styles from './TopBar.module.scss';

/**
 * 顶栏
 * - 左：品牌名
 * - 右：用户头像（hover 弹出信息卡片：头像（可换图）+ 昵称（可改名）+ uid + 退出登录）
 */
export function TopBar() {
  const navigate = useNavigate();
  const { userInfo, login, logout } = useUser();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nicknameInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameValue, setNicknameValue] = useState('');

  // 进入编辑态时聚焦并全选
  useEffect(() => {
    if (editingNickname) {
      nicknameInputRef.current?.select();
    }
  }, [editingNickname]);

  const handleLogout = () => {
    void logout().then(() => navigate('/auth', { replace: true }));
  };

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !userInfo) return;
    e.target.value = '';

    setUploading(true);
    try {
      const rawUrl = await uploadAvatarApi(file);
      const avatarUrl = `${rawUrl}?t=${Date.now()}`;
      const updated = { ...userInfo, avatarUrl };
      saveUserInfo(updated);
      const { getAccessToken } = await import('@/utils/token');
      login(getAccessToken() ?? '', updated);
      void message.success('头像更新成功');
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setUploading(false);
    }
  };

  const startEditNickname = () => {
    if (!userInfo) return;
    setNicknameValue(userInfo.nickname);
    setEditingNickname(true);
  };

  const commitNickname = async () => {
    if (!userInfo || !editingNickname) return;
    setEditingNickname(false);

    const trimmed = nicknameValue.trim();
    if (!trimmed || trimmed === userInfo.nickname) return;

    try {
      const nickname = await updateNicknameApi(trimmed);
      const updated = { ...userInfo, nickname };
      saveUserInfo(updated);
      const { getAccessToken } = await import('@/utils/token');
      login(getAccessToken() ?? '', updated);
      void message.success('昵称修改成功');
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '昵称修改失败');
    }
  };

  const handleNicknameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void commitNickname();
    } else if (e.key === 'Escape') {
      setEditingNickname(false);
    }
  };

  if (!userInfo) return (
    <header className={styles.topbar}>
      <span className={styles.brand}>CoWatch</span>
    </header>
  );

  const popoverContent = (
    <div className={styles.popoverCard}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* 上区：头像 + 用户信息 */}
      <div className={styles.cardSection}>
        <div className={styles.cardHeader}>
          <div
            className={styles.avatarWrap}
            onClick={handleAvatarClick}
            title="点击更换头像"
          >
            <Avatar size={40} src={userInfo.avatarUrl} />
            <div className={`${styles.avatarOverlay} ${uploading ? styles.avatarUploading : ''}`}>
              {uploading ? '…' : <EditOutlined />}
            </div>
          </div>

          <div className={styles.cardInfo}>
            {/* 昵称行：显示态 / 编辑态 */}
            {editingNickname ? (
              <input
                ref={nicknameInputRef}
                className={styles.nicknameInput}
                value={nicknameValue}
                maxLength={20}
                onChange={(e) => setNicknameValue(e.target.value)}
                onBlur={() => void commitNickname()}
                onKeyDown={handleNicknameKeyDown}
              />
            ) : (
              <div className={styles.nicknameRow}>
                <span className={styles.cardNickname}>{userInfo.nickname}</span>
                <EditOutlined className={styles.editIcon} onClick={startEditNickname} />
              </div>
            )}
            <div className={styles.cardUid}>ID: {userInfo.userId.slice(0, 8)}</div>
          </div>
        </div>
      </div>

      <Divider style={{ margin: '0' }} />

      {/* 下区：退出登录 */}
      <div className={styles.cardSection}>
        <div className={styles.logoutText} onClick={handleLogout}>
          退出登录
        </div>
      </div>
    </div>
  );

  return (
    <header className={styles.topbar}>
      <span className={styles.brand}>CoWatch</span>

      <Popover
        content={popoverContent}
        trigger="hover"
        placement="bottomRight"
        overlayClassName={styles.darkPopover}
        arrow={false}
      >
        <button type="button" className={styles.avatarBtn}>
          <Avatar size={32} src={userInfo.avatarUrl} style={{ cursor: 'pointer' }} />
        </button>
      </Popover>
    </header>
  );
}
