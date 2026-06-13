export interface CursorStyle {
  id: string;
  label: string;
  /** webpack asset/resource 处理后的图片文件 URL */
  url: string;
}

import defaultCursorUrl from '@/assets/default-cursor.svg';

// require.context 在编译时扫描 cursors/ 目录，自动打包所有图片并返回 URL。
// 增删图片文件无需修改此文件；迁移 CDN 后只需改此处为远程 URL 即可。
const ctx = require.context('@/assets/cursors', false, /\.(svg|webp|png)$/);

/** 代表「恢复系统默认光标」的虚拟项，始终排在第一位 */
export const DEFAULT_CURSOR: CursorStyle = {
  id: 'default',
  label: '默认',
  url: defaultCursorUrl,
};

export const CURSOR_STYLES: CursorStyle[] = [
  DEFAULT_CURSOR,
  ...ctx.keys().sort().map((key) => {
    const id = key.replace(/^\.\//,  '').replace(/\.[^.]+$/, '');
    return { id, label: id, url: ctx(key) as string };
  }),
];

/** 默认选中项：始终为 'default'（系统光标） */
export const DEFAULT_STYLE_ID = 'default';

/** 根据 styleId 查找样式，找不到时返回第一个 */
export function getCursorStyle(styleId: string): CursorStyle {
  return CURSOR_STYLES.find((s) => s.id === styleId) ?? CURSOR_STYLES[0];
}
