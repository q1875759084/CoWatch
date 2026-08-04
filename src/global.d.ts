// CSS Modules 类型声明
declare module '*.module.scss' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

// webpack DefinePlugin 注入的全局常量
declare const __DEPLOY_ENV__: string;

// 图片/SVG 文件：webpack asset/resource 处理，import 返回文件 URL 字符串
declare module '*.svg' {
  const url: string;
  export default url;
}

declare module '*.webp' {
  const url: string;
  export default url;
}

declare module '*.png' {
  const url: string;
  export default url;
}

declare module '*.jpg' {
  const url: string;
  export default url;
}

declare module '*.jpeg' {
  const url: string;
  export default url;
}

declare module '*.gif' {
  const url: string;
  export default url;
}

// ─── Electron contextBridge 暴露的 API（preload.ts 中定义）──────────────────
/**
 * Unsubscribe 函数：注册 IPC 监听器后返回，调用方在 useEffect cleanup 中调用，
 * 按引用摘除自身 listener，避免 removeAllListeners 误删其他订阅者的监听器。
 */
type ElectronUnsubscribe = () => void;

interface ElectronBridge {
  /** 标识当前运行在 Electron 环境中 */
  readonly isElectron: true;
  /**
   * 后端 origin，格式如 'http://localhost:3002' 或 'https://cowatch.daibao.site'。
   * 供 src/utils/env.ts 使用，业务代码不直接读取此字段。
   */
  readonly apiOrigin: string;
  /** 是否 preview 模式（ELECTRON_PREVIEW=true），决定是否暴露录制调试选项 */
  readonly isPreview: boolean;

  recorder: {
    /** 检测当前机器可用的最佳硬件/软件编码器 */
    detectEncoder: () => Promise<import('./types/recorder').EncoderDetectResult>;
    /** 获取可录制的窗口/整屏列表 */
    getSources: () => Promise<import('./types/recorder').RecorderSource[]>;
    /** 开始录制 */
    start: (
      windowId: string,
      displayTitle: string,
      roomId: string,
      authToken: string,
      recordOnly?: boolean,
    ) => Promise<void>;
    /** 停止录制（等待剩余切片上传完成后调用 finish 接口） */
    stop: () => Promise<void>;
    /** 注册录制计时回调（每秒触发，seconds 为已录秒数），返回 unsubscribe 函数 */
    onTick: (cb: (seconds: number) => void) => ElectronUnsubscribe;
    /** 注册上传进度回调，返回 unsubscribe 函数 */
    onProgress: (cb: (info: import('./types/recorder').RecordingProgress) => void) => ElectronUnsubscribe;
    /** 注册录制异常中止回调（主进程 abortRecording 触发时推送），返回 unsubscribe 函数 */
    onError: (cb: (err: import('./types/recorder').RecorderError) => void) => ElectronUnsubscribe;
    /** 获取本地持久化的待补传录制列表 */
    getPendingRecordings: () => Promise<import('./types/recorder').PendingRecording[]>;
    /** 启动补传单条持久化录制 */
    resumePending: (sessionId: string, authToken: string) => Promise<void>;
    /** 注册补传进度更新回调（复用 progress 通道），返回 unsubscribe 函数 */
    onPendingUpdate: (cb: (list: import('./types/recorder').PendingRecording[]) => void) => ElectronUnsubscribe;
      /** 打开多选文件对话框，返回选中的文件路径列表。{ cancelled: true } 表示用户取消选择 */
      selectVideoFiles: () => Promise<{ cancelled: boolean; filePaths: string[] }>;
      /** 转码指定文件为 HLS 分段并上传。返回 { error: string } 表示启动失败 */
      transcodeExternal: (roomId: string, authToken: string, filePath: string) => Promise<{ error?: string }>;
      /** 注册外部视频转码进度回调，返回 unsubscribe 函数 */
      onExternalTranscodeProgress: (cb: (info: import('./types/recorder').ExternalTranscodeProgress) => void) => ElectronUnsubscribe;

      // ─── 监听模式（文件夹自动转码上传）─────────────────────────────
      /** 打开单目录选择对话框，返回选定目录路径 */
      selectWatchFolder: () => Promise<import('./types/recorder').WatchFolderResult>;
      /** 启动监听模式：监听 folderPath 下新增视频，检测到即广播路径给渲染端 */
      startWatch: (
        folderPath: string,
        options?: import('./types/recorder').WatchModeOptions,
      ) => Promise<{ error?: string }>;
      /** 停止监听模式 */
      stopWatch: () => Promise<{ error?: string }>;
      /** 查询监听状态 */
      getWatchStatus: () => Promise<import('./types/recorder').WatchStatus>;
      /** 注册监听文件检测回调（path → 渲染端按手动上传同构入队），返回 unsubscribe 函数 */
      onWatchFileDetected: (cb: (filePath: string) => void) => ElectronUnsubscribe;
  };

  /** 设置：读取/持久化录制与转码参数 */
  settings: {
    /** 读取完整应用设置（录制 + 转码） */
    get: () => Promise<import('./types/settings').AppSettings>;
    /** 更新指定段的设置，合并写入并持久化，返回更新后的完整设置 */
    set: (
      section: import('./types/settings').SettingsSection,
      values: Partial<import('./types/settings').RecordingSettings> | Partial<import('./types/settings').TranscodeSettings>,
    ) => Promise<import('./types/settings').AppSettings>;
    /** 监听主进程发来的 Tab 切换通知（单例窗口再次打开时），返回 unsubscribe 函数 */
    onSwitchTab: (cb: (section: 'recording' | 'transcode') => void) => ElectronUnsubscribe;
  };

  /** 推送最新 JWT token 给主进程，token 无感刷新后调用，防止录制上传用过期 token */
  updateAuthToken: (token: string) => Promise<void>;

  // 本地存储（阶段1实现后解注释）
  // store: {
  //   get: (key: string) => Promise<string | null>;
  //   set: (key: string, value: string) => Promise<void>;
  //   delete: (key: string) => Promise<void>;
  // };
}

declare interface Window {
  electronBridge?: ElectronBridge;
}
