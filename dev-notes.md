# CoWatch 开发笔记

## 架构决策

### Canvas PainterLayer 蒙层方案（鼠标共享 + 协同绘制）

**背景：** 最初用 DOM `<img>` 元素模拟他人鼠标位置，出现系统鼠标重影、跨分辨率坐标偏移、无法扩展绘制功能等问题。

**结论：** 改用 Canvas 蒙层（`PainterLayer`），锚定在 `.playerRatio`（16:9 视频容器）内，`position: absolute; inset: 0`，`z-index: 100`，`pointer-events: none`。

**坐标系设计：** 所有坐标统一为相对 `.playerRatio` 容器宽高的百分比（0~1），跨分辨率、跨窗口尺寸一致。`.playerRatio` 是所有客户端视觉完全一致的区域（16:9 固定比例、无黑边），Canvas 锚定于此可保证多端位置对齐。

**为什么不继续用 DOM 元素：**
- DOM 方案每个成员一个绝对定位 `<img>`，多人时有多个 DOM 节点频繁 style 更新，性能差
- 无法扩展绘制轨迹（无法把任意路径挂到 DOM 上）
- Canvas 单次 `clearRect + 批量绘制` 是标准的多光标/协同绘制方案（Figma、Excalidraw 均如此）

**DPR 适配（Retina 清晰）：**
```ts
const dpr = window.devicePixelRatio || 1;
canvas.width  = Math.round(w * dpr);  // 物理像素
canvas.height = Math.round(h * dpr);
canvas.style.width  = `${w}px`;       // CSS 逻辑像素（必须显式设置，否则被拉伸）
canvas.style.height = `${h}px`;
// 绘制时缩放到逻辑像素空间，坐标直接用 CSS px，无需手动 × dpr
ctx.save();
ctx.scale(dpr, dpr);
// ... 绘制逻辑 ...
ctx.restore();
```

**事件架构（canvas 始终穿透）：**
- Canvas 保持 `pointer-events: none`，所有 `mousemove / mousedown / mouseup / click` 均绑在父容器（`.playerRatio`）上
- 绘制模式下 `mousedown` 用 `{ capture: true }` 在捕获阶段拦截，防止事件穿透到 `<video>`

---

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

### 预签名直传安全边界与上传防护设计

**背景：** 采用 COS 预签名直传后，文件完全绕过后端，后端在上传过程中对文件内容一无所知，无法在服务端校验文件大小、码率等。需要明确各种防护手段的有效边界。

