# 主控权限体系重构 技术设计

## 1. 功能概述

修复当前主控权限体系的两个缺陷：管理员不在线时房间无主控导致所有人功能瘫痪；主控离线后若管理员也不在线，主控无法自动转移。新规则确保房间任意时刻都有可操作的主控，同时扩展主控转让权限（主控自己也可以转让）。

## 2. 涉及模块

后端：`src/ws/wsServer.ts`
前端：`src/components/MemberList/index.tsx`、`src/pages/Lobby/index.tsx`

## 3. 问题分析

### 当前缺陷

| 时机 | 当前行为 | 问题 |
|------|---------|------|
| 创建房间 | 创建者成为主控 ✅ | — |
| 管理员不在线，普通成员进入 | `controller_id` 仍为 null，无人可操作 ❌ | 功能全部瘫痪 |
| `TRANSFER_CONTROL` | 仅 `is_admin = 1` 可发 | 主控自己无法转让 ❌ |
| 主控离线，管理员也不在线 | `newControllerId = null`，主控置空后不广播 | 房间陷入无主控状态 ❌ |

### 根本原因

主控的产生完全依赖"创建房间"这一时机写入 DB。一旦主控不在线（或从未设置），没有任何机制能自动补位。

## 4. 新规则设计

### 规则一：进入房间时自动成为主控（唯一在线成员）

**触发时机**：WS `connection` 事件，`addClient` 之后。

**条件**：`getOnlineUserIds(roomId).size === 1`（自己是当前房间唯一在线成员）。

**行为**：`setControllerId(roomId, userId)` + 广播 `CONTROL_CHANGED`。

**线程安全分析**：Node.js 单线程，`addClient` + `getOnlineUserIds` + `setControllerId` 全为同步操作，串行执行。A、B 几乎同时连接时，两个 `connection` 回调必然先后执行，不会出现两人同时判断 `size === 1` 的情况。

**不依赖 `controller_id`**：不检查当前 DB 里是否已有主控，只看"我是否是唯一在线的人"。这样即使 DB 里有旧的 `controller_id`（如上一个主控已离线但 DB 未清零），第一个进入的人也能正确拿到主控权。

> ⚠️ 注意：此规则会在每次"房间重新有人进入"时生效。若房间里已有其他人在线（`size > 1`），不触发。

### 规则二：主控离线时按优先级自动转移

**当前逻辑**（断线处理）：

```
主控离线 → 转给管理员 → 管理员不在线 → newControllerId = null，不广播
```

**新逻辑**：

```
主控离线
  → 优先：管理员（is_admin=1）且当前在线
  → 其次：remainingClients（在线成员集合）中任意一个（取 first）
  → 最后：null（房间已空，规则一会在下一个人进入时处理）
```

实现方式：`getAdminByRoom` 查管理员，若管理员不在线则从 `remainingClients`（`removeClient` 之后的在线集合）中取第一个 userId，再用 `getUserById` 获取 nickname 用于广播。

### 规则三：主控转让权限扩展

**当前**：`TRANSFER_CONTROL` 消息的服务端鉴权为 `member.is_admin !== 1`（仅管理员）。

**新**：`!canControl(userId, latestRoom) && member.is_admin !== 1`（主控 **或** 管理员均可）。

**前端**：`MemberList` 的可点击条件从 `isAdmin` 改为 `isAdmin || isController`。`Lobby/index.tsx` 向 `MemberList` 传入 `isAdmin || isController` 作为 `isAdmin` prop（复用现有 prop，语义从"是管理员"扩展为"有转让权限"）。

## 5. 接口/消息变更

无新增 WS 消息类型，全部复用现有 `CONTROL_CHANGED` 消息格式：

```typescript
{
  type: 'CONTROL_CHANGED',
  data: { controllerId: string, controllerNickname: string }
}
```

## 6. 边界情况

| 场景 | 处理 |
|------|------|
| A、B 同时进入空房间 | Node.js 单线程串行，先到的成为主控，后到的 `size=2` 不触发 |
| 主控离线，管理员也不在线 | 随机取一个在线成员（`remainingClients` Set 遍历第一个） |
| 房间最后一人离线 | `remainingClients.size === 0`，`newControllerId = null`，不广播（无人可收） |
| 主控将控制权转让给离线成员 | 前端 MemberList 仅在线成员可点击（现有逻辑，不变）；服务端不做限制（业务上合理，离线成员下次上线即为主控） |

## 7. 关键决策记录

| 问题 | 决策 | 理由 |
|------|------|------|
| 自动主控触发条件 | `onlineIds.size === 1`，不检查 `controller_id` | 覆盖 DB 有旧值但主控已离线的场景 |
| 主控离线备选顺序 | 管理员（在线）→ 任意在线成员 → null | 管理员优先保证权威，无管理员时不让房间瘫痪 |
| `TRANSFER_CONTROL` 权限扩展方式 | 改后端鉴权条件，同步改前端 MemberList 可点击条件 | 前后端一致，不引入新 prop |
| MemberList 传参方式 | 复用 `isAdmin` prop，传 `isAdmin \|\| isController` | 最小改动，语义扩展为"有转让权限" |
