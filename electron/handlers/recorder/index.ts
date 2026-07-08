/**
 * Electron 实时录制主进程处理器（协调层）
 *
 * 职责（重构后）：
 *   - 编码器检测（h264_nvenc → h264_amf → h264_qsv → libx264 兜底）
 *   - 窗口/整屏列表获取
 *   - 协调三层：recording / transcoding / upload
 *   - 录制开始/停止生命周期管理
 *   - 切片文件监听（委托 transcoding 层）
 *   - 录制结束调用 /recording/finish 接口
 *
 * 三层架构：
 *   recording/  → FFmpeg 录制，管理临时目录
 *   transcoding/ → 逐片转码（chokidar 监听 → 串行转码队列）
 *   upload/      → 串行上传队列 + 指数退避
 *
 * IPC 通道（ipcMain.handle / webContents.send）：
 *   recorder:detectEncoder  → detectEncoder()
 *   recorder:getSources     → getSources()
 *   recorder:start          → start()
 *   recorder:stop           → stop()
 *   recorder:tick           ← push（每秒，录制时长秒数）
 *   recorder:progress       ← push（上传进度）
 */

import fs from 'fs';
import path from 'path';
import { app, desktopCapturer, ipcMain, BrowserWindow, net } from 'electron';
import { v4 as uuidv4 } from 'uuid';

import type { RecorderSource, EncoderDetectResult, RecordingProgress } from '../../../src/types/recorder';

// ─── 三层模块 ──────────────────────────────────────────────────────────────────
import {
  startRecording,
  stopRecording,
  restartRecording,
  checkWindowAlive,
  setEncoderInfo,
  getTmpDir,
  isRecording,
} from './recording';

import {
  startTranscodingWatcher,
  stopTranscodingWatcher,
  enqueueExistingRawFiles,
  waitForTranscodeQueue,
} from './transcoding';

import {
  initUploader,
  enqueueUpload,
  enqueueRawUpload,
  enqueueMissingFiles,
  waitForUploadQueue,
  flushPendingQueue,
  cleanupUploader,
  updateAuthToken,
  getActiveUploads,
  getPendingQueue,
  getSegmentKeys,
  getUploadedCount,
} from './upload';

import {
  persistRecording,
  listPendingRecordings,
  resumeUpload,
} from './persistence';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 最长录制时长（毫秒），到时自动停止 */
const MAX_RECORD_MS = 2 * 60 * 60 * 1000;

/** Stop 时的切片积压阈值：≤5 片等排空，>5 片持久化不等待 */
const STOP_PENDING_THRESHOLD = 5;

/** 编码器候选列表，依次探测，取第一个可用的 */
const ENCODER_CANDIDATES = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'] as const;

// ─── 模块级状态 ─────────────────────────────────────────────────────────────────

/** 当前会话 ID，录制开始时生成，结束后清空 */
let sessionId = '';
/** 录制临时目录（存放 ffmpeg 生成的 seg*.ts 和转码后的 seg*_opt.ts） */
let tmpDir = '';
/** 计时器：每秒推 recorder:tick */
let tickTimer: ReturnType<typeof setInterval> | null = null;
/** 定时器：最长录制时间到后自动停止 */
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
/** 用户主动停止标志，区分正常停止和 ffmpeg crash */
let isUserStopped = false;
/** ffmpeg crash 重启次数，超过上限后放弃重启 */
let crashRestartCount = 0;
/** 录制开始时间戳（ms），用于计算时长 */
let recordStartTime = 0;
/** 当前房间 ID，上传和 finish 接口需要 */
let currentRoomId = '';
/**
 * 当前用户的 JWT AccessToken，上传接口鉴权用。
 */
let currentAuthToken = '';
/** 当前录制源 id（desktopCapturer source id），crash 重启时需要 */
let currentSourceId = '';
/** 当前录制窗口的标题（用于 window-watch 备用检测），crash 重启时需要 */
let currentWindowTitle = '';
/**
 * macOS avfoundation 视频设备索引缓存（start 时通过枚举确定，crash 重启时复用）。
 */
let cachedAvfIndex = -1;
/** 后端 origin，由 main.ts 通过 setApiOrigin 注入 */
let apiOrigin = 'http://localhost:3002';
/** 检测到的编码器 */
let detectedEncoder = 'libx264';
/** 是否为软件编码 */
let isSoftwareEncoder = false;

