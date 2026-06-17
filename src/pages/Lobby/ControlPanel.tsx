import { useState } from 'react';
import { Modal, Switch, Tooltip } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
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
  { color: '#eab308', label: '橙色' },
  { color: '#22c55e', label: '绿色' },
  { color: '#2563eb', label: '蓝色' },
  { color: '#8b5cf6', label: '紫色' }
] as const;

// ─── CursorSettings ──────────────────────────────────────────────────────────

export interface CursorSettingsProps {
  /** 整个鼠标功能区是否禁用（自由模式下为 true） */
  disabled: boolean;
  /** 鼠标共享是否开启（控制是否发送自己的位置） */
  cursorEnabled: boolean;
  /** 当前选中的光标样式 ID */
  selectedStyleId: string;
  /** 虚拟光标样式是否已激活（本地渲染 canvas 光标，与共享/绘制无关） */
  cursorStyleActive: boolean;
  /** 是否处于绘制模式 */
  drawingMode: boolean;
  /** 当前画笔颜色 */
  drawColor: string;
  onCursorToggle: () => void;
  /** 点击样式图标时回调：点 default = 恢复系统光标；点其他项 = 激活虚拟光标 + 切换样式 */
  onCursorStyleSelect: (styleId: string) => void;
  onDrawingModeToggle: () => void;
  onDrawColorChange: (color: string) => void;
  /** 清空画布（广播给所有人） */
  onClearStrokes: () => void;
  /** 清除指定颜色的笔迹（广播给所有人） */
  onClearStrokesByColor: (color: string) => void;
}

export function CursorSettings({
  disabled,
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
  onClearStrokesByColor,
}: CursorSettingsProps) {
  return (
    <CollapseSection
      title="鼠标设置"
      subtitle={disabled ? '自由模式下不可用' : undefined}
      collapsible
    >
      {/* 样式选择器 — default 项选中 = 系统光标；其他项选中 = 激活虚拟光标 */}
      <div className={styles.cursorStylePicker}>
        {CURSOR_STYLES.map((cs) => {
          const isActive = cs.id === 'default'
            ? !cursorStyleActive
            : cursorStyleActive && selectedStyleId === cs.id;
          return (
            <button
              key={cs.id}
              type="button"
              title={cs.label}
              className={`${styles.cursorStyleBtn} ${isActive ? styles.cursorStyleBtnActive : ''}`}
              onClick={() => onCursorStyleSelect(cs.id)}
              disabled={disabled}
            >
              <img src={cs.url} alt={cs.label} className={styles.cursorStyleIcon} draggable={false} />
            </button>
          );
        })}
      </div>

      {/* 鼠标共享开关 */}
      <div className={styles.toggleRow}>
        <span className={styles.toggleLabel}>🖱️ 鼠标共享</span>
        <Switch
          size="small"
          checked={cursorEnabled}
          onChange={onCursorToggle}
          disabled={disabled}
          title={cursorEnabled ? '关闭鼠标共享' : '开启鼠标共享'}
        />
      </div>

      {/* 绘制模式开关 */}
      <div className={styles.toggleRow}>
        <span className={styles.toggleLabel}>✒️ 绘制模式</span>
        <Switch
          size="small"
          checked={drawingMode}
          onChange={onDrawingModeToggle}
          disabled={disabled}
          title={drawingMode ? '退出绘制模式' : '进入绘制模式'}
        />
      </div>

      {/* 颜色选择器 */}
      <div className={styles.drawColorPicker}>
        {DRAW_COLORS.map(({ color, label }) => (
          <button
            key={color}
            type="button"
            title={label}
            className={`${styles.drawColorBtn} ${drawColor === color ? styles.drawColorBtnActive : ''}`}
            style={{ background: color }}
            onClick={() => onDrawColorChange(color)}
            disabled={disabled}
          />
        ))}
      </div>

      {/* 清除此色 + 清空画布 */}
      <div className={styles.clearBtnRow}>
        <button
          type="button"
          className={styles.clearColorBtn}
          title={`清除所有${DRAW_COLORS.find(c => c.color === drawColor)?.label ?? ''}色笔迹`}
          onClick={() => onClearStrokesByColor(drawColor)}
          disabled={disabled}
        >
          清除此色
        </button>
        <button
          type="button"
          className={styles.clearStrokesBtn}
          onClick={onClearStrokes}
          title="清空所有人的画布笔迹"
          disabled={disabled}
        >
          清空画布
        </button>
      </div>
    </CollapseSection>
  );
}

