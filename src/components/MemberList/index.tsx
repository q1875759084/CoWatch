import type { Member } from '@/types/room';
import styles from './index.module.scss';

interface MemberListProps {
  members: Member[];
  controllerId?: string | null;
  /** designated 模式下管理员可点击指定控制者 */
  onSelectController?: (userId: string) => void;
  isAdmin?: boolean;
  controlMode?: 'designated' | 'free';
}

export default function MemberList({
  members,
  controllerId,
  onSelectController,
  isAdmin,
  controlMode,
}: MemberListProps) {
  return (
    <ul className={styles.list}>
      {members.map((member) => {
        const isController = member.userId === controllerId;
        const canClick =
          isAdmin &&
          controlMode === 'designated' &&
          onSelectController &&
          !isController;

        return (
          <li
            key={member.userId}
            className={`${styles.item} ${!member.isOnline ? styles.offline : ''} ${isController ? styles.controller : ''}`}
            onClick={canClick ? () => onSelectController!(member.userId) : undefined}
            style={{ cursor: canClick ? 'pointer' : 'default' }}
            title={canClick ? '点击指定为控制者' : undefined}
          >
            <span className={styles.avatar}>
              {member.nickname.charAt(0).toUpperCase()}
            </span>
            <span className={styles.nickname}>{member.nickname}</span>
            <span className={styles.badges}>
              {member.isAdmin && <span className={styles.adminBadge}>管理员</span>}
              {isController && <span className={styles.controllerBadge}>控制中</span>}
              {!member.isOnline && <span className={styles.offlineBadge}>离线</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
