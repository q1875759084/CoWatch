# 房间共享记事本 实现任务

## 任务清单

### 1. 类型定义
- [ ] `src/types/room.ts`：`WsMessageType` 新增 `'NOTE_UPDATE'`
- [ ] `src/types/room.ts`：新增 `NoteUpdateData` 接口
- [ ] `src/types/room.ts`：`RoomStateData` 新增 `noteContent?: string`

### 2. WS Hook
- [ ] `src/hooks/useRoomWs.ts`：`UseRoomWsOptions` 新增 `onNoteUpdate?: (content: string) => void`
- [ ] `src/hooks/useRoomWs.ts`：`switch` 中处理 `NOTE_UPDATE` 消息，调用回调

### 3. NotePanel 组件（新建）
- [ ] `src/pages/Lobby/NotePanel.tsx`：实现浮层组件
  - 触发按钮：`position: fixed`，右上角，z-index: 200
  - 展开面板：标题栏 + textarea + 保存按钮
  - `isController` prop 控制 textarea 是否 readOnly
  - `content` prop + `onChange` 回调（节流由外部 index.tsx 处理）
  - "保存为 txt"：Blob + URL.createObjectURL 触发下载
- [ ] `src/pages/Lobby/NotePanel.module.scss`：浮层样式

### 4. Lobby 页面接入
- [ ] `src/pages/Lobby/index.tsx`：新增 `noteContent` state（初始值 `''`）
- [ ] `src/pages/Lobby/index.tsx`：新增节流 1000ms 的 `handleNoteChange`，调用 `sendMessage('NOTE_UPDATE', { content })`
- [ ] `src/pages/Lobby/index.tsx`：新增 `handleNoteUpdate` 回调，接收远端内容更新 `noteContent`
- [ ] `src/pages/Lobby/index.tsx`：`useRoomWs` 传入 `onNoteUpdate: handleNoteUpdate`
- [ ] `src/pages/Lobby/index.tsx`：`handleRoomState` 中初始化 `noteContent`
- [ ] `src/pages/Lobby/index.tsx`：渲染 `<NotePanel>`，传入所需 props

### 5. 后端支持
- [ ] `CoWatch-backend/src/ws/wsServer.ts`：顶层新增 `roomNote = new Map<string, string>()`
- [ ] `CoWatch-backend/src/ws/wsServer.ts`：`ROOM_STATE` 下发时附带 `noteContent`
- [ ] `CoWatch-backend/src/ws/wsServer.ts`：处理 `NOTE_UPDATE` 上行：更新内存，`broadcastExcept` 下发

---
完成所有任务后将 `- [ ]` 改为 `- [x]`
