import { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from 'antd';
import { getAccessToken } from '@/utils/token';
import { useRoomMeta } from '@/context/RoomMetaContext';
import type { ExternalTranscodeProgress } from '@/types/recorder';
import PendingUploads from '../VideoUploader/PendingUploads';
import styles from '../VideoUploader/index.module.scss';

/** HLS 分段时长（秒），与 electron/handlers/recorder/shared.ts 保持一致 */
const SEGMENT_DURATION_SEC = 10;

/** 格式化秒数为 m:ss */
function formatTime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface QueueItem {
  id: string;
  filePath: string;
  name: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  errorMsg?: string;
}

let _queueId = 0;
function nextQueueId(): string {
  return `q${++_queueId}_${Date.now()}`;
}

interface ElectronVideoUploaderProps {
  lastVideoAddedId?: string;
}

export default function ElectronVideoUploader({ lastVideoAddedId }: ElectronVideoUploaderProps) {
  const { roomMeta } = useRoomMeta();
  const roomId = roomMeta?.roomId ?? '';
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [progress, setProgress] = useState({ uploaded: 0, estimated: -1 });
  const [waitingServer, setWaitingServer] = useState(false);
  const videoAddedRef = useRef(false);
  const currentRef = useRef<QueueItem | null>(null);
  /** 防重入：processNext 执行中标记 */
  const processingRef = useRef(false);
  /** 监听模式（文件夹自动转码上传）UI 状态 */
  const [watchActive, setWatchActive] = useState(false);
  const [watchFolder, setWatchFolder] = useState('');

  // ── 单一自驱效应：队列中有待处理项且无处理中项时，自动启动下一个 ──────────
  useEffect(() => {
    if (processingRef.current) return;
    // 任一任务正在处理时等待其完成，避免并发撞 NVENC（监听与手动共用同一串行约束）
    const hasProcessing = queue.some((item) => item.status === 'processing');
    if (hasProcessing) return;

    // 监听模式检测到的文件也按"手动上传"同构入队，统一由本自驱效应启动转码
    const nextIdx = queue.findIndex((item) => item.status === 'queued');
    if (nextIdx === -1) return;

    // 找到待处理项，开始转码
    const item = queue[nextIdx];
    processingRef.current = true;

    // 标记为 processing（乐观更新，后续 start 失败再回退）
    setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'processing' as const } : q)));
    currentRef.current = item;
    setProgress({ uploaded: 0, estimated: -1 });
    setWaitingServer(false);
    videoAddedRef.current = false;

    void (async () => {
      try {
        const authToken = getAccessToken() ?? '';
        const bridge = window.electronBridge!;
        const result = await bridge.recorder.transcodeExternal(roomId, authToken, item.filePath);
        if (result.error) {
          setQueue((prev) => prev.map((q) =>
            q.id === item.id ? { ...q, status: 'error' as const, errorMsg: result.error } : q,
          ));
          currentRef.current = null;
        }
        // 成功启动 → 等待 phase:completed + VIDEO_ADDED
      } catch (err) {
        setQueue((prev) => prev.map((q) =>
          q.id === item.id ? { ...q, status: 'error' as const, errorMsg: (err as Error).message || '转码启动失败' } : q,
        ));
        currentRef.current = null;
      } finally {
        processingRef.current = false;
      }
    })();
  }, [queue, roomId]);

  // ── 全部完成弹窗（当队列非空且无待处理/处理中项时） ───────────────────────
  useEffect(() => {
    if (queue.length === 0) return;
    const pending = queue.some(
      (item) => item.status === 'queued' || item.status === 'processing',
    );
    if (!pending) {
      const okCount = queue.filter((q) => q.status === 'completed').length;
      Modal.success({
        title: '全部视频已就绪',
        content: `${okCount} 个视频已处理完成，可在视频列表中选择播放。`,
        okText: '知道了',
        onOk: () => setQueue([]),
      });
    }
  }, [queue]);

  // ── 添加文件 ────────────────────────────────────────────────────────────────

  const handleAddFiles = useCallback(async () => {
    const bridge = window.electronBridge!;
    const result = await bridge.recorder.selectVideoFiles();
    if (result.cancelled || result.filePaths.length === 0) return;

    const newItems: QueueItem[] = result.filePaths.map((fp) => ({
      id: nextQueueId(),
      filePath: fp,
      name: fp.split(/[/\\]/).pop() ?? fp,
      status: 'queued' as const,
    }));

    setQueue((prev) => [...prev, ...newItems]);
    // 自驱效应会在队列变化后自动启动第一个
  }, []);

    // ── 监听模式（文件夹自动转码上传）：文件检测入队 + UI 开关 ─────────────────
    // 主进程检测到新视频后广播路径，这里按"用户手动点选"完全相同的路径入队，
    // 由上方 self-driver 统一调 transcodeExternal 启动 —— 下游 100% 复用模式 B。
    const handleWatchFileDetected = useCallback((filePath: string) => {
      setQueue((prev) => {
        if (prev.some((q) => q.filePath === filePath)) return prev;
        return [...prev, {
          id: nextQueueId(),
          filePath,
          name: filePath.split(/[/\\]/).pop() ?? filePath,
          status: 'queued' as const,
        }];
      });
    }, []);

    useEffect(() => {
      const bridge = window.electronBridge!;
      bridge.recorder.onWatchFileDetected((filePath) => handleWatchFileDetected(filePath));
      // 启动时恢复监听状态（主进程持久化目录，UI 仅恢复标记）
      bridge.recorder.getWatchStatus().then((st) => {
        setWatchActive(st.active);
        setWatchFolder(st.folderPath);
      }).catch(() => { /* 非 Electron 环境忽略 */ });
      return () => { bridge.recorder.offWatchFileDetected(); };
    }, [handleWatchFileDetected]);

  const handleSelectWatchFolder = useCallback(async () => {
    const bridge = window.electronBridge!;
    const res = await bridge.recorder.selectWatchFolder();
    if (!res.cancelled && res.folderPath) setWatchFolder(res.folderPath);
  }, []);

    const handleToggleWatch = useCallback(async (checked: boolean) => {
      const bridge = window.electronBridge!;
      if (checked) {
        let folder = watchFolder;
        if (!folder) {
          const res = await bridge.recorder.selectWatchFolder();
          if (res.cancelled || !res.folderPath) return;
          folder = res.folderPath;
          setWatchFolder(folder);
        }
        const res = await bridge.recorder.startWatch(folder);
        if (res.error) { console.error('[uploader] 启动监听失败：', res.error); return; }
        setWatchActive(true);
      } else {
        await bridge.recorder.stopWatch();
        setWatchActive(false);
      }
    }, [watchFolder]);

  // ── VIDEO_ADDED 广播：当前文件处理完毕 ────────────────────────────────────

  useEffect(() => {
    if (!lastVideoAddedId) return;
    videoAddedRef.current = true;

    if (currentRef.current) {
      const currentId = currentRef.current.id;
      setQueue((prev) => prev.map((q) =>
        q.id === currentId ? { ...q, status: 'completed' as const } : q,
      ));
      currentRef.current = null;
      setProgress({ uploaded: 0, estimated: -1 });
      setWaitingServer(false);
    }
  }, [lastVideoAddedId]);

  // ── 转码进度监听 ────────────────────────────────────────────────────────────

  useEffect(() => {
    const bridge = window.electronBridge!;
    bridge.recorder.onExternalTranscodeProgress((raw: unknown) => {
      const info = raw as ExternalTranscodeProgress;
      setProgress({ uploaded: info.uploaded, estimated: info.estimated });

      if (info.phase === 'completed') {
        // 仅当前文件未收到 VIDEO_ADDED 时才转 waiting 态
        if (!videoAddedRef.current) {
          setWaitingServer(true);
        }
      } else if (info.phase === 'failed') {
        if (!videoAddedRef.current && currentRef.current) {
          const currentId = currentRef.current.id;
          setQueue((prev) => prev.map((q) =>
            q.id === currentId
              ? { ...q, status: 'error' as const, errorMsg: '视频转码失败，请检查文件格式' }
              : q,
          ));
          currentRef.current = null;
        }
      } else {
        // transcoding / uploading：新文件正在产出，复位旧文件可能残留的 waiting 态
        setWaitingServer(false);
      }
    });
    return () => { bridge.recorder.offExternalTranscodeProgress(); };
  }, []);

  // ── 进度计算 ────────────────────────────────────────────────────────────────

  const pct = progress.estimated > 0
    ? Math.min(Math.round((progress.uploaded / progress.estimated) * 100), 99)
    : 0;
  const processedSec = progress.uploaded * SEGMENT_DURATION_SEC;
  const totalSec = progress.estimated > 0
    ? progress.estimated * SEGMENT_DURATION_SEC
    : 0;

  // ── 渲染 ────────────────────────────────────────────────────────────────────

  return (
    <div className={styles.wrapper}>
      {/* 监听模式开关 + 目录选择 + 状态（≤30 行 JSX，复用既有上传列表，不新建面板） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
        <span>监听文件夹自动上传</span>
        <input
          type="checkbox"
          checked={watchActive}
          onChange={(e) => void handleToggleWatch(e.target.checked)}
        />
        <button type="button" onClick={() => void handleSelectWatchFolder()} disabled={watchActive} style={{ fontSize: 12 }}>
          选择目录
        </button>
        <span style={{ color: watchActive ? '#52c41a' : '#999' }}>
          {watchActive ? `🔴 监听中 · ${watchFolder}` : '⚪ 已停止'}
        </span>
      </div>

      <label className={styles.idleBox} onClick={handleAddFiles}>
        <span className={styles.idleText}>
          点击选择视频文件
          <span className={styles.idleHint}>&ensp;支持 mp4、mov、avi 等常见格式，客户端自动转码上传</span>
        </span>
      </label>

      {queue.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {queue.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              isProcessing={item.status === 'processing'}
              progress={item.status === 'processing'
                ? { pct, waitingServer, processedSec, totalSec }
                : undefined
              }
            />
          ))}
        </div>
      )}

      <PendingUploads />
    </div>
  );
}

// ── 队列行 ────────────────────────────────────────────────────────────────────

interface QueueRowProgress {
  pct: number;
  waitingServer: boolean;
  processedSec: number;
  totalSec: number;
}

function QueueRow({
  item,
  isProcessing,
  progress,
}: {
  item: QueueItem;
  isProcessing: boolean;
  progress?: QueueRowProgress;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
      <StatusIcon status={item.status} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.name}
      </span>
      {isProcessing && progress && (
        <span style={{ color: '#1677ff', fontSize: 12, whiteSpace: 'nowrap' }}>
          {progress.waitingServer
            ? '等待服务器确认...'
            : progress.totalSec > 0
              ? `${progress.pct}%`
              : `${formatTime(progress.processedSec)}`}
        </span>
      )}
      {item.status === 'error' && item.errorMsg && (
        <span style={{ color: '#ff4d4f', fontSize: 12 }}>{item.errorMsg}</span>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: QueueItem['status'] }) {
  switch (status) {
    case 'queued':
      return <span style={{ color: '#999', minWidth: 20, textAlign: 'center' }}>⏸</span>;
    case 'processing':
      return <span style={{ color: '#1677ff', minWidth: 20, textAlign: 'center' }}>⏳</span>;
    case 'completed':
      return <span style={{ color: '#52c41a', minWidth: 20, textAlign: 'center' }}>✅</span>;
    case 'error':
      return <span style={{ color: '#ff4d4f', minWidth: 20, textAlign: 'center' }}>❌</span>;
  }
}
