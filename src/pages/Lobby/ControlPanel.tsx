import { useState } from 'react';
import { useMemoizedFn, useRequest } from 'ahooks';
import type { Member } from '@/types/room';
import MemberList from '@/components/MemberList';
import CollapseSection from '@/components/CollapseSection';
import { downloadBatApi } from '@/api/room';
import { CURSOR_STYLES } from './cursorStyles';
import styles from './ControlPanel.module.scss';

/** 固定使用 CRF 30 档位 */
const ENCODE_PRESET = '30' as const;

/** 绘制模式可选颜色 */
const DRAW_COLORS = [
  { color: '#ffffff', label: '白色' },
  { color: '#000000', label: '黑色' },
  { color: '#ef4444', label: '红色' },
] as const;

interface ControlPanelProps {
  roomId: string;
  roomName: string;
  members: Member[];
  controllerId: string | null;
  isAdmin: boolean;
  onTransferControl: (targetUserId: string) => void;
  /** 鼠标共享是否开启（控制是否发送自己的位置） */
  cursorEnabled: boolean;
  /** 当前选中的光标样式 ID */
  selectedStyleId: string;
  /** 虚拟光标样式是否已激活（本地渲染 canvas 光标，与共享/绘制无关） */
  cursorStyleActive: boolean;
  /** 是否处于绘制模式 */
  drawingMode: boolean;
  /** 当前画笔颜色（仅在 drawingMode=true 时有意义） */
  drawColor: string;
  onCursorToggle: () => void;
  /** 点击样式图标时回调：已激活且点击同一项 = 反选关闭；其他 = 激活 + 切换样式 */
  onCursorStyleSelect: (styleId: string) => void;
  onDrawingModeToggle: () => void;
  onDrawColorChange: (color: string) => void;
  /** 清空画布（广播给所有人） */
  onClearStrokes: () => void;
}

export default function ControlPanel({
  roomId,
  roomName,
  members,
  controllerId,
  isAdmin,
  onTransferControl,
  cursorEnabled,
  selectedStyleId,
  cursorStyleActive,
  drawingMode,
  drawColor,
  onCursorToggle,
  onCursorStyleSelect,
  onDrawingModeToggle,
  onDrawColorChange,
  onClearStrokes,
}: ControlPanelProps) {
  const controller = members.find((m) => m.userId === controllerId);

  const [copied, setCopied] = useState(false);
  const handleCopy = useMemoizedFn(() => {
    void navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  });

  const { loading: downloading, run: handleDownloadBat } = useRequest(
    () => downloadBatApi(ENCODE_PRESET),
    { manual: true },
  );

  return (
    <div className={styles.panel}>
      {/* Room ID */}
      <CollapseSection title="Room ID">
        <div className={styles.roomIdRow}>
          <span className={styles.roomIdText}>{roomId}</span>
          <button
            type="button"
            className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ''}`}
            onClick={handleCopy}
            title="复制房间码"
          >
            {copied ? '✓' : '复制'}
          </button>
        </div>
        {roomName && <div className={styles.roomNameHint}>{roomName}</div>}
      </CollapseSection>

      {/* 控制权 */}
      <CollapseSection title="控制权">
        {isAdmin && (
          <p className={styles.modeHint}>点击成员名称可指定其为控制者</p>
        )}
        <div className={styles.controllerInfo}>
          <span className={styles.designatedMode}>
            {controller ? controller.nickname : '无'} 正在控制
          </span>
        </div>
      </CollapseSection>

      {/* 鼠标设置 */}
      <CollapseSection title="鼠标设置" collapsible>
        {/* 样式选择器 — 始终可点击，不依赖任何开关。
             选中项 = cursorStyleActive=true 且 id 匹配；再点同一项则反选关闭虚拟光标 */}
        <div className={styles.cursorStylePicker}>
          {CURSOR_STYLES.map((cs) => {
            const isActive = cursorStyleActive && selectedStyleId === cs.id;
            return (
              <button
                key={cs.id}
                type="button"
                title={isActive ? `${cs.label}（点击取消）` : cs.label}
                className={`${styles.cursorStyleBtn} ${isActive ? styles.cursorStyleBtnActive : ''}`}
                style={isActive ? { borderBottomColor: 'rgba(255,255,255,0.7)' } : {}}
                onClick={() => onCursorStyleSelect(cs.id)}
              >
                <img src={cs.url} alt={cs.label} className={styles.cursorStyleIcon} draggable={false} />
              </button>
            );
          })}
        </div>

        {/* 鼠标共享开关 */}
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>🖱️ 鼠标共享</span>
          <button
            type="button"
            className={`${styles.cursorToggle} ${cursorEnabled ? styles.cursorToggleOn : ''}`}
            onClick={onCursorToggle}
            title={cursorEnabled ? '关闭鼠标共享' : '开启鼠标共享'}
          >
            <span className={styles.cursorToggleThumb} />
          </button>
        </div>

        {/* 绘制模式开关 */}
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>✒️ 绘制模式</span>
          <button
            type="button"
            className={`${styles.cursorToggle} ${drawingMode ? styles.cursorToggleOn : ''}`}
            onClick={onDrawingModeToggle}
            title={drawingMode ? '退出绘制模式' : '进入绘制模式'}
          >
            <span className={styles.cursorToggleThumb} />
          </button>
        </div>

        {/* 颜色选择器 — 仅在绘制模式开启时显示 */}
        {drawingMode && (
          <div className={styles.drawColorPicker}>
            {DRAW_COLORS.map(({ color, label }) => (
              <button
                key={color}
                type="button"
                title={label}
                className={`${styles.drawColorBtn} ${drawColor === color ? styles.drawColorBtnActive : ''}`}
                style={{ background: color }}
                onClick={() => onDrawColorChange(color)}
              />
            ))}
          </div>
        )}

        {/* 清空画布 */}
        <button
          type="button"
          className={styles.clearStrokesBtn}
          onClick={onClearStrokes}
          title="清空所有人的画布笔迹"
        >
          清空画布
        </button>
      </CollapseSection>

      {/* 成员列表 */}
      <CollapseSection title="成员" collapsible>
        <MemberList
          members={members}
          controllerId={controllerId}
          isAdmin={isAdmin}
          onSelectController={onTransferControl}
        />
      </CollapseSection>

      {/* 编码设置 — 可折叠，默认收起 */}
      <CollapseSection title="编码设置" collapsible defaultOpen={false}>
        <div className={styles.encodeContent}>
          <div className={styles.encodeRow}>
            <label className={`${styles.encodeLabel} ${styles.encodeLabelDisabled}`}>画质档位</label>
            <span className={styles.encodeValueDisabled}>CRF 30</span>
          </div>
          <div className={styles.encodeRow}>
            <label className={`${styles.encodeLabel} ${styles.encodeLabelDisabled}`}>分辨率</label>
            <span className={styles.encodeValueDisabled} title="二期开放">1080p</span>
          </div>
          <div className={styles.encodeRow}>
            <label className={`${styles.encodeLabel} ${styles.encodeLabelDisabled}`}>帧率</label>
            <span className={styles.encodeValueDisabled} title="二期开放">60fps</span>
          </div>
          <button
            type="button"
            className={styles.downloadBatBtn}
            onClick={() => void handleDownloadBat()}
            disabled={downloading}
          >
            {downloading ? '下载中...' : '⬇ 下载转码脚本'}
          </button>
          <p className={styles.encodeHint}>
            将录屏拖拽到脚本上即可完成转码，需提前安装 ffmpeg
          </p>
        </div>
      </CollapseSection>
    </div>
  );
}
