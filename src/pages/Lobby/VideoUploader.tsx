import { useState, useRef, useEffect, type ChangeEvent } from 'react';
import { Modal } from 'antd';
import { getUploadUrlApi } from '@/api/room';
import request, { ApiError } from '@/utils/request';
import { validateVideoFile } from '@/utils/validateVideo';
import styles from './VideoUploader.module.scss';

/** 上传状态机：idle → uploading → slicing → done | error */
type UploadStatus = 'idle' | 'uploading' | 'slicing' | 'done' | 'error';

interface VideoUploaderProps {
  roomId: string;
  /**
   * WS VIDEO_ADDED 事件透传——由父组件（Lobby）在 useRoomWs 收到 VIDEO_ADDED 时调用，
   * 传入广播的 fileName。VideoUploader 内部对比 pendingFileName，若匹配则切换到"已完成"。
   */
  lastVideoAddedName?: string;
}

export default function VideoUploader({ roomId, lastVideoAddedName }: VideoUploaderProps) {
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * 当前等待切片完成的文件名。
   * 上传完成（200 响应）后写入，VIDEO_ADDED 到来时对比此值。
   */
  const pendingFileNameRef = useRef<string | null>(null);

  // 监听父组件传入的 lastVideoAddedName，判断是否匹配本次上传
  useEffect(() => {
    if (
      lastVideoAddedName &&
      pendingFileNameRef.current &&
      pendingFileNameRef.current === lastVideoAddedName
    ) {
      pendingFileNameRef.current = null;
      setStatus('done');
      setProgress(100);
    }
  }, [lastVideoAddedName]);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setErrorMsg('');
    setStatus('uploading');
    setProgress(0);

    // 上传前校验：moov 索引位置 + 平均码率
    const validateResult = await validateVideoFile(file);
    if (!validateResult.ok) {
      setStatus('idle');
      if (inputRef.current) inputRef.current.value = '';
      Modal.error({
        title: validateResult.errorTitle ?? '视频校验失败',
        content: (
          <div style={{ whiteSpace: 'pre-line', lineHeight: 1.7 }}>
            {validateResult.errorDetail}
          </div>
        ),
        okText: '我知道了',
        width: 480,
      });
      return;
    }

    try {
      // 1. 向后端请求上传地址
      //    - OSS 模式：mode: 'proxy'，后端代理上传，完成后异步切片
      //    - 本地模式：mode: 'local'，直接发给后端落盘，完成后异步切片
      const { uploadUrl, mode } = await getUploadUrlApi(
        roomId,
        file.name,
        file.type || 'video/mp4',
      );

      if (mode === 'local') {
        // ── 本地开发模式 ──────────────────────────────────────────────────
        await uploadToBackend(uploadUrl, file, (pct) => setProgress(pct));
      } else {
        // ── 代理上传模式（所有 OSS 用户统一走此路径）────────────────────
        await uploadToBackend(uploadUrl, file, (pct) => setProgress(pct), 'POST');
      }

      // 上传成功：切换到"切片中"状态，等待后端 ffmpeg 切片完成后广播 VIDEO_ADDED
      pendingFileNameRef.current = file.name;
      setStatus('slicing');

    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '上传失败，请重试';
      setErrorMsg(msg);
      setStatus('error');
    }

    // 重置 input，允许重新选择同名文件
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className={styles.wrapper}>
      {status === 'idle' || status === 'error' ? (
        <label className={styles.idleBox}>
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={handleFileChange}
          />
          <span className={styles.idleText}>
            点击选择录屏文件
            <span className={styles.idleHint}>&ensp;支持 mp4、mov、avi 等常见格式</span>
          </span>
          {status === 'error' && <span className={styles.errorText}>{errorMsg}</span>}
        </label>
      ) : status === 'uploading' ? (
        <div className={styles.progressBox}>
          <p className={styles.uploadingFile}>正在上传：{fileName}</p>
          <div className={styles.progressTrack}>
            <div className={styles.progressBar} style={{ width: `${progress}%` }} />
          </div>
          <p className={styles.progressText}>{progress}%</p>
        </div>
      ) : status === 'slicing' ? (
        <div className={styles.slicingBox}>
          <span className={styles.slicingSpinner}>⏳</span>
          <p className={styles.slicingText}>服务器切片中，请稍候...</p>
          <p className={styles.slicingFile}>{fileName}</p>
        </div>
      ) : (
        <div className={styles.doneBox}>
          <span className={styles.doneIcon}>✅</span>
          <p className={styles.doneText}>{fileName} 已上传</p>
          <button
            className={styles.reuploadBtn}
            onClick={() => { setStatus('idle'); setFileName(''); }}
          >
            重新上传
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 本地模式 / 代理上传模式：将文件发送到后端接口
 * 使用封装的 axios 实例，自动注入 Bearer Token 并支持无感刷新
 *
 * @param method - HTTP 方法，本地模式为 'PUT'，代理上传模式为 'POST'（默认 'PUT'）
 */
async function uploadToBackend(
  uploadUrl: string,
  file: File,
  onProgress: (pct: number) => void,
  method: 'PUT' | 'POST' = 'PUT',
): Promise<void> {
  const config = {
    headers: { 'Content-Type': file.type || 'video/mp4' },
    // baseURL 设为空字符串，避免 request 实例的 /api 前缀重复拼接
    baseURL: '',
    // 视频上传需要等待后端将文件写入 COS，时长不确定，设 0 禁用超时（全局默认 30s 不够用）
    timeout: 0,
    onUploadProgress: (e: { loaded: number; total?: number }) => {
      if (e.total) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    },
  };

  if (method === 'POST') {
    await request.post(uploadUrl, file, config);
  } else {
    await request.put(uploadUrl, file, config);
  }
}