// ─── 公开 API ─────────────────────────────────────────────────────────────────

export function setApiOriginForRecorder(origin: string): void {
  apiOrigin = origin;
}

export function setAuthTokenForRecorder(token: string): void {
  currentAuthToken = token;
  updateAuthToken(token);
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 推送进度事件到所有渲染进程窗口。
 */
function pushProgress(): void {
  const info: RecordingProgress = {
    uploaded: getUploadedCount(),
    pending: getPendingQueue().length,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:progress', info);
  }
}

/**
 * 将录制秒数格式化为 HH:MM:SS。
 */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

// ─── 编码器检测 ───────────────────────────────────────────────────────────────

async function detectEncoder(): Promise<EncoderDetectResult> {
  // 优先用系统 ffmpeg（含 ddagrab）
  const ffmpegPaths = [
    path.join(__dirname, '..', 'electron', 'bin', 'ffmpeg.exe'),   // dev
    path.join(process.resourcesPath ?? '', 'bin', 'ffmpeg.exe'),   // packaged
    'ffmpeg',                                                       // PATH
  ];

  for (const enc of ENCODER_CANDIDATES) {
    for (const ffmpeg of ffmpegPaths) {
      const result = await new Promise<boolean>((resolve) => {
        const proc = require('child_process').spawn(ffmpeg, [
          '-f', 'lavfi', '-i', 'nullsrc', '-t', '1',
          '-c:v', enc, '-f', 'null', '-',
        ], { stdio: 'ignore' });
        proc.on('close', (code: number) => resolve(code === 0));
        proc.on('error', () => resolve(false));
      });
      if (result) {
        detectedEncoder = enc;
        isSoftwareEncoder = enc === 'libx264';
        setEncoderInfo(enc, isSoftwareEncoder);
        console.log(`[recorder] 编码器检测完成：${enc}，软编=${isSoftwareEncoder}`);
        return { encoder: enc, isSoftware: isSoftwareEncoder };
      }
    }
  }

  detectedEncoder = 'libx264';
  isSoftwareEncoder = true;
  setEncoderInfo('libx264', true);
  return { encoder: 'libx264', isSoftware: true };
}

// ─── 窗口列表 ──────────────────────────────────────────────────────────────────

async function getSources(): Promise<RecorderSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 256, height: 144 },
  });

  return sources
    .filter((s) => {
      if (s.id.startsWith('screen:')) return true;
      return s.thumbnail && s.thumbnail.getSize().width > 0;
    })
    .map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : '',
      sourceType: (s.id.startsWith('screen:') ? 'screen' : 'window') as 'screen' | 'window',
    }));
}

// ─── 开始 / 停止录制 ──────────────────────────────────────────────────────────

