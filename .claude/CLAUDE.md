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

**会员与房间等级：** 两级会员 `vip:basic` / `vip:pro`，admin 通过 Dashboard 手动赋予。功能权限绑定**房间等级**（`rooms.plan_level: 'free' | 'vip:basic' | 'vip:pro'`）而非用户等级；房间创建时继承房主最高 plan；房主会员过期后每日凌晨 3:00 降级 job 检查，无独立订阅来源时降为 `free`；Lobby 拿到 `planLevel=free` 时渲染过期遮挡页。

### 功能模块

| 模块 | 路由 | 说明 |
|------|------|------|
| 登录/注册 | `/auth` | 账号注册与登录 |
| Dashboard | `/` | 我的房间列表、创建/加入房间入口；顶栏用户信息面板（hover 弹出：头像（可换图）+ 昵称（可改名）+ uid + 退出登录） |
| 房间主页 | `/room/:roomId` | 视频播放区 + 视频列表（多段录像）+ 上传区 + 成员/控制权面板 + 进度条 Tag 标注（主控在时间轴打标注，点击跳转并同步给所有成员）+ 鼠标共享（Canvas PainterLayer 蒙层，多端实时同步光标位置）+ 协同绘制（绘制模式下按住左键画笔迹，WS 广播同步，支持黑/白/红三色，清空画布） |

### 技术栈

| 端 | 技术 |
|----|------|
| 前端 | React 19 + Webpack 5 + TypeScript + antd 5.x，Node 20 |
| 后端 | Node.js 20 + Express + ws 库 + **PostgreSQL**（postgres.js 连接池），用 `tsx` 直接运行 TS |
| 视频存储 | 腾讯云 COS（预签名直传）或本地 `/uploads` 目录（开发环境） |
| 头像存储 | 腾讯云 COS static 桶（public read），CDN 域名 `static.daibao.site`，路径 `avatar/{userId}.jpg`；无需签名直接访问；本地开发写入 `uploads/avatar/` 目录 |
| 实时通信 | WebSocket（ws 库），服务端广播房间事件 |

**项目结构：** 前后端分离，非 Monorepo。`CoWatch/`（前端）和 `CoWatch-backend/`（后端）各自独立。

## 成员列表设计

成员列表**保留所有历史成员，含在线状态**：
- WS 连接时发 `MEMBER_JOINED`（含 `isOnline: true`），断线时发 `MEMBER_OFFLINE`（只标记离线，不删除）
- 成员列表含 `isOnline` 字段，离线成员仍保留在列表中（灰显）
- `MEMBER_LEFT` 保留给未来退群/踢人功能，当前不触发

## 关键约定

- HTTP 请求必须走封装的 `request`（axios 实例），禁止直接用原生 `fetch` 或 `axios`；以下两类例外场景允许绕过，需在注释中说明原因：
  - **OSS 预签名直传**：OSS 通过 URL query 鉴权，带自定义 `Authorization` 头会报错，用原生 XHR
  - **后端返回非 JSON 数据（如 Blob 文件下载）**：业务拦截器会对 `response.data.code` 做校验，Blob 响应无该字段会被误判失败，改用原生 `axios.get`
- OSS 预签名直传用 XHR（不能带自定义 Authorization），后端接口上传用 `request.put` + `onUploadProgress`
- `__dirname` 在 `tsx` 直接运行时指向源文件目录（`src/`），路径层级与编译后运行不同，写静态文件路径时需注意
- WebSocket 消息类型定义在 `src/types/room.ts`，增加新消息类型时前后端同步更新；当前已有类型含 `DRAW_STROKE`（笔迹广播，含 `userId`、`color`、`points[]`）和 `DRAW_CLEAR`（清空画布），后端纯内存转发不落库
- 数据库使用 **PostgreSQL**（postgres.js），schema 变更通过 `migrations/*.sql` 版本化管理（`schema_migrations` 表记录已执行版本），服务启动时 `runMigrations()` 自动幂等执行；新列使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`；DB 层默认为 NULL，service 层统一做 fallback（如 `avatar_url ?? DEFAULT_AVATAR_URL`）；postgres.js `BIGINT` 列默认返回 JS `string`，连接池初始化时配置 `types.bigint` 自定义 parser 统一转为 number
- 视频上传前在前端做两层校验（`src/utils/validateVideo.ts`）：① 读文件头 32KB 扫描 moov/mdat 顺序（moov 必须在 mdat 之前）；② 用临时 `<video>` 获取时长后计算平均码率（当前上限 8 Mbps，对应 CRF 28）；失败时用 antd `Modal.error()` 弹窗告知用户
- 视频上传链路按白名单分流：白名单用户（`users.is_upload_whitelist = 1`）走 OSS 直传（`getUploadUrl` 返回预签名 URL，`mode` 为空）；非白名单用户走后端代理中转（返回 `mode: 'proxy'`，前端 POST 到 `/upload-proxy`，后端流式 putStream 到 OSS）
- 后端 `uploadGuard` 中间件挂载在 `POST /upload-proxy` 上（非白名单用户上传路径）：校验 Sec-Fetch 请求头 + 每日中转总字节数上限 5GB（`Content-Length` 预检 + 真实写入后 `addDailyBytes` 计费）；白名单用户不经过此中间件；OSS 服务端的 `content-length-range` Policy 待接入 COS 时对白名单直传启用
- `.bat` 压缩脚本：当前仅开放 `compress_30.bat`（CRF 30），`BatController` 的 `VALID_PRESETS` 仅含 `'30'`，扩展时在数组和 `src/assets/bat/` 目录同步新增对应文件；ffmpeg 下载至 `%LOCALAPPDATA%\CoWatch\ffmpeg-bin\`（与 `.bat` 存放位置无关，用户移动脚本不会触发重复下载）
- multer 文件上传路由中，`upload.single()` 之后必须挂载专用 4 参数错误中间件（`err, req, res, next`）拦截 `MulterError`（超大文件等）并返回 400；否则会被全局 errorHandler 当成 500 处理。后续内联箭头函数需显式标注 `(req: Request, res: Response)`，否则 TypeScript 推断链断裂报 `implicit any`
- **RoomGuard 只做轻守卫**：仅校验用户身份（`userInfo`）和 `roomId` 是否存在，不调用任何业务接口（不调 getInfo、不调 initRoom、不写 RoomContext）；房间信息加载、planLevel 判断、过期页渲染等业务逻辑均由 Lobby 内部处理。原则：守卫层不知道业务，业务层不依赖守卫的副作用。

## 编码规范

详细规范见以下 Rules 文件（自动按文件类型加载）：

@.claude/rules/js-guide.md
@.claude/rules/react-guide.md
@.claude/rules/project-engineering.md
