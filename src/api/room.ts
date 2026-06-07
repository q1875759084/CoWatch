import request from '@/utils/request';
import type {
  CreateRoomResponse,
  JoinRoomResponse,
  MyRoomsResponse,
  UploadUrlResponse,
  RoomVideosResponse,
} from '@/types/api';
import type { RoomInfo } from '@/types/room';

/**
 * 创建房间（userId 由 Bearer Token 携带，无需显式传入）
 */
export async function createRoomApi(): Promise<CreateRoomResponse> {
  const res = await request.post<{ code: number; message: string; data: CreateRoomResponse }>(
    '/rooms',
  );
  return res.data.data;
}

/**
 * 加入房间
 */
export async function joinRoomApi(roomId: string): Promise<JoinRoomResponse> {
  const res = await request.post<{ code: number; message: string; data: JoinRoomResponse }>(
    `/rooms/${roomId}/join`,
  );
  return res.data.data;
}

/**
 * 获取当前用户参与的所有房间
 */
export async function getMyRoomsApi(): Promise<MyRoomsResponse> {
  const res = await request.get<{ code: number; message: string; data: MyRoomsResponse }>(
    '/rooms/my',
  );
  return res.data.data;
}

/**
 * 获取房间信息（含成员列表）
 */
export async function getRoomInfoApi(roomId: string): Promise<RoomInfo> {
  const res = await request.get<{ code: number; message: string; data: RoomInfo }>(
    `/rooms/${roomId}`,
  );
  return res.data.data;
}

/**
 * 获取 OSS 预签名上传 URL（仅管理员）
 */
export async function getUploadUrlApi(
  roomId: string,
  fileName: string,
  fileType: string,
): Promise<UploadUrlResponse> {
  const res = await request.get<{ code: number; message: string; data: UploadUrlResponse }>(
    `/rooms/${roomId}/upload-url`,
    { params: { fileName, fileType } },
  );
  return res.data.data;
}

/**
 * 获取房间视频列表
 */
export async function getVideosApi(roomId: string): Promise<RoomVideosResponse> {
  const res = await request.get<{ code: number; message: string; data: RoomVideosResponse }>(
    `/rooms/${roomId}/videos`,
  );
  return res.data.data;
}

/**
 * 确认视频上传完成（OSS 模式）：传入 videoUrl + fileName
 */
export async function confirmVideoUploadApi(
  roomId: string,
  videoUrl: string,
  fileName?: string,
): Promise<void> {
  await request.put(`/rooms/${roomId}/video`, { videoUrl, fileName });
}
