/**
 * Electron 实时录制主进程处理器（协调层）
 *
 * 职责（重构后）：
 *   - 编码器检测（h264_nvenc → h264_amf → h264_qsv → libx264 兜底）
 *   - 窗口/整屏列表获取
 *   - 协调两层：recording / upload（window/screen 均走 window_capture.exe 直出 HLS）
 *   - 录制开始/停止生命周期管理
 *   - 切片文件监听（chokidar 监听成品 .ts → upload）
 *   - 录制结束调用 /recording/finish 接口
 *
 * 两层架构：
 *   recording/  → window_capture.exe 录制（WGC+NVENC+HLS 一体），管理临时目录
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
import chokidar from 'chokidar';
import { app, desktopCapturer, dialog, ipcMain, BrowserWindow, net } from 'electron';
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
  type RecordingCallbacks,
} from './recording';

import { startSentinel, stopSentinel } from './sentinel-client';

import { makeDefaultProfiles } from './recording/profiles';

import { HLS_SEGMENT_DURATION } from './shared';

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
  getAuthToken,
} from './upload';

import {
  persistRecording,
  listPendingRecordings,
  resumeUpload,
} from './persistence';

import {
  startExternalTranscode,
  stopExternalTranscode,
  getExternalTranscodeState,
} from './external-transcode';
import type { ExternalTranscodeProgress } from '../../../src/types/recorder';

// ─── 监听模式（文件夹自动转码上传）：IPC 注册从此文件拆出，避免继续膨胀 ──────────
import { registerWatchHandlers } from './watch-mode/ipc';

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
/** 后端 origin，由 main.ts 通过 setApiOrigin 注入 */
let apiOrigin = 'http://localhost:3002';
/** 检测到的编码器 */
let detectedEncoder = 'libx264';
/** 是否为软件编码 */
let isSoftwareEncoder = false;
/** 外部视频转码进行中标志，与录制互斥 */
let isExternalTranscoding = false;
/** 仅录制模式标志：true 时跳过上传、切片持久化到本地 recordings 目录（停止不删） */
let isRecordOnly = false;

// ─── sentinel（窗口哨兵）接线状态 ───────────────────────────────────────────────
/** 本录制会话中 sentinel 是否处于活动状态（仅 window: 源为 true）。 */
let sentinelActive = false;
/** recording 管道是否已拉起（区分 in-flight 暂停状态）。 */
let recordingLaunched = false;

