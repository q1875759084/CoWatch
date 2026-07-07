# CoWatch — Claude Code 配置

> 每次对话自动加载。包含项目背景、关键约定，以及各规范文件的引用。

## 项目背景

**多人游戏录屏同步复盘平台**。管理员创建房间并上传多段录屏，受邀成员注册后加入，所有人实时同步观看同一视频，支持带权限管理的进度条控制。

### 用户与角色

| 角色 | 说明 |
|------|------|
| 管理员 | 房间创建者，可上传视频、指定控制者 |
| 成员 | 注册用户通过邀请链接加入房间 |

**身份方案：** 注册登录账号体系，JWT 双 Token（短期 `accessToken` 存内存/LS + 长期 `refreshToken` 存 HttpOnly Cookie），前端 axios 拦截器实现无感刷新。

**会员体系：** 两级会员，`vip:basic`（普通会员）和 `vip:pro`（高级会员），存储在 `user_subscriptions` 表（plan 字段为字符串）。等级继承：`vip:pro` 自动满足所有 `vip:basic` 校验（后端 `planGuard.ts` 的 `PLAN_HIERARCHY` 数值表实现）。内测期间不开放前端充值入口，admin 通过 dashboard 手动赋予（`POST /api/admin/cowatch/users/:userId/plans`）。

**房间等级体系：** 功能权限绑定**房间等级**（`rooms.plan_level: 'free' | 'vip:basic' | 'vip:pro'`），而非直接绑定用户等级。房间在创建时继承房主当前最高会员等级；房主会员过期后每日凌晨 3:00 降级 job（`jobs/roomDowngrade.ts`）自动检查并降级为 `free`（不可用状态）。`room_subscriptions` 表统一管理订阅来源（`user_membership` / `admin_grant` / `room_package`），`admin_grant` 和 `room_package` 来源的有效订阅不受用户会员状态影响。后端 `requireRoomActive()` 中间件守卫操作型接口，`plan_level=free` 时 403；`GET /:roomId` 不挂守卫，前端 Lobby 拿到 `planLevel=free` 时渲染过期遮挡页。Admin 可通过 Dashboard 房间管理页手动设置房间等级（`POST /api/admin/cowatch/rooms/:roomId/plan-level`）。

### 功能模块

| 模块 | 路由 | 说明 |
|------|------|------|
| 登录/注册 | `/auth` | 账号注册与登录 |
| Dashboard | `/` | 我的房间列表、创建/加入房间入口；顶栏用户信息面板（hover 弹出：头像（可换图）+ 昵称（可改名）+ uid + 退出登录） |
| 房间主页 | `/room/:roomId` | 视频播放区 + 视频列表（多段录像）+ 上传区 + 成员/控制权面板（合并了原 lobby 和 watch 两个页面）+ 进度条 Tag 标注 + 鼠标共享（Canvas PainterLayer 蒙层，多端实时同步光标位置）+ 协同绘制（绘制模式下按住左键画笔迹，WS 广播同步，支持黑/白/红三色）+ 开庭记录（右上角浮层，主控可编辑，节流 1000ms WS 广播同步，全员可导出为 txt）+ 聊天（右上角独立浮层按钮，全员可发，WS 广播含发送者自身，内存缓存最近 50 条，新成员加入时通过 ROOM_STATE 下发历史记录，不落库）+ 复盘/自由模式（非主控专属：跟随模式默认跟随主控进度；自由模式可独立操作播放器、切换房间内任意视频，不显示/发送画布笔迹；主控可一键拉回所有人至当前状态并强制恢复跟随） |
| Electron 客户端录制 | 房间主页内悬浮控件 | **`vip:pro` 专属**。ffmpeg HLS 实时编码 → chokidar 监听切片 → `net.fetch` 上传后端 → COS。Windows 音频：`audio_capture.exe`（WASAPI Loopback）pipe:0 传入 FFmpeg；macOS 静音。视频：Windows 全屏 ddagrab / 窗口 gfxcapture（GPU 零拷贝），macOS avfoundation。健壮性：窗口录制双层检测（crash 时单次枚举 + 5s 轮询兜底），目标窗口消失时优雅 stop()。代码：`electron/handlers/recorder/`（index.ts + window-watch.ts）。|

### 控制权机制

