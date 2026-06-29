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

import type { RecorderSource, EncoderDetectResult, RecordingProgress, AudioOptions } from '../../src/types/recorder';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 每个 HLS 切片的目标时长（秒）——与后端 hlsService.ts 保持一致 */
const HLS_SEGMENT_DURATION = 10;

/** 最长录制时长（毫秒），到时自动停止 */
const MAX_RECORD_MS = 2 * 60 * 60 * 1000;

/**
 * doUpload 内 pRetry 重试次数（共 2 次尝试 = 1 次首发 + 1 次 retry）。
 * 首次上传只处理瞬时抖动（1s 间隔），持续故障快速失败进 pendingQueue，
 * 交由 triggerRetryQueue 的指数退避兜底，避免多次重试长时间阻塞切片写入。
 * 两路合计重试能力不减弱：triggerRetryQueue 里 doUpload 同样走 pRetry。
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
 *   1. 录制开始时 → start() 传入当前 token
 *   2. token 无感刷新后 → 渲染进程调用 updateAuthToken(newToken)
 *   主进程不主动请求，始终使用最近一次推送的 token。
 */
let currentAuthToken = '';
/** 当前录制源 id（desktopCapturer source id），crash 重启时需要 */
let currentSourceId = '';
/**
 * macOS avfoundation 视频设备索引缓存（start 时通过枚举确定，crash 重启时复用）。
 * -1 表示未初始化，spawnFfmpeg 会用 screenSeq + 1 做兜底。
 */
let cachedAvfIndex = -1;
/** 后端 origin，由 main.ts 通过 setApiOrigin 注入 */
let apiOrigin = 'http://localhost:3002';
/** 检测到的编码器 */
let detectedEncoder = 'libx264';
/** 是否为软件编码 */
let isSoftwareEncoder = false;
/** 当前录制的音频选项（start 时传入，crash 重启时复用） */
let currentAudioOptions: AudioOptions = { withSystemAudio: false, withMic: false };

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
 *
 * 平台策略：
 *   macOS  → 始终使用 ffmpeg-static（avfoundation 捕获，无需 ddagrab）
 *   Windows → 优先使用 electron/bin/ffmpeg.exe（gyan.dev full build，内置 ddagrab filter）
 *             若不存在则降级到 ffmpeg-static（不含 ddagrab，会录制失败）
 *
 * Windows ffmpeg.exe 来源：
 *   从 https://www.gyan.dev/ffmpeg/builds/ 下载 ffmpeg-release-full.7z
 *   解压后取 bin/ffmpeg.exe 放入 electron/bin/
 *   ddagrab 在 full build 中作为 filter 内置，无需自编译。
 *
 * Windows ffmpeg.exe 放置位置：
 *   dev/preview 模式：electron/bin/ffmpeg.exe
 *   packaged 模式：resources/bin/ffmpeg.exe（由 electron-builder extraResources 打包）
 */
function getFfmpegPath(): string {
  // ── Windows：优先用 gyan.dev full build（含 ddagrab filter）────────────
  if (process.platform === 'win32') {
    const binName = 'ffmpeg.exe';

    if (app.isPackaged) {
      // packaged 模式：electron-builder extraResources 将 electron/bin/ 打包到 resources/bin/
      const bundledPath = path.join(process.resourcesPath, 'bin', binName);
      if (fs.existsSync(bundledPath)) {
        console.log('[recorder] 使用 gyan.dev full build ffmpeg（packaged）：', bundledPath);
        return bundledPath;
      }
    } else {
      // dev/preview 模式：从项目根 electron/bin/ 读取
      // __dirname 在 webpack 编译后指向 dist-electron/，向上一级是项目根
      const localBinPath = path.join(__dirname, '..', 'electron', 'bin', binName);
      if (fs.existsSync(localBinPath)) {
        console.log('[recorder] 使用 gyan.dev full build ffmpeg（dev）：', localBinPath);
        return localBinPath;
      }
      console.warn('[recorder] electron/bin/ffmpeg.exe 不存在，降级到 ffmpeg-static（不含 ddagrab，录制将失败）');
    }
  }

  // ── macOS / Linux / Windows 降级：使用 ffmpeg-static ────────────────────
  // ffmpeg-static 在 webpack 打包后路径可能变为相对路径或被内联，
  // 需要从 package.json bin 字段定位真实二进制
  let raw = ffmpegPath as string;

  if (!path.isAbsolute(raw)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require('ffmpeg-static/package.json') as { bin: string };
      raw = path.join(path.dirname(require.resolve('ffmpeg-static/package.json')), pkg.bin);
    } catch {
      raw = 'ffmpeg';
    }
  }

  if (app.isPackaged) {
    // ffmpeg-static 二进制被 electron-builder asarUnpack 解包到 app.asar.unpacked
    return raw.replace('app.asar', 'app.asar.unpacked');
  }
  return raw;
}

