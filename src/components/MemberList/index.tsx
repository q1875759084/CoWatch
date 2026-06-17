import { useMemo } from 'react';
import type { Member } from '@/types/room';
import styles from './index.module.scss';

interface MemberListProps {
  members: Member[];
  controllerId?: string | null;
  /** 当前登录用户 ID，用于将自己置顶 */
  currentUserId?: string;
  /** 管理员可点击指定控制者 */
  onSelectController?: (userId: string) => void;
  isAdmin?: boolean;
}

export default function MemberList({
  members,
  controllerId,
  currentUserId,
  onSelectController,
  isAdmin,
}: MemberListProps) {
  // 自己排第一，在线其他人次之，离线排最后；同层内保持原有顺序（稳定排序）
  const sortedMembers = useMemo(
    () =>
      [...members].sort((a, b) => {
        const aIsSelf = a.userId === currentUserId ? 1 : 0;
        const bIsSelf = b.userId === currentUserId ? 1 : 0;
        if (aIsSelf !== bIsSelf) return bIsSelf - aIsSelf;
        return Number(b.isOnline) - Number(a.isOnline);
      }),
    [members, currentUserId],
  );

  return (
    <ul className={styles.list}>
      {sortedMembers.map((member) => {
        const isController = member.userId === controllerId;
        // 管理员 或 主控 均可点击其他成员进行控制权转让
        const canClick =
          (isAdmin || isController) &&
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
              {member.avatarUrl ? (
                <img src={member.avatarUrl} alt={member.nickname} className={styles.avatarImg} />
              ) : (
                member.nickname.charAt(0).toUpperCase()
              )}
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
