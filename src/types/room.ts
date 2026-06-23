export type ControlMode = 'designated';

export type RoomPlanLevel = 'free' | 'vip:basic' | 'vip:pro';

// ─── Tag ─────────────────────────────────────────────────────────────────────

export interface Tag {
  id: string;
  videoId: string;
  roomId: string;
  time: number;       // 秒，浮点
  label: string;
  createdBy: string;  // userId
  createdAt: number;  // unix ms
}

export interface Member {
  userId: string;
  nickname: string;
  isAdmin: boolean;
  /**
   * WS 连接存在则为 true，断线后标记为 false。
   * HTTP getInfo 不返回此字段（undefined），由 WS ROOM_STATE 首次写入，
   * 随后由 MEMBER_JOINED / MEMBER_OFFLINE 增量维护。
   */
  isOnline?: boolean;
  /** 用户头像 URL，由 HTTP getInfo 下发；null 表示使用首字母占位 */
  avatarUrl?: string | null;
}

export interface VideoItem {
  id: string;
  /**
   * objectKey：视频在 COS 的唯一路径标识，格式为 cowatch/{roomId}/{uuid}-{fileName}
   * 不是播放 URL，点击播放时需发送 SWITCH_VIDEO WS 消息。
   */
  objectKey: string;
  /**
   * videoUrl： m3u8 API 路径，如 /api/rooms/{roomId}/videos/{videoId}/m3u8
   * 可能为 null（列表初始化时未赋值，切换视频后才有值）
   */
  videoUrl: string | null;
  fileName: string;
  /** 用户自定义展示名，未设置时为 null/undefined，前端 fallback 到 fileName */
  displayName?: string | null;
  uploaderId: string;
  createdAt: number;
  /** 视频标签，最多 3 个，每个最多 8 个字 */
  labels?: string[];
}

export interface RoomInfo {
  roomId: string;
  roomName: string;
  /** 房间当前等级：'free' = 已过期不可用 */
  planLevel: RoomPlanLevel;
  controlMode: ControlMode;
  controllerId: string | null;
  members: Member[];
}

// ─── WebSocket 消息类型 ───────────────────────────────────────────────────────

export type WsMessageType =
  | 'SYNC_PROGRESS'
  | 'SYNC_STATE'
  | 'TRANSFER_CONTROL'
  | 'SWITCH_VIDEO'
  | 'CONTROL_CHANGED'
  | 'MEMBER_JOINED'
  | 'MEMBER_LEFT'
  | 'MEMBER_OFFLINE'
  | 'ROOM_STATE'
  | 'VIDEO_ADDED'
  | 'TAG_ADD'
  | 'TAG_ADDED'
  | 'TAG_DELETE'
  | 'TAG_DELETED'
  | 'TAG_SEEK'
  | 'CURSOR_MOVE'
  | 'CURSOR_HIDE'
  | 'DRAW_STROKE'
  | 'DRAW_CLEAR'
  | 'DRAW_CLEAR_COLOR'
  | 'NOTE_UPDATE'
  | 'CHAT_MESSAGE'
  | 'VIDEO_RENAMED'
  | 'VIDEO_DELETED'
  | 'VIDEO_LABELS_UPDATED'
  | 'FORCE_SYNC'
  | 'ERROR';

export interface WsMessage<T = Record<string, unknown>> {
  type: WsMessageType;
  data?: T;
}

// ─── WS 下行消息 data 类型 ────────────────────────────────────────────────────

export interface SyncProgressData {
  currentTime: number;
  fromUserId: string;
}

export interface SyncStateData {
  isPlaying: boolean;
  currentTime: number;
  /** 后端分配的房间级单调递增序列号，非主控用于过期判断 */
  seq: number;
}

export interface ControlChangedData {
  controllerId: string;
  controllerNickname: string;
}

export interface MemberJoinedData {
  userId: string;
  nickname: string;
  isAdmin: boolean;
}

export interface MemberLeftData {
  userId: string;
}

/** 下行：服务端 → 全员，视频已删除 */
export interface VideoDeletedData {
  videoId: string;
}

/** 下行：服务端 → 全员，视频 label 列表已更新 */
export interface VideoLabelsUpdatedData {
  videoId: string;
  labels: string[];
}

/** 下行：服务端 → 全员，视频展示名已更新 */
export interface VideoRenamedData {
  videoId: string;
  displayName: string;
}

/** 下行：服务端 → 前端，成员 WS 断线（仅标记离线，不从列表删除） */
export interface MemberOfflineData {
  userId: string;
}

