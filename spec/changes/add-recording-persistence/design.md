# 录制持久化与补传 技术设计

## 1. 功能概述

stop 时未上传完的切片自动持久化到本地磁盘，下次启动后用户在 Lobby「上传视频」区看到待补传列表，手动点击补传按钮逐片上传统一走。上传全部完成后调 finish 接口入库，视频出现在播放列表。

## 2. 涉及模块

| 层 | 路径 | 改动 |
|----|------|------|
| Electron 主进程 | `electron/handlers/recorder/persistence/index.ts` | **新建** |
| Electron 主进程 | `electron/handlers/recorder/index.ts` | 修改 stop() 流程 |
| Electron 主进程 | `electron/handlers/recorder/upload/index.ts` | cleanupUploader 不再清空 pendingQueue |
| 前端 | `src/pages/Lobby/VideoUploader/index.tsx` | 折叠区内新增 `PendingUploads` 子组件 |
| 前端 | `src/pages/Lobby/VideoUploader/PendingUploads.tsx` | **新建** |
| 前端 | `src/components/Recorder/index.tsx` | finishing 态适配新的持久化分支 |
| 类型 | `src/types/recorder.ts` | 新增 PendingRecording 类型 |

## 3. 页面设计

### Lobby → 上传视频折叠区

#### 功能描述

用户进入房间后，展开「上传视频」折叠区。若本地存在持久化的待补传录制，在 VideoUploader 下方展示待补传列表，每条显示 sessionId 摘要、切片进度、操作按钮。

#### 交互流程

```
When 用户展开「上传视频」折叠区,
  the system shall 调用 IPC `recorder:getPendingRecordings` 获取列表

When 列表非空,
  the system shall 在 VideoUploader 下方渲染 PendingUploads 组件

When 用户点击某条的 [补传] 按钮,
  the system shall 调用 IPC `recorder:resumePending(sessionId)` 开始补传

When 补传进行中,
  the system shall 通过 `recorder:progress` 事件更新该条的进度百分比

When 补传全部完成,
  the system shall 将该项从列表中移除
```

#### 组件结构

```
CollapseSection(title="上传视频")
  ├─ VideoUploader          ← 保留（未来改造为转码入口）
  └─ PendingUploads         ← 新增
       └─ PendingItem × N   ← 每一行：摘要 + 进度条 + [补传] 按钮
```

#### 状态管理

| 状态 | 方案 | 理由 |
|------|------|------|
| 待补传列表 | 组件 `useState` + IPC 拉取 | 数据源在主进程，前端只展示，不需要跨组件共享 |
| 补传进度 | `recorder:progress` IPC push | 复用现有进度通道，主进程 `pushProgress()` 已覆盖 upload layer |

### Recorder → finishing 态

#### 功能描述

录制停止后，若 pendingCount ≤ 5 则显示上传进度条（与当前行为一致）。若 pendingCount > 5，finishing 态快速跳过——切片已持久化，用户无需等待。

#### 交互流程

```
When stop() 返回,
  the system shall 判断 pendingCount:
    - 0:     直接回到 ready 态（无需 finishing UI）
    - 1-5:   显示进度条，等上传排空后回到 ready
    - >5:    持久化完成，立即回到 ready，不显示进度条
```

## 4. 接口设计

### 4.1 IPC: recorder:getPendingRecordings

- **方向**：渲染进程 → 主进程
- **参数**：无
- **返回**：`PendingRecording[]`

```typescript
interface PendingRecording {
  sessionId: string;
  roomId: string;
  createdAt: string;          // ISO 8601
  totalSegments: number;
  uploadedCount: number;      // 已上传切片数
  totalSize: number;          // bytes
  displayName: string;
  durationSeconds: number;
}
```

### 4.2 IPC: recorder:resumePending

- **方向**：渲染进程 → 主进程
- **参数**：`sessionId: string`
- **返回**：`Promise<void>`（后台执行，前端通过 progress 事件感知）

### 4.3 现有接口改动

#### finish 调用时机调整

**改动前**：stop() 末尾固定调一次 finish，传入已上传的 segmentKeys。

**改动后**：
- 全传完（pending=0）→ stop() 内调 finish
- 少量积压（1-5）→ 等排空 → stop() 内调 finish
- 大量积压（>5）→ **不调 finish**，等补传完成后在 `resumeUpload()` 内调 finish

#### cleanupUploader 行为调整

**改动前**：`pendingQueue = []` 清空所有队列引用。

**改动后**：持久化后 pendingQueue 为空（文件已移到持久化目录），cleanup 只清理定时器和标志位即可。

## 5. 类型定义

### `electron/handlers/recorder/persistence/index.ts`

```typescript
interface ManifestSegment {
  index: number;
  fileName: string;       // seg025_opt.ts
  objectKey: string;      // cowatch/{roomId}/recordings/{sessionId}/seg025_opt.ts
  size: number;           // bytes
  transcoded: boolean;    // true = _opt.ts, false = raw .ts
}

interface Manifest {
  sessionId: string;
  roomId: string;
  createdAt: string;
  totalSegments: number;
  uploadedCount: number;
  segments: ManifestSegment[];
  displayName: string;
  durationSeconds: number;
  // 补传用的配置（与 UploadConfig 一致）
  apiOrigin: string;
  authToken: string;
}
```

### `src/types/recorder.ts` 新增

```typescript
interface PendingRecording {
  sessionId: string;
  roomId: string;
  createdAt: string;
  totalSegments: number;
  uploadedCount: number;
  totalSize: number;
  displayName: string;
  durationSeconds: number;
}
```

## 6. 权限控制

无额外权限。补传操作复用现有 authToken，与录制上传一致。

## 7. 关键决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | 补传不自动触发，需用户显式点击按钮 | 用户主动控制上传时机，避免后台占用带宽影响游戏 |
| 2 | 补传完成后才调 finish | 视频不入库直到完整，前后端无需处理"半成品"状态 |
| 3 | finish 只在全部切片上传后调用一次 | 后端不需要追加切片接口，视频完整才入库 |
| 4 | STOP_PENDING_THRESHOLD = 5 | ≤5 片继续等（约 10-30s），>5 片持久化 |
| 5 | 文件移动（rename）而非复制 | 同盘零 IO 开销 |
| 6 | 暂不实现"放弃补传"按钮 | 第一期只做补传，删除功能后续加 |
| 7 | `PendingUploads` 放在 VideoUploader 折叠区内 | 与截图设计一致，复用现有布局 |
| 8 | 进度按切片数百分比 | 切片是上传原子单位，粒度合理且易于实现 |
| 9 | 按 createdAt 倒序排列 | 最新持久化的在最上面 |