interface AudioDeviceInfo {
  name: string;
  index: number;
}

let cachedSpeakerName: string | null | undefined = undefined;
let cachedMicName: string | null | undefined = undefined;

function enumerateDshowAudioDevices(): AudioDeviceInfo[] {
  const ffmpeg = getFfmpegPath();
  const devices: AudioDeviceInfo[] = [];

  try {
    const { execSync } = require('child_process');
    const output = execSync(
      `"${ffmpeg}" -f dshow -list_devices true -i dummy 2>&1`,
      { encoding: 'utf8', timeout: 5000 }
    ) as string;

    const lines = output.split('\n');
    let index = 0;

    for (const line of lines) {
      // FFmpeg dshow 音频设备行格式：
      // [in#0 @ ...] "设备名" (audio)
      if (/\(audio\)/i.test(line)) {
        const nameMatch = line.match(/"(.+?)"/);
        if (nameMatch) {
          devices.push({ index, name: nameMatch[1].trim() });
          index++;
        }
      }
    }
  } catch (e) {
    console.warn('[recorder] dshow 音频设备枚举失败：', e);
  }

  console.log(`[recorder] 枚举到 ${devices.length} 个音频设备`, devices);
  return devices;
}

interface AudioDeviceInfo {
  format: 'wasapi' | 'dshow';
  deviceName: string;
}

let cachedSpeakerInfo: AudioDeviceInfo | null | undefined = undefined;
let cachedMicInfo: AudioDeviceInfo | null | undefined = undefined;

function getDefaultSpeaker(): AudioDeviceInfo | null {
  if (cachedSpeakerInfo !== undefined) return cachedSpeakerInfo;

  const ffmpeg = getFfmpegPath();

  // 方案1：WASAPI loopback（推荐，直接录制系统声音）
  try {
    const { execSync } = require('child_process');
    const wasapiOutput = execSync(
      `"${ffmpeg}" -f wasapi -list_devices true -i dummy 2>&1`,
      { encoding: 'utf8', timeout: 5000 }
    ) as string;

    // WASAPI 输出格式：[wasapi @ ...] "设备名" (loopback)
    const lines = wasapiOutput.split('\n');
    for (const line of lines) {
      if (/loopback/i.test(line)) {
        const nameMatch = line.match(/"(.+?)"/);
        if (nameMatch) {
          cachedSpeakerInfo = { format: 'wasapi', deviceName: nameMatch[1].trim() };
          console.log(`[recorder] ✅ 使用 WASAPI loopback: ${nameMatch[1].trim()}`);
          return cachedSpeakerInfo;
        }
      }
    }
    console.log('[recorder] 未找到 WASAPI loopback 设备，尝试 dshow');
  } catch (e) {
    console.warn('[recorder] WASAPI 枚举失败:', e);
  }

  // 方案2：dshow Stereo Mix（回退）
  const devices = enumerateDshowAudioDevices();

  if (devices.length === 0) {
    cachedSpeakerInfo = null;
    return null;
  }

  // 查找 Stereo Mix / Loopback 设备
  const loopbackDevice = devices.find(d =>
    /stereo\s*mix|loopback|what\s*u\s*hear/i.test(d.name)
  );

  if (loopbackDevice) {
    cachedSpeakerInfo = { format: 'dshow', deviceName: loopbackDevice.name };
    console.log(`[recorder] 使用 dshow Loopback: ${loopbackDevice.name}（#${loopbackDevice.index}）`);
    return cachedSpeakerInfo;
  }

  // 最终回退：第一个 dshow 设备（可能是麦克风，会录到杂音）
  cachedSpeakerInfo = { format: 'dshow', deviceName: devices[0].name };
  console.log(`[recorder] ⚠️ 回退到 dshow 默认设备: ${devices[0].name}（可能不是系统声音）`);
  console.log(`[recorder] 可用音频设备列表:`, devices);
  return cachedSpeakerInfo;
}