/** window 模式成品切片上传监听（替代 transcode 层，直接进 upload）。 */
let windowUploadWatcher: chokidar.FSWatcher | null = null;

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
  recordOnly: boolean = false,
  rcMode: 'cqp' | 'cbr' | 'vbr_ceil' = 'vbr_ceil',
  resolution: '720p' | '900p' = '720p',
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
  recordStartTime = Date.now();
  recordingLaunched = false;
  sentinelActive = false;
  isRecordOnly = recordOnly;

  // 创建目录：仅录制 → userData/recordings（停止保留）；否则 temp/cowatch-rec（停止删除）
  if (recordOnly) {
    const recDir = path.join(app.getPath('userData'), 'recordings', sessionId);
    fs.mkdirSync(recDir, { recursive: true });
    tmpDir = recDir;
    console.log(`[recorder] 仅录制模式，持久化目录：${tmpDir}`);
  } else {
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
  }

  // recording 层回调（crash / stop 透传）
  const recordingCallbacks: RecordingCallbacks = {
    onCrash: (title) => { void handleFfmpegCrash(title); },
    onShouldStop: () => { void stop(); },
    onLog: (msg) => console.log(msg),
  };

  // ─── mode 分支 ────────────────────────────────────────────────────────────
  if (currentSourceId.startsWith('window:')) {
    // window 模式（方案2a 终态）：
    //   sentinel 负责窗口事件探测（与捕获源解耦），recording 层 spawn window_capture.exe
    //   （内嵌 HLS 封装，直接写本地 .ts 切片），成品 sessionN.ts 直接进 upload（无 transcode）。
    //   sourceId 形如 window:<HWND十进制>[:suffix]，中段即目标窗口 HWND（主契约）。
    sentinelActive = true;
    const hwnd = windowId.split(':')[1];
    startSentinel(hwnd, {
      onNotFound: () => { /* 由 exe 兜底或 sentinel 触发停止，无需此处动作 */ },
      onStop: (reason) => {
        console.log(`[recorder] sentinel 请求停止（${reason}），执行干净收尾`);
        BrowserWindow.getAllWindows().forEach((w) => {
          w.webContents.send('recorder:stopped');
        });
        void stop();
      },
      onExit: (code) => {
        console.log(`[recorder] sentinel 退出，code=${code}`);
      },
      onLog: (msg) => console.log(msg),
    });

    // recording 层：spawn exe + 等 READY（exe 内一体编码+封装，直接写本地 HLS .ts）
    const profiles = makeDefaultProfiles(detectedEncoder, tmpDir, hwnd, 30);
    await startRecording(
      {
        sessionId,
        sourceId: windowId,
        displayTitle,
        tmpDir,
        detectedEncoder,
        isSoftwareEncoder,
        windowCapture: {
          capture: profiles.capture,
          encode: profiles.encode,
          mux: profiles.mux,
          audio: true,
          muxTarget: 'file', // 生产态：exe 内 ffmpeg_muxer 直接写本地 HLS .ts
          stats: false,
          rcMode,
          resolution,
          captureMode: 'window',
        },
      },
      recordingCallbacks,
    );
    recordingLaunched = true;

    // window 模式：直接监听 tmpDir 成品切片进 upload（无 transcode 层）
    // 仅录制模式跳过上传监听与上传层初始化，仅保留本地切片
    if (!recordOnly) {
      startWindowUploadWatcher(tmpDir, recordingCallbacks);

      // ③ 启动上传层
      initUploader(
        { roomId, sessionId, authToken, apiOrigin },
        { onProgress: () => pushProgress(), onLog: (msg) => console.log(msg) },
      );
    }

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

    console.log(`[recorder] window 模式录制开始，sessionId=${sessionId}`);
    return;
  }

  // screen 模式：复用 window_capture.exe（--capture-mode screen，无 hwnd），直出 HLS → upload（无 transcode）
  const profiles = makeDefaultProfiles(detectedEncoder, tmpDir, undefined, 30);
  await startRecording(
    {
      sessionId,
      sourceId: windowId,
      displayTitle,
      tmpDir,
      detectedEncoder,
      isSoftwareEncoder,
      windowCapture: {
        capture: profiles.capture,
        encode: profiles.encode,
        mux: profiles.mux,
        audio: true,
        muxTarget: 'file',
        stats: false,
        rcMode,
        resolution,
        captureMode: 'screen',
      },
    },
    recordingCallbacks,
  );
  recordingLaunched = true;

  // screen 模式：直接监听 tmpDir 成品切片进 upload（与 window 模式一致，无 transcode 层）
  // 仅录制模式跳过上传监听与上传层初始化，仅保留本地切片
  if (!recordOnly) {
    startWindowUploadWatcher(tmpDir, recordingCallbacks);

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
  }

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
  if (isUserStopped) return;                         // 重入保护：已停止则直接返回
  if (!recordingLaunched && !sentinelActive) return; // 无活跃会话则无需停止（不依赖 isRecording，避免 in-flight pause 误判）

  const durationSeconds = Math.floor((Date.now() - recordStartTime) / 1000);
  isUserStopped = true;

  // 停止哨兵进程（window: 源录制时由 sentinel 监听窗口移动 / 关闭）
  if (sentinelActive) {
    stopSentinel();
    sentinelActive = false;
  }

  const sessionTmpDir = tmpDir;
  const displayName = `自动录制 ${new Date().toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).replace(/\//g, '-')}`;

  // ① 停止录制层（window/screen: window_capture.exe）
  await stopRecording();

  // window 模式：停止成品切片上传监听（无 transcode 层）
  await stopWindowUploadWatcher();

  if (!isRecordOnly) {
    // ③ 补传临时目录中遗漏的切片
    enqueueMissingFiles(sessionTmpDir);

    // ④ 等待上传队列完全排空（串行队列中的所有切片上传完毕）
    await waitForUploadQueue();
    // 确保在途上传也完成
    await Promise.allSettled(Array.from(getActiveUploads()));

    // 同步上传层自刷新的 token：上传层遇 401 会调用 refreshTokenFromMainProcess() 更新
    // config.authToken，但模块级 currentAuthToken 不会自动跟随；若不在此同步，token 中途过期时
    // persistRecording / finish 仍用过期 token → HTTP 401 → 播放列表丢失。
    const freshToken = getAuthToken();
    if (freshToken) currentAuthToken = freshToken;
  } else {
    console.log('[recorder] 仅录制模式：跳过上传队列等待 / 补传切片');
  }

  // ⑤ 检查 pendingQueue 积压量
  const pendingCount = isRecordOnly ? 0 : getPendingQueue().length;
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

  // ⑥ 调用 finish 接口（仅全传完时；仅录制模式跳过）
  if (!isRecordOnly && !persisted && getSegmentKeys().length > 0) {
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
  } else if (!isRecordOnly && !persisted) {
    console.warn('[recorder] 无可用切片，跳过 finish 接口');
  } else if (isRecordOnly) {
    console.log('[recorder] 仅录制模式：跳过 finish 接口');
  }

  // ⑦ 清理临时目录（仅录制模式保留本地目录，不删除）
  if (isRecordOnly) {
    console.log(`[recorder] 仅录制模式，保留本地录制目录不删除：${sessionTmpDir}`);
  } else {
    fs.rm(sessionTmpDir, { recursive: true, force: true }, (err) => {
      if (err) console.warn('[recorder] 临时目录清理失败：', err.message);
      else console.log('[recorder] 临时目录已清理：', sessionTmpDir);
    });
  }

  // ⑧ 清理上传层状态
  cleanupUploader();

  // ⑩ 重置状态
  sessionId = '';
  tmpDir = '';
  currentRoomId = '';
  currentAuthToken = '';
  crashRestartCount = 0;
  recordingLaunched = false;
  sentinelActive = false;
  isRecordOnly = false;

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
}

