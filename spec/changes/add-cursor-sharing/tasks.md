# 鼠标位置共享 实现任务

## 任务清单

### 1. 类型定义（src/types/room.ts）
- [x] `WsMessageType` 新增 `'CURSOR_MOVE'` | `'CURSOR_HIDE'`
- [x] 新增 `CursorMoveUpData`、`CursorMoveDownData`、`CursorHideDownData` 接口

### 2. 光标样式资源（src/pages/Lobby/cursors/）
- [x] 新建 6 个彩色箭头 SVG 文件：`arrow-red.svg`、`arrow-orange.svg`、`arrow-yellow.svg`、`arrow-green.svg`、`arrow-blue.svg`、`arrow-purple.svg`
- [x] 新建 `src/pages/Lobby/cursorStyles.ts`，export `CURSOR_STYLES` 数组 + `DEFAULT_STYLE_ID` + `getCursorStyle()`

### 3. Webpack SVG 配置（webpack.common.js）
- [x] 新增 SVG `asset/resource` rule，确保 SVG import 返回 URL 字符串
- [x] `src/global.d.ts` 新增 `*.svg` 模块类型声明

### 4. CursorOverlay 组件（src/pages/Lobby/）
- [x] 新建 `CursorOverlay.tsx`：绝对定位覆盖层，`pointer-events: none`，渲染所有光标
- [x] 新建 `CursorOverlay.module.scss`

### 5. useRoomWs hook 扩展（src/hooks/useRoomWs.ts）
- [x] 新增 options：`onCursorMove`、`onCursorHide`
- [x] `ws.onmessage` switch 新增 `CURSOR_MOVE`、`CURSOR_HIDE` case

### 6. 后端 WS 透传（CoWatch-backend/src/ws/wsServer.ts）
- [x] switch 新增 `case 'CURSOR_MOVE'`：补充 `userId`、`nickname` 后 `broadcastExcept`
- [x] switch 新增 `case 'CURSOR_HIDE'`：补充 `userId` 后 `broadcastExcept`

### 7. ControlPanel 扩展（src/pages/Lobby/ControlPanel.tsx）
- [x] 新增 props：`cursorEnabled`、`selectedStyleId`、`onCursorToggle`、`onStyleChange`
- [x] 成员列表上方新增"鼠标共享"区块（Toggle 开关 + 6 个样式图标）
- [x] 更新 `ControlPanel.module.scss`

### 8. RoomPage 集成（src/pages/Lobby/index.tsx）
- [x] 新增 cursor 相关 state：`cursorEnabled`、`selectedStyleId`、`selfCursorVisible`、`selfCursorPos`、`remoteCursors`
- [x] `useRoomWs` 新增 `onCursorMove`、`onCursorHide` 回调
- [x] `.content` 容器挂载 `onMouseMove`（50ms 节流）、`onMouseLeave`、`onMouseEnter`
- [x] 渲染 `<CursorOverlay cursors={allCursors} />`（自己 + 他人合并）
- [x] 向 `ControlPanel` 传入 4 个 cursor props
- [x] `index.module.scss` `.content` 补 `position: relative`

---
✅ 所有任务已完成
