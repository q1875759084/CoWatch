import { useEffect, useRef, useState } from 'react';

import { message, Modal, Tooltip } from 'antd';

import type { RecorderSource, EncoderDetectResult, RecordingProgress, RecorderState, RecorderError } from '@/types/recorder';
import { useRecorderState } from '@/context/RecorderContext';
import { getAccessToken } from '@/utils/token';

import { WindowPicker } from './WindowPicker';
import styles from './index.module.scss';

interface RecorderProps {
  roomId: string;
}

/** 将录制秒数格式化为 HH:MM:SS */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

/**
 * 录制控件
 *
 * 挂载于视频列表标题栏右侧，仅 Electron pro 房间可用。
 * 非 Electron 环境下按钮置灰，hover 提示"请使用 CoWatch 客户端"。
 */
export function Recorder({ roomId }: RecorderProps) {
  const isElectron = !!(window as Window & { electronBridge?: { isElectron: true } }).electronBridge?.isElectron;
  const bridge = isElectron ? window.electronBridge : null;

  const { setRecorderState } = useRecorderState();

  const [localState, setLocalState] = useState<RecorderState>('idle');
  const [encoderInfo, setEncoderInfo] = useState<EncoderDetectResult | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [sources, setSources] = useState<RecorderSource[]>([]);
  const [tickSeconds, setTickSeconds] = useState(0);
  const [progress, setProgress] = useState<RecordingProgress>({ uploaded: 0, pending: 0 });

  const tickSecRef = useRef(0);

  /** 同步本地 state 到 Context，供路由守卫读取 */
  const updateState = (s: RecorderState) => {
    setLocalState(s);
    setRecorderState(s);
  };

  // ── 编码器检测（挂载时自动触发，仅 Electron 环境）────────────────────────
  useEffect(() => {
    if (!bridge) return;

    updateState('detecting');

    bridge.recorder.detectEncoder()
      .then((result) => {
        setEncoderInfo(result);
        updateState('ready');

        // 软编提示延迟到用户实际点击「开始录制」时弹出，避免进房时被忽视
      })
      .catch((err: unknown) => {
        console.error('[Recorder] 编码器检测失败：', (err as Error).message);
        updateState('idle');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 注册 tick / progress / error IPC 监听器（仅 Electron 环境）─────────────
  useEffect(() => {
    if (!bridge) return;

    const unsubTick = bridge.recorder.onTick((seconds) => {
      tickSecRef.current = seconds;
      setTickSeconds(seconds);
    });
    const unsubProgress = bridge.recorder.onProgress((info) => {
      setProgress(info);
    });
    // 主进程 abortRecording 触发：网络持续不可用 / 积压超限
    const unsubError = bridge.recorder.onError((err: RecorderError) => {
      console.error('[Recorder] 主进程异常中止：', err.reason);
      // 重置为 ready，允许用户手动重新录制
      updateState('ready');
      Modal.error({
        title: '录制已中止',
        content: err.reason || '网络持续异常，切片上传失败，录制已自动停止。',
        okText: '确定',
      });
    });

    // 按引用摘除各自 listener，避免 removeAllListeners 误删其他订阅者
    // （PendingUploads 也订阅 onProgress，全局清空会踩踏）
    return () => {
      unsubTick();
      unsubProgress();
      unsubError();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, localState]);

  // ── 打开窗口选择器（点击「开始录制」按钮时触发）────────────────────────────
  const handleOpenPicker = async () => {
    if (!bridge) return;

    // 软编码时先弹一次告知弹窗，用户确认后再进入录制源选择
    if (encoderInfo?.isSoftware) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.info({
          title: '软件编码模式',
          content: '当前设备不支持硬件加速编码，将使用 CPU 软件编码。视频分辨率已自动降为 480p，录制期间可能影响游戏性能。',
          okText: '确定',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }

    try {
      const list = await bridge.recorder.getSources();
      setSources(list);
      setShowPicker(true);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('权限被拒绝') || msg.includes('denied') || msg.includes('Failed to get sources')) {
        void message.error(
          '屏幕录制权限被拒绝，请前往 系统设置 → 隐私与安全性 → 屏幕录制，勾选本应用后重试',
          8,
        );
      } else {
        void message.error(msg || '获取录制源失败，请检查屏幕录制权限');
      }
    }
  };

  // ── 开始录制 ───────────────────────────────────────────────────────────────
  const handleConfirmSource = async (
    source: RecorderSource,
    _sourceType: 'screen' | 'window',
    recordOnly: boolean = false,
  ) => {
    if (!bridge) return;
    setShowPicker(false);
    try {
      setTickSeconds(0);
      tickSecRef.current = 0;
      setProgress({ uploaded: 0, pending: 0 });
      const authToken = getAccessToken() ?? '';
      await bridge.recorder.start(source.id, source.name, roomId, authToken, recordOnly);
      updateState('recording');
    } catch (err) {
      void message.error((err as Error).message || '录制启动失败');
      updateState('ready');
    }
  };

  // ── 停止录制 ───────────────────────────────────────────────────────────────
  const handleStop = async () => {
    if (!bridge) return;
    try {
      updateState('finishing');
      await bridge.recorder.stop();
      // stop() 是同步等待所有切片上传完成后才返回，结束后直接回到 ready
      // （编码器已检测完毕，ready 态可以立即再次录制）
      updateState('ready');
    } catch (err) {
      void message.error((err as Error).message || '停止录制失败');
      updateState('idle');
    }
  };

  // ── 渲染 ───────────────────────────────────────────────────────────────────

  // 非 Electron 环境：按钮置灰 + tooltip
  if (!isElectron) {
    return (
      <Tooltip title="请使用 CoWatch 客户端">
        <button type="button" className={`${styles.btn} ${styles.btnDisabled}`} disabled>
          开始录制
        </button>
      </Tooltip>
    );
  }

  // 编码器检测中
  if (localState === 'detecting') {
    return (
      <button type="button" className={`${styles.btn} ${styles.btnDisabled}`} disabled>
        初始化中…
      </button>
    );
  }

  // 录制中
  if (localState === 'recording') {
    return (
      <div className={styles.wrap}>
        <span className={styles.recordingDot} aria-hidden />
        <span className={styles.timer}>{formatDuration(tickSeconds)}</span>
        <button type="button" className={`${styles.btn} ${styles.btnStop}`} onClick={handleStop}>
          停止录制
        </button>
      </div>
    );
  }

  // 上传中（finishing）
  if (localState === 'finishing') {
    const total = progress.uploaded + progress.pending;
    const pct = total > 0 ? Math.round((progress.uploaded / total) * 100) : 0;
    return (
      <div className={styles.wrap}>
        <span className={styles.finishingText}>
          上传中 {progress.uploaded}/{total > 0 ? total : '…'}
        </span>
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  // idle / ready
  return (
    <>
      <button
        type="button"
        className={styles.btn}
        onClick={handleOpenPicker}
        disabled={localState !== 'ready'}
      >
        开始录制
      </button>

      {showPicker ? (
        <WindowPicker
          sources={sources}
          onConfirm={handleConfirmSource}
          onCancel={() => setShowPicker(false)}
          onRefresh={async () => {
            if (!bridge) return;
            try {
              const list = await bridge.recorder.getSources();
              setSources(list);
            } catch (err) {
              const msg = (err as Error).message || '';
              if (msg.includes('权限被拒绝') || msg.includes('denied') || msg.includes('Failed to get sources')) {
                void message.error(
                  '屏幕录制权限被拒绝，请前往 系统设置 → 隐私与安全性 → 屏幕录制，勾选本应用后重试',
                  8,
                );
              } else {
                void message.error(msg || '获取录制源失败');
              }
            }
          }}
        />
      ) : null}
    </>
  );
}