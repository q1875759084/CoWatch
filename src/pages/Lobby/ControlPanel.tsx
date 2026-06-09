import { useState } from 'react';
import { useMemoizedFn, useRequest } from 'ahooks';
import type { Member } from '@/types/room';
import MemberList from '@/components/MemberList';
import { downloadBatApi } from '@/api/room';
import styles from './ControlPanel.module.scss';

type EncodePreset = 'high' | 'balanced' | 'small';

const PRESET_OPTIONS: { value: EncodePreset; label: string; desc: string }[] = [
  { value: 'high',     label: '高画质', desc: 'CRF 23 · ~1.5 GB/30min' },
  { value: 'balanced', label: '均衡',   desc: 'CRF 26 · ~1 GB/30min' },
  { value: 'small',    label: '小体积', desc: 'CRF 28 · ~700 MB/30min' },
];

interface ControlPanelProps {
  roomId: string;
  roomName: string;
  members: Member[];
  controllerId: string | null;
  isAdmin: boolean;
  currentUserId: string;
  onTransferControl: (targetUserId: string) => void;
}

export default function ControlPanel({
  roomId,
  roomName,
  members,
  controllerId,
  isAdmin,
  currentUserId,
  onTransferControl,
}: ControlPanelProps) {
  const controller = members.find((m) => m.userId === controllerId);
  const isController = controllerId === currentUserId;

  const [copied, setCopied] = useState(false);
  const handleCopy = useMemoizedFn(() => {
    void navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  });

  // 编码设置折叠区状态
  const [encodeExpanded, setEncodeExpanded] = useState(false);
  const [encodePreset, setEncodePreset] = useState<EncodePreset>('balanced');
  const { loading: downloading, run: handleDownloadBat } = useRequest(
    () => downloadBatApi(encodePreset),
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
        <div className={styles.controllerInfo}>
          <span className={styles.designatedMode}>
            🎮 {controller ? controller.nickname : '无'} 正在控制
            {isController && <span className={styles.youBadge}> (你)</span>}
          </span>
        </div>
      </section>

      {/* 管理员：指定控制者提示 */}
      {isAdmin && (
        <section className={styles.section}>
          <p className={styles.modeHint}>点击成员名称可指定其为控制者</p>
        </section>
      )}

      {/* 成员列表 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          成员 ({members.filter((m) => m.isOnline).length} 人在线)
        </h3>
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
            {/* 画质档位 */}
            <div className={styles.encodeRow}>
              <label className={styles.encodeLabel}>画质档位</label>
              <select
                className={styles.encodeSelect}
                value={encodePreset}
                onChange={(e) => setEncodePreset(e.target.value as EncodePreset)}
              >
                {PRESET_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}（{opt.desc}）
                  </option>
                ))}
              </select>
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
