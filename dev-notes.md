# CoWatch 开发笔记

## 架构决策

### 多人视频同步方案选型

**背景：** 需要多个浏览器客户端实时同步视频播放进度。

**结论：** 选用 WebSocket（服务端广播进度事件给所有房间成员）。

**为什么不用 WebRTC DataChannel：** P2P 方案需要信令服务器，多人场景（>2人）网状连接复杂度高，维护成本大。

**为什么不用轮询：** 每隔 N 秒拉取进度会有明显延迟，进度条抖动体验差，且服务器压力随人数线性增长。

---

### 视频存储选 COS 预签名直传

**背景：** 房主需要上传录屏视频供所有成员播放。

**结论：** 前端直传腾讯云 COS，服务端只负责生成预签名 PUT URL 和保存访问 URL，不经手视频流。

**原因：** 服务器零带宽压力，所有成员直接从 CDN 拉流，播放流畅；服务端只同步进度控制事件，职责清晰。

**迁移记录：** 2026-06 从阿里云 OSS 切换到腾讯云 COS（`cos-nodejs-sdk-v5`），`ossService.ts` 完全重写，对外接口签名不变，Controller 和路由零改动。详见 `docs/cos-setup.md`。

---

### OSS 预签名直传的安全边界与上传防护设计

**背景：** 采用 OSS 预签名直传后，文件完全绕过后端，后端在上传过程中对文件内容一无所知，无法在服务端校验文件大小、码率等。需要明确各种防护手段的有效边界。

**OSS 直传链路（关键认知）：**
```
① GET /api/rooms/:roomId/upload-url  → 后端生成预签名 URL 返回前端（后端不知道文件大小）
② PUT https://oss.xxx.com/...        → 前端直接上传到 OSS，完全绕过后端
③ PUT /api/rooms/:roomId/video       → 前端通知后端 confirm，只传 videoUrl 字符串
```
后端在整个过程中看不到文件，只能在 ① 和 ③ 两个节点做控制。

**各防护手段的可靠性分析：**

| 手段 | 有效性 | 说明 |
|------|--------|------|
| IP 限速 | ❌ 无效 | 文件不经后端，IP 无法感知上传流量；内网多人共用一个 IP 也会误伤 |
| fileSize 参数校验 | ❌ 不可靠 | 客户端传入，脚本直接写 `fileSize=1` 绕过 |
| 文件切片 + 时长上报 | ❌ 不可靠 | 同样来自客户端，可任意伪造 |
| Sec-Fetch 请求头校验 | ⚠️ 增加成本 | 浏览器自动注入且 JS 无法修改，脚本默认不带；但 Postman/Python 可手动添加 |
| userId 每日调用次数限制 | ✅ 有效（次数维度） | 后端内存计数，可靠；但无法限制单文件大小 |
| OSS Policy `content-length-range` | ✅ 最可靠 | OSS 服务端强制执行，客户端无法绕过，切换 COS 时启用 |
| 前端码率校验 | ✅ 覆盖误操作 | 挡住正常用户，定位是"用户教育"而非安全边界 |

**~~当前落地方案（已废弃，见下方「最终落地方案」）~~**

~~挂载在 `GET /upload-url` 上，三层校验：~~
1. ~~**Sec-Fetch 请求头校验**：两个头都不存在则拒绝~~
2. ~~**userId 每日调用 `upload-url` 次数限制**：默认 10 次，内存 Map 按日重置~~
3. ~~**白名单豁免**：`users.is_upload_whitelist = 1` 的用户不受次数限制~~

> **废弃原因：** 次数限制防不住"每次上传小文件"的绕过方式，攻击者可以在 10 次配额内反复上传占满 OSS；同时 `upload-url` 节点后端看不到文件，无法感知真实流量。改为分流架构（见下方）。

---

**最终落地方案（`middleware/uploadGuard.ts` + `controller/proxyUpload`）：**

**上传链路按白名单分流：**

| 用户类型 | 上传路径 | 说明 |
|---------|---------|------|
| 白名单用户（`is_upload_whitelist = 1`） | COS 直传 | `getUploadUrl` 返回 OSS 预签名 URL，前端直接 PUT，不经后端，`mode` 为空 |
| 非白名单用户 | 后端代理中转 | `getUploadUrl` 返回 `mode: 'proxy'`，前端 POST 到 `/upload-proxy`，后端流式转发到 OSS |

**`uploadGuard` 中间件（挂载在 `POST /:roomId/upload-proxy`）：**
1. **Sec-Fetch 请求头校验**：两个头都不存在则拒绝（增加脚本伪造成本）
2. **每日中转总字节数预检**：用 `Content-Length` 做快速判断，超过 5GB 则拒绝
3. **实际计费**：文件真实写入 OSS 完成后，通过 `addDailyBytes(userId, realBytes)` 计入当日用量（防止恶意请求用声明大小占用配额）

**代理上传流程（零临时文件）：**
```
① GET /upload-url → 后端返回 { mode: 'proxy', uploadUrl: '/upload-proxy?objectKey=...&fileType=...&fileName=...' }
② POST /upload-proxy → uploadGuard 预检 → req 可读流直接 putStream 到 OSS → 完成后 addDailyBytes + 写库广播
```

