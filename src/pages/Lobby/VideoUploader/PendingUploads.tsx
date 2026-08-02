import { useEffect, useState } from 'react';
import { Button, Progress } from 'antd';
import { useMemoizedFn } from 'ahooks';
import type { PendingRecording } from '@/types/recorder';
import { getAccessToken } from '@/utils/token';
import styles from './PendingUploads.module.scss';

/**
 * 待补传列表组件
 *
 * 挂载于 Lobby → 「上传视频」折叠区内，VideoUploader 下方。
 * 展示本地持久化的待补传录制列表，用户手动触发补传。
 */
export default function PendingUploads() {
  const isElectron = !!(window as Window & { electronBridge?: { isElectron: true } }).electronBridge?.isElectron;
  const bridge = isElectron ? window.electronBridge : null;

  const [recordings, setRecordings] = useState<PendingRecording[]>([]);
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});

  // 挂载时拉取列表
  useEffect(() => {
    if (!bridge) return;
    bridge.recorder.getPendingRecordings().then(setRecordings).catch(console.error);
  }, [bridge]);

  // 监听补传进度
  useEffect(() => {
    if (!bridge) return;
    const unsub = bridge.recorder.onProgress((info) => {
      const total = info.uploaded + info.pending;
      if (total > 0) {
        // 找到正在补传的那条（loading 态），更新进度
        const activeId = Object.keys(loadingMap).find((k) => loadingMap[k]);
        if (activeId) {
          setProgressMap((prev) => ({ ...prev, [activeId]: total > 0 ? Math.round((info.uploaded / total) * 100) : 0 }));
        }
      }
    });
    // 按引用摘除自身 listener，避免与 Recorder 组件订阅的 onProgress 互相踩踏
    return unsub;
  }, [bridge, loadingMap]);

  const handleResume = useMemoizedFn(async (sessionId: string) => {
    if (!bridge) return;
    setLoadingMap((prev) => ({ ...prev, [sessionId]: true }));
    setProgressMap((prev) => ({ ...prev, [sessionId]: 0 }));
    try {
      await bridge.recorder.resumePending(sessionId, getAccessToken() ?? '');
      // 补传完成，从列表移除
      setRecordings((prev) => prev.filter((r) => r.sessionId !== sessionId));
    } catch (err) {
      console.error('[PendingUploads] 补传失败：', (err as Error).message);
    } finally {
      setLoadingMap((prev) => ({ ...prev, [sessionId]: false }));
    }
  });

  if (!isElectron || recordings.length === 0) return null;

  const formatSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  const formatDuration = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.title}>待补传录制</div>
      {recordings.map((rec) => {
        const uploaded = rec.uploadedCount;
        const total = rec.totalSegments;
        const pct = progressMap[rec.sessionId] ?? (total > 0 ? Math.round((uploaded / total) * 100) : 0);
        const isLoading = loadingMap[rec.sessionId] ?? false;

        return (
          <div key={rec.sessionId} className={styles.item}>
            <div className={styles.info}>
              <span className={styles.name}>{rec.displayName || rec.sessionId.slice(0, 8)}</span>
              <span className={styles.meta}>
                {formatDuration(rec.durationSeconds)} · {formatSize(rec.totalSize)}
              </span>
            </div>
            <div className={styles.progress}>
              <Progress
                percent={pct}
                size="small"
                status={isLoading ? 'active' : 'normal'}
              />
              <span className={styles.progressLabel}>{uploaded}/{total} 片</span>
            </div>
            <div className={styles.actions}>
              <Button
                size="small"
                type="primary"
                loading={isLoading}
                disabled={isLoading}
                onClick={() => handleResume(rec.sessionId)}
              >
                {isLoading ? '补传中' : '补传'}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
