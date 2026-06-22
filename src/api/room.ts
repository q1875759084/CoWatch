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
import type { Tag, RoomInfo } from '@/types/room';

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
 * 更新视频的自定义展示名称
 * 权限：上传者 或 房间管理员
 */
export async function renameVideoApi(
  roomId: string,
  videoId: string,
  displayName: string,
): Promise<void> {
  await request.patch(
    `/rooms/${roomId}/videos/${videoId}/name`,
    { displayName },
  );
}

/**
 * 整体替换视频的 label 列表
 * 权限：上传者 或 房间管理员
 */
export async function updateVideoLabelsApi(
  roomId: string,
  videoId: string,
  labels: string[],
): Promise<void> {
  await request.put(
    `/rooms/${roomId}/videos/${videoId}/labels`,
    { labels },
  );
}

/**
 * 删除视频及其所有 tags
 * 权限：上传者 或 房间管理员
 */
export async function deleteVideoApi(
  roomId: string,
  videoId: string,
): Promise<void> {
  await request.delete(`/rooms/${roomId}/videos/${videoId}`);
}

/**
 * 下载转码脚本（.bat）
 * 按 CRF 数字档位返回对应的静态脚本文件，无需鉴权。
 * 使用原生 axios 而非封装的 request，避免业务拦截器对 Blob 响应做 code 校验导致误报错。
 */
export async function downloadBatApi(
  preset: '23' | '26' | '28' | '30',
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