**白名单操作（无需重启服务，直接改数据库即时生效）：**
```sql
-- 旧数据库迁移（新建数据库无需执行）
ALTER TABLE users ADD COLUMN is_upload_whitelist INTEGER NOT NULL DEFAULT 0;

-- 设置白名单
UPDATE users SET is_upload_whitelist = 1 WHERE username = '目标用户名';
```

**TODO（接入腾讯云 COS 时）：**
- 白名单用户的 `getUploadUrl` 中启用 Policy `content-length-range`，单文件上限 4GB（1小时 × 8Mbps ÷ 8）

---

### nginx 大小限制职责分层

**背景：** 宿主机 nginx 默认 `client_max_body_size 1MB`，大文件上传被 413 拦截，但容器内 nginx 已设 `4096M`。由此引发对"应该在哪一层做大小限制"的讨论。

**结论（三层职责分层）：**

| 层级 | 配置值 | 职责说明 |
|------|--------|---------|
| 宿主机 nginx | `client_max_body_size 0` | 纯透传，不感知业务，避免在容器内 nginx 之前就 413 拦截 |
| 容器内 nginx | `client_max_body_size 8192M` | 粗粒度防御上限，防异常超大请求打穿，与具体业务边界解耦 |
| 后端各接口 | 精细业务限制（如单文件 4GB） | 唯一的业务卡点，可按接口/角色动态控制，错误返回结构化 JSON |

**为什么不在两层 nginx 都配业务值：**
- 维护点分散，nginx 和后端容易出现不一致（改了后端忘改 nginx）
- nginx 返回 413 是 HTML，用户体验差；后端可返回结构化 JSON
- 后端逻辑更灵活，可按接口、用户角色动态控制上限

**关键认知：** 两层 nginx 各自独立检查 `client_max_body_size`，宿主机 nginx 的检查在容器内 nginx 之前，设错了直接导致容器内配置失效。

---

### CDN 流量优化演进路线（转码 + Service Worker）

**背景：** 游戏录屏 1080p60 H264，30 分钟约 2.6GB。8 人复盘，主控反复在多个视频片段之间切换，浏览器无法有效缓存视频，每次切换几乎等于重新下载。

**问题量化（腾讯云 CDN，0.21 元/GB）：**

| 方案 | 8人极端场景一晚流量 | 一晚费用 | 月费（每周2次）|
|------|-------------------|---------|--------------|
| 原始方案（无转码、无SW） | ~187GB | ~40 元 | ~320 元 |
| 仅 FFmpeg 转码（CRF 28） | ~23GB | ~5.3 元 | ~42 元 |
| 转码 + Service Worker | ~7.7GB | ~2.1 元 | ~17 元 |

**三阶段演进：**

**① 原始方案**：录屏直传 OSS，浏览器无视频缓存，每次切换片段重新下载 2.6GB，8人每晚约 **187GB / 40元**。

**② FFmpeg 本地转码（CRF 28 + faststart）**：
- 用户上传前在本地用脚本转码，30 分钟从 2.6GB 压缩到 **320MB**（约 1/8）
- 同时将 `moov` atom 移到文件头（`-movflags +faststart`），解决 seek 卡顿问题
- 单项优化收益最大：流量降至 23GB，费用 **降低 87%**
- 实现成本极低：后端提供静态 `.bat` 脚本下载，前端加下载按钮

**③ Service Worker 视频缓存**：
- SW 拦截视频的 Range 请求，首次请求时拉取完整文件写入 Cache Storage（磁盘级缓存）
- 后续所有 Range 请求（seek、重复播放、切换回来）直接从缓存切片返回 206，不产生任何网络流量
- 腾讯云 COS + CDN 原生支持 Range 请求（`206 Partial Content`），可直接对接
- 注意：SW 缓存 Range 响应需手动处理分片重组，不能直接用 `cache.match`（详见下方"SW 视频缓存：Range 请求重组与预缓存"）
- 在转码基础上再降 66%：7.7GB / 2.1 元，月费 **17 元**

**关键洞察：**
- **转码是单项收益最大的优化**，从 40 元 → 5 元，且实现成本极低（静态脚本分发）
- **SW 在反复切换场景才显著**，如果复盘时每段只看一遍，转码后不加 SW 费用也在 2–3 元
- **CRF 不控制文件大小，控制质量下限**——原文件已高度压缩时，CRF 23（高质量档）反而比原文件更大（见下方"FFmpeg CRF 反直觉"）

---

## 工具与概念

### SW 视频缓存：Range 请求重组与预缓存

**背景：** 视频播放器不会一次性请求整个视频文件，而是通过多个 `Range` 请求分段拉取（如 `bytes=0-65535`）。这导致两个问题需要解决：

**问题一：无法直接缓存 Range 响应**

普通资源可以用 `cache.match(request)` 直接命中缓存。视频 Range 请求每次的 Range 区间不同，相同 URL 的请求因 Range 头不同而无法直接命中。

