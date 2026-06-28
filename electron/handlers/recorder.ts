/**
 * Electron 实时录制主进程处理器
 *
 * 职责：
 *   - 编码器检测（h264_nvenc → h264_amf → h264_qsv → libx264 兜底）
 *   - 窗口/整屏列表获取
 *   - ffmpeg HLS 录制生命周期管理（start / stop / crash 自动重启）
 *   - 切片文件监听 + 上传到后端（后端再转存 COS）
 *   - 录制结束调用 /recording/finish 接口
 *
 * 切片上传流程（双队列容错架构）：
 *   ffmpeg 生成 seg*.ts → chokidar add → uploadSegment（fire-and-forget）
 *     → doUpload（pRetry 4 次）
 *       ├─ 成功：更新 segmentKeys / 删除临时文件
 *       └─ 全败：推入 pendingQueue
 *   retryTimerRef（setInterval 30s）→ isRetryScheduled 互斥 → triggerRetryQueue
 *     → 指数退避（10s→20s→40s→80s→160s）+ 批量补录（最多 RETRY_BATCH 片）
 *     → 连续全败 MAX_FAIL_ROUNDS 轮（质：网络不可用）或 积压 MAX_PENDING 片（量：速率跟不上）→ abortRecording
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
import { spawn, ChildProcess } from 'child_process';

import { app, desktopCapturer, ipcMain, net, BrowserWindow } from 'electron';
import ffmpegPath from 'ffmpeg-static';
import chokidar, { FSWatcher } from 'chokidar';
import pRetry from 'p-retry';
import { v4 as uuidv4 } from 'uuid';

import type { RecorderSource, EncoderDetectResult, RecordingProgress } from '../../src/types/recorder';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 每个 HLS 切片的目标时长（秒）——与后端 hlsService.ts 保持一致 */
const HLS_SEGMENT_DURATION = 10;

/** 最长录制时长（毫秒），到时自动停止 */
const MAX_RECORD_MS = 2 * 60 * 60 * 1000;

/**
 * doUpload 内 pRetry 重试次数（1+1=2 次）。
 * 首次上传只处理瞬时抖动（1s 间隔），持续故障快速失败进 pendingQueue，
 * 交由 triggerRetryQueue 的指数退避兜底，避免 4 次重试最坏阻塞 ~15s。
 * 两路合计重试能力不减弱：triggerRetryQueue 里 doUpload 同样 pRetry。
 */
const UPLOAD_MAX_RETRIES = 1;

/** 补录队列：整批全败的连续轮次上限，超过则判定为持续不可用，触发 abortRecording */
const MAX_FAIL_ROUNDS = 5;
/**
 * 补录队列容量上限：网络可用但上传速率持续低于录制速率时触发 abortRecording。
 * 推导：ffmpeg 每 10s 一片，每个 setInterval 周期（30s）最多产生 3 片进入 pendingQueue。
 * 设定为 MAX_FAIL_ROUNDS × 3 = 15，语义：积压量等价于"5 轮周期内完全无消化"，
 * 与 reround 条件覆盖同一时间窗口（≈2.5 分钟），形成质量（reround）和数量（积压）的双保险。
 */
const MAX_PENDING = 15;
/** 每次补录最多处理的切片数（避免单次补录耗时过长） */
const RETRY_BATCH = 5;
/** 补录退避基础时间（ms），指数退避基准：10s, 20s, 40s, 80s, 160s */
const RETRY_BASE_MS = 10_000;

/** 编码器候选列表，依次探测，取第一个可用的 */
const ENCODER_CANDIDATES = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'] as const;

// ─── 模块级录制状态 ───────────────────────────────────────────────────────────

/** 当前会话 ID，录制开始时生成，结束后清空 */
let sessionId = '';
/** 录制临时目录（存放 ffmpeg 生成的 seg*.ts 和 index.m3u8） */
let tmpDir = '';
/** 当前 ffmpeg 子进程 */
let ffmpegProcess: ChildProcess | null = null;
/** 已上传成功的 objectKey 列表（有序） */
let segmentKeys: string[] = [];
/**
 * 补录队列：pRetry 全败后入队，等待 triggerRetryQueue 补传。
 * 替代原 pendingSegments，配合双队列容错架构。
 */
let pendingQueue: string[] = [];
/** 已上传切片数量，用于 crash 重启时的 -hls_start_number */
let uploadedCount = 0;
/** 正在进行中的上传 Promise 集合（用于 stop 时等待所有上传完成） */
const activeUploads = new Set<Promise<void>>();
/** 已入队上传的文件名集合（用于 stop 时去重扫描） */
const queuedFileNames = new Set<string>();
/** 计时器：每秒推 recorder:tick */
let tickTimer: ReturnType<typeof setInterval> | null = null;
/** 定时器：最长录制时间到后自动停止 */
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 补录定时器：每 30s 由 setInterval 检查，若 isRetryScheduled=false 则触发 triggerRetryQueue。
 * isRetryScheduled 互斥判断前置在 setInterval 回调里（不在 triggerRetryQueue 内部），
 * 保证退避期间不被外部时钟打断。
 */
