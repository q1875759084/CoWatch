---
description: CoWatch 项目工程规范
paths:
  - "**/*.{js,ts,jsx,tsx}"
---

# CoWatch 项目工程规范

本项目为前后端分离架构（非 Monorepo），`CoWatch/`（前端）和 `CoWatch-backend/`（后端）各自独立。以下为项目特有的工程约定。

## 数据库与 Migration

- 数据库使用 PostgreSQL（postgres.js 连接池），schema 变更通过 `migrations/*.sql` 版本化管理
- 迁移文件命名：`001_description.sql`，`schema_migrations` 表记录已执行版本
- 服务启动时 `runMigrations()` 自动幂等执行，新列使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- DB 层默认为 NULL，service 层统一做 fallback（如 `avatar_url ?? DEFAULT_AVATAR_URL`）
- postgres.js `BIGINT` 列默认返回 JS `string`，连接池初始化时配置 `types.bigint` 自定义 parser 统一转为 number
- DB 层保留原始列名（`id`/`name`），API 字段映射在 controller 层的 `.map()` 中集中处理

## HTTP 请求规范

- 所有 HTTP 请求必须走封装的 `request`（axios 实例，`src/utils/request.ts`），禁止直接用原生 `fetch` 或 `axios`
- 以下两类例外场景允许绕过（需在注释中说明原因）：
  - **OSS 预签名直传**：OSS 通过 URL query 鉴权，带自定义 `Authorization` 头会报错，用原生 XHR
  - **后端返回非 JSON 数据（如 Blob 文件下载）**：业务拦截器会对 `response.data.code` 做校验，Blob 响应无该字段会被误判失败，改用原生 `axios.get`
- 错误处理两层职责：
  - `request.ts` 拦截器统一格式化错误（包成含中文 message 的 `ApiError`），不做 UI 反馈
  - 影响页面存活的初始化请求（失败后 UI 永远 Loading 的）必须在调用侧添加 `.catch()` 做用户可见提示
- 401 由 `request` 拦截器自动刷新 Token 或跳转登录页，业务代码**不要再额外处理**

## WebSocket 消息规范

- 消息类型定义在 `src/types/room.ts`，新增类型时前后端同步更新
- 后端纯内存转发不落库（DRAW_STROKE、DRAW_CLEAR、CHAT_MESSAGE、NOTE_UPDATE 等）
- 聊天：后端内存缓存最近 50 条，`ROOM_STATE` 下发历史记录
- 笔记：后端 `roomNote` Map 存快照，`ROOM_STATE` 下发时附带 `noteContent`

## 视频上传链路

- 所有用户统一走后端代理中转（`getUploadUrl` 返回 `mode: 'proxy'`，前端 POST 到后端，后端流式 putStream 到 COS）
- 本地开发环境返回 `mode: 'local'`，文件直接落盘到 `/uploads`
- 白名单直传分支（`is_upload_whitelist`）已废弃
- 后端 `uploadGuard` 中间件：校验 Sec-Fetch 请求头 + 每日中转总字节数上限 5GB
- `req.pipe(writeStream)` 在客户端中途断开时不会自动销毁 writeStream，需显式监听 `req.on('close')` 判断 `res.headersSent`，手动 `writeStream.destroy()` + 清理临时文件
- multer 文件上传路由中，`upload.single()` 之后必须挂载专用 4 参数错误中间件拦截 `MulterError` 并返回 400

## Provider 洋葱圈架构

- 层次（由外到内）：`UserProvider` → `RoomMetaProvider` → `RoomProvider` → `RouterProvider`
- **单向原则**：内层 Provider 不得 `import` 或 `useContext` 外层 Context
- 两个 Context 需要联动时，由调用方分别调用各自的 setter，不在 Provider 内部相互引用
- **数据写入约定**：`initRoom` 只写 RoomContext 的业务状态；房间元信息（roomId/roomName/planLevel）由调用方单独调 `setRoomMeta`

## 部署与环境变量

- 部署由 `infra` 仓库统一管理，CoWatch 和 CoWatch-backend 仓库不含任何部署逻辑
- 敏感变量唯一存储位置：infra 仓库的 GitHub Actions Secrets
- `.env` 文件仅用于本地开发（已加入 `.gitignore`），线上完全无关
- 新增环境变量流程：infra Secrets → `deploy-cowatch.yml` env/ envs → `docker-compose.yml` environment

## 目录规范

- 公共类型定义放 `types/` 目录，API 响应类型用泛型约束 `ApiResponse<T>`（定义在 `src/types/api.ts`）
- 常量在 `constants/` 目录统一维护
- `utils/` 下的函数必须是纯函数，有副作用的放 `hooks/` 或 `services/`
- `__dirname` 在 `tsx` 直接运行时指向源文件目录（`src/`），写静态文件路径时需注意路径层级