**解决：** 缓存策略改为"缓存完整文件，按需切片返回"：
1. 首次遇到某视频 URL → 发起**无 Range 的完整请求**，将整个文件存入 Cache Storage
2. 后续任意 Range 请求 → 从缓存的 `ArrayBuffer` 中 `.slice(start, end+1)` 切片，构造 `206 Partial Content` 响应返回
3. 缓存 key 统一为不带请求头的 URL，确保不同 Range 请求都能命中同一缓存条目

**问题二：SW 激活窗口期导致非主控成员缓存 miss**

SW 生命周期：`注册 → install → wait → activate`，activate 完成后才能拦截请求。首次访问时有短暂窗口期，若视频 Range 请求早于 SW activate 触发（多发生在非主控成员进入房间时），这些请求直接到达服务器，SW 无法缓存，后续 seek 仍产生真实流量。

**解决：主动预缓存（postMessage 协议）**

页面拿到视频列表后立即通过 `postMessage` 通知 SW，SW 在后台逐个下载并缓存所有视频，无需等待用户播放：

```ts
// Lobby/index.tsx：视频列表加载后通知 SW
navigator.serviceWorker.ready.then((reg) => {
  reg.active?.postMessage({ type: 'PRECACHE_VIDEOS', urls: videoUrls });
});
```

```ts
// sw.ts：接收指令，后台串行下载缓存
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PRECACHE_VIDEOS') return;
  event.waitUntil(precacheVideos(event.data.urls));
});
```

**DevTools 验证方法：**
- Application → Cache Storage → `cowatch-video-v1`：确认视频文件已缓存，`Content-Length` 与文件大小一致
- Application → Service Workers → 点击 `sw.js` 链接 → SW 专属 Console 查看 `[SW] 缓存命中 / 缓存未命中` 日志
- Network 面板大小列显示 `(ServiceWorker)` = 所有请求经过 SW 处理（含缓存命中和首次下载两种情况，无法仅凭此区分）

**注意：** `(ServiceWorker)` 出现在大小列不代表命中缓存，只代表请求经过了 SW 的 fetch 事件。区分命中缓存的方式：看响应头是否只有 SW 自己构造的 4 个字段（无 `ETag`、`Last-Modified`、`Server` 等服务端原生响应头）。

---

**⚠️ 演进：V1 方案的性能陷阱 → V2 Range 片段级缓存**

**V1 方案（已废弃，保留供参考）：**

缓存完整文件，按需切片返回。核心逻辑：

```ts
// fetch 拦截：首次请求时拉完整文件存入缓存
const cacheKey = new Request(request.url, { headers: {} }); // 去掉 Range 头作为 key
const cachedResponse = await cache.match(cacheKey);
if (cachedResponse) {
  // 命中缓存 → 读整个 ArrayBuffer 再切片返回
  return buildRangeResponse(cachedResponse, rangeHeader);
}
// 未命中 → 发无 Range 的完整请求，缓存整个文件
const fullResponse = await fetch(new Request(request.url, { headers: {} }));
await cache.put(cacheKey, fullResponse.clone());

// buildRangeResponse 的问题所在：
async function buildRangeResponse(cachedResponse, rangeHeader) {
  const arrayBuffer = await cachedResponse.clone().arrayBuffer(); // ← 每次把整个文件读进内存
  const { start, end } = parseRange(rangeHeader, arrayBuffer.byteLength);
  return new Response(arrayBuffer.slice(start, end + 1), { status: 206, ... });
}
```

**V1 的致命问题：** 每次 Range 请求都会把整个文件（300MB）读入内存做 `arrayBuffer()`。主控 seek 一次 → 非主控触发多次 Range 请求 → 每次都是 300MB 内存操作 → SW 线程阻塞 → 画面卡顿逐秒变化。

---

**V2 方案（当前，Range 片段级缓存）：**

以 `URL + Range头` 作为缓存 key，每个片段独立存储，命中时直接返回对应片段，无需读取整个文件：

```ts
// 缓存 key = URL + '?_range=' + encodeURIComponent(rangeHeader)
// 注意：Cache API 禁止带 # fragment 的 URL 作为 key（静默失败），必须用 query 参数
function buildCacheKey(url: string, rangeHeader: string | null): string {
  if (!rangeHeader) return url;
  return `${url}?_range=${encodeURIComponent(rangeHeader)}`;
}

// fetch 拦截：精确匹配 Range 片段
const cacheKeyStr = buildCacheKey(request.url, rangeHeader);
const cachedResponse = await cache.match(new Request(cacheKeyStr));
if (cachedResponse) {
  return cachedResponse.clone(); // ← 直接返回，无内存操作
}
// 未命中：透传请求，将响应片段写入缓存
const response = await fetch(request.clone());
await cache.put(new Request(cacheKeyStr), response.clone());
```

**V2 的预缓存：** 先用 `Range: bytes=0-0` 探测文件总大小，再按 4MB 分片逐个下载写入缓存，与浏览器播放器的常见 Range 分片大小对齐，命中率高。

**Cache Storage 里的变化：** V1 每个视频 1 条记录（完整文件）；V2 每个视频约 `文件大小 ÷ 4MB` 条记录（如 300MB 文件 ≈ 75 条片段）。

---

**⚠️ 演进：V2 方案不可行 → V3 完整文件缓存 + ReadableStream 流式切片（当前）**

