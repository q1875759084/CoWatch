# CoWatch 二期 TODO

---

## 一期当前待解决：SW 缓存并发爆炸（最小改动方案）

**问题**：缓存未命中时 SW 发完整文件请求，用户 seek 触发多个并发完整请求，永远无法完成缓存。  
实测：seek 3 次 = 4 条 197MB 请求（788MB 流量）。

**一期方案：inFlight 去重（方案 D）**  
在 `sw.ts` 中维护 `Map<cacheKeyUrl, Promise<Response>>`，保证同一视频同时只有一个完整下载在飞行中。  
改动范围：仅 `sw.ts`，约 20 行，无架构变化，无新依赖，无新风险。

---

## 二期备选方案（按优先级排序）

### 方案一：IDB 固定分块缓存

**核心思路**：用 IndexedDB 替换 Cache Storage 作为缓存层，按 2MB 固定块存储视频字节。

- 绕开 Cache API 不支持存 206 的限制
- 按需缓存：用户实际播放了哪些片段就缓存哪些，流量 1:1，无预缓存浪费
- 匹配复盘场景：长视频反复跳转特定片段，命中率高

**关键设计**：
- `video_blocks` store：key = `${purePathUrl}:${blockIndex}`，value = `Uint8Array`（最多 2MB）
- `video_meta` store：key = `purePathUrl`，value = `{ totalSize, contentType, cachedBlocks: Set<number> }`
- `blockInFlight` Map：同一块并发请求去重，等待同一 Promise，不发第二个 CDN 请求
- cache key 同样用 `stripCosSignature` 剥离签名，跨天复盘命中缓存
- 容量上限：2GB，超出按 LRU 淘汰最久未访问的视频块

**前置条件**：
- 签名有效期从 30 分钟调整为 2 小时（覆盖单次复盘 session）
- SW 收到 CDN 403 时 fallback 透传 + postMessage 页面刷新签名（兜底）
- 后端 SWITCH_VIDEO 广播附带 `fileSize` 字段（避免 SW 发探测请求获取 totalSize）

**改动范围**：`sw.ts`（重写缓存逻辑）、`ossService.ts`（签名时长）、`wsServer.ts`（附带 fileSize）、前端 postMessage 触发签名刷新协议

---

### 方案二：服务端 HLS 切片

**核心思路**：上传时服务端用 ffmpeg 将视频切成固定时长 fragment（如 15s 一片），生成 m3u8 playlist，播放器用 hls.js 加载。

- 每个 fragment 是完整 200 响应，Cache API 直接支持，SW 缓存逻辑退化为标准 cache-first
- seek 直接跳到目标 fragment，只下那一段，流量精准
- SW 代码复杂度大幅降低（无需 TransformStream 切片、无需 IDB）

**代价**：
- 上传流程必须走后端（ffmpeg 切片），白名单直传 COS 优势消失
- 后端需要 ffmpeg 依赖 + 切片处理时间（~10-30s/视频）
- CDN 签名在 HLS 下更复杂：需后端动态生成含最新签名的 m3u8（不能静态存 COS）
- 前端引入 hls.js（~200KB）

**适合场景**：作为长期架构演进方向，彻底解决 Range 缓存问题，但改动面覆盖前后端全链路。

---

## 其他积压 TODO（从 dev-notes.md 抽离）

### 后端

- **视频码率阈值动态化**：当前硬编码 8 Mbps（CRF 28），后续根据房间/会员等级动态调整（14 Mbps 对应 CRF 23）

### 前端

- **RoomContext 状态管理迁移**：`RoomContext` 中实时更新的业务状态（`members`、`videos`、`controllerId`、`activeVideoUrl`）迁移到 Zustand 或 Jotai，`UserContext` 保持不变，消除不必要的全树重渲染

- **鼠标位置共享（全屏支持）**：一期鼠标共享仅支持非全屏模式。全屏支持需将全屏目标从 `<video>` 元素改为播放器父容器（`.playerRatio`），光标覆盖层作为容器子节点随之进入全屏层，才能在全屏画面中渲染他人光标。具体改动：隐藏原生 `<video controls>` 的全屏按钮（CSS `::-webkit-media-controls-fullscreen-button`），在 `VideoPlayer` 外层叠加自定义全屏按钮，调用容器的 `requestFullscreen()`；全屏状态通过 `document.fullscreenchange` 事件同步，光标坐标百分比逻辑不变。

- **【Bug】自由模式下控制权交接后新主控画布空白**：b 处于自由模式（`PainterLayer` 未挂载，未接收实时笔迹）→ a 画了笔迹 → a 将控制权交给 b → b 成为主控后 `PainterLayer` 重新挂载，但历史笔迹丢失，画布空白。根因：`TRANSFER_CONTROL` 只广播 `CONTROL_CHANGED`，不携带历史笔迹。**修复方案**：引入独立的 `STROKES_SYNC` 消息（只携带 `strokes`，不含 `videoUrl/isPlaying` 等播放状态），在 `TRANSFER_CONTROL` 和断线自动交接两处，给新主控单播此消息；前端 `useRoomWs.ts` 新增 `STROKES_SYNC` case，`types/room.ts` 新增对应类型。**注意不能复用 `ROOM_STATE`**：`ROOM_STATE` 含 `videoUrl/activeObjectKey/isPlaying/currentTime`，会触发切视频和 seek，破坏新主控当前的播放状态。