let retryTimerRef: ReturnType<typeof setInterval> | null = null;
/**
 * 补录队列互斥锁：triggerRetryQueue 运行期间（含退避等待）置为 true。
 * setInterval 回调检查此标志，为 true 时直接跳过，不重复触发。
 */
let isRetryScheduled = false;
/**
 * 补录整批全败的连续轮次计数。
 * 有任意一片成功即归零（代表网络可用只是不稳定）。
 * 达到 MAX_FAIL_ROUNDS 时触发 abortRecording。
 */
let consecutiveFailRounds = 0;
/** chokidar 文件监听器 */
let watcher: FSWatcher | null = null;
/** 用户主动停止标志，区分正常停止和 ffmpeg crash */
let isUserStopped = false;
/** ffmpeg crash 重启次数，超过上限后放弃重启 */
let crashRestartCount = 0;
/** crash 重启最大次数 */
const MAX_CRASH_RESTARTS = 3;
/** 录制开始时间戳（ms），用于计算时长 */
let recordStartTime = 0;
/** 当前房间 ID，上传和 finish 接口需要 */
let currentRoomId = '';
/**
 * 当前用户的 JWT AccessToken，上传接口鉴权用。
 *
 * 设计说明：
 *   渲染进程通过 auth:setToken IPC 主动推送 token，覆盖场景：
 *   1. 陆制开始时 → start() 传入当前 token
 *   2. token 无感刷新后 → 渲染进程调用 updateAuthToken(newToken)
 *   主进程不主动请求，始终使用最近一次推送的 token。
 */
let currentAuthToken = '';
/** 当前录制源 id（desktopCapturer source id，crash 重启时需要 */
let currentSourceId = '';
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

/**
 * 更新主进程持有的 JWT token。
 * 由 main.ts 在 token 刷新时调用（渲染进程通过 auth:setToken IPC 触发）。
 */
export function setAuthTokenForRecorder(token: string): void {
  currentAuthToken = token;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 获取 ffmpeg 可执行文件的实际路径。
 * 打包后，ffmpeg-static 的二进制会被 electron-builder 解包到 app.asar.unpacked，
 * 需要将路径中的 app.asar/ 替换为 app.asar.unpacked/。
 */
function getFfmpegPath(): string {
  // ffmpeg-static 在 webpack 打包后路径可能变为相对路径或被内联，
  // 需要用 require.resolve 或直接读 package.json 的 bin 字段定位。
  // 开发/preview 模式：ffmpegPath 是绝对路径（node_modules 下的二进制）
  // 打包后（isPackaged）：binary 被解包到 app.asar.unpacked
  let raw = ffmpegPath as string;

  // webpack 打包后 ffmpegPath 可能变成相对路径 './ffmpeg' 或 'ffmpeg'，
  // 此时需要基于项目根目录拼接真实路径
  if (!path.isAbsolute(raw)) {
    // 从 ffmpeg-static package.json 定位真实二进制
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require('ffmpeg-static/package.json') as { bin: string };
      raw = path.join(path.dirname(require.resolve('ffmpeg-static/package.json')), pkg.bin);
    } catch {
      // 兜底：尝试系统 PATH 中的 ffmpeg
      raw = 'ffmpeg';
    }
  }

  if (app.isPackaged) {
    return raw.replace('app.asar', 'app.asar.unpacked');
  }
  return raw;
}

/**
 * 推送进度事件到所有渲染进程窗口。
 */