**V2 的根本问题：Cache API 不支持存储 206 响应。**

```
TypeError: Failed to execute 'put' on 'Cache': Partial response (status code 206) is unsupported
```

Cache Storage 只能存储 `200 OK` 响应，存 `206 Partial Content` 会直接抛异常。V2 的"Range 片段级缓存"方案在浏览器层面不可行。

**V3 方案：回到 V1 的"缓存完整文件"思路，但用 ReadableStream 替换 ArrayBuffer 切片。**

V1 的性能问题出在 `arrayBuffer()` 把整个文件读进内存，V3 改用 TransformStream 流式跳过前 N 字节，只传输目标 Range 区间：

```ts
// 流式切片，不把整个文件读入内存
function buildRangeResponseFromStream(cachedResponse, range, totalSize, contentType) {
  const { start, end } = range;
  let bytesSkipped = 0;
  let bytesSent = 0;

  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      const chunkStart = bytesSkipped + bytesSent;
      const chunkEnd = chunkStart + chunk.byteLength - 1;
      if (chunkEnd < start) { bytesSkipped += chunk.byteLength; return; }  // 目标区间之前，跳过
      if (chunkStart > end) { controller.terminate(); return; }            // 目标区间之后，终止
      const slice = chunk.slice(Math.max(0, start - chunkStart), Math.min(chunk.byteLength, end - chunkStart + 1));
      bytesSent += slice.byteLength;
      controller.enqueue(slice);
      if (bytesSent >= end - start + 1) controller.terminate();
    },
  });
  cachedResponse.clone().body.pipeTo(writable).catch(() => {}); // terminate 后 pipeTo 会抛 AbortError，正常忽略
  return new Response(readable, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${totalSize}`, ... } });
}
```

**Cache Storage 里的变化：** V3 与 V1 相同，每个视频 1 条完整文件记录。

---

**⚠️ 踩坑：无痕模式下 SW 缓存始终为空**

**现象：** 用无痕窗口模拟第二个用户，Cache Storage 始终为空，SW Console 报 `Unexpected internal error`，`cache.put` 静默失败。

**根因：** 无痕模式的 Cache Storage 配额极低（通常 < 100MB），300MB 以上的视频文件超出配额，`cache.put` 抛异常。这是浏览器的固有限制，与 SW 实现无关。

**解决：用 Chrome 多用户 Profile 代替无痕窗口**

右上角头像图标 → **添加 Chrome 个人资料** → 新窗口打开测试链接。多 Profile 是完全独立的浏览器环境，有完整的 Cache Storage 配额，同时与主窗口的登录态、缓存完全隔离，是模拟多用户的正确方式。

> Edge 基于 Chromium，与 Chrome 对 SW / Cache Storage 的支持完全一致，也可以作为第二个客户端。Safari 的 SW 支持较保守（`TransformStream`、`pipeTo` 在旧版不可用，且 SW 生命周期更激进），调试阶段不建议用 Safari 测试 SW 逻辑。

---

### FFmpeg CRF 参数：控制质量下限而非文件大小上限

**背景：** 用 CRF 23（高质量档）对原始录屏转码，输出文件反而比原文件更大（529MB → 540MB）。

**根因：** CRF（Constant Rate Factor）控制的是**质量下限**，不是文件大小：
- CRF 越小 → 质量越高 → 编码器保留更多细节 → 文件可能更大
- 当原文件已经是高压缩率编码（如 NVENC 高码率模式），其质量本身就低于 CRF 23 的标准，libx264 会"补回"原文件丢弃的细节，导致输出更大

**结论：**
- 对已高度压缩的录屏，CRF 23 无意义，应直接用 CRF 26–28
- 实测 CRF 28 下，30 分钟录屏从 ~2.6GB → **320MB**（约 1/8），游戏画面复盘清晰度可接受
- CRF 选择参考：23=高质量、26=均衡、28=小文件（游戏复盘推荐 28）

---

### Context 职责边界：依赖注入 vs 状态管理

**背景：** `RoomContext` 将 `members`、`videos`、`controllerId`、`activeVideoUrl` 等实时更新的字段全部放在同一个 `value` 对象里，任意字段变化都会导致整棵 Provider 子树重渲染。

**根因：** Context 底层用引用相等性（`===`）比较，没有"订阅某个 key"的能力，只有"订阅整个 context value"的能力。本质上 Context 是**依赖注入**机制，不是状态管理：

- **适合 Context 的场景**：主题（dark/light）、i18n locale、当前登录用户信息、路由/认证状态——变化极低频的"配置型数据"
- **不适合 Context 的场景**：频繁更新的业务状态（房间成员、播放进度、视频列表）——每次更新都会让所有消费组件重渲染

**真正的状态管理解决了什么：** Zustand / Jotai 的核心能力是**发布订阅 + selector 精细订阅**，只有 selector 返回值变化才通知对应组件，互相完全隔离：

```ts
// Zustand：只订阅 controllerId，members 变化不触发重渲染
const controllerId = useRoomStore(state => state.controllerId);

