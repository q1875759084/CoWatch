# Design: 视频标签（Label）功能

## 1. 需求概述

为视频列表每条视频增加可选的 **label 标签**（如「魔兽世界」「版本10.0」），便于用户快速识别视频内容，并为未来视频筛选做数据准备。

**约束**：最多 3 个 label，每个 label 最多 8 个字。

---

## 2. 数据模型

### 2.1 新建表 `video_labels`

```sql
CREATE TABLE IF NOT EXISTS video_labels (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (video_id) REFERENCES room_videos(id)
);
CREATE INDEX IF NOT EXISTS idx_video_labels_video ON video_labels (video_id);
```

- `id`：`uuid`，前端生成
- `video_id`：关联 `room_videos.id`
- `label`：标签文本，最多 8 个字（后端校验）
- `sort_order`：显示顺序（0-based），前端按数组下标传入
- 上限 3 条由后端 count 校验

### 2.2 migration

在 `schema.ts` 的 `runMigrations()` **不适用**（只支持 ALTER TABLE 补列）。新表在 `initSchema()` 的 `db.exec()` 块内追加 `CREATE TABLE IF NOT EXISTS video_labels ...`，天然幂等。

---

## 3. 后端改动

### 3.1 DB 函数 `src/database/videoLabel/index.ts`（新文件）

| 函数 | 说明 |
|------|------|
| `getLabelsByVideo(videoId)` | 按 sort_order 升序返回 label 文本数组 |
| `setLabelsForVideo(videoId, labels: string[])` | 事务：先 DELETE 全部，再批量 INSERT；整体替换 |
| `deleteLabelsByVideo(videoId)` | 删除视频时级联调用 |

### 3.2 HTTP 接口

**`PUT /api/rooms/:roomId/videos/:videoId/labels`**

- 权限：`roomAuthMiddleware` + 上传者或管理员（同 rename）
- Body：`{ labels: string[] }`（完整数组，整体替换）
- 校验：
  - `labels.length <= 3`
  - 每项 `label.trim().length` 在 `1~8`
- 成功后：调 `setLabelsForVideo`，然后 WS 广播 `VIDEO_LABELS_UPDATED`
- Response：`{ videoId, labels }`

### 3.3 WS 广播

新增消息类型 `VIDEO_LABELS_UPDATED`：

```json
{
  "type": "VIDEO_LABELS_UPDATED",
  "data": { "videoId": "xxx", "labels": ["魔兽世界", "版本10.0"] }
}
```

### 3.4 listVideos / ROOM_STATE 携带 labels

- `GET /api/rooms/:roomId/videos` 返回的每条 video 追加 `labels: string[]`
- `wsServer.ts` ROOM_STATE 下发的 `videos` 数组同步追加 `labels`
- 实现：`getVideosByRoom` 查完后，对每个 video 调 `getLabelsByVideo` 补充

### 3.5 删除视频时级联删 labels

`deleteVideo` controller 中，`deleteRoomVideo` 之前追加 `deleteLabelsByVideo(videoId)`（与 `deleteTagsByVideo` 并列）。

---

## 4. 前端改动

### 4.1 类型 `src/types/room.ts`

```ts
// VideoItem 追加
labels?: string[];

// 新增 WS 消息类型
| 'VIDEO_LABELS_UPDATED'

// 新增下行 data 类型
export interface VideoLabelsUpdatedData {
  videoId: string;
  labels: string[];
}
```

### 4.2 API `src/api/room.ts`

```ts
/**
 * 整体替换视频的 label 列表
 * 权限：上传者 或 房间管理员
 */
export async function updateVideoLabelsApi(
  roomId: string,
  videoId: string,
  labels: string[],
): Promise<void>
```

### 4.3 RoomContext `src/context/RoomContext.tsx`

新增 action：

```ts
/** 更新视频的 label 列表（WS VIDEO_LABELS_UPDATED 广播到来时调用） */
updateVideoLabels: (videoId: string, labels: string[]) => void;
```

实现：`videos.map(v => v.id === videoId ? { ...v, labels } : v)`

### 4.4 WS Hook `src/hooks/useRoomWs.ts`

- `UseRoomWsOptions` 追加可选 `onVideoLabelsUpdated?: (videoId: string, labels: string[]) => void`
- `case 'VIDEO_LABELS_UPDATED'`：调 `updateVideoLabels(d.videoId, d.labels)` + `stableOnVideoLabelsUpdated`

### 4.5 VideoList 组件改造

#### 状态设计

```ts
// 编辑态管理（扩展原有 editingId）
const [editingId, setEditingId] = useState<string | null>(null);
// 编辑态 draft（标题 + labels）
const [draftName, setDraftName] = useState('');
const [draftLabels, setDraftLabels] = useState<string[]>([]);
// 新增 label 输入框是否展示
const [addingLabel, setAddingLabel] = useState(false);
const [labelInput, setLabelInput] = useState('');
```

#### 进入编辑态

```ts
const startEdit = (v: VideoItem) => {
  setEditingId(v.id);
  setDraftName(v.displayName ?? v.fileName);
  setDraftLabels(v.labels ?? []);
  setAddingLabel(false);
  setLabelInput('');
};
```

#### 退出并提交（diff）

```ts
const commitEdit = (v: VideoItem) => {
  const trimmedName = draftName.trim();
  if (trimmedName && trimmedName !== (v.displayName ?? v.fileName)) {
    onRename(v.id, trimmedName);
  }
  const origLabels = v.labels ?? [];
  const labelsChanged =
    draftLabels.length !== origLabels.length ||
    draftLabels.some((l, i) => l !== origLabels[i]);
  if (labelsChanged) {
    onUpdateLabels(v.id, draftLabels);
  }
  setEditingId(null);
};
```

