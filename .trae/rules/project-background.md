---
description: CoWatch 项目背景，供 AI 理解项目定位、技术栈和功能模块时参考
alwaysApply: true
---

# CoWatch 项目背景

## 产品定位

CoWatch 是一个**多人游戏录屏同步复盘平台**。房主创建房间并上传录屏，受邀成员通过分享链接免注册加入，所有人实时同步观看同一视频，支持带权限管理的进度条控制。

## 用户与角色

| 角色 | 说明 |
|------|------|
| 管理员 | 房间创建者，可上传视频、切换控制模式、指定控制者 |
| 成员 | 注册用户通过邀请链接加入房间 |

**身份方案：** 注册登录账号体系，JWT 双 Token（短期 `accessToken` 存内存/LS + 长期 `refreshToken` 存 HttpOnly Cookie），前端 axios 拦截器实现无感刷新。

## 技术栈

| 端 | 技术 |
|----|------|
| 前端 | React 19 + Webpack 5 + TypeScript + antd 5.x，Node 20 |
| 后端 | Node.js 20 + Express + ws 库 + SQLite（better-sqlite3），用 `tsx` 直接运行 TS |
| 视频存储 | 腾讯云 COS（预签名直传）或本地 `/uploads` 目录（开发环境） |
| 实时通信 | WebSocket（ws 库），服务端广播房间事件 |

**项目结构：** 前后端分离，非 Monorepo。`CoWatch/`（前端）和 `CoWatch-backend/`（后端）各自独立。

## 功能模块

| 模块 | 路由 | 说明 |
|------|------|------|
| 登录/注册 | `/auth` | 账号注册与登录 |
| Dashboard | `/` | 我的房间列表、创建/加入房间入口 |
| 房间主页 | `/room/:roomId` | 视频播放区 + 视频列表（多段录像）+ 上传区 + 成员/控制权面板 + 进度条 Tag 标注 |

## 控制权机制

- **指定模式（唯一模式）**：管理员指定某成员为进度控制者，`canControl` 只判断 `controller_id === userId`
- 自由模式已移除（多发送方造成竞态，与防回环计数器冲突，弊大于利）

## 成员列表设计

成员列表是**当前在线快照**，不是历史记录：
- WS 连接建立时加入列表，断开时从列表移除（`MEMBER_JOINED` / `MEMBER_LEFT` 事件驱动）
- 列表中的成员即当前在线的人，**不存在 `isOnline` 字段**，列表本身就代表「在线」
- 离开房间的成员不会保留在列表中，也不记录曾经来过的人

## 开发关键约定

- SQLite schema 新增字段时，`CREATE TABLE IF NOT EXISTS` 不会修改已存在的表，需手动执行 `ALTER TABLE ... ADD COLUMN` 迁移旧数据库文件
- `__dirname` 在 `tsx` 直接运行时指向源文件目录（`src/`），路径层级与编译后运行不同
- HTTP 请求必须走封装的 `request`，以下两类场景例外（需在注释中说明原因）：
  - OSS 预签名直传：用原生 XHR，不能带自定义 `Authorization` 头
  - 后端返回非 JSON 数据（如 Blob 文件下载）：业务拦截器会校验 `response.data.code`，Blob 响应无该字段会误判失败，改用原生 `axios.get`
- 视频上传前在前端做两层校验（`src/utils/validateVideo.ts`）：① 读文件头 32KB 扫描 moov/mdat 顺序；② 用临时 `<video>` 获取时长后计算平均码率（上限 8 Mbps，对应 CRF 28）；失败时用 antd `Modal.error()` 弹窗告知用户
- 视频上传链路按白名单分流：白名单用户走 OSS 直传；非白名单用户走后端代理中转
- 后端 `uploadGuard` 中间件挂载在 `POST /upload-proxy` 上：校验 Sec-Fetch 请求头 + 每日中转总字节数上限 5GB