// Jotai：atom 粒度订阅
const [controllerId] = useAtom(controllerIdAtom);
```

**CoWatch 现状分析：**

- `UserContext`（`userInfo`、`login`、`logout`）：低频变化，接近配置型数据，用 Context 合理
- `RoomContext`（`members`、`videos`、`controllerId`、`activeVideoUrl`）：实时更新的业务状态，用 Context 是性能隐患，应迁移到 Zustand/Jotai

**TODO：** 将 `RoomContext` 中实时更新的业务状态迁移到 Zustand 或 Jotai，`UserContext` 保持不变。

---

### 前端优先 + Mock 驱动开发策略

**背景：** 前后端分离项目，开发者更熟悉前端，希望先调试 UI 流程而不依赖后端服务。

**方案：**
1. API 层（`api/room.ts`）顶部声明 `const USE_MOCK = true`，Mock 模式下所有函数返回固定假数据，不发真实请求
2. WebSocket Hook（`useRoomWs.ts`）Mock 模式下用 `setTimeout` 模拟服务端推送事件（如延迟 500ms 推 `ROOM_STATE`）
3. 后端完成后，将 `USE_MOCK` 改为 `false` 即可切换到真实联调，前端代码几乎无需改动

**优点：** 前端可独立完整调试所有页面和交互流程；Mock 数据格式与真实接口保持一致，联调返工少。

---

### WebSocket 视频同步防回环处理

**背景：** 视频播放器的 `timeupdate` / `play` / `pause` 事件会在远端同步操作时触发，导致收到远端 SYNC 消息 → 同步播放器 → 触发事件 → 再次广播的无限循环。

**进度同步（`SYNC_PROGRESS`）的防护：** 维护 `isSyncingRef = useRef(false)`：
- 收到远端事件时置 `true`，执行 `video.currentTime = ...`
- 用双 `requestAnimationFrame` 延迟重置（比单帧更安全），确保 `timeupdate` 已被处理
- `timeupdate` 回调检查该 flag，为 `true` 时跳过广播
- 进度条广播额外加 throttle 200ms，避免拖动时消息过频

**播放状态同步（`SYNC_STATE`）的防护——初版（boolean remoteTriggerRef）：**

`requestAnimationFrame` 对 play/pause 不可靠：`video.play()` 返回 Promise，其触发的 `onPlay` DOM 事件在 Promise resolve 后才到来，可能晚于 rAF 重置，导致防护失效、两端互相广播形成震荡。

初版做法：在 `VideoPlayer` 内部增加 `remoteTriggerRef`，暴露 `syncPlay()` / `syncPause()` 方法：
```ts
syncPlay: () => {
  remoteTriggerRef.current = true;          // 标记为远端触发
  videoRef.current?.play().catch(() => { remoteTriggerRef.current = false; });
},
```
`onPlay` / `onPause` 事件处理器中优先检查 `remoteTriggerRef`，为 `true` 时重置并直接 `return`，不广播。父组件收到远端同步时改用 `syncPlay/syncPause` 而不是 `play/pause`，从事件源头精准拦截，与计时器无关。

**引入 seek 后 boolean 方案的盲区，升级为计数器（remotePendingRef）：**

**现象：** 引入 seekTo 同步后，仍然出现播放/暂停来回切换（闪回）。

**根因：** 执行 `seek + play` 组合时，浏览器在 seek 期间会先触发一次隐式 `pause` 事件（视频暂停缓冲），`seeked` 后又可能触发 `play`。boolean `remoteTriggerRef` 只有一个名额，`play()` 消耗后 `pause` 事件无保护，被当作本地操作广播出去，形成回环。

**解决：** 将 `remoteTriggerRef` 升级为 **number 计数器 `remotePendingRef`**，每个预期事件提前预留一个名额（+1），事件到来时消耗（-1），不再依赖单个 boolean 状态。

同时将 `seekTo + play/pause` 封装为三个原子方法暴露给父组件：
- `syncSeekAndPlay(time)` — 远端触发的"跳转并播放"
- `syncSeekAndPause(time)` — 远端触发的"跳转并暂停"
- `syncSeek(time)` — 远端触发的纯跳转（保持当前播放状态）

**浏览器 seeked 后自动恢复播放的陷阱：**

`syncSeekAndPause` 不能仅靠设置 `video.currentTime` 然后等浏览器保持暂停——部分浏览器在 `seeked` 事件触发后会自动恢复之前的播放状态（即自动 `play()`）。

**正确做法：** 在 `seeked` 事件回调中显式调用 `video.pause()`，并为这次显式 pause 也预留保护名额：
```ts
const onSeeked = () => {
  video.removeEventListener('seeked', onSeeked);
  remotePendingRef.current += 1; // 为即将触发的 pause 预留名额
  video.pause();
};
remotePendingRef.current += 1; // 为 seek 期间的隐式 pause 预留名额
video.currentTime = time;
video.addEventListener('seeked', onSeeked);
```

**SYNC_PROGRESS 阈值优化：** 父组件 `handleSyncProgress` 增加阈值（`SEEK_THRESHOLD_SEC = 0.5s`），与当前播放时间差值超过阈值才执行 `seekTo`，避免频繁 seek 打断浏览器缓冲导致卡顿。游戏复盘场景对同步精度要求高，0.5s 已足够——正常播放时双方偏差远低于 0.5s，浏览器自然追上，该阈值不会增加 seek 频率。

**移除自由模式（最终决策）：** 自由模式（任意成员可控）在实际使用中弊大于利——多人同时拖进度条时互相广播，造成混乱且与保护计数器产生复杂竞态。最终只保留 designated（指定控制者）模式，控制权单一来源，彻底消除多发送方引起的竞态。实现上删除了 `MODE_CHANGE` / `MODE_CHANGED` 消息处理，`canControl` 只判断 `controller_id`，前端 `isController` 简化为 `controllerId === userId`。

---

### 视频上传前端码率校验

**背景：** 用户可能上传未压缩的原始录屏（30~80 Mbps），导致 COS 存储和 CDN 流量爆炸。大小限制不够精准（高码率 5 分钟可能比低码率 30 分钟还小），需要直接校验码率。

**实现位置：** `src/utils/validateVideo.ts`，在 `VideoUploader` 触发上传前调用。

**校验一：moov 索引位置**
- 只读文件头 32KB，扫描 MP4 box 顺序（每个 box 开头 8 字节：4 字节大小 + 4 字节类型名）
- 若先遇到 `mdat` 再遇到 `moov`，说明未经 `-movflags +faststart` 处理，直接拒绝
- 失败原因：moov 在末尾时浏览器必须完整下载才能 seek，播放体验极差

**校验二：平均码率**
- 创建临时 `<video>` 元素，`src` 指向 `File` 的 ObjectURL，监听 `loadedmetadata` 获取 `duration`
- 计算：`码率(Mbps) = 文件大小(bytes) × 8 / duration(秒) / 1_000_000`
- 当前阈值：**8 Mbps**（对应 CRF 28 视频流上限 6 Mbps + 音频 0.13 Mbps + 余量）
- 注意：JS 算出的是**总平均码率**（视频流 + 音频 + 容器开销），比纯视频流高约 0.1~0.2 Mbps，阈值需留余量

**校验顺序：moov 必须在码率之前**
- moov 在末尾时，`<video>.duration` 可能无法正确获取（需等待完整下载），导致码率计算不准
- 先过 moov 校验，再做码率校验，顺序不可颠倒

**失败提示：** 用 antd `Modal.error()` 弹窗（title + detail 分层），比内联小字更醒目，用户知道该用压缩工具处理

**TODO：** 后续根据房间/会员等级动态调整阈值（高级房间放开到 14 Mbps 对应 CRF 23）

---

### 1080p 60Hz H.264（libx264）各 CRF 档位码率与文件大小参考

游戏录屏高动态画面，仅供估算，实际因场景复杂度而异：

| 档位 | 视频流码率 | 30 分钟文件大小 |
|------|-----------|----------------|
| 原始录屏（N卡 NVENC 默认） | 30~80 Mbps | 6.6~17.6 GB |
| CRF 23（high） | 8~14 Mbps | 1.8~3.2 GB |
| CRF 26（balanced） | 5~9 Mbps | 1.1~2.0 GB |
| CRF 28（small）← 推荐 | 3~6 Mbps | 0.7~1.3 GB |
| CRF 30（smaller） | 2~4 Mbps | 0.4~0.9 GB |
| CRF 32（min） | 1~3 Mbps | 0.2~0.7 GB |

JS 算出的总平均码率 ≈ 视频流码率 + 音频（AAC 128k ≈ 0.13 Mbps）+ 容器开销（可忽略）。

快速推算：`文件大小(MB) ≈ 码率(Mbps) × 时长(秒) ÷ 8`

---

### MP4 moov 位置导致跟随方首次播放卡顿（已验证）

**背景：** 主控 A 播放视频到中途，B 进入房间后通过 `initPlayback` 直接 seek 到 A 的当前位置，出现明显卡顿；重播同一段时不卡顿。

**根因：** 录屏软件（如 N 卡）默认将 MP4 的 `moov` atom（索引信息）写在文件末尾。浏览器播放该文件时，必须先下载完整个文件才能解析索引，然后才能响应任意位置的 seek。B 进房间时 seek 到一个未缓冲的时间点，浏览器没有索引无法定位，触发 `waiting` 状态，表现为卡顿。重播时浏览器已有完整缓存，所以流畅。

**解决：** 用 FFmpeg 将 `moov` 移到文件头（`-movflags +faststart`），浏览器拿到文件开头就能解析索引，任意位置 seek 都可以立即发出正确的 HTTP Range 请求，不需要等待完整下载。

```bash
# 仅移动 moov，不重新编码，速度极快
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

