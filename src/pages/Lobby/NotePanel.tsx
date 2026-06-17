import { useState, useRef, useEffect, useCallback } from 'react';
import { useMemoizedFn } from 'ahooks';
import type { ChatMessageData } from '@/types/room';
import styles from './NotePanel.module.scss';

// ─── 聊天消息分组 ─────────────────────────────────────────────────────────────

interface MessageGroup {
  userId: string;
  nickname: string;
  isSelf: boolean;
  messages: ChatMessageData[];
}

function groupMessages(messages: ChatMessageData[], currentUserId: string): MessageGroup[] {
  return messages.reduce<MessageGroup[]>((groups, msg) => {
    const isSelf = msg.userId === currentUserId;
    const last = groups[groups.length - 1];
    if (last && last.userId === msg.userId) {
      last.messages.push(msg);
    } else {
      groups.push({ userId: msg.userId, nickname: msg.nickname, isSelf, messages: [msg] });
    }
    return groups;
  }, []);
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface NotePanelProps {
  /** 笔记内容（由父组件维护，WS 同步） */
  content: string;
  /** 是否为主控（决定 textarea 是否可编辑） */
  isController: boolean;
  /** 当前房间 ID（用于保存文件名） */
  roomId: string;
  /** 主控输入时回调，父组件负责节流后广播 WS */
  onChange: (content: string) => void;
  /** 聊天消息列表（由父组件维护） */
  messages: ChatMessageData[];
  /** 当前用户 ID（区分自己 / 他人） */
  currentUserId: string;
  /** 发送聊天消息回调 */
  onSendChat: (content: string) => void;
}

/**
 * NotePanel — 房间浮层（共享笔记 + 聊天）
 *
 * 两个按钮横向并排，各自有独立的 position:relative 包裹层。
 * 面板用 position:absolute 挂在各自包裹层下方，右边缘与按钮右边缘对齐，
 * 距按钮底部 12px，互不干扰（各自独立层叠上下文）。
 */
export default function NotePanel({
  content,
  isController,
  roomId,
  onChange,
  messages,
  currentUserId,
  onSendChat,
}: NotePanelProps) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadChat, setUnreadChat] = useState(false);
  const [chatInput, setChatInput] = useState('');

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLenRef = useRef(messages.length);

  // ── 新消息到达：聊天面板未开则标记红点 ──────────────────────────────────────
  useEffect(() => {
    if (messages.length > prevMessagesLenRef.current) {
      if (!chatOpen) {
        setUnreadChat(true);
      }
      prevMessagesLenRef.current = messages.length;
    }
  }, [messages.length, chatOpen]);

  // ── 聊天面板开启时自动滚到底部 ────────────────────────────────────────────
  useEffect(() => {
    if (chatOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, chatOpen]);

  // ── 打开聊天：清除红点 + 滚到底 ───────────────────────────────────────────
  const handleOpenChat = useCallback(() => {
    setChatOpen((v) => {
      if (!v) {
        setUnreadChat(false);
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        }, 0);
      }
      return !v;
    });
  }, []);

  // ── 保存笔记 ──────────────────────────────────────────────────────────────
  const handleSave = useMemoizedFn(() => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cowatch-note-${roomId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── 发送聊天 ──────────────────────────────────────────────────────────────
  const handleSend = useMemoizedFn(() => {
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    onSendChat(trimmed);
    setChatInput('');
  });

  const handleChatKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const groups = groupMessages(messages, currentUserId);

  return (
    <div className={styles.root}>
      {/* 两个按钮横向排列，各自包在独立的 triggerWrap 里 */}
      <div className={styles.triggerGroup}>

        {/* ── 犯罪记录按钮 + 面板 ── */}
        <div className={styles.triggerWrap}>
          <button
            type="button"
            className={`${styles.trigger} ${noteOpen ? styles.triggerActive : ''}`}
            onClick={() => setNoteOpen((v) => !v)}
            title={noteOpen ? '收起犯罪记录' : '展开犯罪记录'}
          >
            犯罪记录
          </button>

          {noteOpen && (
            <div className={styles.panel}>
              <div className={styles.header}>
                <span className={styles.title}>犯罪记录</span>
                {!isController && <span className={styles.readonlyBadge}>只读</span>}
              </div>

              <textarea
                ref={textareaRef}
                className={styles.textarea}
                value={content}
                readOnly={!isController}
                placeholder={isController ? '在此输入复盘笔记...' : '等待主控输入...'}
                onChange={(e) => onChange(e.target.value)}
                spellCheck={false}
              />

              <div className={styles.footer}>
                <span className={styles.hint}>
                  {isController
                    ? '内测阶段，仅主控可编辑，自动同步给所有人'
                    : '内测阶段，主控正在编辑，实时同步'}
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

        {/* ── 聊天按钮 + 面板 ── */}
        <div className={styles.triggerWrap}>
          <button
            type="button"
            className={`${styles.chatTrigger} ${chatOpen ? styles.chatTriggerActive : ''}`}
            onClick={handleOpenChat}
            title={chatOpen ? '收起聊天' : '展开聊天'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {unreadChat && <span className={styles.chatBadge} />}
          </button>

          {chatOpen && (
            <div className={styles.panel}>
              <div className={styles.header}>
                <span className={styles.title}>聊天</span>
              </div>

              <div className={styles.chatBody}>
                {groups.length === 0 && (
                  <p className={styles.chatEmpty}>暂无消息，发个消息打招呼吧～</p>
                )}
                {groups.map((group) => (
                  <div
                    key={`${group.userId}-${group.messages[0].timestamp}`}
                    className={`${styles.msgGroup} ${group.isSelf ? styles.msgGroupSelf : ''}`}
                  >
                    {!group.isSelf && (
                      <div className={styles.msgGroupName}>{group.nickname}</div>
                    )}
                    {group.messages.map((msg, mi) => (
                      <div
                        key={msg.timestamp + String(mi)}
                        className={`${styles.msgBubble} ${group.isSelf ? styles.msgBubbleSelf : ''}`}
                      >
                        {msg.content}
                      </div>
                    ))}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <div className={styles.chatInputRow}>
                <textarea
                  className={styles.chatInput}
                  value={chatInput}
                  rows={1}
                  placeholder="发个消息..."
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleChatKeyDown}
                />
                <button
                  type="button"
                  className={styles.sendBtn}
                  onClick={handleSend}
                  disabled={!chatInput.trim()}
                >
                  发送
                </button>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
