import type { Member } from '@/types/room';
import styles from './index.module.scss';

interface MemberListProps {
  members: Member[];
  controllerId?: string | null;
  /** 管理员可点击指定控制者 */
  onSelectController?: (userId: string) => void;
  isAdmin?: boolean;
}

export default function MemberList({
  members,
  controllerId,
  onSelectController,
  isAdmin,
}: MemberListProps) {
  return (
    <ul className={styles.list}>
      {members.map((member) => {
        const isController = member.userId === controllerId;
        const canClick =
          isAdmin &&
          onSelectController &&
          !isController;

        return (
          <li
            key={member.userId}
            className={`${styles.item} ${isController ? styles.controller : ''}`}
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
            </span>
          </li>
        );
      })}
    </ul>
  );
}
