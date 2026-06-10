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
  /**
   * objectKey：视频在 COS 的唯一路径标识，格式为 cowatch/{roomId}/{uuid}-{fileName}
   * 上传完成后须原样回传给 confirm 接口（PUT /api/rooms/:roomId/video）
   * 不是播放 URL，播放 URL 由后端实时签名后通过 WS VIDEO_ADDED 消息下发
   */
  objectKey: string;
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
  /**
   * objectKey：视频在 COS 的唯一路径标识（非播放 URL）
   * 前端点击播放时发送 SWITCH_VIDEO WS 消息携带此 objectKey，
   * 后端签名后通过 SWITCH_VIDEO 广播下发带时效签名的 videoUrl
   */
  objectKey: string;
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