**验证结论：** 用 `trailer.mp4`（4.2MB / 52s）测试，转换后 B 跟随 A 首次播放不再卡顿，seek 响应正常。推断大文件（1.5GB）转码压缩时同步加上 `+faststart` 即可解决该问题。

**注意：** 压缩脚本（`compress_*.bat` / `compress_balanced.sh`）已包含 `-movflags +faststart`，用户只需在上传前用脚本转码即可，无需额外操作。

---

## 踩坑记录

### 宿主机 nginx 默认 1MB 限制导致大文件上传 413

**现象：** 大文件 PUT 接口返回 413，容器内 nginx 已配置 `client_max_body_size 4096M` 却不生效。

**根因：** 两层 nginx 都会独立检查 `client_max_body_size`。宿主机 nginx 默认值为 1MB，流量在到达容器之前就已被拦截，容器内的配置完全不会生效。

**解决：** 宿主机 nginx 对 CoWatch 的 server 块设置 `client_max_body_size 0`（纯透传，不感知业务），容器内 nginx 设 `8192M` 作为粗粒度防御上限，业务精细限制由后端各接口自行负责。

**架构决策（三层职责分层）：**
- 宿主机 nginx → `client_max_body_size 0`，不感知业务，透传所有请求
- 容器内 nginx → 粗粒度上限（8G），防异常超大请求打穿
- 后端 → 精细业务限制（如单文件 4GB、按接口/角色区分），错误响应为结构化 JSON

