import type { Member, ControlMode } from '@/types/room';
import MemberList from '@/components/MemberList';
import styles from './ControlPanel.module.scss';

interface ControlPanelProps {
  members: Member[];
  controllerId: string | null;
  controlMode: ControlMode;
  isAdmin: boolean;
  currentUserId: string;
  onTransferControl: (targetUserId: string) => void;
  onModeChange: (mode: ControlMode) => void;
}

export default function ControlPanel({
  members,
  controllerId,
  controlMode,
  isAdmin,
  currentUserId,
  onTransferControl,
  onModeChange,
}: ControlPanelProps) {
  const controller = members.find((m) => m.userId === controllerId);
  const isController =
    controlMode === 'free' || controllerId === currentUserId;

  return (
    <div className={styles.panel}>
      {/* 当前控制状态 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>控制权</h3>
        <div className={styles.controllerInfo}>
          {controlMode === 'free' ? (
            <span className={styles.freeMode}>🔓 自由模式 · 任意成员可控制</span>
          ) : (
            <span className={styles.designatedMode}>
              🎮 {controller ? controller.nickname : '无'} 正在控制
              {isController && <span className={styles.youBadge}> (你)</span>}
            </span>
          )}
        </div>
      </section>

      {/* 管理员：模式切换 */}
      {isAdmin && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>控制模式</h3>
          <div className={styles.modeToggle}>
            <button
              className={`${styles.modeBtn} ${controlMode === 'designated' ? styles.active : ''}`}
              onClick={() => onModeChange('designated')}
            >
              指定控制
            </button>
            <button
              className={`${styles.modeBtn} ${controlMode === 'free' ? styles.active : ''}`}
              onClick={() => onModeChange('free')}
            >
              自由抢控
            </button>
          </div>
          {controlMode === 'designated' && (
            <p className={styles.modeHint}>点击成员名称可指定其为控制者</p>
          )}
        </section>
      )}

      {/* 成员列表 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          成员 ({members.filter((m) => m.isOnline).length}/{members.length})
        </h3>
        <MemberList
          members={members}
          controllerId={controllerId}
          isAdmin={isAdmin}
          controlMode={controlMode}
          onSelectController={onTransferControl}
        />
      </section>
    </div>
  );
}
