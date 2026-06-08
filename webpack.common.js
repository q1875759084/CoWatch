const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { DefinePlugin } = require('webpack');

// CI 构建时（测试/联调/生产）都会注入 DEPLOY_ENV，本地启动时没有注入
// 用 DEPLOY_ENV 是否存在来区分"CI 构建"和"本地开发"
const isCI = !!process.env.DEPLOY_ENV;
if (!isCI) {
  require('dotenv').config({ path: path.resolve(__dirname, '.env.development') });
}

module.exports = {
  entry: {
    // 主应用入口
    main: './src/index.tsx',
    // Service Worker：必须输出到根路径，且文件名固定（注册时路径对应）
    // 使用独立 entry 确保 SW 是独立文件，不被 bundle 合并
    sw: './src/sw.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    // main → bundle.[contenthash].js，sw → sw.js（固定文件名，SW 注册需要稳定路径）
    filename: (pathData) => {
      return pathData.chunk?.name === 'sw' ? 'sw.js' : 'bundle.[contenthash].js';
    },
    clean: true,
    // SPA 使用 history 模式路由，资源路径必须是绝对路径
    publicPath: '/',
  },
  module: {
    rules: [
      {
        test: /\.(jsx?|tsx?)$/,
        exclude: /node_modules/,
        use: 'babel-loader',
      },
      {
        test: /\.(s[ac]ss|css)$/,
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              modules: {
                auto: true,
                localIdentName: '[name]__[local]__[hash:base64:5]',
              },
            },
          },
          {
            loader: 'sass-loader',
            options: {
              sassOptions: {
                silenceDeprecations: ['legacy-js-api'],
              },
            },
          },
        ],
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './public/index.html',
    }),
    new DefinePlugin({
      __DEPLOY_ENV__: JSON.stringify(process.env.DEPLOY_ENV || 'dev'),
    }),
  ],
};
