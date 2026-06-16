# Research: 视频标签（Label）功能

## 现有实现调研

### 数据层
- `room_videos` 表目前有 `display_name` 列（用户自定义展示名），但没有 label 字段
- 现有 `tags` 表是时间轴标记点（与本需求的 label 完全不同），不复用
- schema 使用 `runMigrations()` 幂等补列模式，新增表需在 `initSchema()` 中追加 CREATE TABLE IF NOT EXISTS
- 后端无专用 video-label 表，需新建独立表

### 前端现有模式
- `VideoItem` 类型定义在 `src/types/room.ts`
- 视频列表由 `VideoList.tsx` 渲染，编辑态/普通态已有 `editingId` 状态切换
- rename 走 WS 广播（`VIDEO_RENAMED`）+ HTTP PATCH；全员实时同步
- 删除走 WS 广播（`VIDEO_DELETED`）+ HTTP DELETE
- 权限模型：上传者 或 房间管理员 可操作

### Label 约束（需求已明确）
- 最多 3 个 label，每个 label 最多 8 个字
- 普通态：标题 + label（最多显示 2 个，作为 antd Tag 展示）+ 编辑 icon（hover 时）
- 编辑态：标题输入框（全选）+ label chip（带×删除按钮）+ 圆形加号（新增）

---

## 最终决策

### Q1: label 数据存储方式
- **决策**：Option B — 新建独立表 `video_labels(id, video_id, label, sort_order)`
- **理由**：支持未来排序/筛选扩展，数据结构更清晰

### Q2: label 变更实时同步
- **决策**：Option A — 需要 WS 广播，走 HTTP + WS broadcast，全员实时同步
- **理由**：与 rename/delete 行为保持一致，多人协作时视频列表状态对所有人一致

### Q3 + Q4: 编辑态保存时机与交互
- **决策**：退出编辑态时统一提交（diff 模式），具体交互如下：
  - 进入编辑态后，所有操作（改名、增删 label）只修改本地 draft state，UI 即时响应
  - 新增 label：点加号 → 出现临时输入框 → Enter 或非空 blur 确认，Escape/空 blur 取消 → 编辑态保持不退出
  - 删除 label：点×立即从 draft 中移除，编辑态保持不退出
  - 改名：输入框内容实时反映在 draft
  - **退出编辑态触发条件**：整个编辑行失焦（点击行外部），用 `onBlur + relatedTarget` 判断焦点是否仍在行内
  - **退出时 diff 提交**：
    - 名字有变化 → 发一次 PATCH rename → WS 广播 VIDEO_RENAMED
    - label 列表有变化 → 发一次 PUT labels（整体替换） → WS 广播 VIDEO_LABELS_UPDATED
    - 无变化 → 不调 API
- **优点**：最多 2 次 API 调用，无竞态，WS 广播最少，其他成员不会看到中间态闪烁

---

## 技术方案概要

### 后端改动
1. **DB schema**：新增 `video_labels` 表 + migration
2. **DB 函数**：`getLabelsByVideo`、`setLabelsForVideo`（整体替换）、`deleteLabelsByVideo`（级联删除）
3. **HTTP 接口**：`PUT /api/rooms/:roomId/videos/:videoId/labels`（整体替换，权限同 rename）
4. **WS 广播**：新增 `VIDEO_LABELS_UPDATED` 消息类型，data: `{ videoId, labels: string[] }`
5. **ROOM_STATE / listVideos**：返回的 video 对象附带 `labels: string[]`
6. **删除视频时**：级联删除 `video_labels`

### 前端改动
1. **类型**：`VideoItem` 追加 `labels?: string[]`，新增 `WsMessageType.VIDEO_LABELS_UPDATED`、`VideoLabelsUpdatedData`
2. **API**：新增 `updateVideoLabelsApi`
3. **Context**：新增 `updateVideoLabels(videoId, labels)` action
4. **WS Hook**：处理 `VIDEO_LABELS_UPDATED` → 调 `updateVideoLabels`
5. **VideoList**：
   - 普通态：标题行右侧显示 antd `<Tag>` 组件（最多 2 个），hover 时出现编辑 icon
   - 编辑态：标题全选输入框 + label chip（antd Tag 带关闭按钮）+ 圆形加号
   - 编辑行 `onBlur` + `relatedTarget` 检测失焦退出，diff 后调 API
6. **样式**：label chip、加号按钮的暗色主题适配
