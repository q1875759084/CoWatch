import { contextBridge, ipcRenderer } from 'electron';

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

  // ─── 录制相关 ─────────────────────────────────────────────────────────────
  recorder: {
    /** 检测当前机器可用的最佳硬件/软件编码器 */
    detectEncoder: () => ipcRenderer.invoke('recorder:detectEncoder'),
    /** 获取可录制的窗口/整屏列表 */
    getSources: () => ipcRenderer.invoke('recorder:getSources'),
    /**
     * 开始录制
     * @param windowId     desktopCapturer source id
     * @param displayTitle 窗口标题（Windows gfxcapture 使用）
     * @param roomId       房间 ID
     * @param authToken    JWT AccessToken，主进程上传切片时带入 Authorization header
     */
    start: (
      windowId: string,
      displayTitle: string,
      roomId: string,
      authToken: string,
    ) => ipcRenderer.invoke('recorder:start', windowId, displayTitle, roomId, authToken),
    /** 停止录制（等待剩余切片上传完成后通知后端） */
    stop: () => ipcRenderer.invoke('recorder:stop'),
    /** 注册每秒录制计时回调，seconds 为已录秒数 */
    onTick: (cb: (seconds: number) => void) => {
      ipcRenderer.on('recorder:tick', (_event, seconds: number) => cb(seconds));
    },
    /** 注册上传进度回调 */
    onProgress: (cb: (info: { uploaded: number; pending: number }) => void) => {
      ipcRenderer.on('recorder:progress', (_event, info) => cb(info));
    },
    /** 移除录制计时回调 */
    offTick: () => {
      ipcRenderer.removeAllListeners('recorder:tick');
    },
    /** 移除上传进度回调 */
    offProgress: () => {
      ipcRenderer.removeAllListeners('recorder:progress');
    },
    /**
     * 注册录制异常中止回调（网络持续不可用 / 积压超限时由主进程触发）。
     * 收到后应重置 UI 状态并向用户展示错误原因。
     */
    onError: (cb: (err: { reason: string }) => void) => {
      ipcRenderer.on('recorder:error', (_event, err: { reason: string }) => cb(err));
    },
    /** 移除录制异常中止回调 */
    offError: () => {
      ipcRenderer.removeAllListeners('recorder:error');
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