**为什么不在两层都配业务值：** 维护点分散，nginx 和后端容易出现不一致；nginx 的 413 返回 HTML，用户体验差；后端逻辑更灵活（可按接口、用户角色动态控制）。

---

### XHR 绕过 axios 拦截器导致上传 401

**现象：** 视频文件上传接口返回 401，getUploadUrl 接口却正常（200）。

**根因：** `VideoUploader` 使用原生 `XMLHttpRequest` 直接 PUT 文件到后端，完全绕过了 axios 请求拦截器，导致 `Authorization: Bearer <token>` 头没有被自动注入。

**解决：** 改用封装的 `request`（axios 实例）调用 `request.put(url, file, { onUploadProgress })`，进度回调用 `onUploadProgress` 替代 `xhr.upload.onprogress`，token 由拦截器自动注入，无感刷新也正常触发。

**补充：** OSS 预签名直传例外——OSS 通过 URL query 参数鉴权，加上自定义 `Authorization` 头反而会报错，这种场景继续用 XHR。

---

### Express 静态文件目录与 tsx 直接运行时 `__dirname` 不一致导致视频 404

**现象：** 视频上传成功（磁盘文件 4.2MB），但播放器显示 0:00 黑屏，`/uploads/...` 路由返回 404。

**根因：** `app.ts` 中写的是：
```ts
const uploadsDir = path.resolve(__dirname, '../../uploads');
```
这是按"编译后 `dist/src/app.js`"的层级写的。但开发环境用 `tsx src/app.ts` 直接运行，`__dirname` 指向 `src/`，`../../uploads` 解析到 `Desktop/uploads`（不存在）。

与此同时 controller 里写的是 `'../../../uploads'`，从 `src/controllers/rooms/` 上溯三层正好到项目根 `CoWatch-backend/uploads`，两者路径不一致。

**解决：** `app.ts` 改为：
```ts
const uploadsDir = path.resolve(__dirname, '../uploads');
```
从 `src/` 上溯一层即到项目根，与 controller 写文件路径对齐。

**规律：** 用 `tsx` 直接运行 TypeScript 时，`__dirname` 就是源文件所在目录；而 `tsc` 编译后运行时 `__dirname` 是 `dist/` 下对应的目录，相对层级不同，需要区分对待。

---

### SQLite 新增字段后旧数据库文件报 500

**现象：** 后端代码新增了 SQL 查询列（如 `r.name AS room_name`），服务重启后 `/api/rooms/my` 等接口返回 500。

**根因：** `CREATE TABLE IF NOT EXISTS` 只在表不存在时建表，**不会修改已存在表的结构**。旧数据库文件里 `rooms` 表没有 `name` 列，查询时 SQLite 抛出列不存在的异常。

**解决：** 手动对旧数据库文件执行 `ALTER TABLE` 补列：
```bash
sqlite3 database/cowatch.sqlite3 "ALTER TABLE rooms ADD COLUMN name TEXT NOT NULL DEFAULT '';"
```

**规律：** 每次 schema 有字段变更，都需要对已有数据库文件单独跑迁移语句。生产环境应使用迁移工具（如 `better-sqlite3-migrate`、`flyway`）管理版本化 schema 变更，避免手动操作遗漏。

---

### Blob 下载接口被业务拦截器误判为失败

**现象：** 调用 `downloadBatApi` 下载 `.bat` 文件时，前端抛出 `ApiError: 请求失败`，而后端实际返回了 200 和正确的 Blob 内容。

**根因：** 封装的 `request`（axios 实例）响应拦截器会读取 `response.data.code` 做业务 code 校验。后端返回的是二进制 Blob，没有 `.code` 字段，拦截器将其判断为失败并抛错。此外，接口路径写成了 `/bat` 而非完整路径 `/api/bat`，导致请求打到前端 dev server 而非后端。

**解决：** 改用原生 `axios.get`（非封装实例），绕过业务拦截器，直接获得 Blob；同时修正 API 路径为 `/api/bat`。代码注释中说明绕过原因。

**结论：** 以下两类场景允许绕过封装的 `request`，直接用原生 `axios` 或 `XHR`：
1. **OSS 预签名直传**：OSS 通过 URL query 鉴权，带自定义 `Authorization` 头会报错，用 XHR
2. **后端返回非 JSON 数据**（如 Blob 文件下载）：业务拦截器假定响应为 JSON 并做 code 校验，用原生 axios 绕过；需在注释中说明原因

