import { useState } from 'react';
import { useMemoizedFn, useRequest } from 'ahooks';
import type { Member } from '@/types/room';
import MemberList from '@/components/MemberList';
import { downloadBatApi } from '@/api/room';
import { CURSOR_STYLES } from './cursorStyles';
import styles from './ControlPanel.module.scss';

/** 固定使用 CRF 30 档位 */
const ENCODE_PRESET = '30' as const;

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
  /** 是否处于绘制模式（仅在 cursorEnabled=true 时可用） */
  drawingMode: boolean;
  onCursorToggle: () => void;
  onStyleChange: (styleId: string) => void;
  onDrawingModeToggle: () => void;
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
  drawingMode,
  onCursorToggle,
  onStyleChange,
  onDrawingModeToggle,
}: ControlPanelProps) {
  const controller = members.find((m) => m.userId === controllerId);

  const [copied, setCopied] = useState(false);
  const handleCopy = useMemoizedFn(() => {
    void navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  });

  // 编码设置折叠区状态
  const [encodeExpanded, setEncodeExpanded] = useState(false);
  const { loading: downloading, run: handleDownloadBat } = useRequest(
    () => downloadBatApi(ENCODE_PRESET),
    { manual: true },
  );

  return (
    <div className={styles.panel}>
      {/* Room ID */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Room ID</h3>
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
      </section>

      {/* 当前控制状态 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>控制权</h3>
        {isAdmin && (
          <p className={styles.modeHint}>点击成员名称可指定其为控制者</p>
        )}
        <div className={styles.controllerInfo}>
          <span className={styles.designatedMode}>
            {controller ? controller.nickname : '无'} 正在控制
          </span>
        </div>
      </section>

      {/* 鼠标共享 */}
      <section className={styles.section}>
        <div className={styles.cursorHeader}>
          <h3 className={styles.sectionTitle}>鼠标共享</h3>
          {/* Toggle 开关 */}
          <button
            type="button"
            className={`${styles.cursorToggle} ${cursorEnabled ? styles.cursorToggleOn : ''}`}
            onClick={onCursorToggle}
            title={cursorEnabled ? '关闭鼠标共享' : '开启鼠标共享'}
          >
            <span className={styles.cursorToggleThumb} />
          </button>
        </div>

        {/* 样式选择器 */}
        <div className={`${styles.cursorStylePicker} ${!cursorEnabled ? styles.cursorStylePickerDisabled : ''}`}>
          {CURSOR_STYLES.map((cs) => (
            <button
              key={cs.id}
              type="button"
              title={cs.label}
              disabled={!cursorEnabled}
              className={`${styles.cursorStyleBtn} ${selectedStyleId === cs.id ? styles.cursorStyleBtnActive : ''}`}
              style={selectedStyleId === cs.id ? { borderColor: cs.color, boxShadow: `0 0 0 2px ${cs.color}40` } : {}}
              onClick={() => onStyleChange(cs.id)}
            >
              <img src={cs.url} alt={cs.label} className={styles.cursorStyleIcon} draggable={false} />
            </button>
          ))}
        </div>

        {/* 绘制模式开关（仅在开启鼠标共享时可用） */}
        <div className={`${styles.drawingModeRow} ${!cursorEnabled ? styles.drawingModeRowDisabled : ''}`}>
          <span className={styles.drawingModeLabel}>✒️ 绘制模式</span>
          <button
            type="button"
            className={`${styles.cursorToggle} ${drawingMode && cursorEnabled ? styles.cursorToggleOn : ''}`}
            onClick={onDrawingModeToggle}
            disabled={!cursorEnabled}
            title={drawingMode ? '退出绘制模式' : '进入绘制模式'}
          >
            <span className={styles.cursorToggleThumb} />
          </button>
        </div>
      </section>

      {/* 成员列表 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>成员</h3>
        <MemberList
          members={members}
          controllerId={controllerId}
          isAdmin={isAdmin}
          onSelectController={onTransferControl}
        />
      </section>

      {/* 编码设置折叠区 */}
      <section className={`${styles.section} ${styles.encodeSection}`}>
        <button
          type="button"
          className={styles.encodeToggleBtn}
          onClick={() => setEncodeExpanded((v) => !v)}
        >
          <span>编码设置</span>
          <span className={`${styles.encodeArrow} ${encodeExpanded ? styles.encodeArrowOpen : ''}`}>▼</span>
        </button>

        {encodeExpanded && (
          <div className={styles.encodeContent}>
            {/* 画质档位（固定 CRF 30，不可更改） */}
            <div className={styles.encodeRow}>
              <label className={`${styles.encodeLabel} ${styles.encodeLabelDisabled}`}>
                画质档位
              </label>
              <span className={styles.encodeValueDisabled}>
                CRF 30
              </span>
            </div>

            {/* 分辨率（置灰，二期开放） */}
            <div className={styles.encodeRow}>
              <label className={`${styles.encodeLabel} ${styles.encodeLabelDisabled}`}>
                分辨率
              </label>
              <span className={styles.encodeValueDisabled} title="二期开放">
                1080p
              </span>
            </div>

            {/* 帧率（置灰，二期开放） */}
            <div className={styles.encodeRow}>
              <label className={`${styles.encodeLabel} ${styles.encodeLabelDisabled}`}>
                帧率
              </label>
              <span className={styles.encodeValueDisabled} title="二期开放">
                60fps
              </span>
            </div>

            {/* 下载按钮 */}
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
        )}
      </section>
    </div>
  );
}