// ─── window 模式成品切片上传监听（替代 transcode 层，直接进 upload）─────────────────

/**
 * 启动 chokidar 监听 tmpDir，window_capture.exe 内嵌 ffmpeg_muxer 直接写出的 sessionN.ts
 * 成品切片（HLS 切片）直接 enqueueUpload，完全绕过逐片 transcode 层
 * （方案2a 终态编码已在 exe 内一体完成、输出即压缩 HLS 切片）。
 *
 * 仅匹配 `.ts` 切片（排除 .m3u8 播放列表）；index.m3u8 与半成品由 stop 时的
 * enqueueMissingFiles 兜底。ignoreInitial=true 确保不重复拾取已存在文件；
 * awaitWriteFinish 避免拾取半写切片。
 *
 * @param dir  监听目录（录制临时目录，= exe 的 --out 所在目录）
 * @param _cbs 透传录制回调（保留签名一致性，本函数不直接使用）
 */
function startWindowUploadWatcher(dir: string, _cbs?: RecordingCallbacks): void {
  if (windowUploadWatcher) {
    void windowUploadWatcher.close();
    windowUploadWatcher = null;
  }
  windowUploadWatcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  windowUploadWatcher.on('add', (filePath: string) => {
    if (/\.ts$/.test(filePath) && !filePath.endsWith('.m3u8')) {
      enqueueUpload(filePath);
    }
  });
  windowUploadWatcher.on('error', (err: Error) => {
    console.warn(`[recorder] window upload watcher 异常：${err.message}`);
  });
  console.log(`[recorder] window 成品切片监听已启动：${dir}`);
}

/**
 * 停止并释放 window 模式成品切片监听。
 */