**整行失焦检测**（`onBlur + relatedTarget`）：

```tsx
<div
  className={styles.editRow}
  onBlur={(e) => {
    // 焦点仍在编辑行内（如点×或加号），不退出
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    commitEdit(v);
  }}
  // tabIndex 使 div 能接收焦点，否则 relatedTarget 为 null
  tabIndex={-1}
>
```

#### 新增 label 输入框确认

```ts
const confirmAddLabel = () => {
  const t = labelInput.trim();
  if (t && t.length <= 8 && draftLabels.length < 3) {
    setDraftLabels(prev => [...prev, t]);
  }
  setAddingLabel(false);
  setLabelInput('');
};
```

#### Props 新增

```ts
onUpdateLabels: (videoId: string, labels: string[]) => void;
```

---

## 5. UI 布局

### 普通态（非编辑中）

```
┌─────────────────────────────────────────────────────────┐
│  [1]  测试视频1   [魔兽世界] [版本10.0]  ✏(hover)  │  删除  播放  │
│       06/16 10:13                                        │
└─────────────────────────────────────────────────────────┘
```

- `labels` 用 antd `<Tag>` 渲染，暗色主题样式覆盖
- 最多显示 **2 个**（第 3 个在编辑态可见，普通态溢出不显示）
- 编辑 icon（`EditOutlined`）hover 时出现，在 label 右侧

### 编辑态

```
┌─────────────────────────────────────────────────────────┐
│  [1]  [_测试视频1_________]  [魔兽世界 ×] [版本10.0 ×]  [⊕]  │  删除  播放  │
│       06/16 10:13                                        │
└─────────────────────────────────────────────────────────┘
```

- 标题变为输入框（autoFocus + selectAll）
- 每个 label 用 antd `<Tag closable onClose>` 渲染（点×从 draft 移除）
- `⊕` 圆形加号按钮：点击后出现小输入框（内联在 tag 列表右侧）
  - Enter / 非空 blur → confirmAddLabel，编辑态保持
  - Escape / 空 blur → 取消，编辑态保持
- 已有 3 个 label 时加号隐藏

---

## 6. 样式新增（VideoList.module.scss）

| 类名 | 说明 |
|------|------|
| `.labelTag` | antd Tag 暗色主题覆盖（背景/边框/文字颜色） |
| `.labelTagClosable` | 编辑态 Tag，带 × 按钮的样式 |
| `.addLabelBtn` | 圆形加号按钮（`+`，`border-radius: 50%`，虚线边框） |
| `.labelInput` | 新增 label 临时输入框（小尺寸，内联） |
| `.editRow` | 编辑态整行容器，需有 `outline: none` 以避免 focus ring |

---

## 7. 改动文件清单

### 后端（CoWatch-backend）

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/database/schema.ts` | 修改 | `initSchema()` 追加 `video_labels` 建表 SQL |
| `src/database/videoLabel/index.ts` | 新建 | `getLabelsByVideo`、`setLabelsForVideo`、`deleteLabelsByVideo` |
| `src/database/roomVideo/index.ts` | 修改 | `getVideosByRoom` 返回值附带 labels |
| `src/controllers/rooms/index.ts` | 修改 | 新增 `updateVideoLabels` controller；`deleteVideo` 级联删 labels；`listVideos` 附带 labels |
| `src/routes/rooms/index.ts` | 修改 | 注册 `PUT /:roomId/videos/:videoId/labels` |
| `src/ws/wsServer.ts` | 修改 | ROOM_STATE 下发的 videos 附带 labels |

### 前端（CoWatch）

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/types/room.ts` | 修改 | `VideoItem.labels`、`VIDEO_LABELS_UPDATED`、`VideoLabelsUpdatedData` |
| `src/api/room.ts` | 修改 | 新增 `updateVideoLabelsApi` |
| `src/context/RoomContext.tsx` | 修改 | 新增 `updateVideoLabels` action |
| `src/hooks/useRoomWs.ts` | 修改 | 处理 `VIDEO_LABELS_UPDATED` |
| `src/pages/Lobby/index.tsx` | 修改 | 新增 `handleUpdateLabels`，传 `onUpdateLabels` prop 给 VideoList |
| `src/pages/Lobby/VideoList.tsx` | 修改 | 编辑态 UI 改造，label 增删逻辑，整行失焦退出 |
| `src/pages/Lobby/VideoList.module.scss` | 修改 | label Tag 样式、加号按钮、输入框 |

---

## 8. 边界情况

| 场景 | 处理方式 |
|------|----------|
| label 超过 8 个字 | 后端返回 400；前端输入框限制 `maxLength={8}` |
| label 超过 3 个 | 后端返回 400；前端加号在达到 3 个后隐藏 |
| 编辑中点播放按钮 | 播放按钮在编辑行内，`onBlur + relatedTarget` 判断为行内焦点，不提交；播放仍可触发 |
| 多人同时编辑同一视频 labels | 后端整体替换，最后写入者胜出；当前版本不做乐观锁（label 非关键数据） |
| 删除视频时 labels | `deleteLabelsByVideo` 级联清理，无孤儿数据 |
| ROOM_STATE 初始化 | videos 数组每项附带 `labels`，初始化后列表即刻显示 |
