/**
 * Electron Renderer 构建配置
 *
 * 继承 webpack.prod.js，覆盖两个关键点：
 *
 * 1. publicPath: './' 而非 '/'
 *    原因：preview/packaged 模式下页面通过 app:// 协议加载。
 *    绝对路径 /bundle.js 会被解析为系统根目录，导致资源 404。
 *    相对路径 ./bundle.js 则相对于 index.html 所在目录，路径正确。
 *
 * 2. __DEPLOY_ENV__: 'dev'
 *    Electron 不走 CI/CD，DEPLOY_ENV 环境变量永远不存在，
 *    监控 SDK 固定进入 development 模式（不上报）。
 *
 * 不再需要注入 __IS_ELECTRON__ / __ELECTRON_API_ORIGIN__：
 *    所有 HTTP 请求已由 main.ts 注册的 app:// protocol 在 Main 进程中透明转发，
 *    业务代码继续使用相对路径（/api/xxx），与 Web 版本完全一致，无需感知 Electron 环境。
 *    WebSocket 连接通过 window.location.host 推断，因为 app:// 的 host 就是后端地址，
 *    业务代码与 Web 版本完全一致。
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
    publicPath: './',
  },
  plugins: [
    new DefinePlugin({
      // 覆盖 common.js 里 __DEPLOY_ENV__ 的值（common 取 process.env.DEPLOY_ENV || 'dev'，
      // Electron 构建时 DEPLOY_ENV 不存在，结果已经是 'dev'，此处显式声明意图更清晰）。
      __DEPLOY_ENV__: JSON.stringify('dev'),
    }),
  ],
});
