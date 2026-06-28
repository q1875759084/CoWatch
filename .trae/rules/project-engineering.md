---
description: 项目工程规范，包含目录结构、路由约定、模块边界等
globs: "**/*.{js,ts,jsx,tsx}"
alwaysApply: false
---

# 项目工程规范

## 目录结构

```
src/
  pages/              # 页面组件，每个页面一个目录
    Dashboard/        # 首页：房间列表、创建/加入房间
    Lobby/            # 房间主页：播放器 + 视频列表 + 控制面板
    Auth/             # 登录注册
  components/         # 全局公共组件
  context/            # React Context（UserContext、RoomContext）
  hooks/              # 自定义 Hooks
  api/                # 接口定义（基于封装的 request）
  utils/              # 纯函数工具
  types/              # 公共 TS 类型定义
  constants/          # 常量
  router/             # 路由配置
```

## 路由约定

- 路由级别使用 `React.lazy` 懒加载，首屏只加载主应用
- 页面路由定义在 `src/router/index.tsx`

## 模块边界

- `utils/` 只放纯函数，有副作用的逻辑放 `hooks/` 或 `api/`
- `api/` 下封装所有网络请求，禁止在组件中直接调用 `axios` 或 `fetch`
- `types/` 下的类型定义供全局引用，避免重复定义
- 页面私有组件放在页面目录内，不向外暴露

## 请求规范

- HTTP 请求必须走封装的 `request`（axios 实例），禁止直接用原生 `fetch` 或 `axios`
- 例外场景（需在注释中说明原因）：
  - OSS 预签名直传：用原生 XHR，不能带自定义 `Authorization` 头
  - 后端返回非 JSON 数据（如 Blob 文件下载）：业务拦截器会校验 `response.data.code`，Blob 响应无该字段会误判失败，改用原生 `axios.get`

## WebSocket 规范

- WebSocket 消息类型定义在 `src/types/room.ts`
- 增加新消息类型时前后端同步更新
- WS 连接管理通过 `useRoomWs` Hook 统一处理