/**
 * Electron Renderer 构建配置
 *
 * 继承 webpack.prod.js，覆盖两个关键点：
 *
 * 1. publicPath: '/'
 *    app:// 协议注册了 standard: true，Chromium 将其视为标准协议，
 *    绝对路径 /bundle.js 会被正确解析为 app://localhost/bundle.js，
 *    由 protocol.handle 从本地 dist 目录读取。
 *    不能用 './'：相对路径会基于当前路由（如 /room/2XWEVD/）拼接，
 *    导致图片等资源路径变成 /room/2XWEVD/8815f2f....webp，全部 404。
 *
 * 2. __DEPLOY_ENV__: 'dev'
 *    Electron 不走 CI/CD，DEPLOY_ENV 环境变量永远不存在，
 *    监控 SDK 固定进入 development 模式（不上报）。
 */

const { mergeWithCustomize, unique } = require('webpack-merge');
const { DefinePlugin } = require('webpack');
const prod = require('./webpack.prod');

module.exports = mergeWithCustomize({
  // DefinePlugin 按 constructor.name 去重，确保只有一个实例。
  // prod.js 里的 DefinePlugin 不含 __DEPLOY_ENV__（由 common 处理），
  // 但用 unique 兜底防止未来 prod 引入新 DefinePlugin 时产生冲突。
  customizeArray: unique(
    'plugins',
    ['DefinePlugin'],
    (plugin) => plugin.constructor?.name,
  ),
})(prod, {
  output: {
    publicPath: '/',
  },
  plugins: [
    new DefinePlugin({
      // 覆盖 common.js 里 __DEPLOY_ENV__ 的值（common 取 process.env.DEPLOY_ENV || 'dev'，
      // Electron 构建时 DEPLOY_ENV 不存在，结果已经是 'dev'，此处显式声明意图更清晰）。
      __DEPLOY_ENV__: JSON.stringify('dev'),
    }),
  ],
});
