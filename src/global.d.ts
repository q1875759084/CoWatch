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
interface ElectronBridge {
  /** 标识当前运行在 Electron 环境中 */
  readonly isElectron: true;
  /**
   * 后端 origin，格式如 'http://localhost:3002' 或 'https://cowatch.daibao.site'。
   * 供 src/utils/env.ts 使用，业务代码不直接读取此字段。
   */
  readonly apiOrigin: string;

  recorder: {
    /** 检测当前机器可用的最佳硬件/软件编码器 */
    detectEncoder: () => Promise<import('./types/recorder').EncoderDetectResult>;
    /** 获取可录制的窗口/整屏列表 */
    getSources: () => Promise<import('./types/recorder').RecorderSource[]>;
    /**
     * 开始录制
     * @param audioOptions 音频选项（仅 Windows 生效；macOS 传入但被忽略）
     */
    start: (
      windowId: string,
      displayTitle: string,
      roomId: string,
      authToken: string,
      audioOptions: import('./types/recorder').AudioOptions,
    ) => Promise<void>;
    /** 停止录制（等待剩余切片上传完成后调用 finish 接口） */
    stop: () => Promise<void>;
    /** 注册录制计时回调（每秒触发，seconds 为已录秒数） */
    onTick: (cb: (seconds: number) => void) => void;
    /** 注册上传进度回调 */
    onProgress: (cb: (info: import('./types/recorder').RecordingProgress) => void) => void;
    /** 移除录制计时回调 */
    offTick: () => void;
    /** 移除上传进度回调 */
    offProgress: () => void;
    /** 注册录制异常中止回调（主进程 abortRecording 触发时推送） */
    onError: (cb: (err: import('./types/recorder').RecorderError) => void) => void;
    /** 移除录制异常中止回调 */
    offError: () => void;
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
