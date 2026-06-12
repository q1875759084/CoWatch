import arrowRedUrl      from './cursors/arrow-red.svg';
import arrowOrangeUrl   from './cursors/arrow-orange.svg';
import arrowYellowUrl   from './cursors/arrow-yellow.svg';
import arrowGreenUrl    from './cursors/arrow-green.svg';
import arrowBlueUrl     from './cursors/arrow-blue.svg';
import arrowPurpleUrl   from './cursors/arrow-purple.svg';
import blackmagicUrl    from './cursors/blackmagic.webp';

export interface CursorStyle {
  id: string;
  label: string;
  /** webpack asset/resource 处理后的图片文件 URL */
  url: string;
  /** 用于 label badge 的颜色，与光标主色对应 */
  color: string;
}

export const CURSOR_STYLES: CursorStyle[] = [
  { id: 'arrow-red',    label: '红',  url: arrowRedUrl,    color: '#ef4444' },
  { id: 'arrow-orange', label: '橙',  url: arrowOrangeUrl, color: '#f97316' },
  { id: 'arrow-yellow', label: '黄',  url: arrowYellowUrl, color: '#eab308' },
  { id: 'arrow-green',  label: '绿',  url: arrowGreenUrl,  color: '#22c55e' },
  { id: 'arrow-blue',   label: '蓝',  url: arrowBlueUrl,   color: '#3b82f6' },
  { id: 'arrow-purple', label: '紫',  url: arrowPurpleUrl, color: '#a855f7' },
  { id: 'blackmagic',   label: '🎬',  url: blackmagicUrl,  color: '#e2e8f0' },
];

export const DEFAULT_STYLE_ID = 'arrow-blue';

/** 根据 styleId 查找样式，找不到时返回默认蓝色 */
export function getCursorStyle(styleId: string): CursorStyle {
  return CURSOR_STYLES.find((s) => s.id === styleId) ?? CURSOR_STYLES.find((s) => s.id === DEFAULT_STYLE_ID)!;
}
