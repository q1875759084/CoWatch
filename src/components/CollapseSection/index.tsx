import { useState, type ReactNode } from 'react';
import styles from './index.module.scss';

interface CollapseSectionProps {
  /** 标题文字 */
  title: ReactNode;
  /** 标题右侧额外内容（如数量徽标） */
  badge?: ReactNode;
  /** 默认是否展开，默认 true */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * 通用可折叠区块
 * 样式与 ControlPanel 编码设置折叠风格一致：
 *   - 标题行可点击，右侧 ▼ 箭头旋转指示状态
 *   - 展开内容区无动画（与 ControlPanel 一致）
 */
export default function CollapseSection({
  title,
  badge,
  defaultOpen = true,
  children,
}: CollapseSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.titleRow}>
          <span className={styles.title}>{title}</span>
          {badge != null && <span className={styles.badge}>{badge}</span>}
        </span>
        <span className={`${styles.arrow} ${open ? styles.arrowOpen : ''}`}>▼</span>
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  );
}
