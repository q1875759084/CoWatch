import { useMemo } from 'react';
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
  // 在线成员排前，离线排后；同状态内保持原有顺序（稳定排序）
  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => Number(b.isOnline) - Number(a.isOnline)),
    [members],
  );

  return (
    <ul className={styles.list}>
      {sortedMembers.map((member) => {
        const isController = member.userId === controllerId;
        const canClick =
          isAdmin &&
          onSelectController &&
          !isController;

        const itemClass = [
          styles.item,
          isController ? styles.controller : '',
          !member.isOnline ? styles.offline : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <li
            key={member.userId}
            className={itemClass}
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
