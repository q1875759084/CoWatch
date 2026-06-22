import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './index.module.scss';

export type ButtonVariant =
  | 'default'   // 灰色：播放、取消
  | 'primary'   // 蓝色：确定、一键同步、播放中（active）
  | 'danger'    // 红色填充：删除（VideoList）、清空画布
  | 'ghost-danger'; // 灰→红 hover：删除（TagBar）、清除此色

export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** 激活态（primary 下变为实底蓝，其余 variant 忽略） */
  active?: boolean;
  /** 尺寸：sm = padding 2px 8px；md（默认）= padding 5px 14px */
  size?: ButtonSize;
  children: ReactNode;
}

/**
 * 暗色主题下的统一操作按钮
 *
 * variant:
 *   default      灰色边框 → hover 蓝色（播放、取消）
 *   primary      蓝色填充（确定、一键同步）；active=true 时加深背景（播放中）
 *   danger       红色填充（删除列表项、清空画布）
 *   ghost-danger 默认灰色 → hover 变红（TagBar 删除、清除此色）
 */
export function Button({
  variant = 'default',
  active = false,
  size = 'md',
  className,
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    styles.btn,
    styles[variant],
    styles[size],
    active ? styles.active : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}
