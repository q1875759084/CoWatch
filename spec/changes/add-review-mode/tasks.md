# 复盘模式 实现任务

## 任务清单

---

### 后端 / wsServer.ts

#### 1. 消息处理
- [x] 在 `CoWatch-backend/src/ws/wsServer.ts` 的 `switch (msg.type)` 中新增 `FORCE_SYNC` case
  - 若发送者 == 当前主控（`canControl(userId, latestRoom)`）：
    - 构造完整 `ROOM_STATE` data（复用进房逻辑，附加 `forceSynced: true`）
    - `broadcastExcept(roomId, userId, { type: 'ROOM_STATE', data: { ...roomState, forceSynced: true } })`
  - 若发送者 != 主控（非主控点开跟随开关）：
    - 构造完整 `ROOM_STATE` data（附加 `forceSynced: false`）
    - `sendToClient(roomId, userId, { type: 'ROOM_STATE', data: { ...roomState, forceSynced: false } })`
  - ROOM_STATE data 构造逻辑与进房时一致（视频列表、播放状态、画布笔迹、笔记、成员）

---

### 前端 / types/room.ts

#### 2. 类型定义
- [x] `WsMessageType` 联合类型新增 `'FORCE_SYNC'`
- [x] `RoomStateData` 接口新增字段 `forceSynced?: boolean`

---

### 前端 / hooks/useRoomWs.ts

#### 3. 回调签名扩展
- [x] `UseRoomWsOptions.onRoomState` 回调新增第 8 个参数 `forceSynced?: boolean`
- [x] 在 `case 'ROOM_STATE'` 处理中，将 `d.forceSynced` 透传给 `stableOnRoomState` 调用

---

### 前端 / pages/Lobby/index.tsx

#### 4. 状态 & 逻辑
- [x] 新增本地状态 `const [followMode, setFollowMode] = useState(true)`
- [x] 新增 `handleFollowModeToggle` 函数：
  - 若从 `false → true`（用户开启跟随）：发送 `FORCE_SYNC` WS 消息
  - 更新 `followMode` 状态
- [x] 新增 `handleForceSync` 函数（主控用）：发送 `FORCE_SYNC` WS 消息
- [x] `onRoomState` 回调新增 `forceSynced` 参数处理：
  - 若 `forceSynced === true`：在完成状态同步后，额外调用 `setFollowMode(true)`
- [x] `onSyncState` 回调内：若 `!followMode` 则直接 return，不执行同步
- [x] `onSyncProgress` 回调内：若 `!followMode` 则直接 return，不执行 seek 纠偏
- [x] `onSwitchVideo` 回调内：若 `!followMode` 则直接 return，不切换视频
- [x] 将 `followMode` / `handleFollowModeToggle` / `handleForceSync` 传给 `ControlPanel`

---

### 前端 / pages/Lobby/ControlPanel.tsx

#### 5. Props 扩展
- [x] `ControlPanelProps` 新增：
  ```typescript
  isController: boolean;
  followMode: boolean;
  onFollowModeToggle: () => void;
  onForceSync: () => void;
  ```
- [x] 函数签名解构新增上述四个 props

#### 6. UI 新增
- [x] 在「房间信息 CollapseSection」之后、「鼠标设置 CollapseSection」之前，插入新 CollapseSection：
  - `isController === true`：
    - title="复盘工具"
    - 内容：「一键拉回」按钮，点击调用 `onForceSync`
  - `isController === false`：
    - title="复盘模式"
    - 内容：`<Switch>` 标签为「跟随复盘」，`checked={followMode}`，`onChange={onFollowModeToggle}`

---

### 前端 / pages/Lobby/ControlPanel.module.scss

#### 7. 样式
- [x] 新增「一键拉回」按钮样式 `.forceSyncBtn`（蓝色调，参考 clearStrokesBtn 风格）

---

## 完成标准

- 非主控默认跟随，关闭开关后 SYNC_STATE / SYNC_PROGRESS / SWITCH_VIDEO 消息被静默忽略
- 非主控手动开启跟随开关时，立即与当前主控状态对齐（单播 ROOM_STATE）
- 主控点击一键拉回后，所有非主控强制同步且跟随开关回到 ON
- 主控面板不展示跟随开关，非主控面板不展示一键拉回按钮