export interface RoomStateData {
  videoUrl: string | null;
  /** 当前激活视频的 objectKey（稳定标识，不含签名） */
  activeObjectKey: string | null;
  /** 当前激活视频的数据库 id，后端直接查出下发，前端无需本地匹配 */
  activeVideoId?: string | null;
  controlMode: ControlMode;
  controllerId: string | null;
  members?: Member[];
  /** 当前房间播放状态，供新加入成员初始化（后端内存维护） */
  isPlaying?: boolean;
  currentTime?: number;
  /** 当前房间的历史笔迹快照，供新加入成员初始化画布 */
  strokes?: Array<{ color: string; points: DrawStrokePoint[] }>;
  /** 当前房间的共享笔记内容，新成员加入时初始化 */
  noteContent?: string;
  /** 最近聊天消息列表，新成员加入时初始化（最多 50 条） */
  chatMessages?: ChatMessageData[];
  /** 由主控「一键拉回」触发的强制同步，前端收到后重置 followMode = true */
  forceSynced?: boolean;
}

export interface VideoAddedData {
  id: string;
  objectKey: string;
  /** HLS 切片目录前缀，如 cowatch/{roomId}/{videoId}/；切片完成后必填 */
  m3u8ObjectKey?: string;
  /**
   * videoUrl： m3u8 API 路径，如 /api/rooms/{roomId}/videos/{videoId}/m3u8
   * 前端请求此路径获取实时签名的 m3u8 内容，再通过 hls.js 播放
   */
  videoUrl: string;
  fileName: string;
  uploaderId: string;
  createdAt: number;
}

export interface SwitchVideoData {
  /** objectKey：视频在 COS 的唯一路径标识 */
  objectKey: string;
  /**
   * videoUrl： m3u8 API 路径，如 /api/rooms/{roomId}/videos/{videoId}/m3u8
   * 前端请求此路径获取实时签名的 m3u8 内容，再通过 hls.js 播放
   */
  videoUrl: string;
  videoId?: string;
}

// ─── Tag WS data 类型 ─────────────────────────────────────────────────────────

/** 上行：主控 → 服务端，新增 tag */
export interface TagAddData {
  id: string;
  videoId: string;
  time: number;
  label: string;
}

/** 下行：服务端 → 全员，tag 新增完成 */
export interface TagAddedData extends Tag {}

/** 上行：主控 → 服务端，删除 tag */
export interface TagDeleteData {
  id: string;
}

/** 下行：服务端 → 全员，tag 删除完成 */
export interface TagDeletedData {
  id: string;
}

/** 上行：主控 → 服务端，点击 tag 跳转 */
export interface TagSeekData {
  time: number;
}

// ─── Cursor WS data 类型 ──────────────────────────────────────────────────────

/** 上行：前端 → 服务端，鼠标移动（百分比坐标） */
export interface CursorMoveUpData {
  x: number;       // 0~1，相对容器宽度
  y: number;       // 0~1，相对容器高度
  styleId: string; // 光标样式 ID
}

/** 下行：服务端 → 前端，鼠标移动（补充 userId 后广播） */
export interface CursorMoveDownData {
  userId: string;
  x: number;
  y: number;
  styleId: string;
}

/** 下行：服务端 → 前端，鼠标离开区域（补充 userId 后广播） */
export interface CursorHideDownData {
  userId: string;
}

// ─── Draw WS data 类型 ────────────────────────────────────────────────────────

/**
 * 一段笔迹：由 mousedown 开始、mouseup 结束的一组连续坐标点。
 * 坐标 x/y 均为 0~1，相对 .playerRatio 容器的百分比，跨分辨率一致。
 */
export interface DrawStrokePoint {
  x: number;
  y: number;
}

/** 上行 & 下行：绘制一段笔迹 */
export interface DrawStrokeData {
  /** 绘制者 userId（下行由服务端补充） */
  userId: string;
  /** 笔迹颜色，如 '#ffffff'、'#000000'、'#ef4444' */
  color: string;
  /** 笔迹坐标序列 */
  points: DrawStrokePoint[];
}

/** 上行 & 下行：清空画布 */
export interface DrawClearData {
  /** 操作者 userId（下行由服务端补充） */
  userId: string;
}

/** 上行 & 下行：清除指定颜色的所有笔迹 */
export interface DrawClearColorData {
  /** 操作者 userId（下行由服务端补充） */
  userId: string;
  /** 要清除的笔迹颜色，如 '#ffffff' */
  color: string;
}

// ─── Note WS data 类型 ────────────────────────────────────────────────────────────────────────────

/**
 * 上行 & 下行：同步共享笔记内容。
 * 上行由主控发出（节流 1000ms），下行由服务端补充 fromUserId 后广播。
 */
export interface NoteUpdateData {
  content: string;
  /** 下行时由服务端补充 */
  fromUserId?: string;
}

// ─── Chat WS data 类型 ────────────────────────────────────────────────────────────────────────────

/**
 * 上行 & 下行：房间聊天消息。
 * 上行只需传 content，服务端补充 userId/nickname/timestamp 后广播。
 * 下行为完整结构，全员均会收到（含发送者自身）。
 */
export interface ChatMessageData {
  userId: string;
  /** 成员显示昵称 */
  nickname: string;
  /** 消息内容 */
  content: string;
  /** 服务端生成的发送时刻，unix ms */
  timestamp: number;
}
