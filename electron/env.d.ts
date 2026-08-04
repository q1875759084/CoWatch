/**
 * Electron 侧「编译期注入常量」的 ambient 声明。
 *
 * __API_ORIGIN__ 由 webpack.electron.js 的 DefinePlugin 在打包时注入
 * （见 webpack.electron.js:66，取值 process.env.ELECTRON_API_ORIGIN，缺省注入空串 ''）。
 * 它是编译期替换的字面量，不是运行时全局变量，故必须以 ambient 声明告知 tsc。
 *
 * 作用域说明：
 *   - 本文件位于 electron/ 下，由 tsconfig.electron.json 的 include 通配段自动收编，
 *     仅对主进程 / preload 生效。
 *   - 渲染端 tsconfig.json 只 include src 目录，不会拉入本文件；且渲染端代码
 *     不引用 __API_ORIGIN__（它通过 preload 暴露的 electronBridge.apiOrigin 获取），
 *     因此与 src/global.d.ts 不存在重复声明冲突。
 */
declare const __API_ORIGIN__: string;
