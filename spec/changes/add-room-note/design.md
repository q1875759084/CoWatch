# 房间共享记事本 技术设计

## 1. 功能概述

为复盘房间提供一个轻量级共享文本记事本。主控可实时编辑内容并同步给房间内所有成员；其他成员只读。所有成员均可将当前内容保存为本地 txt 文件。浮层展开/收起状态各自独立（本地 state）。

## 2. 涉及模块

- `src/pages/Lobby/NotePanel.tsx`（新建）
- `src/pages/Lobby/NotePanel.module.scss`（新建）
- `src/pages/Lobby/index.tsx`（迭代）
- `src/types/room.ts`（迭代）
- `src/hooks/useRoomWs.ts`（迭代）
- `CoWatch-backend/src/ws/wsServer.ts`（迭代）

## 3. 页面设计

### NotePanel 浮层

#### 功能描述

固定在视口右上角的浮层组件，通过一个常驻按钮控制展开/收起。展开后显示 `<textarea>`，主控可编辑，其他人只读。底部提供"保存为 txt"按钮。

#### 交互流程

- When 用户点击右上角"📝"按钮，the system shall 切换浮层展开/收起状态（本地 state，不影响他人）
- When 主控在 textarea 内输入文字，the system shall 节流 1000ms 后广播 `NOTE_UPDATE` 消息
- When 非主控收到 `NOTE_UPDATE`，the system shall 更新本地 `noteContent` state，textarea 实时刷新
- When 任意成员点击"保存为 txt"，the system shall 使用 Blob API 在本地触发文件下载（文件名：`cowatch-note-{roomId}.txt`）
- When 新成员加入房间，the system shall 从 `ROOM_STATE.noteContent` 初始化笔记内容

#### 组件结构

```
NotePanel（position: fixed，右上角）
├── 触发按钮（📝，始终可见）
└── 浮层面板（展开时显示）
    ├── 标题栏（"共享笔记" + 关闭按钮）
    ├── <textarea>（主控可编辑，其他人 readOnly）
    └── 底部操作栏
        └── "保存为 txt" 按钮
```

#### 状态管理

| 状态 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `noteOpen` | `boolean` | `index.tsx` local state | 浮层展开/收起，各端独立 |
| `noteContent` | `string` | `index.tsx` local state | 笔记内容，由 WS 同步 |

选择放在 `index.tsx` 而非独立 store：笔记内容与 WS 生命周期强绑定（需在 WS 回调里更新），和 `tags`、`cursors` 等其他 WS 状态保持一致的管理方式。

#### 布局

```
position: fixed
top: 12px
right: 300px   // 预留右侧 panel 宽度，不被遮挡
z-index: 200

浮层展开尺寸：width: 360px，高度自适应（textarea min-height: 200px）
```

> 注：当右侧 panel 处于折叠态时（宽度 28px），`right` 可后续用 CSS 变量动态联动，本期固定 `300px`。

## 4. 接口设计

### WS 消息：NOTE_UPDATE

纯内存转发，不落库。

**上行**（主控 → 服务端）：
```typescript
interface NoteUpdateUpData {
  content: string;
}
```

**下行**（服务端 → 其他成员，`broadcastExcept`）：
```typescript
interface NoteUpdateDownData {
  content: string;
  fromUserId: string; // 服务端补充
}
```

### ROOM_STATE 扩展

在现有 `RoomStateData` 接口新增：
```typescript
noteContent?: string; // 当前房间笔记内容，缺省为空字符串
```

后端内存：`const roomNote = new Map<string, string>()` （与 `roomPlayback` 同级）

## 5. 类型定义

新增位置：`src/types/room.ts`

```typescript
// WsMessageType 联合类型新增
| 'NOTE_UPDATE'

// 新增接口
export interface NoteUpdateData {
  content: string;
  fromUserId?: string; // 下行时由服务端补充
}

// RoomStateData 新增字段
noteContent?: string;
```

## 6. 权限控制

| 角色 | 操作 |
|------|------|
| 主控（`isController`） | textarea 可编辑，广播 NOTE_UPDATE |
| 非主控 | textarea `readOnly`，接收 NOTE_UPDATE 更新内容 |
| 全员 | 可保存为 txt，可展开/收起浮层 |

通过 `isController` prop 传入 `NotePanel`，决定 `<textarea readOnly>`。

## 7. 关键决策记录

| 问题 | 决策 | 理由 |
|------|------|------|
| 同步时机 | 节流 1000ms | 减少 WS 频率，输入体验可接受 |
| 新成员初始化 | ROOM_STATE 附带 noteContent | 与 tags/playback 模式一致，零新增请求 |
| 浮层交互 | fixed 右上角，无遮罩，点击外部不关闭 | 用户可同时操作视频和笔记 |
| 编辑权限 | 仅主控可编辑 | 避免多写冲突，本期复杂度可控 |
| 保存 | 前端 Blob 下载 | 后端无需参与，即时响应 |
| Portal | 不使用 | position: fixed 已能脱离布局限制 |
