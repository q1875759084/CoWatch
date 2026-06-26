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

  // 录制相关（阶段2实现后解注释）
  // recorder: {
  //   start: (windowId: string) => Promise<void>;
  //   stop: () => Promise<void>;
  //   onProgress: (cb: (pct: number) => void) => void;
  // };

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
