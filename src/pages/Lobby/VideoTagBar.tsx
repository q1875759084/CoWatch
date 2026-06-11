import { useState, useId } from 'react';
import { useMemoizedFn } from 'ahooks';
import type { Tag } from '@/types/room';
import styles from './VideoTagBar.module.scss';

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 秒 → "m:ss" 或 "mm:ss" */
function formatTime(sec: number): string {
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** "m:ss" / "mm:ss" → 秒（解析失败返回 null） */
function parseTime(str: string): number | null {
  const match = str.trim().match(/^(\d{1,3}):([0-5]\d)$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface VideoTagBarProps {
  /** 当前视频的 tag 列表 */
  tags: Tag[];
  /** 视频总时长（秒），用于时间轴定位；为 0 时时间轴不渲染标记 */
  duration: number;
  /** 当前用户是否为主控 */
  isController: boolean;
  /** 当前激活视频的 id（发送 TAG_ADD 时使用） */
  activeVideoId: string;
  /** 主控确认新增 tag */
  onAdd: (videoId: string, time: number, label: string) => void;
  /** 主控删除 tag */
  onDelete: (id: string) => void;
  /** 主控（或任意成员点击后由主控）发起跳转 */
  onSeek: (time: number) => void;
}

// ─── 新增输入行草稿状态 ───────────────────────────────────────────────────────

interface InputDraft {
  timeStr: string;
  label: string;
  error: string;
}

const EMPTY_DRAFT: InputDraft = { timeStr: '', label: '', error: '' };

// ─── 组件 ────────────────────────────────────────────────────────────────────

export default function VideoTagBar({
  tags,
  duration,
  isController,
  activeVideoId,
  onAdd,
  onDelete,
  onSeek,
}: VideoTagBarProps) {
  const inputId = useId();
  const [showInput, setShowInput] = useState(false);
  const [draft, setDraft] = useState<InputDraft>(EMPTY_DRAFT);

  // ── 点击「+ 新增 Tag」──────────────────────────────────────────────────────
  const handleOpenInput = useMemoizedFn((currentTimeSec?: number) => {
    setDraft({
      timeStr: currentTimeSec != null ? formatTime(currentTimeSec) : '',
      label: '',
      error: '',
    });
    setShowInput(true);
  });

  // ── 输入框变更 ─────────────────────────────────────────────────────────────
  const handleTimeChange = useMemoizedFn((e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((prev) => ({ ...prev, timeStr: e.target.value, error: '' }));
  });

  const handleLabelChange = useMemoizedFn((e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((prev) => ({ ...prev, label: e.target.value, error: '' }));
  });

  // ── 确认新增 ──────────────────────────────────────────────────────────────
  const handleConfirm = useMemoizedFn(() => {
    const time = parseTime(draft.timeStr);
    if (time === null) {
      setDraft((prev) => ({ ...prev, error: '时间格式错误，请输入 m:ss 格式' }));
      return;
    }
    if (!draft.label.trim()) {
      setDraft((prev) => ({ ...prev, error: '请输入标注内容' }));
      return;
    }
    onAdd(activeVideoId, time, draft.label.trim());
    setShowInput(false);
    setDraft(EMPTY_DRAFT);
  });

  // ── 取消 ──────────────────────────────────────────────────────────────────
  const handleCancel = useMemoizedFn(() => {
    setShowInput(false);
    setDraft(EMPTY_DRAFT);
  });

  // ── 键盘快捷键 ─────────────────────────────────────────────────────────────
  const handleKeyDown = useMemoizedFn((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') handleCancel();
  });

  // ── 按时间升序排列（显示用，tags 列表来自外部已排序，此处防御性排序） ────────────────
  const sortedTags = [...tags].sort((a, b) => a.time - b.time);

  return (
    <div className={styles.wrapper}>
      {/* 自定义时间轴 */}
      <div className={styles.timeline}>
        <div className={styles.timelineTrack} />
        {duration > 0 &&
          sortedTags.map((tag) => {
            const pct = Math.min(Math.max((tag.time / duration) * 100, 0), 100);
            return (
              <div
                key={tag.id}
                className={styles.tagMarker}
                style={{ left: `${pct}%` }}
                onClick={() => onSeek(tag.time)}
                title={`${formatTime(tag.time)} · ${tag.label}`}
              >
                <div className={styles.tagTooltip}>
                  {formatTime(tag.time)} · {tag.label}
                </div>
              </div>
            );
          })}
      </div>

      {/* 操作栏：主控可见「+ 新增 Tag」 */}
      {isController && !showInput && (
        <div className={styles.actions}>
          <button
            className={styles.addBtn}
            onClick={() => handleOpenInput()}
          >
            + 新增 Tag
          </button>
        </div>
      )}

      {/* Tag 列表 + 输入行 */}
      <ul className={styles.list}>
        {sortedTags.map((tag) => (
          <li key={tag.id} className={styles.tagItem} onClick={() => onSeek(tag.time)}>
            <span className={styles.tagTime}>{formatTime(tag.time)}</span>
            <span className={styles.tagLabel}>{tag.label}</span>
            {isController && (
              <button
                className={styles.deleteBtn}
                onClick={(e) => {
                  e.stopPropagation(); // 阻止冒泡触发 onSeek
                  onDelete(tag.id);
                }}
              >
                删除
              </button>
            )}
          </li>
        ))}

        {/* 输入行（新增中状态） */}
        {showInput && (
          <li className={styles.inputRow} onKeyDown={handleKeyDown}>
            <input
              id={`${inputId}-time`}
              className={styles.timeInput}
              type="text"
              placeholder="m:ss"
              value={draft.timeStr}
              onChange={handleTimeChange}
              autoFocus
            />
            <input
              id={`${inputId}-label`}
              className={styles.labelInput}
              type="text"
              placeholder="标注内容，如：问题a"
              value={draft.label}
              onChange={handleLabelChange}
            />
            {draft.error && (
              <span className={styles.errorHint}>{draft.error}</span>
            )}
            <button className={styles.confirmBtn} onClick={handleConfirm}>
              确认
            </button>
            <button className={styles.cancelBtn} onClick={handleCancel}>
              取消
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
