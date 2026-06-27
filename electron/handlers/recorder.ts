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
 * 切片上传流程：
 *   ffmpeg 生成 seg*.ts → chokidar 检测到 add 事件 →
 *   POST /api/rooms/:roomId/recording/segment（后端存 COS）→
 *   p-retry 3 次失败 → 进入 pendingSegments 队列 →
 *   网络恢复后批量补传
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

/** 切片上传最大重试次数（p-retry） */
const UPLOAD_MAX_RETRIES = 3;

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
/** 上传失败待补传的本地文件路径列表 */
let pendingSegments: string[] = [];
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
/** 定时器：每 30s 轮询补传 pending 切片 */
let pendingFlushTimerRef: ReturnType<typeof setInterval> | null = null;
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
    pending: pendingSegments.length,
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
 * 上传单个切片文件到后端。
 * 后端接口：POST /api/rooms/:roomId/recording/segment
 * 使用 p-retry 3 次（指数退避 + 随机抖动）。
 * 失败：进入 pendingSegments 队列，不中断录制。
 */
async function uploadSegment(filePath: string): Promise<void> {
  const segmentName = path.basename(filePath);
  const objectKey = `cowatch/${currentRoomId}/recordings/${sessionId}/${segmentName}`;
  queuedFileNames.add(segmentName);

  const upload = pRetry(
    async () => {
      const buffer = fs.readFileSync(filePath);
      const response = await net.fetch(
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
        } as RequestInit,
      );

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

  const uploadPromise = upload
    .then(() => {
      segmentKeys.push(objectKey);
      uploadedCount = segmentKeys.length;
      // 上传成功后删除本地临时文件
      fs.unlink(filePath, (err) => {
        if (err) console.warn('[recorder] 删除临时文件失败：', filePath, err.message);
      });
      pushProgress();
    })
    .catch(() => {
      // 3 次全部失败：进入待补传队列
      console.error(`[recorder] 切片上传失败（已用尽重试）：${segmentName}，加入 pending 队列`);
      pendingSegments.push(filePath);
      pushProgress();
    })
    .finally(() => {
      activeUploads.delete(uploadPromise);
    });

  activeUploads.add(uploadPromise);
}

/**
 * 批量补传 pendingSegments 中所有失败的切片。
 * 网络恢复后调用。
 */
async function flushPendingSegments(): Promise<void> {
  if (pendingSegments.length === 0) return;
  console.log(`[recorder] 网络恢复，开始补传 ${pendingSegments.length} 个切片`);
  const toRetry = pendingSegments.splice(0, pendingSegments.length);
  for (const filePath of toRetry) {
    await uploadSegment(filePath);
  }
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
  const segPattern = path.join(tmpDir, 'seg%03d.ts');
  const m3u8Path = path.join(tmpDir, 'index.m3u8');

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
    // Windows：gdigrab 按窗口标题捕获
    const safeTitle = displayTitle.replace(/"/g, '\\"');
    inputArgs = [
      '-f', 'gdigrab',
      '-framerate', '30',
      '-i', `title=${safeTitle}`,
    ];
  }

  // ── 编码参数 ─────────────────────────────────────────────────────────────
  // 软编（libx264）：
  //   -crf 30：与 compress_30.bat 保持一致的质量标准
  //   -preset veryfast：实时录制必须用快速 preset，medium 及以上会导致 CPU 过高积压掉帧
  //                     代价：同等 CRF 下码率约高 20-30%，但录屏静止帧多实际均值仍很低
  // 硬编（nvenc/amf/qsv）：硬件编码器不支持 CRF 模式，改用 VBR 码率控制
  //   -b:v 2000k：目标码率
  //   -maxrate 2500k -bufsize 4000k：限制峰值，防止码率漂移导致切片大小剧烈波动
  const encodeArgs: string[] = isSoftwareEncoder
    ? ['-c:v', detectedEncoder, '-crf', '30', '-preset', 'veryfast']
    : ['-c:v', detectedEncoder, '-b:v', '2000k', '-maxrate', '2500k', '-bufsize', '4000k'];

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

  watcher = chokidar.watch(path.join(tmpDir, '*.ts'), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watcher.on('add', (filePath) => {
    void uploadSegment(filePath);
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
  pendingSegments = [];
  uploadedCount = 0;
  isUserStopped = false;
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
  watcher = chokidar.watch(path.join(tmpDir, '*.ts'), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watcher.on('add', (filePath) => {
    void uploadSegment(filePath);
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

  // pending 补传：每 30 秒检查一次，网络恢复后自动补传
  // （不依赖 net.on/process.on 事件，简单轮询足够录制场景使用）
  const pendingFlushTimer = setInterval(() => {
    if (pendingSegments.length > 0) void flushPendingSegments();
  }, 30_000);
  // stop 时需要清除此 timer，存入模块变量，与 tickTimer / timeoutTimer 统一在 stop() 开头清理
  pendingFlushTimerRef = pendingFlushTimer;

  console.log(`[recorder] 录制开始，sessionId=${sessionId}，roomId=${roomId}`);
}

/**
 * 停止录制。
 * 流程：停止 ffmpeg → 等待所有上传 → 补传 pending → 调用 finish 接口 → 清理临时目录
 */
async function stop(): Promise<void> {
  if (!ffmpegProcess) return;

  isUserStopped = true;

  // 停止定时器
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
  if (timeoutTimer !== null) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  if (pendingFlushTimerRef !== null) { clearInterval(pendingFlushTimerRef); pendingFlushTimerRef = null; }

  const durationSeconds = Math.floor((Date.now() - recordStartTime) / 1000);

  // 用本地变量固定当前 tmpDir，避免后续状态重置后路径变为空字符串
  const sessionTmpDir = tmpDir;

  // 停止 ffmpeg：
  //   Windows：stdin 写 'q' → ffmpeg 收到后优雅写入 #EXT-X-ENDLIST 再退出
  //            Windows 上 SIGTERM 等于 SIGKILL，会强杀进程导致末片截断、无 #EXT-X-ENDLIST
  //   macOS/Linux：发送 SIGTERM，ffmpeg 收到后 flush 最后一个切片后退出
  //            avfoundation flush 可能需要数秒，给足 15s 兜底
  await new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      // Windows：通过 stdin 发送 'q'，ffmpeg 优雅退出
      ffmpegProcess!.stdin?.write('q');
      ffmpegProcess!.stdin?.end();
    } else {
      // macOS / Linux：SIGTERM 触发 ffmpeg flush 并退出
      ffmpegProcess!.kill('SIGTERM');
    }
    ffmpegProcess!.on('close', () => resolve());
    // 保险：15s 后强杀（avfoundation flush 最后切片可能需要较长时间）
    setTimeout(() => {
      try { ffmpegProcess?.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
      resolve();
    }, 15000);
  });
  ffmpegProcess = null;

  // 停止文件监听
  if (watcher) { await watcher.close(); watcher = null; }

  // ffmpeg 退出后扫描临时目录，补传所有还未上传的切片
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
        await uploadSegment(path.join(sessionTmpDir, file));
      } else {
        console.log(`[recorder] 跳过已入队切片：${file}`);
      }
    }
  } catch (err) {
    console.warn('[recorder] 扫描临时目录失败：', (err as Error).message);
  }

  // 循环等待：activeUploads 完成 → 触发 flushPendingSegments → 新的 upload 加入 activeUploads
  // 直到两者都为空才退出，确保所有重试链全部完成后再清理目录
  // 网络持续故障时最多循环 UPLOAD_MAX_RETRIES 轮，不会无限阻塞
  for (let round = 0; round < UPLOAD_MAX_RETRIES + 1; round++) {
    await Promise.allSettled(Array.from(activeUploads));
    if (pendingSegments.length === 0) break;
    await flushPendingSegments();
  }

  // 调用 finish 接口
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
  pendingSegments = [];
  uploadedCount = 0;
  currentRoomId = '';
  currentAuthToken = '';
  crashRestartCount = 0;
  activeUploads.clear();
  queuedFileNames.clear();

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
