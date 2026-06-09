# Research: 视频时间轴 Tag 功能

## 现有实现调研

### 视频同步机制
- 进度同步通过 `SYNC_PROGRESS` WS 消息广播，调用 `videoRef.current.syncSeek(time)`
- 播放状态同步通过 `SYNC_STATE`（含 `isPlaying` + `currentTime`）
- 切换视频通过 `SWITCH_VIDEO` 消息
- **Tag 跳转** 可复用 `SYNC_STATE` 消息（isPlaying=false，time=tag.time），主控 seek 后广播全员

### Tag 数据存储
- 当前无后端 tag 表，需新增
- Tag 与视频（videoId）关联，非房间级，避免切换视频后 tag 串位
- 需要字段：id, videoId, roomId, time（秒，浮点）, label（文本）, createdBy

### 时间轴组件
- 原生 `<video>` 带有浏览器默认控制栏，需要在播放器**下方**额外渲染一条自定义横轴
- 时间轴宽度对应视频总时长，Tag 位置 = `(tag.time / duration) * 100%`
- 视频 `duration` 需从 `onLoadedMetadata` 事件获取（`video.duration`）
- 目前 `VideoPlayer` 未暴露 `duration`，需要扩展 handle 或通过 props callback 传出

### 权限
- Tag 的增删：仅主控（isController）
- Tag 的跳转：主控点击，跳转后广播全员（与 SYNC_STATE 一致）

---

## 待澄清决策

### Q1：Tag 数据存储在哪里？
- [ ] 待定

### Q2：Tag 跳转时视频播放状态如何处理？
- [ ] 待定

### Q3：多段视频时 tag 如何隔离？
- [ ] 待定（关联 videoId）

---

## 最终决策（待填入）
