# CoWatch Electron 客户端 — 实时录制功能

> **文档定位**：产品 + 技术决策文档，兼作 AI 上下文。具体前后端实现设计另立文档。  

---

## 1. 工程现状

### 已完成模块

| 模块 | 文件 |
|------|------|
| 主进程 + `app://` 协议 | `electron/main.ts` |
| HLS 片段缓存（Main 进程替代 SW） | `electron/handlers/cache.ts` |
| Preload / contextBridge | `electron/preload.ts` |
| Webpack（主进程 + Renderer） | `webpack.electron.js` / `webpack.electron-renderer.js` |
| 打包配置（Windows NSIS + macOS DMG） | `electron-builder.yml` |
| 架构踩坑记录 | `electron/dev-notes.md` |

### 待实现模块

| 模块 | 文件 |
|------|------|
| IPC 录制处理器 | `electron/handlers/recorder.ts` |
| 录制 UI 组件 | `src/components/Recorder/` |
| 后端分片接收 + finish 接口 | 见 §4 |

### 三种运行模式

| 模式 | 命令 | 加载方式 | DevTools |
|------|------|---------|---------|
| `dev` | `npm run electron:dev` | `http://localhost:3001` | ✅ |
| `preview` | `npm run electron:preview` | `app://localhost/index.html`（本地 dist） | ✅ |
| `packaged` | 双击安装包 | `app://localhost/index.html`（本地 dist） | ❌ |

判断依据：`app.isPackaged`（运行时）+ `ELECTRON_PREVIEW` 环境变量。

---

## 2. 已固化的架构约束

以下为**不可更改**的架构决策，写代码时直接遵循，不重新讨论。

### `app://` 协议

业务代码用相对路径写请求（`/api/xxx`），Main 进程 `protocol.handle` 统一拦截转发：后端路径 → `net.fetch(API_ORIGIN + path)`；静态资源 → 本地 `dist/`；HLS 片段 → `cache.ts` cache-first。

`net.fetch` 转发有三个硬性约束（详见 `dev-notes.md`）：
1. 必须删除 `Origin` 头
2. GET/HEAD 不传 body；有 body 加 `duplex: 'half'`
3. **`protocol.handle` 内绝对不能把 `app://` URL 传给 `net.fetch`**（无限递归 → 进程 `SIGTRAP` 崩溃）

### Renderer 不感知 Electron

业务代码中不出现 `__IS_ELECTRON__` 判断、不切换 API URL。`src/utils/env.ts` 是**唯一**可读 `window.electronBridge` 的地方（用于 WS 地址推断）。

### HLS 切片分发

m3u8 切片 URL 格式：`/api/rooms/{roomId}/videos/{videoId}/segments/{segmentName}.ts`，后端鉴权后 302 到 CDN。**不在 m3u8 中写 CDN 绝对 URL**（`app://localhost` 对 CDN 有跨域问题）。

---

## 3. 录制功能规格

### 3.1 功能定位

- 游戏过程中静默录制，**录制期间其他成员不可见**；录制结束后视频自动出现在房间列表
- **不是直播**
- 权限门槛：暂不设，后续迭代决定

### 3.2 两期规划

**第一期（当前目标）：持续录制 + 实时分片上传**

```
ffmpeg 实时编码 → 每 10 秒一个 .ts 切片 → 立即上传 COS → 删除本地临时文件
```

适合"录完整一局复盘"场景，链路最简单。

**第二期（后续迭代）：片段模式**

在第一期基础上加"标记开始/结束"开关，只上传标记区间切片，其余丢弃。**不做完整环形缓冲**（参考 N 卡 Ring Buffer 的思路，但用文件系统滑动窗口实现，Windows 磁盘 IO 管理复杂度高，留后续处理）。

| 维度 | 第一期 | 第二期 |
|------|--------|--------|
| 网络 IO | 持续上传（900p30 ~3~5 Mbps 上行） | 仅保存时上传 |
| 磁盘 | 传完即删 | 滑动窗口保留最近 N 片 |
| 实现难度 | 中 | 高（窗口管理 + 切片边界） |
| COS 成本 | 全程上传 | 只计保存部分 |

### 3.3 录制方案

**已选**：`ffmpeg-static`（npm 包内置各平台二进制）+ `child_process.spawn`。

理由：性能等同系统 ffmpeg、可调用 NVENC/AMF/QSV 硬件编码器、用户零依赖。WASM 版（`@ffmpeg/ffmpeg`）无法调用硬件编码器，排除。

### 3.4 屏幕捕获

`desktopCapturer.getSources()` 取窗口列表 → 用户选择 → ffmpeg 通过 `-f gdigrab`（Windows）直接捕获，不经过浏览器 `getDisplayMedia`。

### 3.5 编码器优先级

录制 UI 挂载时提前检测（约 1~2 秒），**不等用户点"开始"**：

```
h264_nvenc（NVIDIA）→ h264_amf（AMD）→ h264_qsv（Intel）→ libx264（软件兜底）
检测命令：ffmpeg -f lavfi -i nullsrc -t 1 -c:v {encoder} -f null - 返回码 0 = 支持
```

软件编码（`libx264`）在低配笔记本会导致游戏卡顿，见 §5 处理方案。

### 3.6 切片参数与质量档位

**第一期固定参数**（hardcode 在 `recorder.ts`，不对外暴露）：

```bash
ffmpeg -f gdigrab -framerate 30 -i title="..." \
  -c:v {encoder} -crf 30 -g 300 \
  -f hls -hls_time 10 -hls_list_size 0 \
  -hls_segment_filename "{tmpDir}/seg%03d.ts" \
  "{tmpDir}/index.m3u8"
```

