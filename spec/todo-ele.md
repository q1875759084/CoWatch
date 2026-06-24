# Electron 实时录制客户端 — 技术备忘

## 功能定位

pro 会员增值功能。用户在游戏过程中后台静默录制，边录边上传切片；录制结束后房间视频列表自动出现该录屏，供所有成员回放。**不是直播**，录制期间其他成员不可见内容。

---

## 技术选型

### 工程框架
- **electron-vite**：官方推荐脚手架，支持 React + TypeScript，热更新开箱即用
- UI 层复用现有 CoWatch React 组件，零迁移成本

### 录制方案：ffmpeg 子进程（路线 A，推荐）
- 用 `ffmpeg-static` npm 包内置各平台 ffmpeg 可执行文件（包体积 +60-80MB）
- Main Process 通过 `child_process.spawn` 调用 ffmpeg
- ffmpeg 命令参数与现有 `.bat` 脚本一致（`-crf 30 -g 300` 等）
- 完全绕开手写 MPEG-TS muxer 的复杂度

### 屏幕捕获
- `desktopCapturer.getSources()` 获取所有窗口列表
- 捕获源传给 Renderer 的 `getDisplayMedia({ video: { mandatory: { chromeMediaSource, chromeMediaSourceId } } })`
- ffmpeg 通过 `-f gdigrab`（Windows）或 `-f avfoundation`（Mac）直接捕获窗口，无需经过浏览器

### 编码器优先级（ffmpeg 参数层面）
```
1. NVENC（N卡）：-c:v h264_nvenc
2. AMF（A/AMD卡）：-c:v h264_amf
3. QSV（Intel核显）：-c:v h264_qsv
4. 软件编码兜底：-c:v libx264
```
启动时依次尝试，`ffmpeg -f lavfi -i nullsrc -t 1 -c:v h264_nvenc -f null -` 返回 0 则支持。

### 切片策略
- `-f hls -hls_time 10 -hls_segment_filename seg%03d.ts`
- ffmpeg 输出 HLS 流到本地临时目录，每生成一个 `.ts` 片段立即上传 COS
- `.ts` 容器天然无 moov 索引问题，每片独立可解码

### 质量档位
| 档位 | 参数 | 典型码率 | 2小时大小 |
|------|------|----------|-----------|
| 720p30（默认） | `-s 1280x720 -r 30 -crf 30` | 2-3 Mbps | 1.8-2.7 GB |
| 1080p30 | `-s 1920x1080 -r 30 -crf 30` | 4-6 Mbps | 3.6-5.4 GB |
| 1080p60 | `-s 1920x1080 -r 60 -crf 30` | 7-10 Mbps | 6.3-9 GB |

### 进程架构（IPC 桥）
```
Renderer（React UI）
  └─ window.recorder.startRecording(windowId)
       ↓ ipcRenderer.invoke
Main Process
  └─ 启动 ffmpeg 子进程
  └─ 监听 /tmp/hls/ 目录新文件 → 上传 COS → ipcMain 回调进度
       ↓ ipcRenderer.send('upload-progress', pct)
Renderer
  └─ 更新进度 UI
```

---

## 后端改动（小）

新增 2 个接口：

1. `POST /api/rooms/:roomId/segment` — 接收单个 `.ts` 片段（或直传 COS 后通知后端记录）
2. `POST /api/rooms/:roomId/recording/finish` — 录制结束，后端用已记录的片段列表生成 m3u8，广播 `VIDEO_ADDED`

`hlsService.generateM3u8` 已存在，可直接复用。

---

## 成本估算（单次录制，8人观看）

| 费用项 | 720p30 | 1080p60 |
|--------|--------|---------|
| COS 上传 | 免费 | 免费 |
| COS 存储（/月） | ¥0.2 | ¥0.9 |
| CDN 播放（8人） | ¥1.6 | ¥7.2 |
| 服务器转码 | ¥0（客户端编码） | ¥0 |

---

## 已知风险 & 兼容性问题

### 高风险
| 问题 | 触发场景 | 处理方案 |
|------|----------|----------|
| DX12 独占全屏黑屏 | 部分 DX12 游戏全屏模式 | 引导用户改为「无边框窗口化」，首次使用必看提示 |
| 软件编码导致游戏卡顿 | 无独显老笔记本 | 自动降为 480p30；弹窗提示"建议降低画质" |
| 网络中断切片丢失 | 上传途中断网 | 本地保留已切片文件，重连后补传；记录已上传片段序号 |

### 中风险
| 问题 | 触发场景 | 处理方案 |
|------|----------|----------|
| 老驱动 NVENC 不可用 | N卡驱动版本 < 2019 | 自动降级到软件编码，日志记录 |
| 多显示器游戏在副屏 | 副屏游戏 | UI 列出所有窗口/显示器供用户选择 |
| ffmpeg 子进程崩溃 | 内存不足 / 异常帧 | 监听 `close` 事件，自动重启并从断点续录（按片段序号） |
| Windows 10 兼容性 | Win10 1903 以下 | `desktopCapturer` 需要 Electron 9+，标注最低系统要求 |

### 低风险
- 笔记本双显卡（核显 + 独显）：ffmpeg 可能默认用核显编码器，需指定设备索引
- 录制时用户切换分辨率：需重启 ffmpeg 进程并新建片段序列

---

## 开发注意事项

1. **不要在 Renderer 直接调用 ffmpeg**，所有进程操作必须在 Main Process，通过 `contextBridge` 暴露受控 API
2. **硬件编码器检测必须在录制前完成**，不能等用户点"开始"后再检测（有 1-2 秒延迟）
3. **片段上传失败不能阻塞录制**，上传和录制解耦：录制继续，失败片段进入重试队列
4. **录制结束前不向房间广播**，`#EXT-X-ENDLIST` 写入 m3u8 后再触发 `VIDEO_ADDED`
5. **本地临时文件清理**：录制结束且所有片段确认上传后，清理本地 `/tmp/cowatch-rec/` 目录
6. **Windows 打包签名**：未签名的 Electron 应用在 Win11 会触发 SmartScreen 警告，需要代码签名证书（约 ¥500-1500/年）
7. **自动更新**：用 `electron-updater`，发布新版本时强制更新（录制逻辑变更必须同步）

---

## 开发阶段建议

内测阶段不做此功能，等以下条件满足后再开发：
- pro 会员有稳定用户基础（验证付费意愿）
- 服务器转码方案（`-c copy` 或独立转码机）已稳定
- 有至少 2 台不同显卡配置的 Windows 机器用于兼容测试