---

### 新成员加入房间时视频未能跟随当前播放状态

**现象：** A 正在播放视频，B 刷新页面（或首次加入房间）后视频处于暂停状态，每隔约 0.5 秒才被动同步一次画面，始终不播放。

**背景对比（重要）：** 此问题在「修复回环竞态」之前并不存在——当时 A 持续广播 `SYNC_STATE`，B 收到后会调用 `syncPlay()`，靠这条"顺带广播"隐性路径完成初始化。修复回环竞态后引入了更严格的保护逻辑，该隐性路径失效，B 进来后没有任何事件触发播放。

**最终根因（两层）：**

1. **后端没有记录播放状态**：`ROOM_STATE` 消息没有携带 `isPlaying` / `currentTime`，`initPlayback` 拿不到正确参数，无法在 B 加入时恢复播放。

2. **Chrome Autoplay Policy 阻止了自动播放**：即使 `initPlayback` 正确调用了 `video.play()`，Chrome 也会拒绝——有声视频在没有用户手势的情况下不允许自动播放。更坑的是：尝试在 `play().then()` 里立即执行 `video.muted = false` 来取消静音，Chrome 同样拒绝并**顺带 pause 了视频**，此时 `remotePendingRef` 已为 0，这个 pause 被当作本地操作广播给全员，导致 A 也暂停。

**完整解决方案：**

- **后端 `wsServer.ts`**：模块级 `roomPlayback: Map<string, { isPlaying, currentTime }>` 在 `SYNC_STATE` 时更新 `isPlaying`，在 `SYNC_PROGRESS` 时更新 `currentTime`，`ROOM_STATE` 下发时附带这两个字段。
- **前端 `VideoPlayer.tsx`**：新增 `initPlayback(isPlaying, currentTime)` 原子方法——等待 `readyState >= 3`（或 `canplay` 事件），seek 到目标时间，`seeked` 后先 `muted = true` 再 `play()`（静音视频 Chrome 允许自动播放），同时设置 `unmutePendingRef = true`；在 wrapper 的 `onClick` 中检测该标记，用户首次点击时执行 `muted = false` 恢复声音。
- **前端 `Lobby/index.tsx`**：引入 `pendingInitRef` 暂存初始化参数；使用 **callback ref `setVideoRef`** 替代普通 `useRef`，当 `VideoPlayer` 实际挂载时立即消费 `pendingInitRef`，通过 `requestAnimationFrame` 调用 `initPlayback`，确保 video 元素完成首次渲染后再操作。

**关键认知：**
- `useRef` 的 ref 不会在组件挂载时触发回调；callback ref（`ref={fn}`）会在 React 将 handle 赋予 ref 时立即调用，适合"拿到句柄后立即执行副作用"的场景。
- Chrome Autoplay Policy：静音视频可自动播放；`unmute` 必须有用户手势，在 Promise.then() 中直接 unmute 不满足条件，且失败时浏览器会强制 pause 视频。参考：https://goo.gl/xX8pDD

---

### SW 无法拦截 COS / CDN 跨域视频请求

**现象：** SW 已激活，本地播放正常走 SW 缓存（Network 面板显示"来自 service worker"），线上播放不走 SW，启动器显示"其他"，Cache Storage 为空。

**根因：** `isVideoRequest` 只检查同域 `/uploads/` 前缀。本地是本地存储模式，`videoUrl` 为 `/uploads/roomId/xxx.mp4`（同域）能命中；线上是 COS 直传模式，`videoUrl` 存的是 COS 完整 URL（`https://co-watch-xxx.cos.ap-chengdu.myqcloud.com/...`），origin 与页面域名不同，`isVideoRequest` 返回 false，SW 直接 `return` 不调用 `respondWith`，请求完全绕过 SW。

**关键认知：** 两种模式的差异不在播放链路，而在上传时存入数据库的 `videoUrl` 格式——本地存储存相对路径，COS 直传存完整 COS URL。播放时直接用这个 URL，导致 SW 拦截条件不同。

**解决：** 运行时动态注入，两处改动：

1. **`sw.ts`** 新增 `message` 事件监听：
```ts
self.addEventListener('message', (event) => {
  const { type, origin } = event.data ?? {};
  if (type === 'ADD_VIDEO_ORIGIN' && origin && !VIDEO_ORIGINS.includes(origin)) {
    VIDEO_ORIGINS.push(origin);
  }
});
```

2. **`Lobby/index.tsx`** 在 `activeVideoUrl` 变化的 `useEffect` 里通知 SW：
```ts
const videoOrigin = new URL(activeVideoUrl).origin;
if (videoOrigin !== window.location.origin) {
  navigator.serviceWorker.controller.postMessage({ type: 'ADD_VIDEO_ORIGIN', origin: videoOrigin });
}
```

**设计优点：** 无需硬编码 COS 域名，CDN 接入后域名变了也自动适配；`VIDEO_ORIGINS` 是内存数组，SW 重启后自动清空，下次页面加载时前端会重新 postMessage 补充。
