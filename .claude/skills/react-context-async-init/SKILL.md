---
name: react-context-async-init
description: React Context 多异步数据源初始化规范。当 Context state 由多个异步来源（如 HTTP 初始化 + WS 实时更新）共同写入时激活。覆盖直接赋值覆盖已有值的根因、函数式更新的正确使用、字段归属划分、以及用类型约束防止错误写入。当需要在 Context Provider 中编写 initRoom / init 类初始化函数、或同一 state 同时被 HTTP 响应和 WebSocket 消息写入、或发现某字段在初始化后被意外覆盖为 undefined 时激活。
---

# React Context 多异步数据源初始化规范

## 核心规则

**当 Context state 的不同字段分别由不同异步来源写入时，任何 `setState` 调用都必须使用函数式更新 `setState(prev => ...)`，不得直接赋值替换整个 state。**

直接赋值（`setState({ ...payload })`）会在执行时用 payload 的快照完整替换 state，无论其他来源的更新是否已写入——后到的调用会无声覆盖先到的结果。

## 字段归属原则

明确每个字段由哪个数据源"拥有"，每个来源只写自己拥有的字段：

- **HTTP 初始化**：只写 HTTP 接口能返回的字段（视频列表、成员列表、房间元数据等静态信息）
- **WS 实时更新**：只写实时状态字段（当前播放 URL、在线状态、控制权等）

HTTP 接口没有返回的字段（如播放 URL），绝不出现在 `initRoom` 的 payload 里。

## initRoom 的正确写法

```typescript
// ✅ 函数式更新，读取 prev 保留其他来源已写入的字段
setRoomState((prev) => ({
  activeVideoUrl: prev?.activeVideoUrl ?? pendingUrl ?? null, // 保留 WS 已设置的值
  ...payload,   // HTTP 字段覆盖
  members,
}));

// ❌ 直接赋值，后到时覆盖 WS 已写入的 activeVideoUrl
setRoomState({ ...payload, members });
```

## WS 先于 HTTP 到达时的 pending 机制

WS 的函数式更新在 `prev=null`（roomState 尚未初始化）时无法写入，需要 pending ref 暂存：

```typescript
const setActiveVideoUrl = (url) => {
  setRoomState((prev) => {
    if (!prev) {
      pendingRef.current = url; // 暂存，等 initRoom 消费
      return prev;
    }
    return { ...prev, activeVideoUrl: url };
  });
};
```

`initRoom` 执行时通过 `prev?.activeVideoUrl ?? pendingRef.current ?? null` 合并。

## 类型约束

用 `Omit<State, 'wsOwnedField'>` 定义 HTTP 专用的 payload 类型，从类型层面防止 HTTP 初始化函数接收不该传的字段：

```typescript
type InitRoomPayload = Omit<RoomState, 'activeVideoUrl'>;
const initRoom = (payload: InitRoomPayload) => { ... };
```
