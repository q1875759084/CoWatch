import { useState, useRef, type ChangeEvent } from 'react';
import { Modal } from 'antd';
import { getUploadUrlApi, confirmVideoUploadApi } from '@/api/room';
import request, { ApiError } from '@/utils/request';
import { validateVideoFile } from '@/utils/validateVideo';
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
    setErrorMsg('');

    // 上传前校验：moov 索引位置 + 平均码率
    // 先切换到 uploading 展示文件名，让用户知道正在处理
    setStatus('uploading');
    setProgress(0);

    const validateResult = await validateVideoFile(file);
    if (!validateResult.ok) {
      // 校验失败：回到 idle 状态，通过 antd Modal 弹窗告知用户
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
      //    - OSS 模式：返回 OSS 预签名 PUT URL，mode 为空
      //    - 本地模式：返回后端本地上传接口地址，mode === 'local'
      const { uploadUrl, objectKey, mode, fileName: remoteFileName } = await getUploadUrlApi(
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
      } else if (mode === 'proxy') {
        // ── 代理上传模式（非白名单用户）────────────────────────────────────
        // 文件经后端中转写入 OSS，后端负责写入 room_videos 并广播 VIDEO_ADDED
        // 使用封装的 axios 实例，自动注入 Bearer Token
        // uploadUrl 已由后端拼入 objectKey / fileType / fileName 等参数
        await uploadToBackend(
          uploadUrl,
          file,
          file.name,
          (pct) => setProgress(pct),
          'POST',
        );
        // VIDEO_ADDED WS 消息会自动将视频追加到列表
      } else {
        // ── OSS 直传模式（白名单用户）────────────────────────────────────
        // 直接 PUT 到 OSS 预签名 URL（绕过后端，减少带宽消耗）
        await uploadToOss(uploadUrl, file, (pct) => setProgress(pct));

        // 通知后端：传回 objectKey，后端存库并广播带签名的 VIDEO_ADDED
        await confirmVideoUploadApi(roomId, objectKey, remoteFileName || file.name);
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
 * 本地模式 / 代理上传模式：将文件发送到后端接口
 * 使用封装的 axios 实例，自动注入 Bearer Token 并支持无感刷新
 *
 * @param method - HTTP 方法，本地模式为 'PUT'，代理上传模式为 'POST'（默认 'PUT'）
 */
async function uploadToBackend(
  uploadUrl: string,
  file: File,
  _fileName: string,
  onProgress: (pct: number) => void,
  method: 'PUT' | 'POST' = 'PUT',
): Promise<void> {
  // uploadUrl 已由后端 getUploadUrl 拼入 fileName 等参数，无需重复追加
  const config = {
    headers: { 'Content-Type': file.type || 'video/mp4' },
    // baseURL 设为空字符串，避免 request 实例的 /api 前缀重复拼接
    baseURL: '',
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
