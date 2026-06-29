# FFmpeg ddagrab 实际情况备忘

> 本文件记录 ddagrab / gfxcapture 调研结论，供切换电脑后向新 AI 传递上下文使用。

## 结论

**gyan.dev full build 已内置 ddagrab 和 gfxcapture，无需自编译。**

## 关键发现

### 1. ddagrab / gfxcapture 都是 filter，不是 input device

两者在 FFmpeg 中均为 **video source filter**，不能用 `-f ddagrab -i ...` 驱动。

| 错误用法 | 报错 |
|---|---|
| `-f ddagrab -i 0` | `Unknown input format: 'ddagrab'` |

正确用法是通过 `-f lavfi -i` 或 `-filter_complex` 驱动：

```bash
# 全屏：ddagrab
-f lavfi -i 'ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra'

# 窗口：gfxcapture
-f lavfi -i 'gfxcapture=window_title=游戏标题:max_framerate=30,fps=30,hwdownload,format=bgra'
```

### 2. Windows 两套 GPU 零拷贝方案

| 场景 | Filter | 原理 | 兼容性 |
|---|---|---|---|
| **全屏录制** | `ddagrab` | DXGI Desktop Duplication API | Win 8.1+ / Win10 1803+，DX11 |
| **窗口录制** | `gfxcapture` | Windows.Graphics.Capture API | Win10 1803+（Win11 推荐） |

两者 CPU 开销均 ≈0，均输出 D3D11 硬件帧，需接 `hwdownload,format=bgra` 转为 CPU 可见帧。

`gfxcapture` 帧率由合成器决定，不稳定，需在 filter chain 中加 `fps=30` 稳定帧率。

### 3. 缩放策略：等比缩放，不固定宽高比

不能用固定 `scale=1600:900`（会拉伸非 16:9 内容）。

正确写法：限制最大宽度，高度等比自动计算：

```
scale=w='min(iw,1600)':h=-2,format=yuv420p
```

- `iw > 1600` 时等比缩小；`iw <= 1600` 时保持原始，不放大
- `h=-2`：高度向下取偶数（H.264 要求宽高均为偶数）
- 软编最大宽 854，硬编最大宽 1600

### 4. FFmpeg 来源

- **无需自编译**，直接用 [gyan.dev full build](https://www.gyan.dev/ffmpeg/builds/)
- 下载 `ffmpeg-release-full.7z`（约 159 MB），解压取 `bin/ffmpeg.exe`
- full build 将 ddagrab / gfxcapture 作为 filter 内置，essentials build 不含

### 参考来源

- gyan.dev issue #205（2025-11-13）：[I can't find any build with ddagrab api](https://github.com/GyanD/codexffmpeg/issues/205)
  - GyanD 回复：*"ddagrab is not implemented as a regular device but as a filter."*
- FFmpeg 官方 filter 文档（ddagrab）：https://ffmpeg.org/ffmpeg-filters.html#ddagrab
- FFmpeg 官方 filter 文档（gfxcapture）：https://ffmpeg.org/ffmpeg-filters.html#gfxcapture
- gyan.dev 构建下载页：https://www.gyan.dev/ffmpeg/builds/

## 当前代码状态（recorder.ts）

已于 2026-06-29 修改 `electron/handlers/recorder.ts`，Windows 分支逻辑：

```ts
const winScaleFilter = `scale=w='min(iw\\,${maxWidth})':h=-2,format=yuv420p`;

if (sourceId.startsWith('screen:')) {
  // 全屏录制：ddagrab，output_idx 取显示器序号
  const screenIdx = parseInt(sourceId.split(':')[1] ?? '0', 10);
  inputArgs = [
    '-f', 'lavfi',
    '-i', `ddagrab=output_idx=${screenIdx}:framerate=30,hwdownload,format=bgra,${winScaleFilter}`,
  ];
} else {
  // 窗口录制：gfxcapture，按窗口标题正则匹配
  const escapedTitle = displayTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  inputArgs = [
    '-f', 'lavfi',
    '-i', `gfxcapture=window_title=${escapedTitle}:max_framerate=30,fps=30,hwdownload,format=bgra,${winScaleFilter}`,
  ];
}
```

`getFfmpegPath()` Windows 分支：优先读 `electron/bin/ffmpeg.exe`（gyan.dev full build），不存在则降级 ffmpeg-static（不含 ddagrab/gfxcapture，录制将失败）。

## 待办（需在 Windows 机器上完成）

1. 下载 https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z
2. 解压，将 `bin/ffmpeg.exe` 放入项目 `electron/bin/ffmpeg.exe`
3. 启动应用，验证：
   - 全屏录制：CPU 占用应接近 0%
   - 窗口录制：窗口内容正确捕获，无黑屏

## 历史背景

- 最初使用 `gdigrab`，全屏游戏录制卡顿（GDI BitBlt 阻塞 GPU 管线）
- 改用 `-f ddagrab` 用法错误，报 `Unknown input format`
- 曾计划用 MSYS2 自编译 FFmpeg，已确认不必要，放弃自编译方案
- 相关废弃文档：`FFmpeg-ddagrab-编译指南.md`、`FFmpeg-ddagrab-编译catpaw.md`（可忽略）