- **指定模式（唯一模式）**：某成员为进度控制者（主控），`canControl` 只判断 `controller_id === userId`
- 自由模式已移除（多发送方造成竞态，与防回环计数器冲突，弊大于利）
- **主控自动分配**：第一个进入房间的人自动成为主控（`onlineIds.size === 1` 时 `setControllerId` 并广播 `CONTROL_CHANGED`）
- **转让权限**：主控和管理员均可触发 `TRANSFER_CONTROL`（`canControl(userId, room) || is_admin === 1`）
- **离线兜底**：主控断线时按优先级转让 → 在线管理员 → 任意在线成员 → null（房间已空时）

### 技术栈

| 端 | 技术 |
|----|------|
| 前端 | React 19 + Webpack 5 + TypeScript + antd 5.x，Node 20 |
| 后端 | Node.js 20 + Express + ws 库 + **PostgreSQL**（postgres.js 连接池），用 `tsx` 直接运行 TS |
| 视频存储 | 腾讯云 COS（后端代理中转上传）或本地 `/uploads` 目录（开发环境）；HLS 切片通过后端代理路径分发（`/api/rooms/.../segments/seg.ts` → 后端鉴权 → 302 → CDN），不在 m3u8 中直接暴露 CDN 签名 URL |
| 头像存储 | 腾讯云 COS static 桶（public read），CDN 域名 `static.daibao.site`，路径 `avatar/{userId}.jpg`；无需签名直接访问；本地开发写入 `uploads/avatar/` 目录 |
| 实时通信 | WebSocket（ws 库），服务端广播房间事件 |

**项目结构：** 前后端分离，非 Monorepo。`CoWatch/`（前端）和 `CoWatch-backend/`（后端）各自独立。

## 成员列表设计

成员列表**保留所有历史成员，含在线状态**：
- WS 连接时发 `MEMBER_JOINED`（含 `isOnline: true`），断线时发 `MEMBER_OFFLINE`（只标记离线，不删除）
- 成员列表含 `isOnline` 字段，离线成员仍保留在列表中（灰显）
- `MEMBER_LEFT` 保留给未来退群/踢人功能，当前不触发

## 部署与环境变量体系

- **部署由 `infra` 仓库统一管理**，前后端各自触发 `repository_dispatch` 事件 → `infra/.github/workflows/deploy-cowatch.yml` 执行部署；CoWatch 和 CoWatch-backend 仓库**不含任何部署逻辑**
- **服务器是无状态的**，不存在任何 `.env` 文件，不需要也不应该 SSH 到服务器手动维护环境变量
- **敏感变量唯一存储位置：infra 仓库的 GitHub Actions Secrets**（`JWT_SECRET`、`PG_PASSWORD`、`COS_SECRET_ID` 等），通过 `envs` 加密通道注入容器，不出现在命令行/日志
- **非敏感变量**（如 `PORT`、`NODE_ENV`）直接硬编码在 `infra/cowatch/docker-compose.yml` 的 `environment:` 块中
- **新增环境变量的完整流程**：
  1. 敏感值 → infra 仓库 Settings → Secrets 新增
  2. `deploy-cowatch.yml` 的 `env:` 块和 `envs:` 列表追加该变量名
  3. `infra/cowatch/docker-compose.yml` 的 `backend.environment:` 中用 `- VAR=${VAR}` 引用
  4. 非敏感变量跳过前两步，直接在第 3 步硬编码值
- `.env` 文件**仅用于本地开发**（已加入 `.gitignore`），线上完全无关，不要在分析线上问题时将其纳入考虑

## 关键约定

- HTTP 请求必须走封装的 `request`（axios 实例），禁止直接用原生 `fetch` 或 `axios`；以下两类例外场景允许绕过，需在注释中说明原因：
  - **OSS 预签名直传**：OSS 通过 URL query 鉴权，带自定义 `Authorization` 头会报错，用原生 XHR
  - **后端返回非 JSON 数据（如 Blob 文件下载）**：业务拦截器会对 `response.data.code` 做校验，Blob 响应无该字段会被误判失败，改用原生 `axios.get`
