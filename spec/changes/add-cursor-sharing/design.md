# 鼠标位置共享 技术设计

## 1. 功能概述

在 RoomPage 红框区域内实现多人鼠标位置实时共享。每个成员可选择彩色箭头样式，自己和他人看到的光标样式完全一致。个人可通过开关控制是否发送自己的位置。

## 2. 涉及模块

- **前端**：`src/pages/Lobby/`、`src/hooks/useRoomWs.ts`、`src/types/room.ts`
- **后端**：`CoWatch-backend/src/ws/wsServer.ts`

## 3. 页面设计

### RoomPage 红框区域（Lobby/index.tsx）

#### 功能描述

在 `.content` 容器上监听鼠标事件，将位置以百分比坐标发送给其他成员，并渲染 `CursorOverlay` 展示所有人的光标。

#### 交互流程

- When 用户开启鼠标共享开关，the system shall 在容器上设置 `cursor: none`，并开始发送 `CURSOR_MOVE` 消息
- When 鼠标在容器内移动，the system shall 以 50ms 节流发送 `{ x, y, styleId, userId }`（百分比坐标 0~1）
- When 鼠标移出容器（`mouseleave`），the system shall 发送 `CURSOR_HIDE` 消息，并隐藏自己的 DOM 光标
- When 鼠标进入容器（`mouseenter`），the system shall 显示自己的 DOM 光标
- When 用户关闭鼠标共享开关，the system shall 停止发送、恢复系统鼠标、发送 `CURSOR_HIDE`

#### 组件结构

```
RoomPage (.content 容器，cursor: none 时)
  └── CursorOverlay        ← 覆盖在所有内容之上，pointer-events: none
        ├── CursorDot (自己，本地 mousemove 驱动，0 延迟)
        └── CursorDot × N  (他人，WS 驱动)
```

#### 状态管理

- `cursorEnabled`：本地 useState，控制是否发送，持久化到 localStorage（key: `cowatch_cursor_enabled`）
- `selectedStyleId`：本地 useState，持久化到 localStorage（key: `cowatch_cursor_style`）
- `remoteCursors`：`Map<userId, { x, y, styleId, visible }>` — 存在 `useRoomWs` 返回值或 RoomPage 的 useState 中

### ControlPanel — 鼠标共享设置区块

#### 功能描述

在成员列表上方新增"鼠标共享"区块，包含：
1. 开关（toggle）：控制是否发送自己的鼠标位置
2. 样式选择器：6 个彩色箭头图标，点击选中

#### 交互流程

- When 用户点击开关，the system shall 切换 `cursorEnabled` 并持久化到 localStorage
- When 用户点击某个样式图标，the system shall 更新 `selectedStyleId` 并持久化到 localStorage
- When 开关为关闭状态，the system shall 样式选择器置灰不可交互

### CursorOverlay（新建）

#### 功能描述

绝对定位覆盖层，`pointer-events: none`，渲染所有在线成员（含自己）的光标。

每个光标由：
- `<img>` 渲染对应 SVG 箭头图标（32×32px）
- 成员昵称 label（光标右下方，半透明背景）

移出时触发淡出动画（CSS transition opacity 0→1，duration 300ms），动画结束后从 DOM 移除（通过 `visible` 字段控制）。

#### 状态说明

```typescript
interface CursorState {
  userId: string;
  nickname: string;
  x: number;       // 0~1 百分比
  y: number;       // 0~1 百分比
  styleId: string; // 对应 cursorStyles 中的 id
  visible: boolean; // false 时触发淡出动画
}
```

## 4. WS 消息设计

### 上行（前端 → 后端）

#### CURSOR_MOVE
```typescript
interface CursorMoveData {
  x: number;       // 0~1，相对容器宽度
  y: number;       // 0~1，相对容器高度
  styleId: string; // 光标样式 ID
}
```

#### CURSOR_HIDE
```typescript
// data 为空对象即可，userId 由后端从连接上下文取
interface CursorHideData {}
```

### 下行（后端 → 前端，broadcastExcept 发送者）

#### CURSOR_MOVE（透传）
```typescript
interface CursorMoveDownData {
  userId: string;
  nickname: string; // 后端从 users 表补充
  x: number;
  y: number;
  styleId: string;
}
```

#### CURSOR_HIDE（透传）
```typescript
interface CursorHideDownData {
  userId: string;
}
```

### 后端处理（wsServer.ts）

两个 case 均为**纯透传**，无需落库：
- `CURSOR_MOVE`：补充 `userId`、`nickname` 后 `broadcastExcept`
- `CURSOR_HIDE`：补充 `userId` 后 `broadcastExcept`

## 5. 文件结构与类型定义

### 新增文件

```
src/pages/Lobby/
  cursors/
    arrow-red.svg
    arrow-orange.svg
    arrow-yellow.svg
    arrow-green.svg
    arrow-blue.svg
    arrow-purple.svg
  cursorStyles.ts        ← id → { label, url } 映射，import SVG as URL
  CursorOverlay.tsx      ← 光标覆盖层组件
  CursorOverlay.module.scss
```

### cursorStyles.ts 结构

```typescript
import arrowRedUrl    from './cursors/arrow-red.svg';
import arrowOrangeUrl from './cursors/arrow-orange.svg';
// ...

export interface CursorStyle {
  id: string;
  label: string;
  url: string; // SVG 文件 URL（webpack asset/resource 处理）
}

export const CURSOR_STYLES: CursorStyle[] = [
  { id: 'arrow-red',    label: '红色', url: arrowRedUrl },
  { id: 'arrow-orange', label: '橙色', url: arrowOrangeUrl },
  // ...
];

export const DEFAULT_STYLE_ID = 'arrow-red';
```

### types/room.ts 新增类型

```typescript
// WsMessageType 新增：
| 'CURSOR_MOVE'
| 'CURSOR_HIDE'

// 新增 data 类型：
export interface CursorMoveData {
  x: number;
  y: number;
  styleId: string;
}

export interface CursorMoveDownData {
  userId: string;
  nickname: string;
  x: number;
  y: number;
  styleId: string;
}

export interface CursorHideDownData {
  userId: string;
}
```

## 6. Webpack SVG 配置

SVG 文件作为 URL（`asset/resource`）处理，需在 `webpack.common.js` 的 `module.rules` 中确认或新增：

```js
{
  test: /\.svg$/,
  type: 'asset/resource',
}
```

若已有 SVG 规则则复用，无需重复添加。

## 7. 关键决策记录

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 开关粒度 | 个人控制是否**发送**自己的位置 | 简单够用，无需服务端同步 |
| 样式形态 | 彩色箭头 SVG 文件 | 后续换素材只改文件，代码不动 |
| 样式同步方式 | styleId 随每条 `CURSOR_MOVE` 携带 | 无需握手，新成员加入即可看到正确样式 |
| 自己的光标 | 也用 DOM 元素模拟（cursor: none） | 自己和他人视角一致 |
| 坐标系 | 相对容器百分比 0~1 | 跨分辨率一致，事件监听挂容器不挂 document |
| 移出行为 | 发 CURSOR_HIDE，他人光标淡出消失 | 避免幽灵光标停留 |
| 持久化 | localStorage | 无需服务端，刷新后恢复用户偏好 |
