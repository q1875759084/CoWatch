# 复盘模式 技术设计

## 1. 功能概述

在观影房右侧控制面板中新增「复盘模式」模块，允许非主控成员选择是否跟随主控的播放操作。主控可通过「一键拉回」强制将所有非主控同步至当前状态，非主控可通过「跟随复盘」开关自由切换跟随/独立查看模式。

## 2. 涉及模块

- **前端**：`CoWatch/src/pages/Lobby/`
- **后端**：`CoWatch-backend/src/ws/wsServer.ts`

---

## 3. 页面设计

### Lobby 右侧控制面板（ControlPanel）

#### 功能描述

在「房间信息」CollapseSection 和「鼠标设置」CollapseSection 之间，新增一个「复盘模式」模块，根据当前用户身份显示不同内容：

| 身份 | 模块标题 | 内容 |
|------|----------|------|
| 主控（isController） | `复盘工具` | 「一键拉回」按钮 |
| 非主控 | `复盘模式` | 「跟随复盘」Toggle 开关 |

#### 交互流程

**非主控 — 跟随复盘开关**

- When 用户进入房间, the system shall 默认开启跟随复盘（`followMode = true`）
- When `followMode = true`, the system shall 响应 `SYNC_STATE` / `SYNC_PROGRESS` / `SWITCH_VIDEO` 三类 WS 消息，自动同步视频播放状态
- When `followMode = false`, the system shall 静默忽略上述三类消息，用户可自由拖进度条独立查看
- When 非主控手动拨动开关, the system shall 仅更新本地 `followMode` 状态，不发送任何 WS 消息
- When 非主控开启开关（followMode: false → true）, the system shall 发送 `FORCE_SYNC` 上行消息，触发后端单播当前完整状态

**主控 — 一键拉回**

- When 主控点击「一键拉回」按钮, the system shall 发送 `FORCE_SYNC` 上行消息
- When 后端收到主控的 `FORCE_SYNC`, the system shall 构造完整 `ROOM_STATE` 消息（含视频、进度、画布、笔记），广播给房间内所有非主控成员，并在 data 中附带 `forceSynced: true`
- When 非主控收到 `forceSynced: true` 的 `ROOM_STATE`, the system shall 执行完整状态同步 + 强制将 `followMode` 置为 `true`（开关视觉上回到 ON）

**后端 FORCE_SYNC 路由逻辑**

```
发送者 == 当前主控  →  构造 ROOM_STATE { forceSynced: true }，broadcastExcept(发送者) 广播给所有非主控
发送者 != 当前主控  →  构造 ROOM_STATE { forceSynced: false }，sendToClient(发送者) 单播给自己
```

#### 组件结构

```
ControlPanel（迭代）
  └── CollapseSection title="复盘工具" / "复盘模式"（新增，位于房间信息与鼠标设置之间）
        ├── [主控] <button> 一键拉回
        └── [非主控] <Switch> 跟随复盘
```

#### 状态管理

新增以下 props 传入 `ControlPanel`：

```typescript
/** 是否为主控（用于区分显示一键拉回 or 跟随开关） */
isController: boolean;
/** 非主控：是否处于跟随复盘模式（true = 跟随，false = 自由） */
followMode: boolean;
/** 非主控：切换跟随模式 */
onFollowModeToggle: () => void;
/** 主控：一键拉回 */
onForceSync: () => void;
```

`followMode` 本地状态维护在 `Lobby/index.tsx`：

```typescript
// Lobby/index.tsx
const [followMode, setFollowMode] = useState(true); // 默认跟随
```

---

## 4. 接口设计

### WS 消息：FORCE_SYNC

#### 上行（前端 → 后端）

- **消息类型**：`FORCE_SYNC`
- **发送方**：主控（一键拉回）或非主控（开启跟随开关时）
- **data**：无（空对象 `{}`）

#### 下行（后端 → 前端）

- **复用现有** `ROOM_STATE` 消息类型，不新增下行类型
- **新增字段** `forceSynced: boolean` 到 `ROOM_STATE` data

```typescript
// 后端下行，ROOM_STATE data 新增字段
{
  // ...原有 RoomStateData 字段...
  forceSynced?: boolean; // true = 由主控一键拉回触发，前端需重置 followMode = true
}
```

---

## 5. 类型定义

### 前端 `src/types/room.ts`

```typescript
// WsMessageType 新增
| 'FORCE_SYNC'

// RoomStateData 新增字段
export interface RoomStateData {
  // ...原有字段...
  /** 由主控「一键拉回」触发的强制同步，前端收到后重置 followMode = true */
  forceSynced?: boolean;
}
```

### 前端 `src/hooks/useRoomWs.ts`

```typescript
// UseRoomWsOptions 新增回调
/** onRoomState 已有，通过新增 forceSynced 参数区分来源 */
onRoomState?: (
  isPlaying: boolean,
  currentTime: number,
  tags?: Tag[],
  videoUrl?: string | null,
  activeObjectKey?: string | null,
  strokes?: RoomStateData['strokes'],
  noteContent?: string,
  forceSynced?: boolean,  // 新增
) => void;
```

---

## 6. 关键决策记录

| 问题 | 决策 | 理由 |
|------|------|------|
| 模式范式 | 个人跟随开关（非房间级模式） | 更灵活，不影响其他成员，符合复盘场景 |
| 拉回同步内容 | 复用 `ROOM_STATE`（含视频+进度+画布+笔记） | 完整状态一次性下发，无需额外 HTTP 请求 |
| 拉回下行消息类型 | 复用 `ROOM_STATE`，新增 `forceSynced` 字段 | 前端零改动处理逻辑，只在回调中增加参数 |
| FORCE_SYNC 路由 | 后端按发送者身份决定单播/多播 | 同一条上行消息，前端无需区分场景 |
| 拉回时重置开关 | 收到 `forceSynced: true` 时前端强制 `followMode = true` | 拉回后继续跟随，符合用户直觉；用户可再次手动断开 |
| 非主控开关开启时 | 发送 `FORCE_SYNC`（单播回自己当前状态） | 立即对齐当前状态，避免开启后还要等下一条 SYNC 才同步 |
