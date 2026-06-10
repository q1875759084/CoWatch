import axios from 'axios';
import request from '@/utils/request';
import type {
  CreateRoomResponse,
  JoinRoomResponse,
  MyRoomsResponse,
  UploadUrlResponse,
  RoomVideosResponse,
  RoomTagsResponse,
} from '@/types/api';
import type { Tag } from '@/types/room';
import type { RoomInfo } from '@/types/room';

/**
 * 创建房间，传入房间名（userId 由 Bearer Token 携带，无需显式传入）
 */
export async function createRoomApi(name: string): Promise<CreateRoomResponse> {
  const res = await request.post<{ code: number; message: string; data: CreateRoomResponse }>(
    '/rooms',
    { name },
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
 * 确认视频上传完成（白名单用户 COS 直传后调用）
 *
 * 传入 objectKey（由 getUploadUrlApi 返回，原样回传）和原始文件名。
 * 后端将 objectKey 存入 room_videos，并广播带签名的 VIDEO_ADDED 消息。
 */
export async function confirmVideoUploadApi(
  roomId: string,
  objectKey: string,
  fileName?: string,
): Promise<void> {
  await request.put(`/rooms/${roomId}/video`, { objectKey, fileName });
}

/**
 * 获取房间内某视频的 Tag 列表
 */
export async function getTagsApi(roomId: string, videoId: string): Promise<Tag[]> {
  const res = await request.get<{ code: number; message: string; data: RoomTagsResponse }>(
    `/rooms/${roomId}/tags`,
    { params: { videoId } },
  );
  return res.data.data.tags;
}

/**
 * 下载转码脚本（.bat）
 * 按画质档位返回对应的静态脚本文件，无需鉴权。
 * 使用原生 axios 而非封装的 request，避免业务拦截器对 Blob 响应做 code 校验导致误报错。
 */
export async function downloadBatApi(
  preset: 'high' | 'balanced' | 'small',
): Promise<void> {
  const res = await axios.get<Blob>('/api/bat', {
    params: { preset },
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `compress_${preset}.bat`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