function pushProgress(): void {
  const info: RecordingProgress = {
    uploaded: uploadedCount,
    pending: pendingQueue.length,
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

/**
 * 依次探测 ENCODER_CANDIDATES，返回第一个可用的编码器。
 * 探测方式：用 lavfi null source 生成 1 秒视频，检查返回码。
 */
async function detectEncoder(): Promise<EncoderDetectResult> {
  const ffmpeg = getFfmpegPath();

  for (const encoder of ENCODER_CANDIDATES) {
    const result = await new Promise<boolean>((resolve) => {
      const proc = spawn(ffmpeg, [
        '-f', 'lavfi', '-i', 'nullsrc', '-t', '1',
        '-c:v', encoder, '-f', 'null', '-',
      ], { stdio: 'ignore' });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });

    if (result) {
      detectedEncoder = encoder;
      isSoftwareEncoder = encoder === 'libx264';
      console.log(`[recorder] 编码器检测完成：${encoder}，软编=${isSoftwareEncoder}`);
      return { encoder, isSoftware: isSoftwareEncoder };
    }
  }

  // 兜底：所有都失败时默认 libx264（通常不会到这里）
  detectedEncoder = 'libx264';
  isSoftwareEncoder = true;
  return { encoder: 'libx264', isSoftware: true };
}

// ─── 窗口列表 ──────────────────────────────────────────────────────────────────

/**
 * 获取可录制的窗口和整屏列表。
 *
 * macOS 注意事项：
 *   - 首次调用前用 systemPreferences.askForMediaAccess('screen') 主动请求授权，
 *     未授权时 desktopCapturer.getSources 会抛出 "Failed to get sources."
 *   - screen 类型 source 在独占全屏应用（游戏）场景下 thumbnail 可能为黑图，属正常行为
 *   - window 类型过滤掉 thumbnail 尺寸为 0 的条目（最小化窗口）
 */
async function getSources(): Promise<RecorderSource[]> {
  // macOS 注意：desktopCapturer.getSources 在权限未授予时抛出 "Failed to get sources."
  // 权限弹窗由系统在首次调用时自动弹出（需要进程重启后生效）
  // getMediaAccessStatus('screen') 对 Electron 裸进程无效，不做预检
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 256, height: 144 },
  });

  return sources
    .filter((s) => {
      // screen 类型始终保留（即使 thumbnail 为黑图，独占全屏场景下属正常）
      if (s.id.startsWith('screen:')) return true;
      // window 类型：过滤掉 thumbnail 为空或尺寸为 0 的条目（最小化窗口）
      return s.thumbnail && s.thumbnail.getSize().width > 0;
    })
    .map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : '',
      sourceType: (s.id.startsWith('screen:') ? 'screen' : 'window') as 'screen' | 'window',
    }));
}

// ─── 切片上传 ──────────────────────────────────────────────────────────────────

/**
 * 底层上传单个切片：发起 net.fetch + pRetry，成功 resolve，彻底失败时 reject。
 * 供 uploadSegment（录制流）和 triggerRetryQueue（补录流）共同调用。
 * 成功后自动删除本地临时文件。
 */
async function doUpload(filePath: string): Promise<void> {
  const segmentName = path.basename(filePath);
  const objectKey = `cowatch/${currentRoomId}/recordings/${sessionId}/${segmentName}`;

  await pRetry(
    async () => {
      const buffer = fs.readFileSync(filePath);
      // 15s 超时：防止后端宕机时 TCP 进入 TIME_WAIT 导致 fetch 永久 hang
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await net.fetch(
          `${apiOrigin}/api/rooms/${currentRoomId}/recording/segment`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'video/MP2T',
              'X-Object-Key': objectKey,
              ...(currentAuthToken ? { 'Authorization': `Bearer ${currentAuthToken}` } : {}),
            },
            body: buffer,
            duplex: 'half',
            signal: controller.signal,
          } as RequestInit,
        );
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        throw new Error(`上传失败 HTTP ${response.status}：${segmentName}`);
      }
    },
    {
      retries: UPLOAD_MAX_RETRIES,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 8000,
      randomize: true,
      onFailedAttempt: (ctx) => {
        console.warn(
          `[recorder] 切片上传失败，第 ${ctx.attemptNumber} 次：${segmentName}，错误：${ctx.error.message}`,
        );
      },
    },
  );

  // 上传成功：更新状态、删除临时文件
  segmentKeys.push(objectKey);
  uploadedCount = segmentKeys.length;
  fs.unlink(filePath, (err) => {
    if (err) console.warn('[recorder] 删除临时文件失败：', filePath, err.message);
  });
}

/**
 * 录制上传（fire-and-forget）。
 * chokidar 发现新切片时调用，上传失败时将文件路径推入 pendingQueue，不中断录制。
 * 职责：仅负责首次上传（pRetry 4 次），不感知补录队列。
 */
function uploadSegment(filePath: string): void {
  const segmentName = path.basename(filePath);
  queuedFileNames.add(segmentName);

  const uploadPromise = doUpload(filePath)
    .then(() => {
      pushProgress();
    })
    .catch(() => {
      // 4 次全部失败：进入补录队列等待 triggerRetryQueue 处理
      if (isUserStopped) return; // stop 之后不再入队（Bug 2 修复）
      console.error(`[recorder] 切片上传全部失败：${segmentName}，加入 pendingQueue`);
      if (pendingQueue.length >= MAX_PENDING) {
        // 积压超限：触发录制中止（不再入队，避免无限膨胀）
        void abortRecording('网络持续异常，切片积压过多');
        return;
      }
      pendingQueue.push(filePath);
      pushProgress();
    })
    .finally(() => {
      activeUploads.delete(uploadPromise);
    });

  activeUploads.add(uploadPromise);
}

