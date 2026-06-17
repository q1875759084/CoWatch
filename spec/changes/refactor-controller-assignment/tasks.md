# 主控权限体系重构 实现任务

## 任务清单

### CoWatch-backend / wsServer.ts

#### 1. 进入房间自动成为主控
- [x] 在 `addClient` 之后，检测 `getOnlineUserIds(roomId).size === 1`
- [x] 条件成立时调用 `setControllerId(roomId, userId)`
- [x] 广播 `CONTROL_CHANGED`（含 `controllerId` 和 `controllerNickname`）给房间内所有成员

#### 2. TRANSFER_CONTROL 权限扩展
- [x] 将鉴权条件从 `member.is_admin !== 1` 改为 `!canControl(userId, latestRoom) && member.is_admin !== 1`
  （主控 **或** 管理员均可触发转让）

#### 3. 主控离线时备选顺序扩展
- [x] 在 `ws.on('close')` 的主控离线处理中，保留"转给管理员"逻辑
- [x] 新增：若管理员不在线，从 `remainingClients`（`removeClient` 后的在线集合）取第一个成员
- [x] 用 `getUserById` 获取备选成员的 nickname，广播 `CONTROL_CHANGED`
- [x] 仅在 `remainingClients.size === 0` 时才置 null 且不广播

---

### CoWatch / MemberList/index.tsx

#### 4. 可点击条件扩展
- [x] 将 `canClick` 的条件从 `isAdmin && onSelectController && !isController`
  改为 `(isAdmin || isController) && onSelectController && !isController`

---

### CoWatch / src/pages/Lobby/ControlPanel.tsx

#### 5. 传给 MemberList 的 isAdmin prop 更新
- [x] `<MemberList isAdmin={isAdmin}>` 改为 `<MemberList isAdmin={isAdmin || isController}>`
- [x] `subtitle` 判断同步更新为 `isAdmin || isController`

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
