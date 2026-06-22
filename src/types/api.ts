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
  /** 当前用户有效的权益 plan 列表，普通成员为 [] */
  plans: string[];
  /** 用户头像 URL，始终非空（后端 DB 为 null 时返回默认头像地址） */
  avatarUrl: string;
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
  is_admin: boolean;
  joined_at: number;
}

export interface MyRoomsResponse {
  rooms: MyRoom[];
}

export interface UploadUrlResponse {
  uploadUrl: string;
  /**
   * objectKey：视频在 COS 的唯一路径标识，格式为 cowatch/{roomId}/{uuid}-{fileName}
   * 不是播放 URL，播放通过 hls.js 加载 m3u8 实现
   */
  objectKey: string;
  fileName: string;
  /**
   * 上传模式：
   * - 'proxy'：线上模式，文件经后端中转上传到 COS
   * - 'local'：本地模式，文件落盘到后端本地
   */
  mode: 'local' | 'proxy';
}

export interface VideoItemResponse {
  id: string;
  /**
   * objectKey：视频在 COS 的唯一路径标识（非播放 URL）
   * 前端点击播放时发送 SWITCH_VIDEO WS 消息携带此 objectKey。
   */
  objectKey: string;
  fileName: string;
  /** 用户自定义展示名，未设置时为 null，前端 fallback 到 fileName */
  displayName?: string | null;
  uploaderId: string;
  createdAt: number;
  /** HLS 切片状态：'pending' | 'done' | 'error' */
  hlsStatus?: 'pending' | 'done' | 'error';
  /** 视频标签，最多 3 个 */
  labels?: string[];
}

export interface RoomVideosResponse {
  videos: VideoItemResponse[];
}

export interface RoomTagsResponse {
  tags: import('./room').Tag[];
}
