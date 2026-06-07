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
  const [roomId, setRoomId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (tab === 'create') {
        const result = await createRoomApi();
        onSuccess();
        navigate(`/room/${result.roomId}/lobby`);
      } else {
        if (!roomId.trim()) { setError('请输入房间码'); return; }
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
            onClick={() => { setTab('create'); setError(''); }}
          >
            创建房间
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'join' ? styles.active : ''}`}
            onClick={() => { setTab('join'); setError(''); }}
          >
            加入房间
          </button>
        </div>

        <form onSubmit={(e) => { void handleSubmit(e); }}>
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
            <button type="button" className={styles.cancel} onClick={onClose}>取消</button>
            <button type="submit" className={styles.confirm} disabled={loading}>
              {loading ? '处理中…' : tab === 'create' ? '立即创建' : '加入房间'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
