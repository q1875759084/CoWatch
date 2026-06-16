import { useState } from 'react';
import { EditOutlined } from '@ant-design/icons';
import { Modal, Tooltip } from 'antd';
import type { VideoItem } from '@/types/room';
import styles from './VideoList.module.scss';

interface VideoListProps {
  videos: VideoItem[];
  /**
   * 当前激活视频的 objectKey（用于高亮当前播放项）
   * 不使用 videoUrl 对比，因为签名 URL 每次不同
   */
  activeObjectKey: string | null;
  /** 仅主控可点击播放按钮切换视频 */
  isController: boolean;
  onPlay: (objectKey: string, videoId: string) => void;
  /** 当前登录用户 id，用于判断是否为上传者（有改名权限） */
  currentUserId: string;
  /** 当前用户是否为房间管理员（有改名权限） */
  isAdmin: boolean;
  /** 改名回调：由 Lobby 负责调用接口，成功后后端广播 VIDEO_RENAMED 更新全员列表 */
  onRename: (videoId: string, displayName: string) => void;
  /** 删除回调：由 Lobby 负责调用接口，成功后后端广播 VIDEO_DELETED 更新全员列表 */
  onDelete: (videoId: string) => void;
}

export default function VideoList({
  videos,
  activeObjectKey,
  isController,
  onPlay,
  currentUserId,
  isAdmin,
  onRename,
  onDelete,
}: VideoListProps) {
  /** 当前正在编辑的视频 id，同时只能编辑一个 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 输入框草稿值 */
  const [inputValue, setInputValue] = useState('');

  const startEdit = (v: VideoItem) => {
    setEditingId(v.id);
    setInputValue(v.displayName ?? v.fileName);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setInputValue('');
  };

  const confirmEdit = (videoId: string) => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      onRename(videoId, trimmed);
    }
    cancelEdit();
  };

  if (videos.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon}>📂</span>
        <p>暂无视频，请上传录屏文件</p>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      <ul className={styles.items}>
        {videos.map((v, idx) => {
          const isActive = v.objectKey === activeObjectKey;
          const canRename = v.uploaderId === currentUserId || isAdmin;
          const isEditing = editingId === v.id;

          return (
            <li key={v.id} className={`${styles.item} ${isActive ? styles.active : ''}`}>
              <div className={styles.itemLeft}>
                <span className={styles.index}>{idx + 1}</span>
                <div className={styles.itemInfo}>
                  {isEditing ? (
                    <input
                      className={styles.nameInput}
                      value={inputValue}
                      autoFocus
                      onChange={(e) => setInputValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') confirmEdit(v.id);
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      onBlur={cancelEdit}
                      // 阻止失焦时冒泡触发父级的其他事件
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div className={styles.nameRow}>
                      <span className={styles.fileName}>{v.displayName ?? v.fileName}</span>
                      {canRename && (
                        <button
                          className={styles.editIcon}
                          title="重命名"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(v);
                          }}
                        >
                          <EditOutlined />
                        </button>
                      )}
                    </div>
                  )}
                  <span className={styles.uploadTime}>
                    {new Date(v.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
              <div className={styles.itemActions}>
                {canRename && (
                  <Tooltip title={isActive ? '视频正在播放中，无法删除' : ''}>
                    <button
                      className={styles.deleteBtn}
                      disabled={isActive}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        Modal.confirm({
                          title: '确认删除视频',
                          content: `确认删除《${v.displayName ?? v.fileName}》？此操作不可撤销，同时会删除该视频的所有标注。`,
                          okText: '删除',
                          okButtonProps: { danger: true },
                          cancelText: '取消',
                          onOk: () => onDelete(v.id),
                        });
                      }}
                    >
                      删除
                    </button>
                  </Tooltip>
                )}
                {isController && (
                  <button
                    className={`${styles.playBtn} ${isActive ? styles.playBtnActive : ''}`}
                    onClick={() => onPlay(v.objectKey, v.id)}
                  >
                    {isActive ? '播放中' : '播放'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
