const { merge } = require('webpack-merge');
const common = require('./webpack.common');

module.exports = merge(common, {
  mode: 'development',

  // eval-cheap-module-source-map：构建快，精确到行，保留 Babel 转译前的 TS/JSX 源码定位
  devtool: 'eval-cheap-module-source-map',

  devServer: {
    port: 3001,
    historyApiFallback: true, // SPA history 路由刷新兜底
    hot: true,
    open: true,
    // webpack-dev-server v5 的 proxy 格式改为数组
    // 注意：HMR 默认占用 /ws（前缀匹配），业务 WS 使用 /socket 彻底避免冲突
    proxy: [
        {
          context: ['/api', '/uploads'],
          target: 'http://localhost:3002',
          changeOrigin: true,
          secure: false,
        },
      {
        context: ['/socket'],
        target: 'ws://localhost:3002',
        changeOrigin: true,
        ws: true,
        secure: false,
      },
    ],
  },
});
