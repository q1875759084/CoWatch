import { useState } from 'react';
import { EditOutlined } from '@ant-design/icons';
import { Tag, Modal, Tooltip } from 'antd';
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
  /** label 更新回调：点确定时若 label 有变化则调用，后端广播 VIDEO_LABELS_UPDATED */
  onUpdateLabels: (videoId: string, labels: string[]) => void;
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
  onUpdateLabels,
}: VideoListProps) {
  /** 当前正在编辑的视频 id，同时只能编辑一个 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 标题草稿（文件名输入框 blur 时更新） */
  const [draftName, setDraftName] = useState('');
  /** label 草稿列表（增删 label 时实时更新） */
  const [draftLabels, setDraftLabels] = useState<string[]>([]);
  /** 是否正在显示新增 label 输入框 */
  const [addingLabel, setAddingLabel] = useState(false);
  /** 新增 label 的输入值 */
  const [labelInput, setLabelInput] = useState('');

  const startEdit = (v: VideoItem) => {
    setEditingId(v.id);
    setDraftName(v.displayName ?? v.fileName);
    setDraftLabels([...(v.labels ?? [])]);
    setAddingLabel(false);
    setLabelInput('');
  };

  /** 取消：退出编辑态，清空输入框控制状态（draft 值会在 startEdit 时重新初始化，无需回滚） */
  const cancelEdit = () => {
    setEditingId(null);
    setAddingLabel(false);
    setLabelInput('');
  };

  /** 确定：diff 后按需调用 API，退出编辑态 */
  const confirmEdit = (v: VideoItem) => {
    // 若新增输入框还开着且有内容，先追加到 draft
    let finalLabels = draftLabels;
    if (addingLabel && labelInput.trim()) {
      const t = labelInput.trim();
      if (t.length <= 8 && draftLabels.length < 3) {
        finalLabels = [...draftLabels, t];
      }
    }

    const trimmedName = draftName.trim();
    const origName = v.displayName ?? v.fileName;
    if (trimmedName && trimmedName !== origName) {
      onRename(v.id, trimmedName);
    }

    const origLabels = v.labels ?? [];
    const labelsChanged =
      finalLabels.length !== origLabels.length ||
      finalLabels.some((l, i) => l !== origLabels[i]);
    if (labelsChanged) {
      onUpdateLabels(v.id, finalLabels);
    }

    setEditingId(null);
    setAddingLabel(false);
    setLabelInput('');
  };

  /** 新增 label 输入框确认（Enter / 非空 blur） */
  const confirmAddLabel = () => {
    const t = labelInput.trim();
    if (t && t.length <= 8 && draftLabels.length < 3) {
      setDraftLabels((prev) => [...prev, t]);
    }
    setAddingLabel(false);
    setLabelInput('');
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
          const canEdit = v.uploaderId === currentUserId || isAdmin;
          const isEditing = editingId === v.id;
          const labels = v.labels ?? [];

          return (
            <li key={v.id} className={`${styles.item} ${isActive ? styles.active : ''} ${isEditing ? styles.editing : ''}`}>
              <div className={styles.itemLeft}>
                <div className={styles.itemInfo}>
                  {isEditing ? (
                    /* ── 编辑态 ─────────────────────────────────────── */
                    <div className={styles.editRow}>
                      <input
                        className={styles.nameInput}
                        value={draftName}
                        autoFocus
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') cancelEdit();
                          if (e.key === 'Enter') confirmEdit(v);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      {/* label chip 列表 */}
                      {draftLabels.map((label, i) => (
                        <Tag
                          key={i}
                          closable
                          className={styles.labelTagEdit}
                          onClose={(e) => {
                            e.preventDefault();
                            setDraftLabels((prev) => prev.filter((_, idx2) => idx2 !== i));
                          }}
                        >
                          {label}
                        </Tag>
                      ))}
                      {/* 新增 label 输入框 或 「新增标签」文字按钮 */}
                      {addingLabel ? (
                        <input
                          className={styles.labelInput}
                          value={labelInput}
                          autoFocus
                          maxLength={8}
                          placeholder="输入标签"
                          onChange={(e) => setLabelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); confirmAddLabel(); }
                            if (e.key === 'Escape') { setAddingLabel(false); setLabelInput(''); }
                          }}
                          onBlur={() => {
                            if (!labelInput.trim()) {
                              setAddingLabel(false);
                              setLabelInput('');
                            } else {
                              confirmAddLabel();
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        draftLabels.length < 3 && (
                          <button
                            className={styles.addLabelBtn}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setAddingLabel(true);
                            }}
                          >
                            新增标签
                          </button>
                        )
                      )}
                    </div>
                  ) : (
                    /* ── 普通态 ─────────────────────────────────────── */
                    <div className={styles.nameRow}>
                      <span className={styles.fileName}>{v.displayName ?? v.fileName}</span>
                      {labels.map((label, i) => (
                        <Tag key={i} className={styles.labelTag}>
                          {label}
                        </Tag>
                      ))}
                      {canEdit && (
                        <button
                          className={styles.editIcon}
                          title="编辑"
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
                {isEditing ? (
                  /* 编辑态：确定 / 取消 */
                  <>
                    <button
                      className={styles.confirmBtn}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => { e.stopPropagation(); confirmEdit(v); }}
                    >
                      确定
                    </button>
                    <button
                      className={styles.cancelBtn}
                      onMouseDown={(e) => e.preventDefault()}
                       onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  /* 普通态：删除 / 播放 */
                  <>
                    {canEdit && (
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
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