**COS 直传链路（关键认知）：**
```
① GET /api/rooms/:roomId/upload-url  → 后端生成预签名 URL 返回前端（后端不知道文件大小）
② PUT https://cos.xxx.com/...        → 前端直接上传到 COS，完全绕过后端
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
| COS Policy `content-length-range` | ✅ 最可靠 | COS 服务端强制执行，客户端无法绕过 |
| 前端码率校验 | ✅ 覆盖误操作 | 挡住正常用户，定位是"用户教育"而非安全边界 |

**最终落地方案（`middleware/uploadGuard.ts` + `controller/proxyUpload`）：**

所有用户统一走后端代理中转（COS 模式返回 `mode: 'proxy'`，本地模式返回 `mode: 'local'`），不再有直传分支。

**`uploadGuard` 中间件（挂载在 `POST /:roomId/upload-proxy`）：**
1. **Sec-Fetch 请求头校验**：两个头都不存在则拒绝（增加脚本伪造成本）
2. **每日中转总字节数预检**：用 `Content-Length` 做快速判断，超过 5GB 则拒绝
3. **实际计费**：文件真实写入 COS 完成后，通过 `addDailyBytes(userId, realBytes)` 计入当日用量（防止恶意请求用声明大小占用配额）

**代理上传流程（零临时文件）：**
```
① GET /upload-url → 后端返回 { mode: 'proxy', uploadUrl: '/upload-proxy?objectKey=...&fileType=...&fileName=...' }
② POST /upload-proxy → uploadGuard 预检 → req 可读流直接 putStream 到 COS → 完成后 addDailyBytes + 写库广播
```

---

### COS 私有读写 + 时效签名 URL（objectKey 存库，读时签名）

**背景：** COS 存储桶从公开读改为私有读写，所有 GET 访问需要时效签名。需要决定 URL 的生成时机、存储方式和有效期设计。

**核心问题链（识别顺序）：**

```
① 存储桶设私有  →  videoUrl 必须带签名参数才能播放
② 签名有时效    →  不能把带签名的 URL 存数据库（过期后无法播放）
③ 签名 URL 带 query 参数  →  SW cache key 会随签名变化，同一视频每次签名不同导致永远缓存未命中
④ 需要 objectKey 存库  →  读取时按需生成签名 URL
```

**决策：objectKey 存库，读时签名（方案 B）**

| 字段 | 存法 | 说明 |
|------|------|------|
| `room_videos.video_url` | objectKey（`cowatch/{roomId}/{uuid}-{fileName}.mp4`） | 稳定标识，无签名，永久有效 |
| 播放 URL | 临时生成，仅下发，不落库 | 每次切换视频时实时签名，有效期 30 分钟 |

**签名时机设计（方案 B：SWITCH_VIDEO 时签名）：**

两个可选时机：
- **方案 A：进房间时统一签名**（`ROOM_STATE` 下发时对所有视频并发签名）
  - 缺陷：有 N 个视频时，最晚播放的视频签名从"进房间时刻"起算，用户 20 分钟后才点播该视频，签名已近过期
- **方案 B：SWITCH_VIDEO 时签名（最终选择）**
  - 收到 WS `SWITCH_VIDEO { objectKey }` → 后端实时签名 → 广播 `SWITCH_VIDEO { objectKey, videoUrl: 签名URL }`
  - 签名从"切换时刻"起算，有效期覆盖从切换到首次完整下载完成的时间窗口

**有效期设计（30 分钟）：**

签名有效期不需要覆盖整场复盘（2~4 小时），只需覆盖"首次完整下载到 SW Cache"的时间窗口：
- SW 缓存完成后，所有后续 Range 请求走本地 Cache Storage，完全不触碰 COS
- 最大文件约 1GB（CRF 28 转码后），普通带宽（5Mbps）约需 27 分钟下载完成
- 30 分钟有足够余量，且不会给攻击者留下过长的盗链窗口

**SW cache key 策略（stripCosSignature）：**

```ts
// 剥离 COS 签名 query 参数，以纯路径为 cache key
// 签名每 30 分钟轮换，但 pathname 不变 → 同一视频永远命中同一缓存条目
function stripCosSignature(url: string): string {
  const u = new URL(url);
  ['q-sign-algorithm','q-ak','q-sign-time','q-key-time',
   'q-header-list','q-url-param-list','q-signature'].forEach((p) => u.searchParams.delete(p));
  return u.toString();
}
```

**前端字段命名规范（objectKey vs videoUrl 的职责分离）：**

| 字段 | 含义 | 用途 |
|------|------|------|
| `objectKey` | COS 唯一路径标识，永久稳定 | 切换视频时发 WS、列表高亮（`activeObjectKey`） |
| `videoUrl` | 带签名的临时播放 URL | 播放器 `<video src>`、SW 拦截后发网络请求 |

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

**④ HLS 服务端切片 + SW cache-first .ts 片段（当前）**：
- 后端用 `ffmpeg -c copy` 将 mp4 切成 ~15s 的 .ts 片段（无重编码，切片速度 < 5s/视频小时）
- 前端用 hls.js 加载播放，每次只请求当前缓冲所需的片段（约 7MB/片）
- SW 退化为极简 cache-first：拦截 .ts 片段，以纯路径（剥离签名）为 key，仅缓存已播放片段
- **核心收益**：用户只看了几段 → 只下载那几段，彻底解决"一小时视频只看了 3 段却下载完整文件"的浪费
- **额外收益**：SW 代码从 ~300 行降至 ~80 行，并发爆炸 bug 自然消除（hls.js 不发 Range 请求，Cache API 原生支持 200 响应）

**浏览器内转码方案调研（已否决）：**

背景：`.bat` 脚本需要用户手动下载、拖拽操作，体验有摩擦。调研是否可以在浏览器内完成转码，消除对本地工具的依赖，同时实现「边转码边上传」并行以缩短整体等待时间。

调研了两个方向：

**方案一：ffmpeg.wasm（`@ffmpeg/ffmpeg`）**

- 将完整 ffmpeg 编译为 WebAssembly，在浏览器内运行，参数与 `.bat` 完全一致（`libx264 -crf 30 -preset veryfast`）
- **优势**：CRF 质量恒定模式完全保留，画质与 `.bat` 产物一致；文件大小可预期；无兼容性问题
- **否决原因**：纯 WASM 软编，不能调用 GPU，速度约为本地 ffmpeg 的 1/10（30 分钟视频约需 50~90 分钟）；原始录屏 3GB 直接载入内存，浏览器会 OOM；整体时间远超现有方案，用户体验更差

**方案二：WebCodecs API**

- 浏览器原生 API（Chrome 94+，Firefox 不支持），通过系统编码器抽象层调用硬件加速（Windows 走 Media Foundation/NVENC，macOS 走 VideoToolbox）
- **优势**：有独显的玩家可走硬件编码，速度接近实时甚至更快；纯浏览器 API，无需客户端任何额外安装；HTTPS 下即可运行
- **否决原因（核心）**：WebCodecs `VideoEncoder` 没有 CRF 模式，只支持 CBR/VBR 目标码率。硬件编码器（NVENC）在目标码率模式下，静止场景浪费码率、动态场景码率不足，实测画质比 x264 CRF 30 下降 15~25%，且输出文件可能更大——这与用户此前直接使用 NVENC 硬件加速时的体验一致（「文件更大画质更差」）。此外，mp4 容器的 `moov` box 必须在全部帧编码完成后才能写入文件头，因此无法实现真正的「边转码边上传」并行；若改用 fMP4 分片格式则需后端额外拼接逻辑，开发成本上升至 4~6 天

**结论：维持现有 `.bat` 方案**

| | `.bat`（现有） | ffmpeg.wasm | WebCodecs |
|---|---|---|---|
| 画质（CRF 30 等效） | ✅ | ✅ | ❌ 明显下降 |
| 有独显用户总耗时 | ~11~19 min | ~50~90 min | ~6~12 min |
| 无独显用户总耗时 | ~11~19 min | ~50~90 min | ~15~26 min（更慢） |
| 用户操作体验 | 需下载脚本/拖拽 | 浏览器内 ✅ | 浏览器内 ✅ |
| 开发成本 | ✅ 已完成 | 中（性能不可接受） | 高（2~3 天，画质不可接受） |

`.bat` 在画质、文件大小可控性、综合耗时（有独显场景）上仍是最优解。浏览器内转码方案的本质瓶颈是：**能保画质的方案（ffmpeg.wasm）太慢；能跑快的方案（WebCodecs 硬件编码）无法使用 CRF 质量控制**。

**关键洞察：**
- **转码是单项收益最大的优化**，从 40 元 → 5 元，且实现成本极低（静态脚本分发）
- **SW 在反复切换场景才显著**，如果复盘时每段只看一遍，转码后不加 SW 费用也在 2–3 元
- **CRF 不控制文件大小，控制质量下限**——原文件已高度压缩时，CRF 23（高质量档）反而比原文件更大（见下方"FFmpeg CRF 反直觉"）
- **HLS 切片是 SW 缓存的根本解法**——Range 请求是 SW 缓存视频的核心难题，HLS 切换到 GET 整片后问题自然消失

---

### WebSocket 长连接保活：心跳 vs Nginx proxy_read_timeout

**背景：** CoWatch 使用原生 WebSocket，房间内用户长时间无操作时讨论是否需要心跳机制。

**结论：当前不加心跳，仅依赖 Nginx `proxy_read_timeout=3600s`，满足需求。**

**两者的本质区别：**

| | Nginx proxy_read_timeout | 应用层心跳 |
|---|---|---|
| **作用** | 多久没有数据就切断连接 | 主动探测连接是否还活着 |
| **防止 Nginx 超时** | ✅ 直接解决 | ✅ 通过保持数据流解决 |
| **检测僵尸连接** | ❌ 要等超时时间才感知 | ✅ 60s 内感知 |
| **实现成本** | 一行 nginx 配置 | 前后端各需要 PING/PONG 逻辑 |

**断开行为差异（关键认知）：**
- **主动断开**（关标签页/浏览器/刷新）：浏览器发 TCP FIN 包，服务端 `ws.on('close')` 立刻触发，`proxy_read_timeout` 完全不参与，断开即时生效
- **被动断开**（手机掉网/合盖/路由器断电）：网络层中断无 FIN 包，服务端要等 `proxy_read_timeout` 超时才感知，期间连接为"僵尸连接"

**为什么 CoWatch 不需要心跳：**
1. 主路径是主动断开（用户正常关页面），即时生效无问题
2. 在线状态感知是"尽力而为"，掉线后延迟几分钟更新不影响复盘体验
3. 复盘 session 通常不超过 1 小时，`proxy_read_timeout=3600s` 覆盖场景充足
4. 心跳引入额外复杂度（前后端均需改动），收益不匹配

**若未来需要心跳：** 应同时实现随机抖动指数退避重连（见"待了解"章节）。

---

### 聊天消息渲染路径：统一走 WS broadcast（含发送者自身），不做乐观更新

**背景：** 实现房间聊天功能时，需决定发送者自己的消息是"本地立即追加"还是"等服务端广播回来再渲染"。

**结论：** 统一走服务端 broadcast 回调渲染，发送者不做本地乐观追加。服务端收到 `CHAT_MESSAGE` 后直接 `broadcast(roomId, ...)` 广播给全员（含发送者），前端 `onChatMessage` 回调统一处理。

**原因：**
- 乐观更新需要去重（本地消息 + WS 消息会重复），且消息顺序难以保证与其他端一致
- 聊天场景对延迟不敏感（vs. 输入框实时回显），轻微网络延迟可接受
- 逻辑简单：前端只维护一条数据流，无需临时消息状态和合并逻辑

**代价：** 网络延迟较高时发送者会感知到轻微延迟（消息发出后短暂空白再出现），属于可接受的 tradeoff。

---

## 工具与概念

### CSS `grid-template-rows` 折叠动画

**背景：** 需要为 `CollapseSection` 组件实现展开/收起过渡动画。

**为什么不用 `max-height` 过渡：**
`max-height` 必须写死一个足够大的上限值（如 `999px`）。过渡时浏览器在 `0 → 999px` 全程匀速，但内容实际高度只有 `200px`，`999→200` 这段视觉静止，导致动画明显卡顿/延迟。贝塞尔曲线（easing）无法解决此问题——它只控制速率，不改变起止值范围。

**为什么不用 JS 读取 scrollHeight：**
需要在展开/收起前后各插一次 `requestAnimationFrame` 强制回流，还要监听 `transitionend` 清除 inline style，逻辑复杂且容易出现"从 auto 直接到 0 无动画"的边界 bug（antd 的 rc-motion 通过两步 `auto → 精确值 → 0` 解决，但实现较重）。

**最终方案：`grid-template-rows: 1fr ↔ 0fr`**

浏览器在插值时自动感知 `1fr` 对应的真实行高，过渡范围精确等于内容高度，无需任何 JS。

```scss
// 外层 grid 容器
.body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.25s ease;
}
.bodyClosed {
  grid-template-rows: 0fr;
  .bodyInner { padding-top: 0; padding-bottom: 0; }
}

// 内层必须有 overflow: hidden，否则 grid 行高归 0 后内容仍然溢出可见
.bodyInner {
  overflow: hidden;
  padding: 0 12px 12px;
  transition: padding 0.25s ease;
}
```

**必须双层 DOM 的原因：** `grid-template-rows: 0fr` 只压缩 grid 行高，不处理直接子元素的 `padding`。`padding` 区域不受 `overflow: hidden` 裁剪，需要内层元素单独同步过渡 `padding → 0`。

**已知限制（兼容性）：** `grid-template-rows` 插值动画在 Chrome 107+、Firefox 116+、Safari 16+ 才稳定支持，不支持 IE。对于只需支持现代浏览器的项目（如 CoWatch）完全可用。

---

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

**计数器方案的根本缺陷 → 后端全局 Seq 方案（最终）：**

计数器方案的核心假设是"能精确预测每个远端操作会触发几个 play/pause 事件"，但这个假设在快速连续操作下会崩溃：

**根本缺陷（名额悬空竞态）：**

主控执行"Tag 跳转 → 播放 → 暂停"三连操作时，非主控侧发生如下竞态：

1. 收到 `SYNC_STATE(isPlaying=false, time=T1)`：调用 `syncSeekAndPause`，提前预留 2 个计数名额（seek 期间的隐式 pause + seeked 后的显式 pause），然后注册 `onSeeked` 回调异步等待
2. 在 `onSeeked` 触发之前（异步窗口），又收到 `SYNC_STATE(isPlaying=true)`：再次预留 1 个名额并调用 `video.play()`
3. 步骤 1 的 `onSeeked` 终于触发，执行 `video.pause()`——这一次 pause 是为旧指令服务的，但此时计数器名额已被步骤 2 消耗，pause 事件被当作本地操作广播出去，或者名额仍在导致更新的指令被静默丢弃

**本质**：计数器是对"未来事件数量"的预测，异步回调（`onSeeked`、`play().then()`）执行时，外部状态已被新指令改变，预测失效，名额对不上号。计数器无法区分"这个事件属于哪条指令"。

**后端全局 Seq 方案：**

后端为每个房间维护单调递增的 `roomSeq`，每次广播 `SYNC_STATE` / `TAG_SEEK` 时分配并附带 `seq`：

```ts
// wsServer.ts
const roomSeq = new Map<string, number>();
function nextSeq(roomId: string): number {
  const seq = (roomSeq.get(roomId) ?? 0) + 1;
  roomSeq.set(roomId, seq);
  return seq;
}
// 广播时附带
broadcastExcept(roomId, userId, { type: 'SYNC_STATE', data: { isPlaying, currentTime, seq } });
```

前端 `VideoPlayer` 用 `lastSyncSeqRef` 记录当前处理的最新 seq，**异步回调执行前做过期检查**：

```ts
// VideoPlayer.tsx
const lastSyncSeqRef = useRef(0);

