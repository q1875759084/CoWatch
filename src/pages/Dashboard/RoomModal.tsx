import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoomApi, joinRoomApi } from '@/api/room';
import styles from './RoomModal.module.scss';

type ModalTab = 'create' | 'join';

interface RoomModalProps {
  onClose: () => void;
  /** 加入/创建成功后刷新房间列表 */
  onSuccess: () => void;
}

/**
 * 创建 / 加入房间弹窗
 */
export function RoomModal({ onClose, onSuccess }: RoomModalProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ModalTab>('create');
  const [roomName, setRoomName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');

  const switchTab = (next: ModalTab) => {
    setTab(next);
    setError('');
    setNameError('');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNameError('');

    // 创建时前置校验房间名
    if (tab === 'create') {
      if (!roomName.trim()) {
        setNameError('请输入房间名');
        return;
      }
      if (roomName.trim().length > 10) {
        setNameError('房间名最多 10 个字符');
        return;
      }
    }

    if (tab === 'join' && !roomId.trim()) {
      setError('请输入房间码');
      return;
    }

    setLoading(true);
    try {
      if (tab === 'create') {
        const result = await createRoomApi(roomName.trim());
        onSuccess();
        navigate(`/room/${result.roomId}/lobby`);
      } else {
        await joinRoomApi(roomId.trim());
        onSuccess();
        navigate(`/room/${roomId.trim()}/lobby`);
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>{tab === 'create' ? '创建新房间' : '加入房间'}</h3>
          <button type="button" onClick={onClose}>×</button>
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'create' ? styles.active : ''}`}
            onClick={() => switchTab('create')}
          >
            创建房间
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'join' ? styles.active : ''}`}
            onClick={() => switchTab('join')}
          >
            加入房间
          </button>
        </div>

        <form onSubmit={(e) => { void handleSubmit(e); }}>
          {tab === 'create' && (
            <div className={styles.fieldGroup}>
              <input
                className={`${styles.input} ${nameError ? styles.inputError : ''}`}
                type="text"
                placeholder="输入房间名，最多 10 个字符"
                value={roomName}
                maxLength={10}
                autoFocus
                onChange={(e) => {
                  setRoomName(e.target.value);
                  if (nameError) setNameError('');
                }}
              />
              {nameError && <p className={styles.fieldError}>{nameError}</p>}
            </div>
          )}

          {tab === 'join' && (
            <input
              className={styles.input}
              type="text"
              placeholder="输入房间码（6位字母/数字）"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              autoFocus
            />
          )}

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.actions}>
            <button type="submit" className={styles.confirm} disabled={loading}>
              {loading ? '处理中…' : tab === 'create' ? '立即创建' : '加入房间'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
