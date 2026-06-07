import { useState, useRef, type ChangeEvent } from 'react';
import { getUploadUrlApi, confirmVideoUploadApi } from '@/api/room';
import request, { ApiError } from '@/utils/request';
import styles from './VideoUploader.module.scss';

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

interface VideoUploaderProps {
  roomId: string;
}

export default function VideoUploader({ roomId }: VideoUploaderProps) {
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setStatus('uploading');
    setProgress(0);
    setErrorMsg('');

    try {
      // 1. 向后端请求上传地址
      //    - OSS 模式：返回 OSS 预签名 PUT URL，mode 为空
      //    - 本地模式：返回后端本地上传接口地址，mode === 'local'
      const { uploadUrl, videoUrl: ossVideoUrl, mode, fileName: remoteFileName } = await getUploadUrlApi(
        roomId,
        file.name,
        file.type || 'video/mp4',
      );

      if (mode === 'local') {
        // ── 本地开发模式 ──────────────────────────────────────────────────
        // 直接 PUT 文件到后端，后端落盘后写入 room_videos 并广播 VIDEO_ADDED
        await uploadToBackend(
          uploadUrl,
          file,
          file.name,
          (pct) => setProgress(pct),
        );
        // VIDEO_ADDED WS 消息会自动将视频追加到列表，无需手动更新 Context
      } else {
        // ── OSS 模式 ──────────────────────────────────────────────────────
        // 2. 直传 OSS（XHR PUT，监听 progress）
        await uploadToOss(uploadUrl, file, (pct) => setProgress(pct));

        // 3. 通知后端追加到 room_videos，后端广播 VIDEO_ADDED
        await confirmVideoUploadApi(roomId, ossVideoUrl, remoteFileName || file.name);
      }

      setStatus('done');
      setProgress(100);
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
 * 本地模式：PUT 文件到后端接口，读取响应 JSON 中的 videoUrl
 * 使用封装的 axios 实例，自动注入 Bearer Token 并支持无感刷新
 */
async function uploadToBackend(
  uploadUrl: string,
  file: File,
  _fileName: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  // uploadUrl 已由后端 getUploadUrl 拼入 fileName 参数，无需重复追加
  await request.put(
    uploadUrl,
    file,
    {
      headers: { 'Content-Type': file.type || 'video/mp4' },
      // baseURL 设为空字符串，避免 request 实例的 /api 前缀重复拼接
      baseURL: '',
      onUploadProgress: (e) => {
        if (e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      },
    },
  );
  // videoUrl 由后端通过 VIDEO_ADDED WS 消息广播，无需从响应中读取
}

/**
 * OSS 模式：使用 XMLHttpRequest 直传 OSS，支持上传进度回调
 */
function uploadToOss(
  uploadUrl: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`OSS 上传失败：HTTP ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('OSS 上传网络错误'));
    xhr.send(file);
  });
}