/**
 * 补录队列执行函数（由 retryTimerRef 定时器调用）。
 * 互斥锁 isRetryScheduled 的判断由外部 setInterval 回调前置执行，
 * 本函数不重复判断，职责更单一。
 * 流程：终止判断 → 指数退避 → 批量补传 → 健康状态更新 → 释放锁。
 */
async function triggerRetryQueue(): Promise<void> {
  // isUserStopped 兜底（abortRecording 触发后退避期间 stop 可能介入）
  if (isUserStopped) return;
  // 无需补传：队列为空且无连续失败记录
  if (pendingQueue.length === 0 && consecutiveFailRounds === 0) return;

  // 终止条件判断（优先于退避逻辑）
  if (consecutiveFailRounds >= MAX_FAIL_ROUNDS || pendingQueue.length >= MAX_PENDING) {
    void abortRecording('网络持续异常，上传已中止');
    return;
  }

  isRetryScheduled = true;

  try {
    // 指数退避 + 随机抖动
    // consecutiveFailRounds=0（首次补录）时立即执行，无需等待
    const jitter = Math.random() * 2000;
    const backoffMs = consecutiveFailRounds === 0
      ? 0
      : Math.min(RETRY_BASE_MS * Math.pow(2, consecutiveFailRounds - 1), 160_000) + jitter;

    if (backoffMs > 0) {
      console.log(`[recorder] 补录退避 ${Math.round(backoffMs / 1000)}s（连续失败轮次：${consecutiveFailRounds}）`);
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }

    if (isUserStopped) return; // 退避期间用户停止录制，放弃补录

    // 取最多 RETRY_BATCH 片进行补录
    const batch = pendingQueue.splice(0, RETRY_BATCH);
    if (batch.length === 0) return;

    console.log(`[recorder] 开始补录 ${batch.length} 个切片（队列剩余：${pendingQueue.length}）`);

    let batchHasSuccess = false;
    for (const filePath of batch) {
      if (isUserStopped) break;
      try {
        await doUpload(filePath);
        batchHasSuccess = true;
        console.log(`[recorder] 补录成功：${path.basename(filePath)}`);
        pushProgress();
      } catch {
        // 本批次这片补录失败：重新推回队列头部（保持顺序）
        pendingQueue.unshift(filePath);
        console.warn(`[recorder] 补录失败（将重试）：${path.basename(filePath)}`);
      }
    }

    if (batchHasSuccess) {
      // 有任意一片成功 → 网络可用，重置失败轮次
      consecutiveFailRounds = 0;
    } else {
      // 整批全败 → 网络不可用，轮次 +1
      consecutiveFailRounds += 1;
      console.warn(`[recorder] 补录整批失败，连续失败轮次：${consecutiveFailRounds}/${MAX_FAIL_ROUNDS}`);
    }
  } finally {
    // 无论成功、失败或异常，都必须释放锁
    isRetryScheduled = false;
  }
}

/**
 * 录制异常中止（网络持续不可用 / 积压超限）。
 * 通知渲染进程 + 调用 cleanup 重置状态。
 * 注意：不等待 activeUploads，直接放弃未完成的上传。
 */
async function abortRecording(reason: string): Promise<void> {
  if (isUserStopped) return; // 已经在停止流程中，避免重复触发
  console.error(`[recorder] 录制中止：${reason}`);
  isUserStopped = true;

  // 通知渲染进程
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:error', { reason });
  }

  await cleanup();
}

/**
 * 统一清理所有录制资源（定时器 + ffmpeg + watcher + 状态重置）。
 * stop() 和 abortRecording() 均调用此函数。
 * 注意：tmpDir 清理与 finish 接口调用在 stop() 中单独处理，
 *       abortRecording 路径下不调用 finish（无需通知后端生成视频）。
 */