| 档位 | 参数 | 典型码率 | 2h 预估大小 | 触发方式 |
|------|------|----------|------------|---------|
| 900p30（唯一档位） | `-s 1600x900 -r 30 -crf 30` | 3~5 Mbps | 2.7~4.5 GB | 正常录制 |
| 480p30（降级兜底） | `-s 854x480 -r 30 -crf 30` | <1 Mbps | <0.9 GB | 软编 + CPU 高负载时自动触发，不暴露给用户 |

参数客户端侧无需防篡改——能解包 asar 的用户同样能绕过任何客户端限制；实际危害仅是"上传更高质量视频"，成本影响极小。若需限制，控制点在**服务端**校验文件大小/时长。

### 3.7 IPC 架构

待实现：`electron/handlers/recorder.ts`

```
Renderer → ipcRenderer.invoke('recorder:start', { windowId, quality })
Main Process
  ├─ spawn ffmpeg
  ├─ fs.watch(tmpDir) → 新 .ts 片段 → uploadSegment() → 失败入重试队列（不阻塞录制）
  └─ ipcMain.send('recorder:progress', { segCount })

Renderer → ipcRenderer.invoke('recorder:stop')
Main Process
  ├─ SIGTERM → ffmpeg 写 #EXT-X-ENDLIST 后退出
  ├─ 等待所有片段上传完成
  └─ POST /recording/finish → 后端生成 m3u8 → 广播 VIDEO_ADDED
```

`electron/preload.ts` 新增 `contextBridge.exposeInMainWorld('recorder', { detectEncoder, getSources, start, stop, onProgress })`。

---

## 4. 后端改动方向

- 新增 2 个接口：接收单片切片、录制结束通知（接口详细设计在 change 文档中）
- **切片由客户端编码完成，后端不转码，直接存 COS**
- 录制结束后复用现有 `hlsService.generateM3u8`，广播 `VIDEO_ADDED`
- 播放路径复用现有 segment 代理接口，无需改动

---

## 5. 已知风险 & 兼容性

| 级别 | 问题 | 触发场景 | 处理方案 |
|------|------|----------|----------|
| 高 | DX12 独占全屏黑屏 | 部分 DX12 游戏全屏 | 首次使用弹窗引导改为无边框窗口化 |
| 高 | 软件编码导致游戏卡顿 | 无独显老笔记本 | 检测到软编弹窗提示；自动降 480p30 |
| 高 | 网络中断切片丢失 | 上传途中断网 | 两层策略：①单片 `p-retry` 3 次（1s~8s，随机抖动）处理瞬时抖动；②耗尽后片段入 `pending` 队列，监听网络恢复后批量补传；UI 显示"录制中，X 片待上传" |
| 高 | 录制中应用崩溃 | 内存不足 / ffmpeg 异常 | 监听 ffmpeg `close`，自动重启从断点续录 |
| 中 | 老驱动 NVENC 不可用 | N 卡驱动 < 2019 | 编码器检测失败自动降级 |
| 中 | 多显示器 / 游戏在副屏 | 副屏游戏 | UI 列出所有窗口/显示器供选择 |
| 中 | 双显卡（核显 + 独显） | 笔记本常见 | ffmpeg 可能默认核显，需指定设备索引；待测试 |
| 中 | Win10 1903 以下 | 老系统 | 标注最低要求：Win10 1903+ |
| 低 | 录制中切换分辨率 | — | 重启 ffmpeg，新建片段序列 |

---

## 6. 开发注意事项

1. **编码器检测提前**：录制 UI 挂载时（`useEffect`）就检测，不等用户点"开始"
2. **上传与录制解耦**：上传失败入重试队列，不中断 ffmpeg 进程
3. **切片重试用 `p-retry`**：`pRetry(uploadFn, { retries: 3, minTimeout: 1000, maxTimeout: 8000, randomize: true })`。4xx 不重试，只重试网络错误和 5xx。3 次耗尽后片段进 `pending` 队列（不是丢弃），另起网络恢复监听器批量补传。同一库后续可用于 WS 重连和手动上传重试，参数分别配置，不需封装。
4. **结束后才广播**：ffmpeg 写入 `#EXT-X-ENDLIST` 后才调 `/recording/finish`
5. **临时文件清理**：录制结束且所有片段上传完成后删除 `tmp/cowatch-rec/{sessionId}/`；下次启动时清理崩溃遗留目录
6. **Windows 打包签名**：未签名应用在 Win11 触发 SmartScreen 警告；内测可接受，上线需代码签名证书（¥500~1500/年）
7. **自动更新**：`electron-updater` 已配置 GitHub Releases；录制逻辑变更时强制升级

---

## 7. 成本参考

单次 2 小时录制、8 人观看一遍：

| 费用项 | 900p30 |
|--------|--------|
| COS 上传 | 免费 |
| COS 存储（/月） | ~¥0.3 |
| CDN 播放（8 人） | ~¥2.4 |
| 服务器转码 | **¥0**（客户端编码，后端直存） |

---

## 8. 开发前需确认的问题

- [x] 单次录制时长上限：**2 小时**。超时自动停止并提示用户点击「开启新一轮」可重新计时，将前一段录制整体当一个视频归档。
- [x] 软件编码低配设备：指无独显、只能用 `libx264` 的设备。处理方案：**自动降到 480p30 并展示弹窗警告**，不禁用录制（用户可自行决定是否继续）。
- [x] 网络中断处理：不设定"彻底失败"目标。片段永远保留在本地直到确认上传成功，网络恢复后自动补传，不需用户操作。
- [x] 录制视频默认标题：**自动录制 + 日期 + 开始时间**，格式如「自动录制 2026-06-27 20:30」。