- OSS 预签名直传用 XHR（不能带自定义 Authorization），后端接口上传用 `request.put` + `onUploadProgress`
- `__dirname` 在 `tsx` 直接运行时指向源文件目录（`src/`），路径层级与编译后运行不同，写静态文件路径时需注意
- WebSocket 消息类型定义在 `src/types/room.ts`，增加新消息类型时前后端同步更新；当前已有类型含 `DRAW_STROKE`（笔迹广播，含 `userId`、`color`、`points[]`）和 `DRAW_CLEAR`（清空画布），后端纯内存转发不落库
- 数据库使用 **PostgreSQL**（postgres.js），schema 变更通过 `migrations/*.sql` 版本化管理（`schema_migrations` 表记录已执行版本），服务启动时 `runMigrations()` 自动幂等执行；新列使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`；DB 层默认为 NULL，service 层统一做 fallback（如 `avatar_url ?? DEFAULT_AVATAR_URL`）；postgres.js `BIGINT` 列默认返回 JS `string`，连接池初始化时配置 `types.bigint` 自定义 parser 统一转为 number
- 视频上传前端校验（`src/utils/validateVideo.ts`）按**房间等级**区分策略：`vip:basic` — ① 读文件头 32KB 扫描 moov/mdat 顺序（moov 必须在 mdat 之前）；② 平均码率 ≤ 8 Mbps（CRF 28）；`vip:pro` — 跳过以上两项，只校验文件大小 ≤ 3 GB（后端负责转码）；失败时用 antd `Modal.error()` 弹窗告知用户
- 视频上传链路：所有用户统一走后端代理中转（`getUploadUrl` 返回 `mode: 'proxy'`，前端 POST 到后端，后端流式 putStream 到 COS）；本地开发环境返回 `mode: 'local'`，文件直接落盘到 `/uploads`；白名单直传分支（`is_upload_whitelist`）已废弃
- 后端 `uploadGuard` 中间件挂载在上传路由上：校验 Sec-Fetch 请求头 + 每日中转总字节数上限 5GB（`Content-Length` 预检 + 真实写入后 `addDailyBytes` 计费）
- **req.pipe 踩坑**：`req.pipe(writeStream)` 在客户端中途断开时不会自动销毁 writeStream，需显式监听 `req.on('close')` 判断 `res.headersSent`，手动 `writeStream.destroy()` + 清理临时文件，防止文件句柄泄漏和 `/tmp` 残留
- `.bat` 压缩脚本：当前仅开放 `compress_30.bat`（CRF 30），`BatController` 的 `VALID_PRESETS` 仅含 `'30'`，扩展时在数组和 `src/assets/bat/` 目录同步新增对应文件；ffmpeg 下载至 `%LOCALAPPDATA%\CoWatch\ffmpeg-bin\`（与 `.bat` 存放位置无关，用户移动脚本不会触发重复下载）
- multer 文件上传路由中，`upload.single()` 之后必须挂载专用 4 参数错误中间件（`err, req, res, next`）拦截 `MulterError`（超大文件等）并返回 400；否则会被全局 errorHandler 当成 500 处理。后续内联箭头函数需显式标注 `(req: Request, res: Response)`，否则 TypeScript 推断链断裂报 `implicit any`
- **RoomGuard 只做轻守卫**：仅校验用户身份（`userInfo`）和 `roomId` 是否存在，不调用任何业务接口（不调 getInfo、不调 initRoom、不写 RoomContext）；房间信息加载、planLevel 判断、过期页渲染等业务逻辑均由 Lobby 内部处理。原则：守卫层不知道业务，业务层不依赖守卫的副作用。
- **Provider 洋葱圈结构与单向数据原则**：当前层次（由外到内）：`UserProvider`（用户身份）→ `RoomMetaProvider`（roomId、roomName、planLevel）→ `RoomProvider`（视频列表、成员列表、控制权、播放 URL）→ `RouterProvider`。**单向原则**：内层 Provider 不得 `import` 或 `useContext` 外层 Context；两个 Context 需要联动时，由调用方（如 Lobby）分别调用各自的 setter，而非在 Provider 内部相互引用。**数据写入约定**：`initRoom` 只写 RoomContext 的业务状态；房间元信息（roomId/roomName/planLevel）由调用方在同一处理函数中单独调 `setRoomMeta` 写入 RoomMetaContext。

## 编码规范

详细规范见以下 Rules 文件（自动按文件类型加载）：

@.claude/rules/js-guide.md
@.claude/rules/react-guide.md
@.claude/rules/project-engineering.md