function getDefaultMic(): string | null {
  if (cachedMicName !== undefined) return cachedMicName;

  const devices = enumerateDshowAudioDevices();

  if (devices.length <= 1) {
    cachedMicName = null;
    return null;
  }

  cachedMicName = devices[1].name;
  console.log(`[recorder] 默认麦克风: ${cachedMicName}（dshow audio 设备 #1）`);
  return cachedMicName;
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
      // 顺带探测 WASAPI（仅 Windows）
      const isAudioAvailable = await detectAudioAvailable(ffmpeg);
      return { encoder, isSoftware: isSoftwareEncoder, isAudioAvailable };
    }
  }

  // 兜底：所有都失败时默认 libx264（通常不会到这里）
  detectedEncoder = 'libx264';
  isSoftwareEncoder = true;
  return { encoder: 'libx264', isSoftware: true, isAudioAvailable: false };
}

/**
 * 探测 Windows 系统音频录制是否可用。
 *
 * 优先级：
 * 1. WASAPI loopback（推荐）：直接录制系统声音，无需 Stereo Mix，Win7+ 原生支持
 * 2. dshow Stereo Mix：需要声卡驱动支持，用户可能未启用
 *
 * macOS/Linux 返回 false。
 */
async function detectAudioAvailable(ffmpeg: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  return new Promise<boolean>((resolve) => {
    let stderr = '';
    const proc = spawn(ffmpeg, [
      '-f', 'wasapi', '-list_devices', 'true', '-i', 'dummy',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      const hasWasapi = code === 0 || /loopback/i.test(stderr);
      console.log(`[recorder] WASAPI 探测结果：${hasWasapi ? '可用' : '不可用'}`);

      if (hasWasapi) {
        resolve(true);
        return;
      }

      // 回退：检查 dshow 是否有音频设备
      let dshowStderr = '';
      const dshowProc = spawn(ffmpeg, [
        '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      dshowProc.stderr?.on('data', (chunk: Buffer) => {
        dshowStderr += chunk.toString();
      });

      dshowProc.on('close', () => {
        const hasDshow = /\(audio\)|\[audio\]/i.test(dshowStderr);
        console.log(`[recorder] dshow 回退探测：${hasDshow ? '可用' : '不可用'}`);
        resolve(hasDshow);
      });

      dshowProc.on('error', () => resolve(false));
    });

    proc.on('error', () => resolve(false));

    setTimeout(() => { try { proc.kill(); } catch (_) { /* ignore */ } resolve(false); }, 5000);
  });
}

/**
 * 动态枚举 avfoundation 视频设备，找到对应 desktopCapturer sourceId 的实际索引。
 *
 * 问题背景：
 *   avfoundation 视频设备列表不固定。文档示例写的是 [0]=FaceTime摄像头、[1]=主屏，
 *   但实际上：
 *   - 无摄像头的 Mac（如 Mac mini）：[0]=主屏、[1]=第二屏
 *   - 有摄像头但摄像头被禁用：视频设备列表里无摄像头项
 *   - 外接多屏时屏幕数量动态变化
 *   因此固定用 screenSeq + 1 会在无摄像头环境下 off-by-one 导致 Invalid device index。
 *
 * 解决方案：
 *   运行 `ffmpeg -list_devices true -f avfoundation -i dummy` 枚举实际设备列表，
 *   从 stderr 中解析 "Capture screen N" 条目（N = desktopCapturer 屏幕序号），
 *   获取其对应的 avfoundation 索引号，作为 -i 参数使用。
 *
 * 兜底策略：
 *   - 枚举失败 / 找不到对应屏幕：返回 screenSeq + 1（旧逻辑，保证向后兼容）
 *   - 窗口录制（window: 前缀）：目标屏幕序号取 0（降级为主屏捕获）
 */