async function start(
  windowId: string,
  displayTitle: string,
  roomId: string,
  authToken: string,
): Promise<void> {
  if (isRecording()) {
    throw new Error('[recorder] 录制已在进行中');
  }

  // 初始化状态
  sessionId = uuidv4();
  currentRoomId = roomId;
  currentSourceId = windowId;
  currentWindowTitle = displayTitle;
  currentAuthToken = authToken;
  isUserStopped = false;
  crashRestartCount = 0;
  cachedAvfIndex = -1;
  recordStartTime = Date.now();

  // 创建临时目录
  const primaryTmpDir = path.join(app.getPath('temp'), 'cowatch-rec', sessionId);
  const fallbackTmpDir = path.join(app.getPath('userData'), 'recordings', sessionId);
  try {
    fs.mkdirSync(primaryTmpDir, { recursive: true });
    tmpDir = primaryTmpDir;
  } catch {
    fs.mkdirSync(fallbackTmpDir, { recursive: true });
    tmpDir = fallbackTmpDir;
    console.warn('[recorder] temp 目录创建失败，降级到 userData：', fallbackTmpDir);
  }
  console.log(`[recorder] 临时目录：${tmpDir}`);

  // macOS：解析 avfoundation 索引
  if (process.platform === 'darwin' && windowId.startsWith('screen:')) {
    try {
      const allSources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const idx = allSources.findIndex((s) => s.id === windowId);
      cachedAvfIndex = idx >= 0 ? idx : 0;
    } catch {
      cachedAvfIndex = 0;
    }
  }

  // ① 启动录制层
  await startRecording(
    {
      sessionId,
      sourceId: windowId,
      displayTitle,
      tmpDir,
      detectedEncoder,
      isSoftwareEncoder,
      cachedAvfIndex,
    },
    {
      onCrash: (title) => {
        void handleFfmpegCrash(title);
      },
      onShouldStop: () => {
        void stop();
      },
      onLog: (msg) => console.log(msg),
    },
  );

  // ② 启动转码层（chokidar 监听）
  startTranscodingWatcher(
    {
      tmpDir,
      detectedEncoder,
      isSoftwareEncoder,
    },
    {
      onTranscodeComplete: (transcodedPath) => {
        // 转码完成 → 通知上传层
        enqueueUpload(transcodedPath);
      },
      onTranscodeFailed: (rawPath) => {
        // 转码失败 → 上传原始切片（降级策略 C）
        enqueueRawUpload(rawPath);
      },
      onLog: (msg) => console.log(msg),
      onProgress: () => pushProgress(),
    },
  );

  // ③ 启动上传层
  initUploader(
    {
      roomId,
      sessionId,
      authToken,
      apiOrigin,
    },
    {
      onProgress: () => pushProgress(),
      onLog: (msg) => console.log(msg),
    },
  );

  // ④ 启动 tick 计时器
  tickTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - recordStartTime) / 1000);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('recorder:tick', seconds);
    }
  }, 1000);

  // ⑤ 最长录制时间保护
  timeoutTimer = setTimeout(() => {
    console.log('[recorder] 达到最大录制时长 2 小时，自动停止');
    void stop();
  }, MAX_RECORD_MS);

  console.log(`[recorder] 录制开始，sessionId=${sessionId}，roomId=${roomId}`);
}

async function stop(): Promise<void> {
  if (!isRecording() && !isUserStopped) return;
  if (isUserStopped) return;

  const durationSeconds = Math.floor((Date.now() - recordStartTime) / 1000);
  isUserStopped = true;
  const sessionTmpDir = tmpDir;
  const displayName = `自动录制 ${new Date().toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).replace(/\//g, '-')}`;

  // ① 停止录制层（FFmpeg）
  await stopRecording();

  // ② 停止转码层监听（chokidar 关闭，但转码队列继续处理已入队切片）
  await stopTranscodingWatcher();

  // ②.5 等待转码队列排空（确保所有原始切片都被转码为 _opt.ts）
  await waitForTranscodeQueue();

  // ③ 补传临时目录中遗漏的切片
  enqueueMissingFiles(sessionTmpDir);

  // ④ 等待上传队列完全排空（串行队列中的所有切片上传完毕）
  await waitForUploadQueue();
  // 确保在途上传也完成
  await Promise.allSettled(Array.from(getActiveUploads()));

  // ⑤ 检查 pendingQueue 积压量
  const pendingCount = getPendingQueue().length;
  let persisted = pendingCount > STOP_PENDING_THRESHOLD;

  if (persisted) {
    // 积压过多：持久化，不等待
    persistRecording(
      sessionId, currentRoomId, sessionTmpDir,
      getPendingQueue(), getSegmentKeys(),
      displayName, durationSeconds, apiOrigin, currentAuthToken,
    );
    console.log(`[recorder] pendingQueue=${pendingCount} > 阈值 ${STOP_PENDING_THRESHOLD}，已持久化，不调 finish`);
  } else if (pendingCount > 0) {
    // 少量积压（≤5）：等待排空
    console.log(`[recorder] pendingQueue=${pendingCount} ≤ 阈值 ${STOP_PENDING_THRESHOLD}，等待上传排空`);
    await flushPendingQueue(2);

    // flush 后残余切片也持久化，防止 cleanupUploader 清空后丢失
    const remaining = getPendingQueue().length;
    if (remaining > 0) {
      console.log(`[recorder] flush 后仍有 ${remaining} 片未上传，持久化残余切片`);
      persistRecording(
        sessionId, currentRoomId, sessionTmpDir,
        getPendingQueue(), getSegmentKeys(),
        displayName, durationSeconds, apiOrigin, currentAuthToken,
      );
      persisted = true;
    }
  }

  // ⑥ 调用 finish 接口（仅全传完时）
  if (!persisted && getSegmentKeys().length > 0) {
    try {
      const response = await net.fetch(
        `${apiOrigin}/api/rooms/${currentRoomId}/recording/finish`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(currentAuthToken ? { 'Authorization': `Bearer ${currentAuthToken}` } : {}),
          },
          body: JSON.stringify({
            segmentKeys: getSegmentKeys(),
            displayName,
            durationSeconds,
          }),
          duplex: 'half',
        } as RequestInit,
      );

      if (!response.ok) {
        console.error(`[recorder] finish 接口失败：HTTP ${response.status}`);
      } else {
        console.log('[recorder] finish 接口调用成功');
      }
    } catch (err) {
      console.error('[recorder] finish 接口异常：', (err as Error).message);
    }
  } else if (!persisted) {
    console.warn('[recorder] 无可用切片，跳过 finish 接口');
  }

  // ⑦ 清理临时目录
  fs.rm(sessionTmpDir, { recursive: true, force: true }, (err) => {
    if (err) console.warn('[recorder] 临时目录清理失败：', err.message);
    else console.log('[recorder] 临时目录已清理：', sessionTmpDir);
  });

  // ⑧ 清理上传层状态
  cleanupUploader();

  // ⑩ 重置状态
  sessionId = '';
  tmpDir = '';
  currentRoomId = '';
  currentAuthToken = '';
  crashRestartCount = 0;

  // 清理定时器
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
  if (timeoutTimer !== null) { clearTimeout(timeoutTimer); timeoutTimer = null; }

  console.log(`[recorder] 录制结束，时长 ${formatDuration(durationSeconds)}`);
}

