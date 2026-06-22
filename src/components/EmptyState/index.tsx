import type { ReactNode } from 'react';
import styles from './index.module.scss';

interface EmptyStateProps {
  /** 提示文本，默认"暂无数据" */
  description?: string;
  /** 自定义图标（emoji 或 ReactNode），不传则不显示图标区域 */
  icon?: ReactNode;
  className?: string;
}

/**
 * 暗色主题下的空态占位组件
 *
 * - icon 传 emoji/ReactNode 时渲染图标
 * - icon 不传则只显示文字，无任何图片
 */
export function EmptyState({ description = '暂无数据', icon, className }: EmptyStateProps) {
  return (
    <div className={`${styles.root}${className ? ` ${className}` : ''}`}>
      {icon && <span className={styles.icon}>{icon}</span>}
      <span className={styles.desc}>{description}</span>
    </div>
  );
}
