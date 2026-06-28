/**
 * Electron 主进程 & preload 构建配置
 *
 * 独立于 webpack.common.js，不包含 HTML、CSS、React 相关 loader。
 * 编译目标是 Node.js（Electron main process 运行在 Node 环境）。
 *
 * 输出目录：dist-electron/
 *   - main.js    → Electron 主进程入口
 *   - preload.js → contextBridge 脚本（renderer 启动前加载）
 */

const path = require('path');
const fs = require('fs');
const webpack = require('webpack');

// webpack mode：与 webpack.common.js 对齐，有 DEPLOY_ENV（CI）时用 production，否则 development
const isDev = !process.env.DEPLOY_ENV;

// 并行编译前先清空输出目录，避免两个 compiler 交叉删除对方产物
const outDir = path.resolve(__dirname, 'dist-electron');
fs.rmSync(outDir, { recursive: true, force: true });

// main 和 preload 的 target 不同，必须分开编译：
// - electron-main：完整 Node.js 环境（fs、child_process 等）
// - electron-preload：受限环境，只有 contextBridge、ipcRenderer 等白名单 API

// 纯 JS 小包，无原生依赖，应打包进 bundle（否则 electron-builder 打包后找不到）
const BUNDLE_PACKAGES = new Set(['uuid', 'p-retry']);

const shared = {
  mode: isDev ? 'development' : 'production',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: 'babel-loader',
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  // Electron 主进程运行在完整 Node.js 环境。
  // 大部分 npm 包应标记为 external（不打包进 bundle），原因：
  //   1. ffmpeg-static 等包依赖运行时路径解析，打包后路径基准变为 dist-electron/ 导致 ENOENT
  //   2. chokidar、fsevents 等含 native addon（.node 文件），webpack 无法正确处理
  //   3. 减小 bundle 体积，加快冷启动速度
  //
  // 但纯 JS 小包（如 uuid、p-retry）没有上述问题，应该打包进 bundle，
  // 否则 electron-builder 打包后找不到这些模块。
  externals: [
    // electron 本身由 Electron runtime 提供，不在 node_modules 里
    { electron: 'commonjs electron' },
    // 排除大部分 node_modules：匹配不以 . 或 / 开头的模块名（即 npm 包）
    ({ request }, callback) => {
      if (request && /^[a-zA-Z@]/.test(request) && !request.startsWith('electron/')) {
        if (BUNDLE_PACKAGES.has(request)) return callback();
        return callback(null, `commonjs ${request}`);
      }
      callback();
    },
  ],
  plugins: [
    new webpack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify(process.env.ELECTRON_API_ORIGIN || ''),
    }),
  ],
  devtool: isDev ? 'source-map' : false,
};

/** @type {import('webpack').Configuration} */
const mainConfig = {
  ...shared,
  target: 'electron-main',
  entry: { main: './electron/main.ts' },
  output: {
    path: path.resolve(__dirname, 'dist-electron'),
    filename: '[name].js',
    // clean 不在并行编译时设置，避免两个 compiler 交叉删除对方产物
    // dist-electron 目录由下方 beforeRun 勾子统一清理
    clean: false,
  },
};

/** @type {import('webpack').Configuration} */
const preloadConfig = {
  ...shared,
  target: 'electron-preload',
  entry: { preload: './electron/preload.ts' },
  output: {
    path: path.resolve(__dirname, 'dist-electron'),
    filename: '[name].js',
    clean: false,
  },
};

// webpack 支持数组配置，两个目标并行编译
module.exports = [preloadConfig, mainConfig];