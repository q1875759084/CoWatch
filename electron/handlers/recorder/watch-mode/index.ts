/**
 * 监听模式（文件夹自动转码上传）—— 极简实现。
 *
 * 设计本质：监听模式 = 模式 B（用户点击选择视频上传）的自动版。
 *   主进程 chokidar 监听源目录，检测到"新增且写完"的视频文件后，
 *   仅把文件路径广播给渲染端（recorder:watchMode:fileDetected）；
 *   渲染端收到后，按"用户手动点选"完全相同的路径 enqueue，
 *   由既有 self-driver 调 transcodeExternal 启动转码 —— 下游 100% 复用模式 B。
 *
 * 因此本模块【不】持有调度 / 队列 / 串行泵：那些是模式 B 既有链路的责任。
 * 本模块只负责"检测 + 去重 + 广播路径"，不做任何转码编排。
 */

import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';

import type { WatchModeOptions, WatchStatus } from './types';

/** 默认视频扩展名白名单（排除 .tmp/.part/.crdownload 等半写中间名） */
const DEFAULT_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'webm'];

/** 源 watcher 依赖（仅负责把检测到的路径广播出去） */
export interface WatchModeDeps {
  /** 广播检测到的视频文件路径给渲染端 */
  emitFileDetected: (filePath: string) => void;
  /** 日志输出（可选） */
  onLog?: (msg: string) => void;
}

/** 监听控制器（createWatchSource 返回的句柄） */
export interface WatchSourceController {
  start: (folderPath: string, options?: WatchModeOptions) => { error?: string };
  stop: () => { error?: string };
  getStatus: () => WatchStatus;
}

/**
 * 创建监听源控制器。
 * 仅做检测 + 去重 + 广播；转码调度交给模式 B 既有链路（渲染端 self-driver）。
 */
export function createWatchSource(deps: WatchModeDeps): WatchSourceController {
  const log = (msg: string) => deps.onLog?.(msg);

  let watcher: chokidar.FSWatcher | null = null;
  let active = false;
  let folderPath = '';
  /** 运行期去重（绝对路径）；启动快照预种进一步防止历史文件重触发 */
  const memorySet = new Set<string>();

  function videoExtRe(options?: WatchModeOptions): RegExp {
    const exts = options?.extensions?.length ? options.extensions : DEFAULT_EXTENSIONS;
    return new RegExp(`\\.(${exts.join('|')})$`, 'i');
  }

  /** 检测到新文件：去重 + 扩展名过滤后，广播路径给渲染端 */
  function onAddFile(filePath: string, options?: WatchModeOptions): void {
    if (!videoExtRe(options).test(filePath)) return; // 扩展名白名单
    if (memorySet.has(filePath)) return;             // 运行期去重
    memorySet.add(filePath);
    deps.emitFileDetected(filePath);                 // 渲染端按手动上传同构入队
    log(`[watch-mode] 检测到新视频，已通知上传：${filePath}`);
  }

  function start(fp: string, options?: WatchModeOptions): { error?: string } {
    if (active) return { error: '监听已在进行中' };
    if (!fp) return { error: '未指定监听目录' };

    folderPath = fp;
    active = true;
    memorySet.clear();

    // 启动快照预种：把当前目录已存在文件塞进 Set，双保险防止任何历史文件重触发
    try {
      const entries = fs.readdirSync(fp);
      for (const entry of entries) {
        memorySet.add(path.join(fp, entry));
      }
    } catch (err) {
      log(`[watch-mode] 预读目录失败（继续）：${(err as Error).message}`);
    }

    watcher = chokidar.watch(fp, {
      persistent: true,
      ignoreInitial: true,                 // 启动瞬间已存在文件不触发
      awaitWriteFinish: {
        pollInterval: 2000,                // 仅影响"写完判定"采样频率，不影响"发现新文件"及时性
        stabilityThreshold: 5000,          // 固定 5000ms（最稳）：容忍录制中正常停顿
      },
      // 不传 ignored，过滤在 add 回调里做（按扩展名）
    });

    watcher.on('add', (filePath) => onAddFile(filePath, options));
    // R5-sub：监听目录被删/移 → 仅静默 crash guard（不弹 UI、不存状态），避免未捕获异常崩主进程
    watcher.on('error', (err) => {
      log(`[watch-mode] 监听异常，停止监听：${(err as Error).message}`);
      stop();
    });

    log(`[watch-mode] 已开始监听：${fp}`);
    return {};
  }

  function stop(): { error?: string } {
    active = false;
    if (watcher) {
      void watcher.close();
      watcher = null;
    }
    return {};
  }

  function getStatus(): WatchStatus {
    return { active, folderPath };
  }

  return { start, stop, getStatus };
}