// ─── crash 处理 ───────────────────────────────────────────────────────────────

async function handleFfmpegCrash(displayTitle: string): Promise<void> {
  if (isUserStopped) return;

  // 窗口录制：先检查目标窗口是否还存在
  if (currentSourceId.startsWith('window:')) {
    const alive = await checkWindowAlive(currentSourceId);
    if (!alive) {
      console.log('[recorder] 窗口录制目标已消失，ffmpeg crash 属预期行为，触发优雅停止');
      void stop();
      return;
    }
  }

  crashRestartCount++;
  if (crashRestartCount > 3) {
    console.error(`[recorder] ffmpeg 已连续崩溃 ${crashRestartCount} 次，放弃重启`);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('recorder:error', { reason: 'ffmpeg 持续崩溃，录制已终止' });
    }
    return;
  }

  console.warn(`[recorder] ffmpeg 进程异常退出，第 ${crashRestartCount} 次重启续录...`);

  // 等待当前上传完成
  await Promise.allSettled(Array.from(getActiveUploads()));

  if (isUserStopped) return;

  // 重启录制层（-start_number 会自动从已有切片序号续接，不会覆盖）
  await restartRecording(displayTitle);

  // 转码层 watcher 无需重启——它一直在监听同一个 tmpDir。
  // 只需补扫 crash 期间可能遗漏的原始切片（chokidar awaitWriteFinish 可能漏掉崩溃时的半成品）。
  enqueueExistingRawFiles(tmpDir);
}

// ─── IPC 注册 ─────────────────────────────────────────────────────────────────

export function registerRecorderHandlers(): void {
  ipcMain.handle('recorder:detectEncoder', async () => {
    try {
      return await detectEncoder();
    } catch (err) {
      console.error('[recorder] detectEncoder 异常：', (err as Error).message);
      return { encoder: 'libx264', isSoftware: true };
    }
  });

  ipcMain.handle('recorder:getSources', async () => {
    try {
      return await getSources();
    } catch (err) {
      console.error('[recorder] getSources 异常：', err instanceof Error ? err.message : String(err));
      return [];
    }
  });

  ipcMain.handle('recorder:start', async (
    _event,
    windowId: string,
    displayTitle: string,
    roomId: string,
    authToken: string,
  ) => {
    try {
      await start(windowId, displayTitle, roomId, authToken);
    } catch (err) {
      console.error('[recorder] start 异常：', (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle('recorder:stop', async () => {
    try {
      await stop();
    } catch (err) {
      console.error('[recorder] stop 异常：', (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle('recorder:getPendingRecordings', async () => {
    return listPendingRecordings();
  });

  ipcMain.handle('recorder:resumePending', async (_event, sid: string, authToken: string) => {
    await resumeUpload(sid, authToken);
  });

  ipcMain.handle('auth:setToken', (_event, token: string) => {
    setAuthTokenForRecorder(token);
  });
}
