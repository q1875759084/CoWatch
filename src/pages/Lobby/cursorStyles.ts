export interface CursorStyle {
  id: string;
  label: string;
  /** webpack asset/resource 处理后的图片文件 URL */
  url: string;
}

// require.context 在编译时扫描 cursors/ 目录，自动打包所有图片并返回 URL。
// 增删图片文件无需修改此文件；迁移 CDN 后只需改此处为远程 URL 即可。
const ctx = require.context('./cursors', false, /\.(svg|webp|png)$/);

// 从文件名（不含扩展名）派生 id，按文件名字母序排列
export const CURSOR_STYLES: CursorStyle[] = ctx.keys()
  .sort()
  .map((key) => {
    const id = key.replace(/^\.\//, '').replace(/\.[^.]+$/, '');
    return {
      id,
      label: id,
      url: ctx(key) as string,
    };
  });

export const DEFAULT_STYLE_ID = CURSOR_STYLES[0]?.id ?? '';

/** 根据 styleId 查找样式，找不到时返回第一个 */
export function getCursorStyle(styleId: string): CursorStyle {
  return CURSOR_STYLES.find((s) => s.id === styleId) ?? CURSOR_STYLES[0];
}
