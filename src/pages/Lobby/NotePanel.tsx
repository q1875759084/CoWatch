import { useState, useRef } from 'react';
import { useMemoizedFn } from 'ahooks';
import styles from './NotePanel.module.scss';

interface NotePanelProps {
  /** 笔记内容（由父组件维护，WS 同步） */
  content: string;
  /** 是否为主控（决定 textarea 是否可编辑） */
  isController: boolean;
  /** 当前房间 ID（用于保存文件名） */
  roomId: string;
  /** 主控输入时回调，父组件负责节流后广播 WS */
  onChange: (content: string) => void;
}

/**
 * NotePanel — 房间共享记事本浮层
 *
 * 固定在视口右上角（position: fixed）。
 * 一个常驻"📝"按钮控制展开/收起（本地状态，各端独立）。
 * 展开后显示 textarea：主控可编辑，其他人只读。
 * 底部"保存为 txt"使用 Blob API 触发本地下载，后端无需参与。
 */
export default function NotePanel({ content, isController, roomId, onChange }: NotePanelProps) {
  const [open, setOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSave = useMemoizedFn(() => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cowatch-note-${roomId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  return (
    <div className={styles.root}>
      {/* 常驻触发按钮 */}
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerActive : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起笔记' : '展开共享笔记'}
      >
        logs
      </button>

      {/* 展开的浮层面板 */}
      {open && (
        <div className={styles.panel}>
          {/* 标题栏 */}
          <div className={styles.header}>
            <span className={styles.title}>开庭记录</span>
            {!isController && (
              <span className={styles.readonlyBadge}>只读</span>
            )}
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => setOpen(false)}
              title="收起"
            >
              ✕
            </button>
          </div>

          {/* 输入区 */}
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={content}
            readOnly={!isController}
            placeholder={isController ? '在此输入复盘笔记...' : '等待主控输入...'}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
          />

          {/* 底部操作栏 */}
          <div className={styles.footer}>
            <span className={styles.hint}>
              {isController ? '内测阶段，仅主控可编辑，自动同步给所有人' : '内测阶段，主控正在编辑，实时同步'}
            </span>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={!content.trim()}
              title="保存为 txt 文件"
            >
              ⬇ 保存为 txt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