async function cleanup(): Promise<void> {
  // 清理定时器
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
  if (timeoutTimer !== null) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  if (retryTimerRef !== null) { clearInterval(retryTimerRef); retryTimerRef = null; }

  // 关闭文件监听
  if (watcher) { await watcher.close(); watcher = null; }

  // 停止 ffmpeg（若尚未停止）
  if (ffmpegProcess) {
    await new Promise<void>((resolve) => {
      if (process.platform === 'win32') {
        // Windows 上 SIGTERM 等于 SIGKILL（强杀进程导致末片截断），
        // 改用 stdin 写入 'q' 让 ffmpeg 优雅退出（flush 编码器缓冲区后关闭）。
        // 在 write 回调中 end，确保 'q' 字符已刷入管道再关闭 stdin
        ffmpegProcess!.stdin?.write('q', () => {
          ffmpegProcess!.stdin?.end();
        });
      } else {
        ffmpegProcess!.kill('SIGTERM');
      }
      ffmpegProcess!.on('close', () => resolve());
      setTimeout(() => {
        try { ffmpegProcess?.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
        resolve();
      }, 15000);
    });
    ffmpegProcess = null;
  }

  // 重置业务状态（tmpDir 由调用方负责清理目录后再重置）
  pendingQueue = [];
  consecutiveFailRounds = 0;
  isRetryScheduled = false;
  activeUploads.clear();
  queuedFileNames.clear();
}

// ─── ffmpeg 启动 ──────────────────────────────────────────────────────────────

/**
 * 构造并启动 ffmpeg 进程，写入 tmpDir。
 *
 * @param displayTitle   窗口标题（Windows gdigrab 使用）
 * @param startNumber    -hls_start_number，crash 重启时传入已上传数量
 */
function spawnFfmpeg(sourceId: string, displayTitle: string, startNumber = 0): ChildProcess {
  const ffmpeg = getFfmpegPath();
  // 软编降分辨率：854x480；硬编正常档：1600x900
  const resolution = isSoftwareEncoder ? '854x480' : '1600x900';
  // ffmpeg 在所有平台上都能正确解析正斜杠路径；
  // Windows path.join 生成反斜杠，部分 ffmpeg 版本（静态构建）可能将 \s \U 等误解析为转义序列
  const segPattern = path.join(tmpDir, 'seg%03d.ts').replace(/\\/g, '/');
  const m3u8Path = path.join(tmpDir, 'index.m3u8').replace(/\\/g, '/');

  // ── 平台差异：输入源参数 ─────────────────────────────────────────────────
  // Windows：gdigrab 通过窗口标题捕获
  // macOS：avfoundation 通过 desktopCapturer source id（格式 "screen:N:M" 或 "window:N:M"）
  //        avfoundation 设备索引：视频设备从 "Capture screen N" 取索引，音频设备用 none
  let inputArgs: string[];
  if (process.platform === 'darwin') {
    // sourceId 格式：'screen:0:0' 或 'window:12345:0'
    // avfoundation 设备布局（macOS）：
    //   [0] FaceTime 摄像头（始终占据索引 0）
    //   [1] Capture screen 0（主屏，对应 desktopCapturer screenId 中序号 0）
    //   [2] Capture screen 1（第二屏，对应序号 1）
    // 因此：avfoundation 索引 = desktopCapturer 屏幕序号 + 1
    // 窗口录制（window: 前缀）降级为主屏（avfoundation 不支持按窗口 id 捕获）
    const screenSeq = sourceId.startsWith('screen:')
      ? parseInt(sourceId.split(':')[1] ?? '0', 10)
      : 0;
    const avfIndex = screenSeq + 1; // 跳过摄像头占据的 [0]
    inputArgs = [
      '-f', 'avfoundation',
      '-framerate', '30',
      '-capture_cursor', '1',
      '-i', `${avfIndex}:none`, // 视频设备:音频设备，none 表示不录音
    ];
  } else {
    // Windows：ddagrab（Desktop Duplication API）
    //
    // 为什么不用 gdigrab：
    //   gdigrab 使用 GDI BitBlt（纯 CPU），每帧拷贝整个显存到系统内存，
    //   30fps 下 CPU 占用 ~20% 单核，且 BitBlt 会阻塞 GPU 渲染管线导致游戏卡顿。
    //   窗口模式（title=）对 DXGI 独占的游戏窗口匹配不可靠。
    //
    // ddagrab 的优势：
    //   基于 Windows Desktop Duplication API（DXGI），GPU 直接读取显存帧缓冲，
    //   CPU 开销 ≈0，不阻塞游戏渲染。窗口模式通过 DDA API 锁定窗口对象句柄，
    //   自动跟踪窗口移动/缩放，无需手动 crop。
    //
    // 兼容性要求：Windows 8.1+ / Win10 1803+，DX11 显卡驱动（游戏电脑均满足）
    if (sourceId.startsWith('screen:')) {
      inputArgs = ['-f', 'ddagrab', '-framerate', '30', '-i', '0'];
    } else {
      const safeTitle = displayTitle.replace(/"/g, '\\"');
      inputArgs = ['-f', 'ddagrab', '-framerate', '30', '-window_title', safeTitle, '-i', '0'];
    }
  }

  // ── 编码参数 ─────────────────────────────────────────────────────────────
  // 质量基准：游戏录屏（高动态）场景，软编 CRF 28 为保底质量标准。
  //
  // 软编（libx264）：
  //   -crf 28：恒定质量模式，游戏场景保底画质，动态画面自动升码率
  //   -preset veryfast：实时录制必须用快速 preset，medium 及以上会导致 CPU 过高积压掉帧
  //
  // 硬编：各引擎均使用"质量优先"模式，而非固定码率 VBR。
  //   原因：固定码率会导致静止帧浪费码率、动态场景画质下降（块状失真）。
  //   目标场景：游戏录屏（高动态），对标软编 CRF 28（保底）的视觉质量。
  //   -maxrate 5000k -bufsize 10000k：为游戏高动态瞬间留足峰值空间，防止块状失真。
  //
  //   h264_nvenc：-rc vbr -cq 28
  //     CQ（Constant Quality）是 nvenc 唯一的质量恒定模式，CQ 28 ≈ libx264 CRF 28
  //     必须配合 -b:v 0 让编码器自由分配码率
  //
  //   h264_qsv：-global_quality 28 -look_ahead 1
  //     QSV 的质量参数，功能等同于 CRF；look_ahead 开启前向参考，稍微提升编码效率
  //
  //   h264_amf：-quality quality -b:v 0
  //     AMF 无 CQ 模式，-quality quality 指定质量优先策略，放开目标码率让其自行分配
  let encodeArgs: string[];
  if (isSoftwareEncoder) {
    encodeArgs = ['-c:v', detectedEncoder, '-crf', '28', '-preset', 'veryfast'];
  } else if (detectedEncoder === 'h264_nvenc') {
    encodeArgs = ['-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', '28', '-b:v', '0', '-maxrate', '5000k', '-bufsize', '10000k'];
  } else if (detectedEncoder === 'h264_qsv') {
    encodeArgs = ['-c:v', 'h264_qsv', '-global_quality', '28', '-look_ahead', '1', '-b:v', '0', '-maxrate', '5000k', '-bufsize', '10000k'];
  } else {
    // h264_amf 及其他未知硬编，使用质量优先 VBR
    encodeArgs = ['-c:v', detectedEncoder, '-quality', 'quality', '-b:v', '0', '-maxrate', '5000k', '-bufsize', '10000k'];
  }

  // macOS avfoundation 屏幕捕获的帧 PTS 全部相同（差值=0），
  // 导致每帧 duration=0，编码器输出的时间戳全部错误，播放器显示 0:00。
  //
  // 修复方案（macOS 专用，仅影响 darwin 分支）：
  //   -vf fps=30
  //     通过 fps filter 重新生成 PTS：完全丢弃 avfoundation 提供的原始 PTS，
  //     按 30fps 均匀重新分配时间戳（第 0 帧=0, 第 1 帧=1/30, 第 2 帧=2/30 ...）。
  //     这是 avfoundation 屏幕录制的标准处理方式，等价于 OBS 的 "Use CFR" 选项。
  //
  //   -bf 0
  //     禁用 B 帧，使编码器输出的 DTS 严格等于 PTS，消除 HLS muxer 的 DTS 不单调警告。
  //     屏幕录制场景下 B 帧压缩收益极小（静止帧全为 skip），禁用无实质质量损失。
  const darwinExtraArgs: string[] = process.platform === 'darwin'
    ? ['-vf', 'fps=30', '-bf', '0']
    : [];

  const args = [
    ...inputArgs,
    '-s', resolution,
    ...darwinExtraArgs,
    ...encodeArgs,
    '-g', String(30 * HLS_SEGMENT_DURATION), // GOP = framerate × segment_duration
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_DURATION),
    '-hls_list_size', '0',
    // ffmpeg 6.x HLS muxer 选项名为 -start_number（不是 -hls_start_number）
    '-start_number', String(startNumber),
    '-hls_segment_filename', segPattern,
    m3u8Path,
  ];

  console.log('[recorder] 启动 ffmpeg：', args.join(' '));

  const proc = spawn(ffmpeg, args, {
    // Windows 停止时需要向 stdin 写 'q'（SIGTERM 在 Windows 上等于 SIGKILL，会强杀进程导致末片截断）
    // macOS/Linux 用 SIGTERM，stdin 不需要 pipe，但统一设置 'pipe' 无副作用
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  // 打印 stderr 用于调试
  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stdout.write('[ffmpeg] ' + chunk.toString());
  });

  return proc;
}

// ─── crash 处理 ───────────────────────────────────────────────────────────────

/**
 * ffmpeg 进程异常退出时的处理逻辑。
 * 等待当前上传完成后，以 -hls_start_number 重启 ffmpeg 续录。
 */
async function handleFfmpegCrash(displayTitle: string): Promise<void> {
  if (isUserStopped) return;

  crashRestartCount++;
  if (crashRestartCount > MAX_CRASH_RESTARTS) {
    console.error(`[recorder] ffmpeg 已连续崩溃 ${crashRestartCount} 次，放弃重启`);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('recorder:error', 'ffmpeg 持续崩溃，录制已终止');
    }
    return;
  }

  console.warn(`[recorder] ffmpeg 进程异常退出，第 ${crashRestartCount} 次重启续录...`);

  // 等待当前正在进行的上传完成
  await Promise.allSettled(Array.from(activeUploads));

  if (isUserStopped) return;

  // 重启 ffmpeg，从已上传数量处续录
  if (watcher) {
    await watcher.close();
    watcher = null;
  }

  ffmpegProcess = spawnFfmpeg(currentSourceId, displayTitle, uploadedCount);
  attachFfmpegHandlers(displayTitle);

  // 注意：chokidar v5 不支持 glob 路径 watch，必须 watch 目录后在回调内过滤扩展名
  watcher = chokidar.watch(tmpDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watcher.on('add', (filePath) => {
    if (filePath.endsWith('.ts')) void uploadSegment(filePath);
  });
}

/**
 * 挂载 ffmpeg 进程的 close 事件，非正常退出时触发 crash 处理。
 */
function attachFfmpegHandlers(displayTitle: string): void {
  ffmpegProcess?.on('close', (code) => {
    if (isUserStopped) {
      console.log(`[recorder] ffmpeg 正常退出，code=${code}`);
      return;
    }
    console.warn(`[recorder] ffmpeg 异常退出，code=${code}`);
    void handleFfmpegCrash(displayTitle);
  });
}

// ─── 开始 / 停止录制 ──────────────────────────────────────────────────────────

/**
 * 开始录制。
 * @param windowId     desktopCapturer source id（格式 "screen:N:M" 或 "window:N:M"）
 *                     macOS avfoundation 模式下用于推导屏幕设备索引；
 *                     Windows gdigrab 模式下不使用（按 displayTitle 定位窗口）
 * @param displayTitle 窗口标题（Windows gdigrab 使用）
 * @param roomId       所属房间 ID
 */
async function start(windowId: string, displayTitle: string, roomId: string, authToken: string): Promise<void> {
  if (ffmpegProcess) {
    throw new Error('[recorder] 录制已在进行中');
  }

  // 初始化状态
  sessionId = uuidv4();
  currentRoomId = roomId;
  currentSourceId = windowId;
  currentAuthToken = authToken;
  segmentKeys = [];
  pendingQueue = [];
  uploadedCount = 0;
  isUserStopped = false;
  isRetryScheduled = false;
  consecutiveFailRounds = 0;
  crashRestartCount = 0;
  recordStartTime = Date.now();
  activeUploads.clear();
  queuedFileNames.clear();

  // 创建临时目录
  // 主路径：系统 temp 目录；fallback：userData（企业机器可能封锁 %TEMP%，userData 权限有保证）
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

  // 启动 ffmpeg
  ffmpegProcess = spawnFfmpeg(currentSourceId, displayTitle);
  attachFfmpegHandlers(displayTitle);

  // 启动 chokidar 监听新增切片文件
  // 注意：chokidar v5 不支持 glob 路径 watch，必须 watch 目录后在回调内过滤扩展名
  watcher = chokidar.watch(tmpDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watcher.on('add', (filePath) => {
    if (filePath.endsWith('.ts')) uploadSegment(filePath);
  });

  // 启动 tick 计时器
  tickTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - recordStartTime) / 1000);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('recorder:tick', seconds);
    }
  }, 1000);

  // 最长录制时间保护
  timeoutTimer = setTimeout(() => {
    console.log('[recorder] 达到最大录制时长 2 小时，自动停止');
    void stop();
  }, MAX_RECORD_MS);

  // 补录定时器：每 30s 检查一次
  // isRetryScheduled 互斥判断前置在此回调里，保证退避期间不被外部时钟打断
  retryTimerRef = setInterval(() => {
    if (isRetryScheduled) return; // ★ 上一轮还在跑（可能正在退避），跳过本次
    void triggerRetryQueue();
  }, 30_000);

  console.log(`[recorder] 录制开始，sessionId=${sessionId}，roomId=${roomId}`);
}