// ─── ControlPanel ─────────────────────────────────────────────────────────────

interface ControlPanelProps {
  roomId: string;
  roomName: string;
  members: Member[];
  controllerId: string | null;
  isAdmin: boolean;
  onTransferControl: (targetUserId: string) => void;
  /** 是否为主控（区分显示一键拉回 or 跟随开关） */
  isController: boolean;
  /** 非主控：是否处于跟随复盘模式 */
  followMode: boolean;
  /** 非主控：切换跟随模式 */
  onFollowModeToggle: () => void;
  /** 主控：一键拉回 */
  onForceSync: () => void;
  /** 鼠标功能区 props（透传给 CursorSettings） */
  cursorSettings: CursorSettingsProps;
}

export default function ControlPanel({
  roomId,
  roomName,
  members,
  controllerId,
  isAdmin,
  onTransferControl,
  isController,
  followMode,
  onFollowModeToggle,
  onForceSync,
  cursorSettings,
}: ControlPanelProps) {
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

  const handleDownloadBatWithConfirm = useMemoizedFn(() => {
    Modal.confirm({
      title: '使用说明（我知道样式很丑，你先别急，内测阶段呢，搞不过来了！）',
      content: (
        <div style={{ lineHeight: 1.8 }}>
          <p style={{ margin: '0 0 8px' }}>
            1. 下载脚本后，将录屏文件<strong>直接拖拽到 .bat 文件上</strong>即可开始转码
            <br />
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>（请勿直接双击打开脚本）</span>
          </p>
          <p style={{ margin: 0 }}>
            2. 首次使用会自动下载转码工具（约 130 MB），耗时 10～20 秒
            <br />
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>下载完成后无需重复安装</span>
          </p>
        </div>
      ),
      okText: '下载脚本',
      cancelText: '取消',
      onOk: () => void handleDownloadBat(),
    });
  });

  return (
    <div className={styles.panel}>
      {/* 房间信息 */}
      <CollapseSection title={roomName || roomId}>
        <div className={styles.roomIdRow}>
          <span className={styles.roomIdText}>{roomId}</span>
          <Tooltip title={copied ? '已复制' : '复制房间码'} placement="top">
            <button
              type="button"
              className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ''}`}
              onClick={handleCopy}
            >
              {copied ? <CheckOutlined /> : <CopyOutlined />}
            </button>
          </Tooltip>
        </div>
      </CollapseSection>

      {/* 当前模式：主控显示「一键同步」按钮，非主控显示跟随/自由切换开关 */}
      <div className={styles.modeRow}>
        <span className={styles.modeRowLabel}>当前模式</span>
        {isController ? (
          <button
            type="button"
            className={styles.forceSyncBtn}
            onClick={onForceSync}
            title="将所有成员同步到当前播放进度和画布状态"
          >
            一键同步
          </button>
        ) : (
          <Switch
            size="small"
            checked={followMode}
            onChange={onFollowModeToggle}
            checkedChildren="跟随"
            unCheckedChildren="自由"
            title={followMode ? '关闭跟随，进入自由模式' : '开启跟随，同步主控操作'}
          />
        )}
      </div>

      {/* 鼠标设置 */}
      <CursorSettings {...cursorSettings} />

      {/* 成员列表 */}
      <CollapseSection
        title="成员"
        subtitle={isAdmin ? '点击成员可使其成为控制者' : undefined}
        collapsible
      >
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
            onClick={handleDownloadBatWithConfirm}
            disabled={downloading}
          >
            {downloading ? '下载中...' : '⬇ 下载转码脚本'}
          </button>
        </div>
      </CollapseSection>
    </div>
  );
}
