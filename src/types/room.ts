export type ControlMode = 'designated' | 'free';

export interface Member {
  userId: string;
  nickname: string;
  isAdmin: boolean;
  isOnline: boolean;
}

export interface RoomInfo {
  roomId: string;
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
  | 'MODE_CHANGE'
  | 'START_WATCH'
  | 'CONTROL_CHANGED'
  | 'MODE_CHANGED'
  | 'MEMBER_JOINED'
  | 'MEMBER_LEFT'
  | 'ROOM_STARTED'
  | 'ROOM_STATE'
  | 'VIDEO_READY'
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

export interface ModeChangedData {
  mode: ControlMode;
}

export interface MemberJoinedData {
  userId: string;
  nickname: string;
  isAdmin: boolean;
}

export interface MemberLeftData {
  userId: string;
}

export interface RoomStartedData {
  videoUrl: string;
}

export interface RoomStateData {
  videoUrl: string | null;
  controlMode: ControlMode;
  controllerId: string | null;
}

export interface VideoReadyData {
  videoUrl: string;
}
