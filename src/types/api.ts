export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

// ─── 用户/认证 ────────────────────────────────────────────────────────────────

export interface UserInfo {
  userId: string;
  username: string;
  nickname: string;
}

export interface AuthResponse {
  userInfo: UserInfo;
  accessToken: string;
}

// ─── 房间 ─────────────────────────────────────────────────────────────────────

export interface CreateRoomResponse {
  roomId: string;
  roomName: string;
  inviteUrl: string;
}

export interface JoinRoomResponse {
  roomId: string;
  isAdmin: boolean;
  videoUrl: string | null;
}

export interface MyRoom {
  room_id: string;
  room_name: string;
  video_url: string | null;
  is_admin: 0 | 1;
  joined_at: number;
}

export interface MyRoomsResponse {
  rooms: MyRoom[];
}

export interface UploadUrlResponse {
  uploadUrl: string;
  videoUrl: string;
  fileName: string;
  /**
   * 上传模式：
   * - undefined：白名单用户 OSS 直传（默认）
   * - 'proxy'：非白名单用户走后端代理中转上传
   * - 'local'：本地开发模式，文件落盘到后端本地
   */
  mode?: 'local' | 'proxy';
}

export interface VideoItemResponse {
  id: string;
  videoUrl: string;
  fileName: string;
  uploaderId: string;
  createdAt: number;
}

export interface RoomVideosResponse {
  videos: VideoItemResponse[];
}

export interface RoomTagsResponse {
  tags: import('./room').Tag[];
}
