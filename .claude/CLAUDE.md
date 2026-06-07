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

### 功能模块

| 模块 | 路由 | 说明 |
|------|------|------|
| 登录/注册 | `/auth` | 账号注册与登录 |
| Dashboard | `/` | 我的房间列表、创建/加入房间入口 |
| 房间主页 | `/room/:roomId` | 视频播放区 + 视频列表（多段录像）+ 上传区 + 成员/控制权面板 |

### 技术栈

| 端 | 技术 |
|----|------|
| 前端 | React 19 + Webpack 5 + TypeScript，Node 20 |
| 后端 | Node.js 20 + Express + ws 库 + SQLite（better-sqlite3），用 `tsx` 直接运行 TS |
| 视频存储 | 阿里云 OSS（预签名直传）或本地 `/uploads` 目录（开发环境） |
| 实时通信 | WebSocket（ws 库），服务端广播房间事件 |

**项目结构：** 前后端分离，非 Monorepo。`CoWatch/`（前端）和 `CoWatch-backend/`（后端）各自独立。

## 关键约定

- HTTP 请求必须走封装的 `request`（axios 实例），禁止直接用原生 `fetch` 或 `axios`
- OSS 预签名直传用 XHR（不能带自定义 Authorization），后端接口上传用 `request.put` + `onUploadProgress`
- `__dirname` 在 `tsx` 直接运行时指向源文件目录（`src/`），路径层级与编译后运行不同，写静态文件路径时需注意
- WebSocket 消息类型定义在 `src/types/room.ts`，增加新消息类型时前后端同步更新
- SQLite schema 新增字段时，`CREATE TABLE IF NOT EXISTS` 不会修改已存在的表，需手动执行 `ALTER TABLE ... ADD COLUMN` 迁移旧数据库文件

## 编码规范

详细规范见以下 Rules 文件（自动按文件类型加载）：

@.claude/rules/js-guide.md
@.claude/rules/react-guide.md
@.claude/rules/project-engineering.md
