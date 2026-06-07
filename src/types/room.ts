export type ControlMode = 'designated';

export interface Member {
  userId: string;
  nickname: string;
  isAdmin: boolean;
}

export interface VideoItem {
  id: string;
  videoUrl: string;
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
  controlMode: ControlMode;
  controllerId: string | null;
  videos: VideoItem[];
  members?: Member[];
  /** 当前房间播放状态，供新加入成员初始化（后端内存维护） */
  isPlaying?: boolean;
  currentTime?: number;
}

export interface VideoAddedData extends VideoItem {}

export interface SwitchVideoData {
  videoUrl: string;
  videoId?: string;
}