async function resolveAvfIndex(sourceId: string): Promise<number> {
  const ffmpeg = getFfmpegPath();

  const screenSeq = sourceId.startsWith('screen:')
    ? parseInt(sourceId.split(':')[1] ?? '0', 10)
    : 0;

  const fallback = screenSeq + 1; // 旧兜底逻辑

  return new Promise<number>((resolve) => {
    let stderr = '';
    const proc = spawn(ffmpeg, [
      '-list_devices', 'true',
      '-f', 'avfoundation',
      '-i', 'dummy',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', () => {
      // stderr 示例（视频设备区段）：
      //   [AVFoundation indev @ ...] AVFoundation video devices:
      //   [AVFoundation indev @ ...] [0] FaceTime HD Camera
      //   [AVFoundation indev @ ...] [1] Capture screen 0
      //   [AVFoundation indev @ ...] [2] Capture screen 1
      //   [AVFoundation indev @ ...] AVFoundation audio devices:
      //
      // 或无摄像头时：
      //   [AVFoundation indev @ ...] [0] Capture screen 0
      //   [AVFoundation indev @ ...] [1] Capture screen 1

      // 只解析视频设备区段（音频设备区段之前的内容）
      const videoSection = stderr.split(/AVFoundation audio devices/i)[0] ?? stderr;

      // 匹配 "[N] Capture screen M" 格式，N = avfoundation 索引，M = desktopCapturer 屏幕序号
      const pattern = /\[(\d+)\]\s+Capture screen\s+(\d+)/gi;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(videoSection)) !== null) {
        const avfIdx = parseInt(match[1]!, 10);
        const screenNum = parseInt(match[2]!, 10);
        if (screenNum === screenSeq) {
          console.log(`[recorder] avfoundation 设备枚举：Capture screen ${screenSeq} → 索引 ${avfIdx}`);
          resolve(avfIdx);
          return;
        }
      }

      // 找不到匹配项（可能是新系统格式变化），使用兜底值
      console.warn(`[recorder] avfoundation 未找到 Capture screen ${screenSeq}，使用兜底索引 ${fallback}`);
      console.debug('[recorder] avfoundation 枚举输出：\n', videoSection);
      resolve(fallback);
    });

    proc.on('error', () => {
      console.warn(`[recorder] avfoundation 枚举失败，使用兜底索引 ${fallback}`);
      resolve(fallback);
    });

    // 5s 超时保护
    setTimeout(() => {
      try { proc.kill(); } catch (_) { /* ignore */ }
      console.warn(`[recorder] avfoundation 枚举超时，使用兜底索引 ${fallback}`);
      resolve(fallback);
    }, 5000);
  });
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
 * 职责：仅负责首次上传（pRetry UPLOAD_MAX_RETRIES 次），不感知补录队列。
 */