/**
 * 停止录制（用户主动停止）。
 * 流程：
 *   1. 提前设置 isUserStopped = true（阻止新入队）
 *   2. 通过 cleanup 清理定时器、停止 ffmpeg、关闭 chokidar
 *   3. 扫描临时目录，补入遗漏的尾片（fire-and-forget 加入 activeUploads）
 *   4. 等待所有正在进行的 activeUploads 完成
 *   5. 对剩余 pendingQueue 做最后一轮直接补传（绕过 triggerRetryQueue，确保 stop 时上传完整）
 *   6. 调用 finish 接口 → 清理临时目录 → 重置状态
 */
async function stop(): Promise<void> {
  if (!ffmpegProcess && !isUserStopped) return; // 没有在录制，直接返回
  if (isUserStopped) return;                    // 已在停止流程（abortRecording 可能已触发）

  // ① 提前设置 isUserStopped，阻止后续 uploadSegment 将新失败再次入队
  isUserStopped = true;

  const durationSeconds = Math.floor((Date.now() - recordStartTime) / 1000);

  // 用本地变量固定当前 tmpDir，避免后续状态重置后路径变为空字符串
  const sessionTmpDir = tmpDir;

  // ② 通过 cleanup 清理定时器、停止 ffmpeg、关闭 chokidar
  //    cleanup 不重置 segmentKeys / tmpDir / currentRoomId（finish 接口还需要）
  await cleanup();

  // ③ ffmpeg 退出后扫描临时目录，补传所有还未入队的切片
  // 这里处理两类遗漏：
  //   1. 最后一个不满 HLS_SEGMENT_DURATION 的尾片（用户停止时正在写入，chokidar 已关闭）
  //   2. awaitWriteFinish 稳定期内 chokidar 尚未触发的切片
  try {
    const allFiles = fs.readdirSync(sessionTmpDir);
    console.log(`[recorder] 临时目录内容：${allFiles.join(', ') || '(空)'}`);
    const tsFiles = allFiles.filter((f) => f.endsWith('.ts'));
    for (const file of tsFiles) {
      if (!queuedFileNames.has(file)) {
        const stat = fs.statSync(path.join(sessionTmpDir, file));
        console.log(`[recorder] 补传遗漏切片：${file}（${stat.size} bytes）`);
        // fire-and-forget：加入 activeUploads，后续 await 统一等待
        uploadSegment(path.join(sessionTmpDir, file));
      } else {
        console.log(`[recorder] 跳过已入队切片：${file}`);
      }
    }
  } catch (err) {
    console.warn('[recorder] 扫描临时目录失败：', (err as Error).message);
  }

  // ④ 等待所有 activeUploads 完成（含上方补传触发的新 upload）
  await Promise.allSettled(Array.from(activeUploads));

  // ⑤ 对剩余 pendingQueue 做最后一轮直接补传（最多 UPLOAD_MAX_RETRIES 轮避免无限循环）
  //    绕过 triggerRetryQueue 的退避逻辑（stop 时用户已等待，尽快上传）
  for (let round = 0; round < UPLOAD_MAX_RETRIES + 1; round++) {
    if (pendingQueue.length === 0) break;
    console.log(`[recorder] stop 补传第 ${round + 1} 轮，剩余 ${pendingQueue.length} 片`);
    const batch = pendingQueue.splice(0, pendingQueue.length);
    for (const filePath of batch) {
      try {
        await doUpload(filePath);
        pushProgress();
      } catch {
        // 本轮仍失败：暂不重新入队，等下一轮循环处理
        pendingQueue.push(filePath);
      }
    }
  }

  // ⑥ 调用 finish 接口
  if (segmentKeys.length > 0) {
    const displayName = `自动录制 ${new Date().toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).replace(/\//g, '-')}`;

    try {
      const response = await net.fetch(
        `${apiOrigin}/api/rooms/${currentRoomId}/recording/finish`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(currentAuthToken ? { 'Authorization': `Bearer ${currentAuthToken}` } : {}),
          },
          body: JSON.stringify({ segmentKeys, displayName, durationSeconds }),
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
  } else {
    console.warn('[recorder] 无可用切片，跳过 finish 接口');
  }

  // 清理临时目录（用 sessionTmpDir，状态重置后 tmpDir 已为空字符串）
  fs.rm(sessionTmpDir, { recursive: true, force: true }, (err) => {
    if (err) console.warn('[recorder] 临时目录清理失败：', err.message);
    else console.log('[recorder] 临时目录已清理：', sessionTmpDir);
  });

  // 重置状态
  sessionId = '';
  tmpDir = '';
  segmentKeys = [];
  uploadedCount = 0;
  currentRoomId = '';
  currentAuthToken = '';
  crashRestartCount = 0;

  console.log(`[recorder] 录制结束，时长 ${formatDuration(durationSeconds)}`);
}

// ─── IPC 注册 ─────────────────────────────────────────────────────────────────

/**
 * 在 ipcMain 上注册所有录制相关的 handle 处理器。
 * 由 main.ts 在 app.whenReady() 中调用。
 */
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

  ipcMain.handle('recorder:start', async (_event, windowId: string, displayTitle: string, roomId: string, authToken: string) => {
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

  // 渲染进程 token 刷新后主动推送最新 token，确保主进程上传切片时不使用过期 token
  ipcMain.handle('auth:setToken', (_event, token: string) => {
    setAuthTokenForRecorder(token);
  });
}