# 待处理：useRoomWs 职责混乱 & Context 架构

## 问题一：useRoomWs 职责混乱

`useRoomWs.ts` 的 `switch` 里两类职责混在一起：

1. **Context 层操作**：`setControllerId`、`addMember`、`renameVideo` 等全局状态维护
2. **Lobby 层回调**：`stableOnXxx` 具体页面业务

导致 `useRoomWs` 既依赖 `RoomContext` 内部方法，又依赖调用方的业务回调，两种职责耦合在同一个 `switch case` 里。

### 具体混乱的 case

| case | Context 操作 | Lobby 回调 |
|---|---|---|
| `ROOM_STATE` | `setControllerId` / `syncMembersOnlineStatus` / `addVideo` / `setActiveVideoUrl` | `stableOnRoomState` |
| `CONTROL_CHANGED` | `setControllerId` | `stableOnControlChanged` |
| `VIDEO_ADDED` | `addVideo` | `stableOnVideoAdded` |
| `VIDEO_RENAMED` | `renameVideo` | `stableOnVideoRenamed` |
| `VIDEO_DELETED` | `removeVideo` | `stableOnVideoDeleted` |
| `VIDEO_LABELS_UPDATED` | `updateVideoLabels` | `stableOnVideoLabelsUpdated` |

纯透传回调、无 Context 操作的 case 不受影响：`SYNC_PROGRESS`、`SYNC_STATE`、`SWITCH_VIDEO`、`TAG_ADDED/DELETED`、`CURSOR_*`、`DRAW_*`、`NOTE_UPDATE`。

---

## 问题二：RoomContext 大而全，所有领域状态集中在一处

当前 `RoomContext` 包含成员管理、控制权、视频列表、播放状态四个领域，更新频率差异大但全部放在同一个 state 对象里，导致任意字段变化都会触发所有消费方重渲染。

### 切片方向（洋葱圈 Provider）

```
<RoomMetaProvider>       ← roomId / roomName / controlMode（几乎不变）
  <MemberProvider>       ← members / online status（中频）
    <VideoListProvider>  ← videos 列表（低频）
      <PlayerProvider>   ← activeVideoUrl / controllerId（高频）
        <App />
      </PlayerProvider>
    </VideoListProvider>
  </MemberProvider>
</RoomMetaProvider>
```

每层 Provider 只暴露自己领域的数据和操作，WS 消息分发后由各自 Provider 消化，`useRoomWs` 不再直接调用任何 Context 方法（同步解决问题一）。

### 切片抽离顺序

| 顺序 | 切片 | 理由 |
|---|---|---|
| 1 | **MemberProvider** | 独立性最强，只有 `MemberList` 消费，影响面最小 |
| 2 | **VideoListProvider** | `videos` 跨多组件但只读居多，接口清晰 |
| 3 | **PlayerProvider** | 与 `Lobby` 耦合最深，放最后 |

### 前置条件

**切片 Context 需配合 Lobby 拆子组件一起做，否则 Lobby 本身订阅多个 Context 收益有限。**
建议先拆 `Lobby/index.tsx`（当前 842 行），再做 Context 切片，收益更直接。

### 风险评估

低。每个切片独立可验证，不影响其他切片。
顺带可修复现有 `setControllerId` 在 `roomState=null` 时静默丢弃的边界问题（各 Provider 独立管理自身状态，不依赖统一 `roomState` 是否初始化）。
