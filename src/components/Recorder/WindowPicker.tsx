import { useState } from "react";

import { Modal, Button, Radio } from "antd";

import type { RecorderSource, RecordingRcMode } from "@/types/recorder";

import styles from "./index.module.scss";

interface WindowPickerProps {
  sources: RecorderSource[];
  onConfirm: (source: RecorderSource, sourceType: "screen" | "window", recordOnly: boolean, rcMode: RecordingRcMode) => void;
  onCancel: () => void;
  onRefresh?: () => void | Promise<void>;
  isPreview?: boolean;
}

/**
 * 录制窗口/整屏选择弹窗
 *
 * - screen 类型：标注"整屏"，缩略图全黑时显示文字提示（独占全屏游戏下的预期行为）
 * - window 类型：展示窗口名称和缩略图
 */
export function WindowPicker({
  sources,
  onConfirm,
  onCancel,
  onRefresh,
  isPreview = false,
}: WindowPickerProps) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [rcMode, setRcMode] = useState<RecordingRcMode>('cqp');

  const selectedSource = sources.find((s) => s.id === selectedId) ?? null;

  const handleConfirmWithRecord = (recordOnly: boolean) => {
    if (!selectedSource) return;
    onConfirm(selectedSource, selectedSource.sourceType, recordOnly, rcMode);
  };

  /** 判断缩略图是否为纯黑（整屏录制独占游戏时的预期情况） */
  const isBlackThumbnail = (dataUrl: string): boolean => {
    // dataUrl 为空或非常短时视为黑图
    if (!dataUrl || dataUrl.length < 200) return true;
    // canvas 1x1 黑图的 base64 约 22 字节；真实缩略图通常 >5000 字节
    return (
      dataUrl.includes("data:image/png;base64,iVBORw0KGgo") &&
      dataUrl.length < 300
    );
  };

  const screens = sources.filter((s) => s.sourceType === "screen");
  const windows = sources.filter((s) => s.sourceType === "window");

  return (
    <Modal
      open
      title="选择录制内容"
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button
          key="recordUpload"
          type="primary"
          onClick={() => handleConfirmWithRecord(false)}
          disabled={!selectedId}
        >
          录制上传
        </Button>,
        <Button
          key="recordOnly"
          onClick={() => handleConfirmWithRecord(true)}
          disabled={!selectedId}
        >
          仅录制
        </Button>,
      ]}
      width={680}
      centered
      className={styles.pickerModal}
    >
        <div className={styles.modeToggle}>
          <span className={styles.modeLabel}>录制模式</span>
          <Radio.Group
            value={rcMode}
            onChange={(e) => setRcMode(e.target.value as RecordingRcMode)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio value="cqp">CQP（质量优先）</Radio>
            <Radio value="cbr">CBR（恒定码率）</Radio>
            <Radio value="vbr_ceil">VBR（弹性码率）</Radio>
          </Radio.Group>
        </div>
      {sources.length === 0 ? (
        <div className={styles.emptyWrap}>
          <p className={styles.empty}>未检测到可录制的窗口</p>
          <p className={styles.emptyHint}>
            macOS 需授予屏幕录制权限（系统设置 → 隐私与安全性 →
            屏幕录制），授权后重启应用
          </p>
          <p className={styles.emptyHint}>
            Windows 下以管理员权限运行的窗口无法被捕获
          </p>
          <p className={styles.emptyHint}>
            windows权限问题不保真，因为我没遇见过。
          </p>
          {onRefresh ? (
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={() => void onRefresh()}
            >
              刷新
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {screens.length > 0 ? (
            <div className={styles.sourceGroup}>
              <h4 className={styles.groupTitle}>整屏</h4>
              <div className={styles.grid}>
                {screens.map((s) => (
                  <SourceItem
                    key={s.id}
                    source={s}
                    isSelected={selectedId === s.id}
                    isBlack={isBlackThumbnail(s.thumbnailDataUrl)}
                    onSelect={() => setSelectedId(s.id)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {windows.length > 0 ? (
            <div className={styles.sourceGroup}>
              <h4 className={styles.groupTitle}>应用窗口（高速画面可能卡顿，游戏建议选整屏）</h4>
              <div className={styles.grid}>
                {windows.map((s) => (
                  <SourceItem
                    key={s.id}
                    source={s}
                    isSelected={selectedId === s.id}
                    isBlack={false}
                    onSelect={() => setSelectedId(s.id)}
                  />
                ))}
              </div>
            </div>
          ) : null}

        </>
      )}
    </Modal>
  );
}

interface SourceItemProps {
  source: RecorderSource;
  isSelected: boolean;
  isBlack: boolean;
  onSelect: () => void;
}

function SourceItem({
  source,
  isSelected,
  isBlack,
  onSelect,
}: SourceItemProps) {
  const label = source.sourceType === "screen" ? "整屏" : source.name;

  return (
    <button
      type="button"
      className={`${styles.sourceItem} ${isSelected ? styles.sourceItemSelected : ""}`}
      onClick={onSelect}
    >
      <div className={styles.thumbnail}>
        {isBlack ? (
          <span className={styles.thumbnailPlaceholder}>
            {source.sourceType === "screen" ? "整屏（独占模式）" : "预览不可用"}
          </span>
        ) : (
          <img
            src={source.thumbnailDataUrl}
            alt={label}
            className={styles.thumbnailImg}
          />
        )}
      </div>
      <span className={styles.sourceName}>{label}</span>
    </button>
  );
}
