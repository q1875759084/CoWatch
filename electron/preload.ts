import { contextBridge, ipcRenderer } from 'electron';
import type {
  RecordingRcMode,
  RecordingResolution,
  WatchModeOptions,
  WatchFolderResult,
} from '../src/types/recorder';

/**
 * contextBridge 将受控 API 暴露给 renderer（React 页面）
 *
 * renderer 通过 window.electronBridge 访问这些 API
 * 不暴露 ipcRenderer 本身，防止 renderer 直接发送任意 IPC 消息
 */
contextBridge.exposeInMainWorld('electronBridge', {
  /** 标识当前运行在 Electron 环境中，供 src/ 里的环境判断使用 */
  isElectron: true as const,

  /**
   * 后端 origin，格式如 'http://localhost:3002' 或 'https://cowatch.daibao.site'。
   * app:// 协议的 host 不含端口，无法从 window.location 推断真实后端地址，
   * 由此字段补全，供 env.ts 的 apiOrigin 使用（WS 地址推断等场景）。
   */
  apiOrigin: (__API_ORIGIN__ as string) || process.env.ELECTRON_API_ORIGIN || 'http://localhost:3002',

  /** 是否 preview 模式（ELECTRON_PREVIEW=true），用于决定是否暴露录制调试选项 */
  isPreview: process.env.ELECTRON_PREVIEW === 'true',

  // ─── 录制相关 ─────────────────────────────────────────────────────────────
  recorder: {
    /** 检测当前机器可用的最佳硬件/软件编码器 */
    detectEncoder: () => ipcRenderer.invoke('recorder:detectEncoder'),
    /** 获取可录制的窗口/整屏列表 */
    getSources: () => ipcRenderer.invoke('recorder:getSources'),
    /**
     * 开始录制
     * @param windowId     desktopCapturer source id，形如 window:<HWND十进制>[:suffix]，中段即目标窗口 HWND（CoWatch 主契约）
     * @param displayTitle 窗口标题（保留用于 crash 日志 / 解析，不进捕获 CLI）
     * @param roomId       房间 ID
     * @param authToken    JWT AccessToken，主进程上传切片时带入 Authorization header
     */
    start: (
      windowId: string,
      displayTitle: string,
      roomId: string,
      authToken: string,
      recordOnly?: boolean,
      rcMode?: RecordingRcMode,
      resolution?: RecordingResolution,
    ) => ipcRenderer.invoke('recorder:start', windowId, displayTitle, roomId, authToken, recordOnly, rcMode, resolution),
    /** 停止录制（等待剩余切片上传完成后通知后端） */
    stop: () => ipcRenderer.invoke('recorder:stop'),
    /**
     * 注册每秒录制计时回调，seconds 为已录秒数。
     * 返回 unsubscribe 函数，调用方在 useEffect cleanup 中调用以按引用摘除自身 listener，
     * 避免使用 removeAllListeners 误删其他订阅者的监听器（多组件订阅同一 channel 时会互相踩踏）。
     */
    onTick: (cb: (seconds: number) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, seconds: number) => cb(seconds);
      ipcRenderer.on('recorder:tick', wrapped);
      return () => ipcRenderer.removeListener('recorder:tick', wrapped);
    },
    /** 注册上传进度回调，返回 unsubscribe 函数（同 onTick） */
    onProgress: (cb: (info: { uploaded: number; pending: number }) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, info: { uploaded: number; pending: number }) => cb(info);
      ipcRenderer.on('recorder:progress', wrapped);
      return () => ipcRenderer.removeListener('recorder:progress', wrapped);
    },
    /**
     * 注册录制异常中止回调（网络持续不可用 / 积压超限时由主进程触发）。
     * 收到后应重置 UI 状态并向用户展示错误原因。
     * 返回 unsubscribe 函数（同 onTick）。
     */
    onError: (cb: (err: { reason: string }) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, err: { reason: string }) => cb(err);
      ipcRenderer.on('recorder:error', wrapped);
      return () => ipcRenderer.removeListener('recorder:error', wrapped);
    },
    /** 获取本地持久化的待补传录制列表 */
    getPendingRecordings: () => ipcRenderer.invoke('recorder:getPendingRecordings'),
    /** 启动补传单条持久化录制 */
    resumePending: (sessionId: string, authToken: string) =>
      ipcRenderer.invoke('recorder:resumePending', sessionId, authToken),
    /** 注册补传进度更新回调，返回 unsubscribe 函数（同 onTick） */
    onPendingUpdate: (cb: (list: unknown[]) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, list: unknown[]) => cb(list);
      ipcRenderer.on('recorder:pendingUpdate', wrapped);
      return () => ipcRenderer.removeListener('recorder:pendingUpdate', wrapped);
    },

    // ─── 外部视频转码 ─────────────────────────────────────────────────────
    /** 打开多选文件对话框，返回选中的文件路径列表 */
    selectVideoFiles: () =>
      ipcRenderer.invoke('recorder:selectVideoFiles') as Promise<{ cancelled: boolean; filePaths: string[] }>,
    /** 转码指定文件为 HLS 分段并上传 */
    transcodeExternal: (roomId: string, authToken: string, filePath: string) =>
      ipcRenderer.invoke('recorder:transcodeExternal', roomId, authToken, filePath),
    /** 注册外部视频转码进度回调，返回 unsubscribe 函数（同 onTick） */
    onExternalTranscodeProgress: (cb: (info: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, info: unknown) => cb(info);
      ipcRenderer.on('recorder:transcodeExternal:progress', wrapped);
      return () => ipcRenderer.removeListener('recorder:transcodeExternal:progress', wrapped);
    },

    // ─── 监听模式（文件夹自动转码上传）─────────────────────────────
    /** 打开单目录选择对话框，返回选定目录路径 */
    selectWatchFolder: () =>
      ipcRenderer.invoke('recorder:watchMode:selectFolder') as Promise<WatchFolderResult>,
    /** 启动监听模式：监听 folderPath 下新增视频，检测到即广播路径给渲染端（渲染端按手动上传同构处理） */
    startWatch: (folderPath: string, options?: WatchModeOptions) =>
      ipcRenderer.invoke('recorder:watchMode:start', folderPath, options),
    /** 停止监听模式 */
    stopWatch: () => ipcRenderer.invoke('recorder:watchMode:stop'),
    /** 查询监听状态 */
    getWatchStatus: () => ipcRenderer.invoke('recorder:watchMode:getStatus'),
    /** 注册监听文件检测回调（path → 渲染端按手动上传同构入队），返回 unsubscribe 函数（同 onTick） */
    onWatchFileDetected: (cb: (filePath: string) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, filePath: string) => cb(filePath);
      ipcRenderer.on('recorder:watchMode:fileDetected', wrapped);
      return () => ipcRenderer.removeListener('recorder:watchMode:fileDetected', wrapped);
    },
  },

  /**
   * 推送最新 JWT token 给主进程（录制上传时使用）。
   * 应在 token 无感刷新成功后调用，防止长时间录制时 token 过期导致上传 401。
   */
  updateAuthToken: (token: string) => ipcRenderer.invoke('auth:setToken', token),

  // ─── 本地存储（阶段1实现）见 ./handlers/store.ts ─────────────────────────
  // store: storeHandlers,
});