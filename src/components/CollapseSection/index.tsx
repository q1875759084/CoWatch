import { useState, type ReactNode } from 'react';
import styles from './index.module.scss';

interface CollapseSectionProps {
  /** 标题文字 */
  title: ReactNode;
  /**
   * 是否可折叠。
   * - true：标题行可点击展开/折叠，右侧显示 ▼ 箭头
   * - false（默认）：普通容器模式，内容始终展开，标题不可点击
   */
  collapsible?: boolean;
  /** 默认是否展开，仅在 collapsible=true 时有意义，默认 true */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * 通用面板区块。支持两种模式，标题样式完全一致：
 *
 * **普通容器（collapsible 缺省/false）**
 *   标题行不可点击，内容始终显示。
 *
 * **可折叠（collapsible=true）**
 *   标题行可点击展开/折叠，右侧 ▼ 箭头旋转指示状态。
 */
export default function CollapseSection({
  title,
  collapsible = false,
  defaultOpen = true,
  children,
}: CollapseSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  const titleContent = (
    <span className={styles.titleRow}>
      <span className={styles.title}>{title}</span>
    </span>
  );

  return (
    <div className={styles.section}>
      {collapsible ? (
        <button
          type="button"
          className={styles.header}
          onClick={() => setOpen((v) => !v)}
        >
          {titleContent}
          <span className={`${styles.arrow} ${open ? styles.arrowOpen : ''}`}>▼</span>
        </button>
      ) : (
        <div className={styles.header}>
          {titleContent}
        </div>
      )}
      {(!collapsible || open) && <div className={styles.body}>{children}</div>}
    </div>
  );
}
