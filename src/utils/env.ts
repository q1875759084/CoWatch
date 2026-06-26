/**
 * 运行环境工具 —— 基础设施层
 *
 * 职责：屏蔽"浏览器 vs Electron"的平台差异，对业务层提供统一接口。
 * 只有这个文件允许读取 window.electronBridge，业务代码不直接访问它。
 *
 * 背景：
 *   Electron 以 app://localhost/index.html 加载页面，
 *   window.location.host === 'localhost'（无端口），
 *   无法从 location 推断真实后端地址（如 localhost:3002）。
 *   preload 通过 contextBridge 注入 apiOrigin 解决这个问题。
 */

/**
 * 后端 origin。
 * - 浏览器：window.location.origin（含协议、host、端口）
 * - Electron：electronBridge.apiOrigin（由 preload 注入）
 *
 * 用途：拼接 WebSocket 地址等需要绝对地址的场景。
 */
export const apiOrigin: string =
  window.electronBridge?.apiOrigin ?? window.location.origin;
