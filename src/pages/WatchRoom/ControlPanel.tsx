import { useState, useCallback } from 'react';
import type { Member } from '@/types/room';
import MemberList from '@/components/MemberList';
import styles from './ControlPanel.module.scss';

interface ControlPanelProps {
  roomId: string;
  roomName: string;
  members: Member[];
  controllerId: string | null;
  isAdmin: boolean;
  currentUserId: string;
  onTransferControl: (targetUserId: string) => void;
}

export default function ControlPanel({
  roomId,
  roomName,
  members,
  controllerId,
  isAdmin,
  currentUserId,
  onTransferControl,
}: ControlPanelProps) {
  const controller = members.find((m) => m.userId === controllerId);
  const isController = controllerId === currentUserId;

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [roomId]);

  return (
    <div className={styles.panel}>
      {/* Room ID */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Room ID</h3>
        <div className={styles.roomIdRow}>
          <span className={styles.roomIdText}>{roomId}</span>
          <button
            type="button"
            className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ''}`}
            onClick={handleCopy}
            title="复制房间码"
          >
            {copied ? '✓' : '复制'}
          </button>
        </div>
        {roomName && <div className={styles.roomNameHint}>{roomName}</div>}
      </section>

      {/* 当前控制状态 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>控制权</h3>
        <div className={styles.controllerInfo}>
          <span className={styles.designatedMode}>
            🎮 {controller ? controller.nickname : '无'} 正在控制
            {isController && <span className={styles.youBadge}> (你)</span>}
          </span>
        </div>
      </section>

      {/* 管理员：指定控制者提示 */}
      {isAdmin && (
        <section className={styles.section}>
          <p className={styles.modeHint}>点击成员名称可指定其为控制者</p>
        </section>
      )}

      {/* 成员列表 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          成员 ({members.filter((m) => m.isOnline).length} 人在线)
        </h3>
        <MemberList
          members={members}
          controllerId={controllerId}
          isAdmin={isAdmin}
          onSelectController={onTransferControl}
        />
      </section>
    </div>
  );
}