syncSeekAndPause: (time, seq) => {
  lastSyncSeqRef.current = seq;          // 记录最新 seq
  if (video.paused) {
    video.currentTime = time;
  } else {
    video.currentTime = time;
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      if (lastSyncSeqRef.current > seq) return; // ← 过期则丢弃，不执行 pause
      video.pause();
    };
    video.addEventListener('seeked', onSeeked);
  }
},
```

**为什么用大小比较而非相等比较：** 快速连续操作可能产生多条消息，`onSeeked` 执行时 `lastSyncSeqRef` 可能已经跳过了多个 seq 值（不是简单地 +1），大小比较可以统一处理"任何更新指令到达后，旧指令的异步回调一律丢弃"的语义，相等比较会漏掉中间跳过的情况。

**方案优势：**
- **不需要预测**：不再猜"会触发几个事件"，只关心"当前执行的是不是最新指令"
- **防护机制前移到后端**：后端 `canControl` 拦截非主控的 `SYNC_STATE` 上报，前端完全不需要保护 `handlePlay/handlePause`
- **非主控 `disabled` 的语义清晰化**：`pointerEvents: none` 只屏蔽用户鼠标操作；远端指令触发的 play/pause 事件上报给后端，后端 `canControl` 鉴权拦截，天然无害，无需前端额外保护

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

### 主控权限体系重构（自动分配 + 扩展转让权 + 离线兜底）

**背景：** 原设计存在三个问题：
1. 管理员不在线时，房间从一开始就无人可成为主控（所有人均无法使用任何功能）
2. 只有管理员能转让主控，管理员中途离开后主控无法更换
3. 主控离线后如果管理员也不在线，房间陷入无人控制状态

**结论：** 三条规则彻底解决上述问题：
1. **第一人自动成主控**：`ws.on('message')` 中 `addClient` 之后检测 `getOnlineUserIds(roomId).size === 1`，成立则调用 `setControllerId` 并广播 `CONTROL_CHANGED`
2. **主控和管理员均可转让**：`TRANSFER_CONTROL` 鉴权由 `member.is_admin !== 1` 扩展为 `!canControl(userId, room) && member.is_admin !== 1`（`canControl` 为主控判断函数）
3. **离线时优先级转让**：`ws.on('close')` 主控离线处理按顺序取：在线管理员 → `remainingClients` 第一个在线成员 → null（仅房间已清空时）

**实现位置：**
- 后端：`CoWatch-backend/src/ws/wsServer.ts`（自动分配、鉴权扩展、离线兜底）
- 前端：`src/components/MemberList/index.tsx`（`canClick = (isAdmin || isController) && !isController`）
- 前端：`src/pages/Lobby/ControlPanel.tsx`（`isAdmin` prop 传入改为 `isAdmin || isController`）

**为什么不用"第一个注册用户成为管理员"方案：** 管理员是数据库级别的角色（`is_admin = 1`），与房间在线状态无关；主控是运行时的房间控制权，两者职责不同，不应合并。

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

### 数据库迁移中哪些操作需要幂等

使用 SQLite 期间曾遇到两类问题，根源相同：某些 schema 操作在重复执行时会报错，导致服务启动失败。

**需要幂等处理的典型场景：**

| 操作 | 非幂等的错误 | 幂等写法 |
|------|------------|--------|
| 新增列 | `ALTER TABLE` 重复执行报"column already exists" | try/catch 捕获同名错误，或迁移版本号标记 |
| 删除外键约束 | 重复执行（如重建表）会因表已存在而失败 | `PRAGMA foreign_key_list` 检测有无约束再决定是否执行 |
| 插入种子数据 | 重复插入主键冲突 | `INSERT ... ON CONFLICT DO NOTHING` |

现已迁移至 PostgreSQL，改用 `migrations/*.sql` 版本化管理。每个迁移文件只执行一次，由迁移工具记录版本，天然幂等，不再需要手动 try/catch。

---

### Blob 下载接口被业务拦截器误判为失败

**现象：** 调用 `downloadBatApi` 下载 `.bat` 文件时，前端抛出 `ApiError: 请求失败`，而后端实际返回了 200 和正确的 Blob 内容。

**根因：** 封装的 `request`（axios 实例）响应拦截器会读取 `response.data.code` 做业务 code 校验。后端返回的是二进制 Blob，没有 `.code` 字段，拦截器将其判断为失败并抛错。此外，接口路径写成了 `/bat` 而非完整路径 `/api/bat`，导致请求打到前端 dev server 而非后端。

**解决：** 改用原生 `axios.get`（非封装实例），绕过业务拦截器，直接获得 Blob；同时修正 API 路径为 `/api/bat`。代码注释中说明绕过原因。

**结论：** 以下两类场景允许绕过封装的 `request`，直接用原生 `axios` 或 `XHR`：
1. **OSS 预签名直传**：OSS 通过 URL query 鉴权，带自定义 `Authorization` 头会报错，用 XHR
2. **后端返回非 JSON 数据**（如 Blob 文件下载）：业务拦截器假定响应为 JSON 并做 code 校验，用原生 axios 绕过；需在注释中说明原因

---

### syncPlay 静默吞掉 Autoplay Policy 拒绝导致非主控永久暂停

**现象：** 非主控进度条静止不动，每隔 0.5s 被动 seek 一次，画面始终停在暂停态，不播放。

**根因：** `syncPlay` / `syncSeekAndPlay` 内部的 `video.play().catch(() => {})` 将 Autoplay Policy 的拒绝完全静默吞掉：

```ts
// 问题代码
video.play().catch(() => {});  // Autoplay Policy 拒绝 → 吞掉 → 视频实际未起播
```

Chrome 的 Autoplay Policy 规定：用户与页面没有任何交互之前，有声视频不允许自动播放，`play()` 返回的 Promise 直接 reject。`.catch(() => {})` 让视频停留在暂停态，而主控的 `SYNC_PROGRESS` 持续广播进度（主控在播放），非主控的偏差不断超过 0.5s 阈值，触发 `syncSeek` 不断纠偏但永远不起播，形成无限 seek 循环。

**与"新成员加入"场景的区别：** `initPlayback` 从建立之初就用静音起播来绕过 Autoplay Policy；但中途修复计数器竞态时，`syncPlay` / `syncSeekAndPlay` 直接写了 `.catch(() => {})`，没有沿用同样的静音重试逻辑，漏掉了这个边界场景。

**解决：** 提取 `tryPlay(video)` 辅助函数，与 `initPlayback` 保持一致的静音重试逻辑：

```ts
const tryPlay = (video: HTMLVideoElement) => {
  video.play().catch(() => {
    // 非静音播放失败 → 静音重试（Autoplay Policy 允许静音视频自动播放）
    video.muted = true;
    unmutePendingRef.current = true;
    video.play().catch(() => {
      // 静音也失败（极少见，如网络异常），重置标志
      unmutePendingRef.current = false;
      video.muted = false;
    });
  });
};
```

`syncPlay` / `syncSeekAndPlay` 均改为调用 `tryPlay(video)` 而非直接 `video.play().catch(() => {})`。静音起播成功后设置 `unmutePendingRef = true`，用户首次点击页面时在 `handleClick` 里执行 `muted = false` 恢复声音。

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

---

**⚠️ 初版解决方案（postMessage 动态注入 origin）——已废弃**

运行时从页面向 SW postMessage 注入 COS/CDN 的 origin，SW 维护白名单 `VIDEO_ORIGINS[]` 做判断：

```ts
// sw.ts
const VIDEO_ORIGINS: string[] = [];
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ADD_VIDEO_ORIGIN') VIDEO_ORIGINS.push(event.data.origin);
});
function isVideoRequest(request) {
  return VIDEO_ORIGINS.some((o) => new URL(request.url).origin === o);
}

// Lobby/index.tsx（activeVideoUrl 变化时）
navigator.serviceWorker.controller.postMessage({ type: 'ADD_VIDEO_ORIGIN', origin: videoOrigin });
```

**废弃原因——两个根本缺陷：**

1. **时序竞态**：`SWITCH_VIDEO` 消息到达 → 前端更新 `activeVideoUrl` → `useEffect` 触发 `postMessage` → SW 收到并写入白名单。这整条链路是异步的，而播放器的第一个 Range 请求在 `<video src=...>` 赋值后**立即**发出，极大概率早于 postMessage 到达 SW，导致首个 Range 请求漏网，SW 没有机会缓存完整文件，后续所有 seek 都产生真实流量。

2. **与时效签名 URL 不兼容**：COS 私有读写模式下，videoUrl 带签名 query 参数（`q-sign-*`），每次切换视频签名不同，cache key 跟签名走则同一视频无法命中；剥离签名后 key 稳定但需在 SW 里实现签名剥离逻辑，且 SW 还需要用原始带签名 URL 去发网络请求，两套 URL 并存逻辑复杂。

---

**最终解决方案（路径特征判断 + 签名剥离）：**

**核心洞察：** 所有视频（COS / CDN / 本地）的 objectKey 格式固定为 `cowatch/{roomId}/{uuid}-{fileName}.mp4`，路径特征不依赖域名，可以直接用 pathname 判断，彻底绕开跨域识别问题。

**两处改动：**

**① `isVideoRequest` 改为路径特征判断**（sw.ts）：
```ts
function isVideoRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  // objectKey 格式固定，无论域名如何（COS/CDN/本地）路径特征不变
  return pathname.startsWith('/cowatch/') && pathname.endsWith('.mp4');
}
```

**② `stripCosSignature` 剥离时效签名，以纯路径为 cache key**（sw.ts）：
```ts
function stripCosSignature(url: string): string {
  const u = new URL(url);
  ['q-sign-algorithm','q-ak','q-sign-time','q-key-time',
   'q-header-list','q-url-param-list','q-signature'].forEach((p) => u.searchParams.delete(p));
  return u.toString();
}

// fetch 拦截中：
const cacheKeyUrl = stripCosSignature(request.url);  // 纯路径，签名轮换不影响命中
const cacheKey = new Request(cacheKeyUrl, { headers: {} });
// 发网络请求时仍用原始带签名 URL（有权限访问 COS）
const fullResponse = await fetch(new Request(request.url, { ... }));
```

**效果：**
- 消除时序竞态：不再依赖 postMessage，SW 从 pathname 直接判断，零延迟
- 签名轮换不影响缓存命中：cache key 是稳定的纯路径，30 分钟签名过期后重新签名拿到的是新 URL，但 pathname 不变，SW 仍能命中同一缓存条目
- 无需 VIDEO_ORIGINS 白名单，也无需 message 事件监听器，代码更简洁

---

### proxyUpload：先落临时文件再切片（而非流式转发 COS）

**背景：** 视频上传走后端中转，原方案是 `req → putStream 到 COS → ffmpeg 用 getSignedUrl 从 COS 下载原文件 → 切片`。

**问题：**
1. **前端等待时间长**：req 必须等 COS 写完才响应前端，大文件（1GB）写入 COS 需要数分钟，前端进度条卡在 99%。
2. **ffmpeg 从 COS/CDN URL 下载不可靠**：容器内 ffmpeg 发 HTTP 请求，可能遇到 DNS 解析失败、CDN 鉴权签名计算时机问题（getSignedUrl 生成签名到 ffmpeg 开始执行有延迟）。

**决策：改为"临时文件"路线**

```
req → 写入 /tmp/cowatch-{uuid}.mp4（本地磁盘 I/O）
     → 立即写 DB 并响应前端 200（进度条跳 100%，进入"切片中"状态）
     → 后台异步：ffmpeg 读临时文件切片
     → 上传 .ts 片段到 COS（串行，避免带宽爆炸）
     → 广播 VIDEO_ADDED，通知前端切片完成
     → 删除临时文件（isTmpFile=true）
```

**优势：**
- 前端等待从"上传 + COS 写完"缩短为"仅上传"，体验大幅提升
- ffmpeg 读本地文件，零网络依赖，稳定可靠
- 临时文件在切片完成后自动清理，不占用持久存储

**注意：** 本地模式（无 COS 配置）直接写 `uploads/{objectKey}`，ffmpeg 从同一本地目录读，切片后 .ts 文件 rename 到 `uploads/{hlsPrefix}/`，无临时文件开销。

**pro 房间转码路径（2026-06-23 新增）：**

pro 房间支持前端直传原始视频（跳过码率/moov 校验），后端在切片前先用 libx264 重新编码，参数与 `compress_30.bat` 对齐：

```
-c:v libx264 -crf 30 -preset veryfast -pix_fmt yuv420p
-c:a aac -b:a 128k -movflags +faststart
-g 300 -keyint_min 300 -sc_threshold 0
```

- `-pix_fmt yuv420p`：兼容 10bit 源文件（N卡 NVENC 默认输出 10bit）
- `-g 300 -keyint_min 300 -sc_threshold 0`：固定 GOP 保证 HLS 切片对齐关键帧，避免 seek 花屏
- 转码任务走**串行队列**（Promise 链），同一时刻只有一个转码任务运行；`-c copy` 切片不走队列，仍并发执行

**资源约束（服务器：4 核，3.6GB 内存，/tmp 在根分区剩余 18GB）：**
- **内存**：ffmpeg 流式处理，实际占用约数十~几百 MB，与文件大小无关，不会 OOM
- **CPU**：libx264 veryfast 单任务约占 1-2 核，串行队列保护
- **磁盘**：排队任务的原始文件在 /tmp 堆积（最大 3GB/个），任务完成后立即清理；当前 18GB 余量支持约 5 个排队任务

---

### .bat 压缩脚本分发设计

**背景：** 用户需要在上传前用 ffmpeg 对录屏做 CRF 转码，后端提供 `.bat` 脚本供 Windows 用户下载使用。

**ffmpeg 存储位置：`%LOCALAPPDATA%\CoWatch\ffmpeg-bin\`**

早期版本将 ffmpeg 下载到 `.bat` 同目录的 `ffmpeg-bin\` 子文件夹。用户不了解原理时容易只移动 `.bat` 文件，导致每次使用都触发重新下载（130MB）。改为固定存储在 `%LOCALAPPDATA%\CoWatch\ffmpeg-bin\`（即 `C:\Users\{用户名}\AppData\Local\CoWatch\ffmpeg-bin\`）：
- 路径与 `.bat` 存放位置完全无关，移动脚本不影响 ffmpeg 复用
- `%LOCALAPPDATA%` 是用户目录，无需管理员权限，各 Windows 版本均有效

**PowerShell 下载的两个必要优化：**

1. **`$ProgressPreference = 'SilentlyContinue'`**：`Invoke-WebRequest` 默认渲染进度条，在 cmd 窗口内嵌执行时会大幅拖慢下载速度（130MB 可能从 30 秒变成 5 分钟），且界面出现乱码/闪烁。`SilentlyContinue` 禁用进度条，速度恢复正常。

2. **`try/catch + exit 1`**：PowerShell 下载失败时默认退出码不一定传递给 cmd，直接用 `if errorlevel 1` 捕获不可靠。用 `try { ... } catch { exit 1 }` 包裹，配合 cmd 侧的 `if errorlevel 1 ( pause; exit /b 1 )` 才能让窗口在失败时停住而不是闪退。

**当前档位与扩展方式：**

仅开放 CRF 30 一档，`BatController` 中 `VALID_PRESETS = ['30']`。扩展时两处同步：
1. `src/assets/bat/` 新增对应 `.bat` 文件
2. `VALID_PRESETS` 数组添加对应数字字符串

**ffmpeg 安全性：** 使用 gyan.dev 构建的有 Authenticode 签名版本，Windows Defender 误杀率低。企业 EDR 环境（Crowdstrike 等）可能仍会拦截，属于策略问题，无法在 `.bat` 层面解决。

---

## CDN 接入与 TypeA 鉴权

### 背景

视频文件存储在腾讯云 COS 私有桶，接入 CDN 加速后需要解决两个问题：
1. CDN 鉴权：用户拿到 CDN URL 后不能无限期访问（COS 私有读签名在 CDN 有缓存时失效）
2. 签名格式：CDN TypeA 鉴权与 COS 私有读签名是两套完全不同的体系

### CDN 鉴权 vs COS 私有读签名的区别

| | COS 私有读签名 | CDN TypeA 鉴权 |
|---|---|---|
| 参数 | `q-sign-*` 系列 query 参数 | 单个 `sign` query 参数 |
| 验签方 | COS 源站 | CDN 节点 |
| 缓存命中时是否验签 | 否（CDN 直接返回缓存，不回源） | **是**（CDN 节点自行验签） |
| URL 泄露风险 | 有（CDN 有缓存时 URL 永久有效） | 无（过期后 CDN 返回 403） |

**结论：** 只有 CDN TypeA 鉴权才能在缓存命中时也阻止过期 URL 访问。

### CDN TypeA 签名公式（逆向验证）

腾讯云控制台文档描述不清晰，通过「鉴权计算器」逐组验证后确认：

```
sign   = {timestamp}-{rand}-{uid}-{md5}
md5    = md5(path + "-" + timestamp + "-" + rand + "-" + uid + "-" + key)
```

- `timestamp`：当前 Unix 时间戳（**起始时间**，不是过期时间）
- `rand`：随机字符串（任意内容，自己生成即可，CDN 验签时从 sign 参数里直接读取）
- `uid`：固定为 `0`
- `key`：CDN 控制台配置的鉴权密钥（主）
- `path`：视频文件的 pathname（如 `/cowatch/ZRPERZ/xxx.mp4`）

**有效时间**由 CDN 控制台「鉴权配置 → 有效时间」控制（配置为 1800s），与后端 `expireSeconds` 保持一致。

### CORS 问题的根因

签名错误时，CDN 返回 403，但这个 403 **不携带 `Access-Control-Allow-Origin` 响应头**（鉴权层的错误响应不经过响应头配置层）。浏览器检测到跨域请求的响应没有 CORS 头，将其屏蔽并上报 CORS 错误，而非真实的 403。

> 这导致调试时看到的是 CORS 错误，而不是"签名无效"，误导排查方向。

**规律**：跨域请求中，任何 4xx/5xx 响应如果没有 `Access-Control-Allow-Origin`，在浏览器侧都会表现为 CORS 错误。

### SW fetch 请求不能加自定义头

SW 内部向 CDN 发完整请求时，不能加任何自定义请求头（如 `Cache-Control: no-cache`）：
- 自定义头 = 非简单请求 = 浏览器发 preflight（OPTIONS）
- CDN TypeA 鉴权会拦截 OPTIONS 请求（OPTIONS 不带 `sign` 参数），返回 403
- 导致真正的 GET 请求被 CORS 策略阻止

**解法**：SW fetch 请求只保留 `method: 'GET'`，不加任何自定义头。CDN TypeA 鉴权通过 `sign` query 参数完成，无需头部传参。

### stripCosSignature 兼容 CDN TypeA

接入 CDN 后，`stripCosSignature` 需要同时剥离两种签名参数：

```ts
// CDN TypeA 鉴权参数
u.searchParams.delete('sign');
// COS 直连签名参数（本地开发回退路径）
['q-sign-algorithm', 'q-ak', 'q-sign-time', ...].forEach(p => u.searchParams.delete(p));
```

---

### CDN TypeA uid 字段不能放业务参数（流量归因 userId）

**现象：** 将 UUID 格式的 userId（如 `550e8400-e29b-41d4-a716-446655440000`）嵌入 TypeA sign 的 `uid` 字段，CDN 验签失败，浏览器因 403 响应不含 `Access-Control-Allow-Origin` 而报 CORS 错误（误导排查方向，参见"CORS 问题的根因"条目）。

**根因：** TypeA sign 格式为 `{timestamp}-{rand}-{uid}-{md5}`，以连字符为字段分隔符。UUID 本身含 4 个连字符，CDN 解析 sign 时字段错位，md5 校验失败。

**解决：** sign 中 `uid` 字段固定为 `'0'`（TypeA 规范原本就不要求填有意义的值），userId 作为独立 `&uid=` query 参数附加，不参与签名计算，CDN 透传，SW 直接读取用于流量归因：

```ts
// ossService.ts
const uid = '0';  // TypeA uid 字段固定为 0，不放业务数据
const sign = `${timestamp}-${rand}-${uid}-${md5hash}`;
// userId 独立附加，不参与验签
const uidParam = userId !== '0' ? `&uid=${encodeURIComponent(userId)}` : '';
return `${cdnBase}${pathname}?sign=${sign}${uidParam}`;
```

**SW 处理：** `uid` 需在构建 cache key 时一并剥离，否则同一片段因请求用户不同产生多条缓存：

```ts
u.searchParams.delete('sign');  // CDN TypeA 鉴权参数
u.searchParams.delete('uid');   // 流量归因参数（不参与验签，但会破坏缓存命中率）
```

SW 用 `searchParams.get('uid')` 读取归因参数，上报流量统计。

**规律：** query 参数剥离策略需区分"鉴权参数"（必须剥离）和"业务参数"（同样必须剥离），两者都会破坏缓存命中率，但原因不同：鉴权参数随签名轮换，业务参数随请求用户不同。

---

## SW 缓存策略演进：V4 HLS 片段 cache-first（当前）

### 背景

V3（TransformStream 流式切片）彻底解决了 V1/V2 的内存问题，但存在另一个根本缺陷：

**并发请求爆炸**：缓存未命中时，SW 发一次 197MB 的完整请求（去掉 Range 头）。用户在文件下载完成前 seek，每次 seek 触发新 Range 请求 → SW cache.match 未命中（文件还没写完）→ 又发一次 197MB 完整请求。实测：5 分钟视频，seek 3 次，产生 4 条 197MB 完整请求（788MB 流量），且永远无法完成缓存。

`inFlight` Map 去重（方案 D）可以缓解并发爆炸，但无法解决"一小时视频只看了几个 5 分钟片段"场景下的流量浪费：用户只看了 3 个片段，SW 却下载了完整的 1.2GB。

### V4 根本解法：HLS 服务端切片

**后端用 ffmpeg `-c copy` 将 mp4 切成 ~15s 的 .ts 片段**（无重编码，切片速度极快，约 < 5s/视频小时），每片约 7MB（1080p60 CRF28）。

SW 退化为极简 cache-first，只拦截 `.ts` 片段请求：

```ts
// 拦截条件：pathname 包含 /cowatch/ 且以 .ts 结尾
// cache key：剥离 CDN TypeA sign 参数 + COS q-sign-* 参数，以纯路径为 key
// 命中缓存：直接返回（200 响应，无需处理 Range）
// 未命中：fetch 网络，存入缓存，返回
```

**为什么彻底消除了并发 bug：** HLS .ts 片段本身就是完整的 200 响应（hls.js 不发 Range 请求），Cache API 原生支持，无需任何 TransformStream / inFlight 逻辑。代码量从 ~300 行降到 ~80 行。

**流量收益：**
- 只看 3 个 5 分钟片段 → 只下载 3×20片×7MB = 420MB，而不是完整的 1.2GB
- 第二次播放 / seek 到已播片段 → 0 流量（从 Cache Storage 返回）
- 跨天复盘：重新请求 m3u8 接口刷新片段签名 URL，SW 缓存的 .ts 字节不受影响

**关键前提：** hls.js 播放 HLS 时不发 Range 请求，直接 GET 完整 .ts 片段，与 Cache API "只支持 200 响应"完全契合。

---

**CACHE_NAME 更新为 `cowatch-hls-v1`**（与旧 `cowatch-video-v1` 不同），旧缓存在 activate 时自动清理。

---

### hls.js + Blob URL 加载 m3u8 导致内部相对路径解析失败

**现象：** hls.js 加载 Blob URL 后立刻抛 `manifestParsingError`，控制台显示 `Failed to fetch: blob:http://...`。实际上 m3u8 内容中的 .ts 片段 URL 使用的是相对路径（如 `segment0000.ts`），hls.js 会以 m3u8 URL 为 base 解析相对路径。

**根因：** 将 m3u8 文本转为 Blob URL（`URL.createObjectURL(blob)`）后，base URL 变为 `blob:http://localhost:3000/xxxx`，hls.js 将 `.ts` 相对路径拼接为 `blob:http://...segment0000.ts`，这不是合法的网络 URL，fetch 直接失败。

**解决：** 不使用 Blob URL，直接将 API URL（`/api/rooms/:roomId/video/:videoId/playlist.m3u8`）传给 `hls.loadSource(url)`。鉴权通过 `xhrSetup` 回调注入 Token：

```ts
const hls = new Hls({
  xhrSetup: (xhr) => {
    const token = getAccessToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  },
});
hls.loadSource(`/api/rooms/${roomId}/video/${videoId}/playlist.m3u8`);
```

这样 hls.js 内部以 API URL 为 base 解析相对路径，.ts 片段的请求 URL 正确。

---

### `cursor: none` 无法隐藏子元素（button/input）的系统光标

**现象：** 给父容器设置 `cursor: none` 后，鼠标移到播放按钮、进度条等子元素上时，手型光标重新出现。

**根因：** CSS `cursor` 属性被子元素自身的 `cursor: pointer`（浏览器默认样式）覆盖。父元素的 `cursor: none` 只作用于自身，无法强制子元素继承——子元素的 `cursor` 声明优先级更高。直接写 `parent.style.cursor = 'none'` 同样不起作用，因为内联样式无法使用 `*` 选择器覆盖后代。

**解决：** 使用 CSS class + `& *` 子选择器 + `!important` 强制覆盖所有后代：

```scss
.cursorHidden {
  &,
  & * {
    cursor: none !important;
  }
}
```

通过 JS 切换 class（`classList.add/remove`）而非直接操作 `style.cursor`。

---

### `<video controls>` Shadow DOM 内的系统光标无法被外部 CSS 覆盖

**现象：** 已给 `.playerRatio` 加了 `.cursorHidden`（`& * { cursor: none !important }`），但鼠标移到视频控制栏（播放按钮、音量键）时，手型光标依然出现。

**根因：** `<video controls>` 的播放控制栏是浏览器渲染在 **Shadow DOM** 内的原生 UI，任何外部 CSS 选择器（包括 `!important`）都无法穿透 Shadow DOM 边界，UA stylesheet 里的 `cursor` 声明对这部分天然免疫。

**解决：** 给 `<video>` 设置 `pointer-events: none`，让整个原生控件不响应鼠标事件，浏览器不会为"不响应鼠标的元素"显示系统光标：

```tsx
// VideoPlayer.tsx
style={{ pointerEvents: disabled ? 'none' : 'auto' }}
```

**`disabled` 的判断逻辑（`Lobby/index.tsx` 传入）：**
```ts
const videoDisabled =
  (!isController && !freeMode) ||   // 跟随模式 + 非主控 → 不可操作
  (isController && drawingMode);    // 主控绘制模式 → 防止绘制点击触发播放/暂停
```

**注意：** `cursorEnabled`（鼠标共享）与 `disabled`（视频操作权限）职责分离——鼠标共享只发送 WS 位置/样式，不影响视频控件的可操作性。自由模式（`freeMode=true`）下鼠标功能区全部禁用，`disabled` 始终为 false（用户可自由操作视频）。

---

### 鼠标共享与视频可操作性职责混淆（`cursorLocked` 反模式）

**现象：** 非主控用户在自由模式下开启"鼠标共享"后，无法拖动进度条或点击播放/暂停；但自由模式的语义是"用户可自由操作视频"，两者相互矛盾。

**根因：** `cursorEnabled`（是否开启鼠标共享）被错误地与"是否能操作视频"绑定：`cursorLocked = cursorEnabled && !isController`，导致非主控一旦开启鼠标共享，视频控件就被 `pointer-events: none` 封锁。实际上鼠标共享只应管"发送 WS 位置 + 隐藏原生光标"，与视频交互权限无关。

**解决：** 移除 `cursorLocked` prop，将 `disabled` 判断统一收口到父组件，只依赖两个正交条件：

```ts
// Lobby/index.tsx
const videoDisabled =
  (!isController && !freeMode) ||   // 跟随模式 + 非主控 → 不可操作
  (isController && drawingMode);    // 主控绘制模式 → 防止绘制点击触发播放/暂停
```

**职责边界总结：**
| 状态 | 含义 | 影响 |
|------|------|------|
| `cursorEnabled` | 是否开启鼠标共享 | 只影响：① 隐藏原生光标；② 发送 WS 鼠标位置 |
| `drawingMode` | 是否开启绘制模式 | 影响绘制 Canvas 交互；主控时额外置 `disabled=true` 防意外点击 |
| `freeMode` | 是否切换至自由模式 | 鼠标功能区全部 disabled（不可开鼠标共享/画笔）；视频操作不受限 |
| `disabled` | 视频控件是否禁用 | 只由上方逻辑决定，与 `cursorEnabled` 完全解耦 |

---

### 绘制模式下单击触发视频播放

**现象：** 在绘制模式中点击视频区域时，视频会播放/暂停（而非只执行绘制）。

**根因：** `mousedown` 事件绑在父容器（`.playerRatio`）上，但事件的冒泡/穿透阶段 `<video>` 也能收到。浏览器把同一元素上的 `mousedown + mouseup` 组合合成 `click`，触发了视频播放/暂停。

**解决：** 两道拦截，均使用 `{ capture: true }` 在捕获阶段拦截（早于子元素接收）：

```ts
// ① mousedown 捕获阶段：阻止事件到达 <video>
const handleMouseDown = (e: MouseEvent) => {
  if (!drawingMode || e.button !== 0) return;
  e.preventDefault();     // 阻止默认行为（文字选中、拖拽）
  e.stopPropagation();    // 阻止冒泡到 <video>
  // ... 绘制逻辑
};
parent.addEventListener('mousedown', handleMouseDown, { capture: true });

// ② click 捕获阶段：兜底拦截（防止其他路径生成的 click）
const handleClick = (e: MouseEvent) => {
  if (!drawingMode) return;
  e.preventDefault();
  e.stopPropagation();
};
parent.addEventListener('click', handleClick, { capture: true });
```

两道拦截均只在 `drawingMode=true` 时生效，关闭绘制模式后视频控件恢复正常交互。

---

### ffmpeg -c copy 切片后 .ts 文件数量与实际播放秒数不符

**现象：** 30 分钟视频切片，`-hls_time 15` 参数设置 15 秒一片，实际产出的片段时长有的 13s 有的 18s，总片数比预期多几片。

**根因：** `-c copy` 不重编码，切片点只能在关键帧（I 帧）位置切。ffmpeg 遇到一个 I 帧时才能切割，如果相邻 I 帧间距大于 15s，该片段就会超过 15s；如果间距小于 15s 但跨过了目标切割时间点，就会提前切割。最终每片时长取决于源视频的 GOP（Group of Pictures）大小，不是精确的 15s。

**影响：** .m3u8 `#EXTINF:` 标记的是每片实际时长，hls.js 能正确处理不均匀片长，播放不受影响。

**注意：** 如果需要严格的 15s 切割（如广告插入场景），必须用 `-c:v libx264 -force_key_frames "expr:gte(t, n_forced * 15)"` 强制在切割点插入 I 帧，代价是重编码，时间更长（约 2–5 倍）。CoWatch 复盘场景不需要严格切割，`-c copy` 足够。

---

### Docker Hub mirror 同步延迟导致 CI/CD 拉镜像失败

**现象：** 业务仓库 CI 推镜像成功后立刻触发 infra 部署，infra `docker pull` 报 `manifest not found` 或 `content not found`。

**根因：** 服务器配置了第三方 mirror（如 `docker.1ms.run`）做 Docker Hub 加速。mirror 是**按需缓存**机制——首次有人拉某个 tag 时才回源 Docker Hub 建立缓存。push 完立刻触发 infra，此时 mirror 尚未缓存该镜像，拉取失败。

**解决：** 等几分钟让 mirror 同步完成后，在 infra 手动重新触发 `workflow_dispatch`，填入相同的 image tag（如 `sha-4a61131d`）即可。

**长期方案（待实施）：** 在 infra deploy script 中加 pull 重试逻辑：
```bash
for i in 1 2 3; do
  docker pull docker.io/$DOCKER_HUB_USERNAME/cowatch:$FRONTEND_TAG && break
  echo "pull 失败，第 $i 次重试（等待 15s）..."
  sleep 15
done
```

**注意：** image tag 是 `sha-4a61131d` 这样的短 SHA（CI 生成），不是 `sha256:675d769d...` 这种 digest。infra `workflow_dispatch` 的 `image_tag` 参数填前者。

---

### `useMemoizedFn` 内读取 state 变量的 stale closure 问题

**现象：** `handleSwitchVideo` 里用 `objectKey === activeObjectKey` 判断是否为主控自身广播，但该判断**永远为 false**，导致主控收到自己发出的 `SWITCH_VIDEO` 广播时重复执行了完整的元数据同步逻辑。

**根因：** `useMemoizedFn` 的核心机制是记忆函数引用，其闭包在首次创建时捕获 state 变量（此时为初始值 `null`）。后续 `setState` 不会更新闭包内的捕获值，因此闭包里的 `activeObjectKey` 永远是 `null`，比较永远不成立。

**解决：** 对所有需要在 `useMemoizedFn` 闭包内读取最新值的 state，引入对应的 `useRef` 作为"可变镜像"：

```ts
const [activeObjectKey, setActiveObjectKey] = useState<string | null>(null);
const activeObjectKeyRef = useRef<string | null>(null); // 同步镜像

// 每次 setState 时同步写 ref
activeObjectKeyRef.current = objectKey;
setActiveObjectKey(objectKey);

// useMemoizedFn 内读 ref，而非 state
if (objectKey === activeObjectKeyRef.current) { ... }
```

**同类场景：** `followModeRef` 也是同一模式，用于解决 `followMode` 在 `useMemoizedFn` 内读取时的 stale closure。项目中所有需要在稳定函数引用内读取最新状态的变量，均应配套 ref 镜像。

---

### 控制权转移后原主控意外进入跟随状态

**现象：** 管理员 A 将控制权转移给 B 后，A 的界面开始跟随 B 的播放操作（进度同步、视频切换均随 B 变化）。

**根因：** `CONTROL_CHANGED` 消息只触发了 `setControllerId` 更新，没有重置 `followMode`。A 变成非主控后，`followMode` 仍保持初始值 `true`（跟随模式），立即开始响应新主控 B 的所有广播。

**解决：** 在 `useRoomWs` 的 `CONTROL_CHANGED` 处新增 `onControlChanged` 回调，`index.tsx` 收到后判断：若 `newControllerId !== myUserId`（自己不再是主控），则将 `followMode` 重置为 `false`（自由模式）：

```ts
const handleControlChanged = useMemoizedFn((newControllerId: string) => {
    const myUserId = userInfo?.userId;
    if (!myUserId) return;
    if (newControllerId !== myUserId) {
        followModeRef.current = false;
        setFollowMode(false);
    }
});
```

**三人房间的影响：** 控制权从 A 转给 B 时，C（第三人）若之前处于跟随模式，也会被重置为自由模式——主控换人意味着跟随对象改变，让 C 自主决定是否继续跟随新主控，比静默继续跟随更安全。

---

### 腾讯云 CDN 日志字段解读

**日志格式（空格分隔）：**
```
时间 IP 域名 路径 响应字节数 请求数 并发数 状态码 NULL 耗时ms UA referer 方法 协议 缓存状态 端口
```

**第5字段 = 实际传输字节数**（非 `Content-Length` 元数据）。浏览器 Range 请求下值较小（几百KB/片），完整下载时与文件大小接近。

**`Go-http-client/1.1` UA + `hit` 缓存状态 = CDN 节点间内网流量**

`123.58.10.x` 是腾讯云 CDN 内部节点 IP，`Go-http-client` 是其内部传输客户端的 UA。缓存状态 `hit` 表示该节点已有缓存，不触发回源，**流量不计入 COS 出口流量**，计入 CDN 节点间流量费用科目（通常低于出口流量单价，部分套餐免费）。

**`miss` = 真实回源**，此时 COS 出口流量计费。整个 6.14 晚 18-20 点时段仅有 1 条 `miss`（64KB，分片回源首片），说明 CDN 缓存命中率极高。

**真实用户流量识别：** 看 UA 是否为浏览器（`Mozilla/5.0`）或 PowerShell（`WindowsPowerShell`），排除 `Go-http-client` 节点内部流量后，才是终端用户实际产生的下载流量。

---

### 上传头像后界面头像不更新（CDN 缓存 + objectKey 固定）

**现象：** 用户上传头像后，页面头像无变化；接口 `POST /api/auth/avatar` 返回 200 且 `avatarUrl` 有值，但与上次完全相同。

**根因（两个叠加）：**

1. **objectKey 固定**：后端生成路径为 `avatar/{userId}.jpg`，同一用户反复上传永远是同一 URL。CDN 以 URL 为 key 命中旧缓存，即使 COS 上的文件已替换，前端拿到的 URL 也完全没变。
2. **缺乏用户级目录隔离**：所有用户头像平铺在 `avatar/` 下，无法按用户维度列举或管理历史版本。

**解决：** 后端 objectKey 改为 `avatar/{userId}/{userId}-{ts}.jpg`（`ts = Date.now()`）：
- 时间戳后缀保证每次上传 URL 唯一，CDN 必然回源，彻底绕过缓存
- 用户子目录实现文件级隔离，方便未来按用户维度管理
- 旧文件不主动删除（头像文件极小，存储成本忽略不计）

**通用规则：** 凡是后端返回的"可更新静态资源 URL"（头像、封面图、二维码等），objectKey 都不能固定为用户维度的唯一路径。只要路径不变，CDN 就会永久命中旧缓存，无论文件内容是否已替换。解法统一：在文件名中加入时间戳或内容 hash。

---

### `useMemoizedFn` 闭包读到旧 state（stale closure）

**现象：** `useMemoizedFn` 包裹的函数内读取 React state，值永远是初始值（如 `activeObjectKey` 始终为 `null`），导致条件判断永远不成立。历史实际 bug：`handleSwitchVideo` 中 `objectKey === activeObjectKey` 永远 false，主控切换视频无反应；`handleControlChanged` 里 `activeVideoIdRef` 漏写，控制权转移后新主控同步视频失败。

**根因：** `useMemoizedFn` 的核心特性是返回引用稳定的函数，函数引用不随渲染更新。代价是内部闭包只在初始化时捕获一次外部变量，后续 state 更新触发重渲染时函数不重建，闭包里的 state 值永远是旧的。

**解决：** 凡是需要在 `useMemoizedFn` 闭包里读取最新值、同时又需要驱动渲染的状态，必须同时维护 state（服务渲染）和 ref（服务闭包命令式读取）：
- **state**：驱动 JSX 重渲染，通过 `useState` 管理
- **ref**：在 `useMemoizedFn` 闭包内命令式读取，`ref.current` 每次读取都是当时最新值，不受闭包捕获时机影响

原始写法需要在每次写入时手动同步双写（`setXxx(val)` + `xxxRef.current = val`），漏写即产生 bug。封装 `useSyncedState` hook 将两者合并为单一 setter：

```ts
// src/hooks/useSyncedState.ts
export function useSyncedState<T>(initial: T) {
    const [value, setValue] = useState<T>(initial);
    const ref = useRef<T>(initial);
    const set = useCallback((next: T) => {
        ref.current = next;
        setValue(next);
    }, []);
    return [value, ref, set] as const;
    // 用法：const [activeObjectKey, activeObjectKeyRef, setActiveObjectKey] = useSyncedState<string | null>(null);
    //   value  → JSX 渲染（响应式）
    //   ref    → useMemoizedFn 闭包内读取（始终最新）
    //   setter → 同时更新两者，不可能遗漏
}
```

**注意：** `useSyncedState` 的 setter 只接受值，不接受函数式更新 `(prev) => next`。若原逻辑用了函数式更新，改为从 `ref.current` 读当前值再计算：`const next = !xxxRef.current; setXxx(next)`。

---

### daibao-dashboard 多段端口与跨 Compose 网格设计

**背景：** daibao-dashboard（大盘网）需要访问运行在不同 Docker Compose 网格中的 cowatch-backend 和 monitor-backend，同时要保证 backend 端口不暴露到公网。

**端口段约定（用分段避免冲突，便于扩展）：**

| 段 | 用途 |
|----|------|
| `3070~3079` | CoWatch 前端对外入口（3070 生产，3071 测试） |
| `3100~3109` | monitor-backend（3100 生产，3101 测试） |
| `6000~6009` | daibao-dashboard 对外入口（6000 生产，6001 测试） |
| `8000~8009` | 仅本机可达的 backend 内部通道（8000 cowatch 生产，8001 测试） |
| 容器内统一 | `3002`（Node.js）/ `80`（Nginx） |

**`127.0.0.1:PORT` vs `0.0.0.0:PORT` 的安全语义（含踩坑修正）：**

```yaml
# ❌ 看似安全，实际上 Docker 容器经 host-gateway 访问时会被拒绝
# 127.0.0.1 只有宿主机本地进程可达，容器走 172.17.0.1 不经过 loopback
- "127.0.0.1:8000:3002"

# ✅ 正确做法：绑定 0.0.0.0，安全性靠云服务器安全组不开放该端口来保证
- "8000:3002"  # 等价于 0.0.0.0:8000:3002
```

cowatch-backend 的 8000/8001 端口用 `0.0.0.0` 绑定（省略 IP 前缀），安全组不开放这两个端口，外网无法直连；daibao-dashboard 自身的 6000/6001 同样 `0.0.0.0` 绑定，供内网/VPN 访问。

**跨 Compose 网格：`host-gateway` 机制：**

daibao 与 cowatch 是独立 Compose 网格，不共享内部 DNS，容器间无法通过服务名互访。通过 `extra_hosts: host-gateway:host-gateway` 将宿主机 IP 注入容器 `/etc/hosts`，容器内 Nginx 用 `http://host-gateway:8000` 穿透 Compose 边界访问 cowatch-backend。

**两段 Nginx 的职责：**

```
宿主机 Nginx → SSL 终止 + 子域名分发（daibao 不绑域名，此层直接跳过）
容器内 Nginx → 静态资源服务 + /api/* 代理到 cowatch-backend + /monitor-api/* 代理到 monitor-backend
```

**后端 URL 注入方式（envsubst）：** `nginx.conf` 用 `${COWATCH_BACKEND_URL}` 占位，镜像启动时 `envsubst` 将 Docker Compose `environment` 变量替换为实际 URL，无需重新构建镜像即可切换生产/测试指向。

**当前耦合的临时性：** daibao 借用 cowatch 的 8000 端口，尚未拆分独立 admin-backend。未来第二个子产品上线时，改为独立 admin-backend 聚合层，daibao 只需修改 `COWATCH_BACKEND_URL` 环境变量，nginx.conf 和对外端口（6000/6001）不变。

---

### daibao-dashboard 502 — 容器经 host-gateway 无法访问 127.0.0.1 绑定的端口

**现象：** dashboard 部署后登录请求返回 502 Bad Gateway，cowatch-backend 容器正常运行。

**根因：** cowatch-backend 端口绑定为 `127.0.0.1:8001:3002`。`127.0.0.1` 是 loopback 地址，只有宿主机本地进程可达。Docker 容器有独立网络命名空间，经 `host-gateway`（即宿主机 docker0 网桥 IP `172.17.0.1`）访问宿主机时，不经过 loopback 接口，因此被拒绝。

**解决：** 改为 `8001:3002`（绑定 `0.0.0.0`），外网安全性靠云服务器安全组不开放 8000/8001 端口来保证。

**规律：** 凡是需要让 Docker 容器经 `host-gateway` 访问的宿主机端口，绝对不能用 `127.0.0.1` 绑定，必须用 `0.0.0.0`（或省略 IP 前缀）。

---

### `useRequest` + 不稳定 deps 导致 Monitor 页面无限请求风暴

**现象：** 切换到 Monitor 页面后，接口在本地无 `monitor-backend` 时进入无限循环——请求失败 → 触发重试 → deps 变化 → 再次发起请求，Network 面板持续刷新，无法自然停止。

**根因（三个叠加）：**

1. **`useDateRange` 返回值不稳定：** `startTime` / `endTime` 在每次渲染时通过 `dayjs().subtract(...)` 重新生成，对象引用每次都是新的。`useRequest` 的 `refreshDeps` 检测引用相等，引用变化 → 触发重新请求 → 组件渲染 → 又生成新引用 → 死循环。

2. **`useRequest` 默认开启重试：** ahooks `useRequest` 默认 `retryCount: 3`，请求失败后自动重试 3 次，叠加上面的循环效果放大了请求数量。

3. **超时过长（30s）：** 每次请求失败要等 30 秒才进入重试，循环可以持续很长时间。

**解决（三处同步修复）：**

```ts
// 1. useDateRange.ts：用 useMemo 稳定引用
const startTime = useMemo(() => dayjs().subtract(days - 1, 'day').startOf('day').valueOf(), [days]);
const endTime   = useMemo(() => dayjs().endOf('day').valueOf(), [days]);

// 2. monitorRequest 超时从 30s 降到 8s，更快暴露不可达问题
timeout: 8000,

// 3. Monitor 页面 useRequest 调用，显式禁止重试
useRequest(fetchPerfStats, {
  refreshDeps: [startTime, endTime],
  retryCount: 0,   // ← 明确禁用，防止不可达时的雪崩重试
});
```

**通用规则：** 凡是作为 `useRequest` refreshDeps 的时间范围值，必须用 `useMemo`（或 `useRef`）保证引用稳定，否则任何触发渲染的操作都会导致无意义的重新请求。

---

### 日志型表不设外键

`segment_views.video_id` 曾设有外键，导致删除视频时因子记录未清理而报约束错误；直接级联删又会丢失流量历史数据。最终决策：移除外键。

**外键的三个作用，对日志表都不适用：**

| 作用 | 业务主数据（适用） | 日志/埋点表（不适用） |
|------|------|------|
| 引用完整性（插入时拒绝孤立记录） | `room_members` 不能引用不存在的 user | 流量已真实发生，视频删除不影响这个事实 |
| 级联操作（父表删除时处理子表） | 适合"父删子必无意义"的强关联 | 父删后日志应保留，级联删破坏统计回溯 |
| 查询优化提示 | 有效 | 实际收益有限 |

**通用原则：** 流量日志、操作记录、埋点等表，`*_id` 字段只是分组 key，不设外键。外键适合业务主数据之间的强关联（如 `room_members → users/rooms`）。

---

### 房间等级体系：功能权限绑定房间而非用户

**背景：** 引入 `vip:pro` 高级会员后，需要决定"功能限制绑在用户等级还是房间上"。

**结论：** 功能权限绑定**房间等级**（`rooms.plan_level`），而非直接绑定用户等级。

**原因：**
- 若直接绑用户等级，房主会员过期后，所有受邀成员正在使用的房间会立即失效，体验差
- 房间等级在**创建时**由房主当前最高 plan 决定（继承一次），此后独立存在
- 房主会员过期 → 每日降级 job 检查 → 若无独立订阅来源则降级为 `free`

**双轨付费架构（`room_subscriptions` 表）：**

| 来源 `source` | 含义 | 受用户会员状态影响 |
|---|---|---|
| `user_membership` | 创建房间时由会员等级决定 | ✅ 受影响（会员过期后降级） |
| `admin_grant` | Admin 手动赋予（永久有效） | ❌ 不受影响 |
| `room_package` | 房间独立付费包（预留） | ❌ 不受影响 |

**降级判断逻辑（每日凌晨 3:00 `jobs/roomDowngrade.ts`）：**
1. 查所有 `plan_level != 'free'` 的房间
2. 查 owner 当前有效 plan → 推导 `ownerMaxLevel`
3. 若 `ownerMaxLevel < roomLevel`，再查 `room_subscriptions` 是否有 `admin_grant` 或 `room_package` 来源的有效订阅
4. 有 → 跳过（独立来源不降级）；无 → 降级为 `free`

**前后端拦截层：**
- 后端：`requireRoomActive()` 中间件挂在操作型接口上（`plan_level=free` 时 403）；`GET /:roomId`（getInfo）**不挂**，前端需要拿到 planLevel 才能显示过期页
- 前端：Lobby 拿到 `roomState.planLevel === 'free'` 时，渲染 `<RoomExpired />` 遮挡页，不初始化 WS 无关功能

---

### req.pipe(writeStream) 不会在客户端断开时自动关闭 writeStream

**现象：** 用户上传视频中途刷新浏览器，TCP 断开，但 `writeStream` 永远不会触发 `finish` 或 `error` 事件。文件句柄泄漏，`/tmp` 下残留不完整的临时文件，且永远不被清理。

**原因：** Node.js `req.pipe(writeStream)` 在 readable stream（req）关闭时，默认行为是 **不自动销毁** writable stream（writeStream）。`finish` 事件只在 writable 正常写完时触发，`error` 只在写入出错时触发；客户端断开属于 readable 侧的事件，writable 侧无感知。

**解决：** 监听 `req` 的 `'close'` 事件，判断 `res.headersSent`（区分「正常完成后关闭」和「中途断开」）：

```ts
req.on('close', () => {
  if (res.headersSent) return; // 已正常响应，忽略
  writeStream.destroy();
  fs.rm(tmpFile, { force: true }, () => {});
});
```

**适用场景：** 所有用 `req.pipe(writeStream)` 接收文件流的接口（`proxyUpload`、`uploadLocal`）。

---

### Provider 洋葱圈：内层不得依赖外层

**背景：** `RoomContext` 的 `initRoom` 需要同时写入 `RoomMetaContext`（外层）和 `RoomContext`（内层），最初实现为在 `RoomProvider` 内部调用 `useRoomMeta()`，造成内层 Context 引用外层。

**问题：** 违反洋葱圈独立原则——内层 Provider 依赖外层 Context，Provider 间产生隐式耦合，测试和复用都困难。

**解决：** 将联动职责上移到调用方（Lobby），两个 Context 各自只管自己的数据：

```ts
// Lobby 中
setRoomMeta({ roomId, roomName, planLevel }); // 写外层
initRoom({ videos, members, controlMode, controllerId }); // 写内层
```

**通用原则：** 两个 Context 需要联动时，由调用方在同一处理函数中分别调用各自的 setter，而非在 Provider 内部相互 `useContext`。Provider 应当对其他 Context 一无所知。

---

### SQLite → PostgreSQL 迁移注意点

迁移过程中有三处需要注意：

1. **`BIGINT` 类型**：postgres.js 默认将 `BIGINT` 列以 JS `string` 返回（防精度丢失），需在连接池初始化时配置 type parser 统一转为 `number`。
2. **API 字段名**：SQLite 层习惯用 `AS` 别名重命名结果列，迁移后 PG 返回原始列名，需在 controller 层显式做字段映射以保持 API 契约不变。
3. **NULL 数据导出**：sqlite3 导出时 NULL 变为空字符串，psql `\COPY` 会报类型错误，需用 `COALESCE(..., '\N')` + `NULL AS '\N'` 显式标记。

---

## 待了解

- **WebSocket 心跳 + 随机抖动指数退避重连**
  当前 CoWatch 不需要心跳（见架构决策章节），但若未来遇到"用户显示在线但实际已断开"的僵尸连接问题，需要实现：
  1. **应用层心跳**：服务端每 30s 发 PING 帧，客户端响应 PONG；超过 2 次无响应则主动 close
  2. **指数退避重连**：客户端断线后不立即重连，按 `min(base * 2^n, maxDelay)` 退避，避免服务端重启时大量客户端同时重连造成雪崩
  3. **随机抖动（jitter）**：在退避延迟上叠加随机量 `delay * Math.random()`，将重连请求分散到时间窗口内，防止同时在线用户同步重连的"惊群"问题
