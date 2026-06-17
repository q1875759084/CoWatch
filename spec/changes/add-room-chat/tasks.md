# 房间聊天 实现任务

## 任务清单

### 后端：wsServer.ts

#### 1. 内存结构 + ROOM_STATE 携带历史消息
- [ ] 新增 `roomChat: Map<string, ChatMessageData[]>` 内存结构（类型内联定义在文件顶部）
- [ ] `ROOM_STATE` 下发时附带 `chatMessages: roomChat.get(roomId) ?? []`
- [ ] `FORCE_SYNC` 的 `roomStateData` 对象同步附带 `chatMessages`

#### 2. CHAT_MESSAGE case
- [ ] 新增 `CHAT_MESSAGE` switch case
- [ ] 校验 `content` 为非空字符串
- [ ] 构造 `{ userId, nickname, content, timestamp: Date.now() }` 消息对象
- [ ] 写入 `roomChat`，超 50 条时 `shift()` 丢弃最旧
- [ ] `broadcast(roomId, { type: 'CHAT_MESSAGE', data })` 广播全员

---

### 前端类型：types/room.ts

#### 3. 新增类型
- [ ] `WsMessageType` 联合类型新增 `'CHAT_MESSAGE'`
- [ ] 新增 `ChatMessageData` 接口（`userId/nickname/content/timestamp`）
- [ ] `RoomStateData` 新增可选字段 `chatMessages?: ChatMessageData[]`

---

### 前端 Hook：useRoomWs.ts

#### 4. 新增 onChatMessage 回调
- [ ] `UseRoomWsOptions` 接口新增 `onChatMessage?: (data: ChatMessageData) => void`
- [ ] 函数参数解构加入 `onChatMessage`
- [ ] 新增 `stableOnChatMessage = useMemoizedFn(onChatMessage ?? (() => {}))`
- [ ] `switch` 新增 `case 'CHAT_MESSAGE'`，调用 `stableOnChatMessage(d)`

---

### 前端：index.tsx

#### 5. 聊天状态与回调
- [ ] 新增 `const [chatMessages, setChatMessages] = useState<ChatMessageData[]>([])`
- [ ] 新增 `handleChatMessage`：追加新消息到 `chatMessages`
- [ ] 新增 `handleSendChat`：调用 `sendMessage('CHAT_MESSAGE', { content })`
- [ ] `handleRoomState` 中：初始化 `chatMessages`（`d.chatMessages?.length` 时 `setChatMessages`）
- [ ] `useRoomWs` 调用处传入 `onChatMessage: handleChatMessage`
- [ ] `<NotePanel>` 传入 `messages={chatMessages}`、`currentUserId={userInfo?.userId ?? ''}`、`onSendChat={handleSendChat}`

---

### 前端：NotePanel.tsx

#### 6. 改造为 tab 式面板
- [ ] 新增 props：`messages: ChatMessageData[]`、`currentUserId: string`、`onSendChat`
- [ ] 新增本地状态：`activeTab: 'note' | 'chat'`、`unreadChat: boolean`、`chatInput: string`
- [ ] 新增 `messagesEndRef` + `useEffect` 自动滚动到底部（仅 chatMessages 变化时）
- [ ] 收到新消息时：若 `!open || activeTab !== 'chat'` 则 `setUnreadChat(true)`
- [ ] 触发按钮：`open=false` 且 `unreadChat=true` 时显示红点
- [ ] 标题栏替换为 tabBar：「笔记」tab + 「聊天」tab（含红点），切换到 chat tab 清除红点
- [ ] 内容区按 `activeTab` 条件渲染：笔记内容（原有 textarea）或聊天内容
- [ ] 实现 `groupMessages` 分组函数（纯函数，文件内定义）
- [ ] 渲染消息分组：他人消息靠左（组首显示昵称），自己消息靠右（无昵称）
- [ ] 输入框：`<textarea rows={1}>`，Enter 发送（`e.preventDefault()`），Shift+Enter 换行，发送后清空

---

### 前端：NotePanel.module.scss

#### 7. 新增样式
- [ ] `.tabBar`：tab 切换栏（flex row，border-bottom）
- [ ] `.tab` / `.tabActive`：tab 按钮（含激活态下划线/颜色）
- [ ] `.dot`：红点（`8px` 圆形，绝对定位在 tab 右上角）
- [ ] `.triggerDot`：触发按钮上的红点（绝对定位）
- [ ] `.chatBody`：消息列表容器（`flex:1, overflow-y:auto`）
- [ ] `.msgGroup`：消息分组容器（`margin-bottom: 12px`）
- [ ] `.msgGroupName`：昵称（小字，`color: #4a5568`）
- [ ] `.msgBubble`：消息文本（无背景，轻量纯文本）
- [ ] `.msgBubbleSelf`：自己的消息（靠右，略有背景色区分）
- [ ] `.chatInputRow`：输入栏（border-top，flex row）
- [ ] `.chatInput`：输入框（`flex:1`，无边框，`resize:none`）
- [ ] `.sendBtn`：发送按钮

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
