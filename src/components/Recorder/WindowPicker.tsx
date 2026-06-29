import { useState } from "react";

import { Checkbox, Modal, Tooltip } from "antd";

import type { AudioOptions, RecorderSource } from "@/types/recorder";

import styles from "./index.module.scss";

interface WindowPickerProps {
  sources: RecorderSource[];
  /** isAudioAvailable = Windows WASAPI 探测结果；false = 音频选项疗化 */
  isAudioAvailable: boolean;
  onConfirm: (source: RecorderSource, sourceType: "screen" | "window", audioOptions: AudioOptions) => void;
  onCancel: () => void;
  onRefresh?: () => void | Promise<void>;
}

/**
 * 录制窗口/整屏选择弹窗
 *
 * - screen 类型：标注"整屏"，缩略图全黑时显示文字提示（独占全屏游戏下的预期行为）
 * - window 类型：展示窗口名称和缩略图
 */
export function WindowPicker({
  sources,
  isAudioAvailable,
  onConfirm,
  onCancel,
  onRefresh,
}: WindowPickerProps) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [withSystemAudio, setWithSystemAudio] = useState(true);
  const [withMic, setWithMic] = useState(false);

  const selectedSource = sources.find((s) => s.id === selectedId) ?? null;

  const handleConfirm = () => {
    if (!selectedSource) return;
    onConfirm(selectedSource, selectedSource.sourceType, {
      withSystemAudio: isAudioAvailable && withSystemAudio,
      withMic: isAudioAvailable && withSystemAudio && withMic,
    });
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
      onOk={handleConfirm}
      onCancel={onCancel}
      okText="开始录制"
      cancelText="取消"
      okButtonProps={{ disabled: !selectedId }}
      width={680}
      centered
      className={styles.pickerModal}
    >
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
              <h4 className={styles.groupTitle}>应用窗口</h4>
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

          {/* 音频选项：仅 Windows WASAPI 可用时展示 */}
          <div className={styles.audioOptions}>
            <Tooltip
              title={!isAudioAvailable ? 'Windows 10+ 上可用，当前平台或设备不支持音频录制' : ''}
            >
              <Checkbox
                checked={isAudioAvailable && withSystemAudio}
                disabled={!isAudioAvailable}
                onChange={(e) => {
                  setWithSystemAudio(e.target.checked);
                  if (!e.target.checked) setWithMic(false);
                }}
              >
                录制系统声音
                <span className={styles.audioHint}>（游戏音效、语音等用户听到的全部声音）</span>
              </Checkbox>
            </Tooltip>

            <Checkbox
              checked={isAudioAvailable && withSystemAudio && withMic}
              disabled={!isAudioAvailable || !withSystemAudio}
              onChange={(e) => setWithMic(e.target.checked)}
              className={styles.audioMicCheck}
            >
              同时录制麦克风输入
            </Checkbox>
          </div>
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