function uploadSegment(filePath: string): void {
  const segmentName = path.basename(filePath);
  queuedFileNames.add(segmentName);

  const uploadPromise = doUpload(filePath)
    .then(() => {
      pushProgress();
    })
    .catch(() => {
      // pRetry 全部失败：进入补录队列等待 triggerRetryQueue 处理
      if (isUserStopped) return; // stop 之后不再入队
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
 * @param displayTitle   窗口标题（Windows 窗口录制时用于 gfxcapture window_title 匹配）
 * @param audioOptions   音频录制选项（仅 Windows 生效）
 * @param startNumber    -hls_start_number，crash 重启时传入已上传数量
 */
function spawnFfmpeg(sourceId: string, displayTitle: string, audioOptions: AudioOptions, startNumber = 0): ChildProcess {
  const ffmpeg = getFfmpegPath();
  // 缩放策略：等比缩放，限制最大宽度，保持原始宽高比，避免失真。
  // 宽度超出上限时等比缩小；宽度未达上限时不放大（原始更小则保持原始）。
  // -2 确保高度为偶数（H.264 编码器要求宽高均为偶数）。
  // 软编：最大宽 854（降低 CPU 压力）；硬编：最大宽 1600（高清档）
  const maxWidth = isSoftwareEncoder ? 854 : 1600;

  // ffmpeg 在所有平台上都能正确解析正斜杠路径；
  // Windows path.join 生成反斜杠，部分 ffmpeg 版本（静态构建）可能将 \s \U 等误解析为转义序列
  const segPattern = path.join(tmpDir, 'seg%03d.ts').replace(/\\/g, '/');
  const m3u8Path = path.join(tmpDir, 'index.m3u8').replace(/\\/g, '/');

  // ── 平台差异：输入源参数 ─────────────────────────────────────────────────
  // Windows：ddagrab filter（通过 lavfi 驱动）捕获全屏，零 CPU 开销
  // macOS：avfoundation 通过动态枚举得到的视频设备索引（见 resolveAvfIndex）
  let inputArgs: string[];
  if (process.platform === 'darwin') {
    // cachedAvfIndex 由 start() 调用 resolveAvfIndex() 预先填充。
    // 若未缓存（理论上不应发生），以 screenSeq + 1 做降级兜底（旧逻辑）。
    const screenSeq = sourceId.startsWith('screen:')
      ? parseInt(sourceId.split(':')[1] ?? '0', 10)
      : 0;
    const avfIndex = cachedAvfIndex >= 0 ? cachedAvfIndex : screenSeq + 1;
    inputArgs = [
      '-f', 'avfoundation',
      '-framerate', '30',
      '-capture_cursor', '1',
      '-i', `${avfIndex}:none`, // 视频设备:音频设备，none 表示不录音
    ];
  } else {
    // Windows：根据录制源类型选择不同的 GPU 零拷贝捕获方案
    //
    // 为什么不用 gdigrab：
    //   gdigrab 使用 GDI BitBlt（纯 CPU），每帧拷贝整个显存到系统内存，
    //   30fps 下 CPU 占用 ~20% 单核，且 BitBlt 会阻塞 GPU 渲染管线导致游戏卡顿。
    //
    // 两种 GPU 零拷贝视频捕获方案：
    //
    //   【全屏】ddagrab（Desktop Duplication API / DXGI）
    //     - 捕获整块显示器，output_idx 对应显示器序号
    //     - 必须通过 -f lavfi -i 语法驱动（不是 input device）
    //     - 兼容性：Windows 8.1+ / Win10 1803+，DX11 显卡
    //     - 音频：ddagrab 本身不含音频，需额外加 WASAPI loopback 输入
    //
    //   【窗口】gfxcapture（Windows.Graphics.Capture API）
    //     - 支持按窗口标题正则、进程名、HWND 精确捕获单个窗口
    //     - 同样是 GPU 硬件帧，CPU 开销 ≈0
    //     - 兼容性：Windows 10 1803+（Win11 推荐）
    //     - 不稳定帧率（由合成器决定），需加 fps filter 稳定到 30fps
    //     - 音频：capture_audio=1 可直接捕获该窗口进程的音频输出（WGC 会话内同步）
    //
    // 注意：两者均为 filter（非 input device），必须通过 -f lavfi -i 或
    //   -filter_complex 语法驱动，后接 hwdownload + format=bgra 转为 CPU 可见帧。
    //
    // 缩放策略：等比缩放，限制最大宽度，保持原始宽高比。
    //   scale=w='min(iw,W)':h=-2
    //   - iw > W 时等比缩小；iw <= W 时保持原始，不放大
    //   - h=-2：高度自动等比计算，且向下取偶数（H.264 要求）
    //   - format=yuv420p：编码器要求，hwdownload 输出 bgra 需显式转换
    const winScaleFilter = `scale=w='min(iw\\,${maxWidth})':h=-2,format=yuv420p`;
    const { withSystemAudio, withMic } = audioOptions;
    console.log(`[recorder] spawnFfmpeg 音频参数 → withSystemAudio=${withSystemAudio}, withMic=${withMic}`);

    if (sourceId.startsWith('screen:')) {
      // ── 全屏录制：ddagrab（视频） + WASAPI loopback（音频，可选）──────────
      const screenIdx = parseInt(sourceId.split(':')[1] ?? '0', 10);
      inputArgs = [
        '-f', 'lavfi',
        `-i`, `ddagrab=output_idx=${screenIdx}:framerate=30,hwdownload,format=bgra,${winScaleFilter}`,
      ];

      if (withSystemAudio) {
        const speakerInfo = getDefaultSpeaker();
        if (speakerInfo) {
          inputArgs.push('-f', speakerInfo.format, '-i', `audio=${speakerInfo.deviceName}`);
        }

        if (withMic) {
          const micName = getDefaultMic();
          if (micName) {
            inputArgs.push('-f', 'dshow', '-i', `audio=${micName}`);
          }
        }
      }
    } else {
      // ── 窗口录制：gfxcapture（视频） + WASAPI/dshow（音频，可选） ─────────
      //
      // gfxcapture 基于 Windows.Graphics.Capture API，只捕获视频帧不含音频。
      // 音频必须通过独立输入源采集。
      //
      // 系统音频策略：
      //   优先用 WASAPI loopback（-i 'default'），自动指向系统默认输出设备，
      //   不依赖具体设备名，兼容所有语言/厂商。
      //   若 WASAPI 不可用则降级到 dshow 按列表顺序取第一个音频设备。
      //
      // 麦克风策略：
      //   通过 dshow 枚举取第二个音频设备（#1），Windows 上通常 #0=扬声器 #1=麦克风。
      //   不依赖名称匹配，与语言/厂商无关。
      const escapedTitle = displayTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      inputArgs = [
        '-f', 'lavfi',
        `-i`, `gfxcapture=window_title=${escapedTitle}:max_framerate=30,fps=30,hwdownload,format=bgra,${winScaleFilter}`,
      ];

      if (withSystemAudio) {
        const speakerInfo = getDefaultSpeaker();
        if (speakerInfo) {
          inputArgs.push('-f', speakerInfo.format, '-i', `audio=${speakerInfo.deviceName}`);
        }
      }

      if (withMic) {
        const micName = getDefaultMic();
        if (micName) {
          inputArgs.push('-f', 'dshow', '-i', `audio=${micName}`);
        }
      }
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

  // macOS avfoundation 屏幕捕获的帧 PTS 全部相同（差値=0），
  // 导致每帧 duration=0，编码器输出时间戳错误。
  // 修复：用 fps filter 重新生成 PTS，同时内联等比缩放（限制最大宽）。
  // -s 与 -vf 互斥，不能同时使用，缩放必须内联到 -vf filter chain 中。
  //
  // scale=w='min(iw,W)':h=-2：
  //   - iw > W 时等比缩小；iw <= W 时保持原始，不放大
  //   - h=-2：高度自动等比计算，且向下取偶数（H.264 要求）
  // -bf 0：禁用 B 帧，使 DTS 严格等于 PTS，消除 HLS muxer 的 DTS 不单调警告
  const darwinExtraArgs: string[] = process.platform === 'darwin'
    ? ['-vf', `fps=30,scale=w='min(iw\,${maxWidth})':h=-2`, '-bf', '0']
    : [];

  // ── Windows 音频混流参数 ────────────────────────────────────────────────
  // 有音频输入时才构造音频编码和混流参数，否则加 -an 明确禁音（避免 HLS muxer 警告）
  //
  // 各场景流索引分析：
  //
  //   全屏（ddagrab）+ withSystemAudio：
  //     输入 0: lavfi(ddagrab)  → 0:v 视频（无音频）
  //     输入 1: wasapi loopback → 1:a 系统音频
  //     输入 2（有 mic）: dshow → 2:a 麦克风
  //     混流：amix inputs=2（1:a + 2:a），map 0:v + [amix]
  //
  //   窗口（gfxcapture, capture_audio=1）+ withSystemAudio：
  //     输入 0: lavfi(gfxcapture) → 0:v 视频 + 0:a 窗口音频（lavfi 双路输出）
  //     输入 1（有 mic）: dshow  → 1:a 麦克风
  //     混流：amix inputs=2（0:a + 1:a），map 0:v + [amix]
  //
  // amix：将多路音频流混合为一路，normalize=0 防止音量自动衰减
  // aac：HLS 标准音频编码，128k 足够语音+游戏音效场景
  const { withSystemAudio, withMic } = audioOptions;
  const hasAudio = process.platform === 'win32' && withSystemAudio;
  // 有麦克风时需要 amix 混流（无论全屏/窗口）
  const needsMix = hasAudio && withMic;
  const isScreenCapture = sourceId.startsWith('screen:');

  let audioArgs: string[];
  if (!hasAudio) {
    audioArgs = ['-an'];
  } else if (needsMix) {
    // 混流：全屏和窗口的音频流来源不同，-filter_complex 写法相同（均为 2 路）
    // 全屏：[1:a][2:a] → amix；  窗口：[0:a][1:a] → amix
    // 用 [0:a][1:a] 统一写法不对全屏，所以按来源分支处理
    const audioInputs = '[1:a][2:a]amix=inputs=2:normalize=0[amix]';  // 全屏/窗口统一：dshow系统音频(1) + dshow麦克风(2)
    audioArgs = [
      '-filter_complex', audioInputs,
      '-map', '0:v',
      '-map', '[amix]',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-strict', '-2',
    ];
  } else {
    // 只有系统音频，无需混流
    audioArgs = [
      '-c:a', 'aac',
      '-b:a', '128k',
      '-strict', '-2',
    ];
  }

  const args = [
    ...inputArgs,
    ...darwinExtraArgs,
    ...encodeArgs,
    ...audioArgs,
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

  ffmpegProcess = spawnFfmpeg(currentSourceId, displayTitle, currentAudioOptions, uploadedCount);
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
 *                     macOS：推导 avfoundation 屏幕设备索引
 *                     Windows screen:：推导 ddagrab output_idx
 *                     Windows window:：使用 gfxcapture，依赖 displayTitle 匹配
 * @param displayTitle 窗口标题（Windows 窗口录制时使用）
 * @param roomId       所属房间 ID
 * @param authToken    JWT AccessToken
 * @param audioOptions 音频录制选项（仅 Windows 生效）
 */
async function start(
  windowId: string,
  displayTitle: string,
  roomId: string,
  authToken: string,
  audioOptions: AudioOptions = { withSystemAudio: false, withMic: false },
): Promise<void> {
  if (ffmpegProcess) {
    throw new Error('[recorder] 录制已在进行中');
  }

  // 初始化状态
  sessionId = uuidv4();
  currentRoomId = roomId;
  currentSourceId = windowId;
  currentAuthToken = authToken;
  currentAudioOptions = audioOptions;
  segmentKeys = [];
  pendingQueue = [];
  uploadedCount = 0;
  isUserStopped = false;
  isRetryScheduled = false;
  consecutiveFailRounds = 0;
  crashRestartCount = 0;
  cachedAvfIndex = -1;
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

  // macOS：动态枚举 avfoundation 设备列表，确定正确的屏幕设备索引
  if (process.platform === 'darwin') {
    cachedAvfIndex = await resolveAvfIndex(windowId);
  }

  // 启动 ffmpeg
  ffmpegProcess = spawnFfmpeg(currentSourceId, displayTitle, audioOptions);
  attachFfmpegHandlers(displayTitle);

  // 启动 chokidar 监听新增切片文件
  // 注意：chokidar v5 不支持 glob 路径 watch，必须 watch 目录后在回调内过滤扩展名
  watcher = chokidar.watch(tmpDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watcher.on('add', (filePath) => {
    if (filePath.endsWith('.ts')) void uploadSegment(filePath);
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
  if (!ffmpegProcess && !isUserStopped) return; // 进程未启动且也不在停止流程中，直接返回
  if (isUserStopped) return;                    // 已在停止流程中（abortRecording 可能已触发），避免重复执行

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
      return { encoder: 'libx264', isSoftware: true, isAudioAvailable: false };
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
    audioOptions: AudioOptions,
  ) => {
    try {
      await start(windowId, displayTitle, roomId, authToken, audioOptions);
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