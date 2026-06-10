export type ControlMode = 'designated';

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
}

export interface VideoItem {
  id: string;
  /**
   * objectKey：视频在 COS 的唯一路径标识，格式为 cowatch/{roomId}/{uuid}-{fileName}
   * 不是播放 URL，点击播放时需发送 SWITCH_VIDEO WS 消息，后端实时签名广播 videoUrl
   */
  objectKey: string;
  /**
   * videoUrl：带时效签名的播放 URL，由后端在 SWITCH_VIDEO 广播时实时生成
   * 可能为 null（列表初始化时未签名，切换视频后才有值）
   */
  videoUrl: string | null;
  fileName: string;
  uploaderId: string;
  createdAt: number;
}

export interface RoomInfo {
  roomId: string;
  roomName: string;
  videoUrl: string | null;
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
  | 'ROOM_STATE'
  | 'VIDEO_ADDED'
  | 'TAG_ADD'
  | 'TAG_ADDED'
  | 'TAG_DELETE'
  | 'TAG_DELETED'
  | 'TAG_SEEK'
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

export interface RoomStateData {
  videoUrl: string | null;
  /** 当前激活视频的 objectKey（稳定标识，不含签名），用于匹配视频列表找到 videoId */
  activeObjectKey: string | null;
  controlMode: ControlMode;
  controllerId: string | null;
  videos: VideoItem[];
  members?: Member[];
  /** 当前房间播放状态，供新加入成员初始化（后端内存维护） */
  isPlaying?: boolean;
  currentTime?: number;
  /** 当前激活视频的 tag 列表 */
  tags?: Tag[];
}

export interface VideoAddedData {
  id: string;
  objectKey: string;
  /** 带时效签名的播放 URL，上传完成后由后端实时签名生成 */
  videoUrl: string;
  fileName: string;
  uploaderId: string;
  createdAt: number;
}

export interface SwitchVideoData {
  /** objectKey：视频在 COS 的唯一路径标识 */
  objectKey: string;
  /** videoUrl：后端实时签名的播放 URL */
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