async function stopWindowUploadWatcher(): Promise<void> {
  if (windowUploadWatcher) {
    const w = windowUploadWatcher;
    windowUploadWatcher = null;
    try {
      await w.close();
    } catch (err) {
      console.warn(`[recorder] window upload watcher 关闭异常：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── 外部视频转码 ──────────────────────────────────────────────────────────────

async function selectVideoFiles(): Promise<{ cancelled: boolean; filePaths: string[] }> {
  const result = await dialog.showOpenDialog({
    title: '选择要转码的视频文件',
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return { cancelled: result.canceled, filePaths: result.filePaths };
}

export async function startExternalVideoTranscode(
  roomId: string,
  authToken: string,
  inputPath: string,
): Promise<{ error?: string }> {
  if (isRecording() || isExternalTranscoding) {
    return { error: '录制或转码已在进行中' };
  }
  // [phase2] modeGuard() 校验：四种录制/转码模式互斥入口（本期不实现，仅留口子）
  isExternalTranscoding = true;

  // ② 创建临时目录
  const extSessionId = uuidv4();
  const extTmpDir = path.join(app.getPath('temp'), 'cowatch-ext', extSessionId);
  fs.mkdirSync(extTmpDir, { recursive: true });

  // ③ 初始化上传层
  initUploader(
    { roomId, sessionId: extSessionId, authToken, apiOrigin, disableThrottle: true },
    {
      onProgress: () => pushExternalProgress(),
      onLog: (msg) => console.log(msg),
    },
  );

  // ④ 启动转码
  startExternalTranscode(
    {
      inputPath,
      outputDir: extTmpDir,
      detectedEncoder,
      isSoftwareEncoder,
    },
    {
      onSegmentReady: (filePath) => enqueueUpload(filePath),
      onProgress: () => pushExternalProgress(),
      onComplete: () => void handleExternalTranscodeComplete(extSessionId, extTmpDir, roomId, authToken),
      onError: (msg) => {
        console.error(`[recorder] 外部转码失败：${msg}`);
        void handleExternalTranscodeError(extSessionId, extTmpDir, msg);
      },
      onLog: (msg) => console.log(msg),
    },
  );

  return {};
}

function pushExternalProgress(): void {
  const { active } = getExternalTranscodeState();
  const info: ExternalTranscodeProgress = {
    phase: active ? 'transcoding' : 'uploading',
    uploaded: getUploadedCount(),
    estimated: -1,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:transcodeExternal:progress', info);
  }
}

async function handleExternalTranscodeComplete(
  extSessionId: string,
  extTmpDir: string,
  roomId: string,
  authToken: string,
): Promise<void> {
  // 等待上传排空
  await waitForUploadQueue();
  await Promise.allSettled(Array.from(getActiveUploads()));

  // 调用 finish 接口
  const keys = getSegmentKeys();
  if (keys.length > 0) {
    try {
      const response = await net.fetch(
        `${apiOrigin}/api/rooms/${roomId}/recording/finish`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            segmentKeys: keys,
            displayName: `外部视频 ${new Date().toLocaleString('zh-CN')}`,
            durationSeconds: keys.length * HLS_SEGMENT_DURATION,
          }),
          duplex: 'half',
        } as RequestInit,
      );

      if (!response.ok) {
        console.error(`[recorder] 外部转码 finish 接口失败：HTTP ${response.status}`);
      }
    } catch (err) {
      console.error('[recorder] 外部转码 finish 接口异常：', (err as Error).message);
    }
  }

  // 推送完成事件
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:transcodeExternal:progress', {
      phase: 'completed' as const,
      uploaded: getUploadedCount(),
      estimated: getUploadedCount(),
    });
  }

  // 清理
  cleanupUploader();
  isExternalTranscoding = false;
  fs.rm(extTmpDir, { recursive: true, force: true }, (err) => {
    if (err) console.warn('[recorder] 外部转码临时目录清理失败：', err.message);
  });

  // [watch-mode] 任务完成：下游由渲染端既有进度/完成链路处理，无需额外钩子
}

async function handleExternalTranscodeError(
  _extSessionId: string,
  extTmpDir: string,
  errorMsg: string,
): Promise<void> {
  cleanupUploader();
  isExternalTranscoding = false;
  fs.rm(extTmpDir, { recursive: true, force: true }, () => {
    // best-effort cleanup
  });

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:transcodeExternal:progress', {
      phase: 'failed' as const,
      uploaded: 0,
      estimated: -1,
    });
  }

  // [watch-mode] 任务失败：下游由渲染端既有进度/失败链路处理
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
    recordOnly?: boolean,
    rcMode?: 'cqp' | 'cbr' | 'vbr_ceil',
    resolution?: '720p' | '900p',
  ) => {
    try {
      await start(windowId, displayTitle, roomId, authToken, recordOnly ?? false, rcMode ?? 'vbr_ceil', resolution ?? '720p');
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

  ipcMain.handle('recorder:selectVideoFiles', async () => {
    return selectVideoFiles();
  });

  ipcMain.handle('recorder:transcodeExternal', async (
    _event,
    roomId: string,
    authToken: string,
    filePath: string,
  ) => {
    try {
      return await startExternalVideoTranscode(roomId, authToken, filePath);
    } catch (err) {
      console.error('[recorder] transcodeExternal 异常：', (err as Error).message);
      return { error: (err as Error).message || '转码启动失败' };
    }
  });

  ipcMain.handle('recorder:transcodeExternal:cancel', async () => {
    try {
      await stopExternalTranscode();
      cleanupUploader();
      isExternalTranscoding = false;
    } catch (err) {
      console.error('[recorder] transcodeExternal:cancel 异常：', (err as Error).message);
    }
  });

  // ─── 监听模式（文件夹自动转码上传）IPC（从本文件拆出，避免继续膨胀）──
  registerWatchHandlers();
}
