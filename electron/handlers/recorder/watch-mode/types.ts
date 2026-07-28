/**
 * 监听模式（文件夹自动转码上传）类型契约。
 *
 * 单一事实来源（single source of truth）：
 * 所有监听模式共享类型均在 `src/types/recorder.ts` 定义
 * （preload / global.d.ts / ElectronVideoUploader 都从那里取用，
 * 含文件夹选择结果类型 `WatchFolderResult`）。
 *
 * 本文件仅做再导出（re-export），避免与 `src/types/recorder.ts` 重复定义。
 * 历史注记：早期实现曾在本文件用 `SelectFolderResult`、在 src 侧用 `WatchFolderResult`，
 * 造成"同名概念两个名字"的不一致 —— 现统一为 `WatchFolderResult`。
 *
 * 监听模式 = 模式 B（手动选文件转码上传）的自动版：
 * 用户指定单个监控目录（源），CoWatch 通过 chokidar 监听该目录下新增的视频文件，
 * 串行调用既有的 startExternalVideoTranscode 完成转码 + 上传，复用模式 B 全部下游链路。
 *
 * 设计要点（详见 docs/watch-mode-design.md v3.2）：
 *  - 两层去重：ignoreInitial（启动瞬间已存在文件不触发）+ 运行期内存 Set（绝对路径）
 *  - 不持久化 manifest
 *  - 串行泵保证同时仅 1 路 NVENC（规避 GeForce 并发上限）
 *  - 半写文件防护：源侧 awaitWriteFinish{stabilityThreshold:5000, pollInterval:2000}
 *  - phase1 已知限制：忽略 change 事件，OBS 暂停>5s 后半段丢失（有意取舍，非 bug）
 */

export type {
  WatchModeOptions,
  WatchStatus,
  WatchFolderResult,
} from '../../../../src/types/recorder';
