# 房间聊天 技术设计

## 1. 功能概述

在现有 `NotePanel` 浮层中新增「聊天」tab，房间内成员可互发文字消息。消息不持久化，纯内存广播；新成员加入时通过 `ROOM_STATE` 下发最近 50 条历史消息。按钮/tab 有未读红点提示。

## 2. 涉及模块

- `CoWatch-backend/src/ws/wsServer.ts`
- `src/types/room.ts`
- `src/hooks/useRoomWs.ts`
- `src/pages/Lobby/NotePanel.tsx` + `NotePanel.module.scss`
- `src/pages/Lobby/index.tsx`

## 3. 消息 UI 设计

### 分组规则

连续来自同一发送者的消息归为一组，只在组首显示昵称，消息体连续排列（无重复昵称）：

```
a成员昵称
  第一条消息
  第二条消息

b成员昵称
  b成员第一条消息

                        自己的消息（靠右，无昵称）

c成员昵称
  c成员第一条消息
```

**自己的消息**：靠右对齐，无昵称，浅色气泡背景。  
**他人消息**：靠左对齐，组首显示昵称（小字），消息体无气泡背景，轻量纯文本风格。

### 自动滚动

每次新消息到达时，若用户已在消息列表底部（或面板刚打开），自动滚动到底部。

## 4. WS 消息设计

### 上行：`CHAT_MESSAGE`（前端 → 后端）

```typescript
interface ChatMessageUpData {
  content: string; // 消息内容，trim 后不得为空
}
```

### 下行：`CHAT_MESSAGE`（后端 → 全员，含发送者自身）

```typescript
interface ChatMessageData {
  userId: string;
  nickname: string;   // 后端从连接上下文补充，无需前端传
  content: string;
  timestamp: number;  // unix ms，后端生成
}
```

后端逻辑：
- 内存缓存 `roomChat: Map<roomId, ChatMessageData[]>`，上限 50 条，超出丢弃最旧
- `broadcast(roomId, { type: 'CHAT_MESSAGE', data })` 广播给全员（含发送者，前端统一走回调渲染）
- `ROOM_STATE` 下发时附带 `chatMessages: roomChat.get(roomId) ?? []`

## 5. 组件设计

### NotePanel 改造

新增本地状态：
```typescript
const [activeTab, setActiveTab] = useState<'note' | 'chat'>('note');
const [unreadChat, setUnreadChat] = useState(false); // 聊天 tab 红点
```

新增 props：
```typescript
// 新增
messages: ChatMessageData[];       // 聊天消息列表（由父组件维护）
currentUserId: string;             // 用于区分自己/他人
onSendChat: (content: string) => void; // 发送消息回调
```

Tab 标题栏渲染：
```tsx
<div className={styles.tabBar}>
  <button className={activeTab === 'note' ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab('note')}>笔记</button>
  <button className={activeTab === 'chat' ? styles.tabActive : styles.tab}
          onClick={() => { setActiveTab('chat'); setUnreadChat(false); }}>
    聊天{unreadChat && <span className={styles.dot} />}
  </button>
</div>
```

消息列表分组算法（纯计算，无额外状态）：
```typescript
// 将 messages 转换为分组结构
type MessageGroup = { userId: string; nickname: string; messages: ChatMessageData[] };
function groupMessages(messages: ChatMessageData[]): MessageGroup[] {
  return messages.reduce<MessageGroup[]>((groups, msg) => {
    const last = groups[groups.length - 1];
    if (last && last.userId === msg.userId) {
      last.messages.push(msg);
    } else {
      groups.push({ userId: msg.userId, nickname: msg.nickname, messages: [msg] });
    }
    return groups;
  }, []);
}
```

输入框：`<textarea>` 单行模式（`rows=1`，CSS `resize:none`），Enter 发送，Shift+Enter 换行。

### index.tsx 新增

```typescript
const [chatMessages, setChatMessages] = useState<ChatMessageData[]>([]);

const handleChatMessage = useMemoizedFn((data: ChatMessageData) => {
  setChatMessages((prev) => [...prev, data]);
});

const handleSendChat = useMemoizedFn((content: string) => {
  sendMessage('CHAT_MESSAGE', { content });
});
```

`ROOM_STATE` 回调中初始化历史消息：
```typescript
if (d.chatMessages?.length) {
  setChatMessages(d.chatMessages);
}
```

## 6. 类型定义

**新增到 `types/room.ts`**：

```typescript
// WsMessageType 新增 'CHAT_MESSAGE'

export interface ChatMessageData {
  userId: string;
  nickname: string;
  content: string;
  timestamp: number;
}
```

**`RoomStateData` 新增字段**：
```typescript
chatMessages?: ChatMessageData[];
```

## 7. 关键决策记录

| 问题 | 决策 |
|------|------|
| 消息是否持久化 | 不落库，内存缓存最近 50 条 |
| 自己消息的渲染路径 | 统一走 WS broadcast 回调（含自身），不做乐观更新 |
| 新消息红点位置 | NotePanel 触发按钮本身（面板关闭时）+ 聊天 tab 标签（面板开启但在笔记 tab 时） |
| 消息分组规则 | 连续相同发送者合并，只显示一次昵称 |
| 输入换行 | Shift+Enter 换行，Enter 直接发送 |
