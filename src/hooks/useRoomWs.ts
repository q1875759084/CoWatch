import { useEffect, useRef } from 'react';
import { useMemoizedFn } from 'ahooks';
import { useRoom } from '@/context/RoomContext';
import type {
  WsMessage,
  SyncProgressData,
  SyncStateData,
  ControlChangedData,
  MemberJoinedData,
  MemberLeftData,
  RoomStateData,
  VideoAddedData,
  SwitchVideoData,
  Tag,
  TagAddedData,
  TagDeletedData,
} from '@/types/room';

interface UseRoomWsOptions {
  roomId: string;
  /** accessToken，通过 WS 连接参数传给后端鉴权 */
  token: string;
  /** 收到 ROOM_STATE 时通知调用方初始化播放状态，附带 tags 和当前激活视频 URL */
  onRoomState?: (isPlaying: boolean, currentTime: number, tags?: Tag[], videoUrl?: string | null) => void;
  /** 收到 SYNC_PROGRESS 时通知播放器同步（防回环由调用方负责） */
  onSyncProgress?: (currentTime: number) => void;
  /** 收到 SYNC_STATE 时通知播放器同步 */
  onSyncState?: (isPlaying: boolean, currentTime: number) => void;
  /** 收到 TAG_ADDED 时通知调用方追加 tag */
  onTagAdded?: (tag: Tag) => void;
  /** 收到 TAG_DELETED 时通知调用方移除 tag */
  onTagDeleted?: (id: string) => void;
}

export function useRoomWs({
  roomId,
  token,
  onRoomState,
  onSyncProgress,
  onSyncState,
  onTagAdded,
  onTagDeleted,
}: UseRoomWsOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const {
    setMembers,
    addMember,
    removeMember,
    setControllerId,
    setActiveVideoUrl,
    addVideo,
  } = useRoom();

  /**
   * useMemoizedFn：返回引用稳定的函数，内部始终调用最新的回调实现。
   * 解决 ws.onmessage 闭包只能捕获初始回调的问题，无需手动维护 callbacksRef。
   */
  const stableOnRoomState    = useMemoizedFn(onRoomState    ?? (() => {}));
  const stableOnSyncProgress = useMemoizedFn(onSyncProgress ?? (() => {}));
  const stableOnSyncState    = useMemoizedFn(onSyncState    ?? (() => {}));
  const stableOnTagAdded     = useMemoizedFn(onTagAdded     ?? (() => {}));
  const stableOnTagDeleted   = useMemoizedFn(onTagDeleted   ?? (() => {}));

  // 发送消息的稳定引用
  const sendMessage = useMemoizedFn((type: string, data?: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  });

  useEffect(() => {
    if (!roomId || !token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/socket?roomId=${roomId}&token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[WS] connected to room ${roomId}`);
    };

    ws.onmessage = (event) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(event.data as string) as WsMessage;
      } catch {
        console.warn('[WS] 收到非法消息');
        return;
      }

      switch (msg.type) {

        case 'ROOM_STATE': {
          const d = msg.data as unknown as RoomStateData | undefined;
          if (d) {
            setControllerId(d.controllerId);
            if (d.members?.length) {
              setMembers(d.members);
            }
            // 初始化视频列表
            if (d.videos?.length) {
              d.videos.forEach((v) => addVideo(v));
            }
            // 初始化当前激活视频
            if (d.videoUrl) {
              setActiveVideoUrl(d.videoUrl);
            }
            console.log('[WS] ROOM_STATE received', { isPlaying: d.isPlaying, currentTime: d.currentTime, videoUrl: d.videoUrl });
            stableOnRoomState(d.isPlaying ?? false, d.currentTime ?? 0, d.tags, d.videoUrl);
          }
          break;
        }

        case 'SYNC_PROGRESS': {
          const d = msg.data as unknown as SyncProgressData | undefined;
          if (d) stableOnSyncProgress(d.currentTime);
          break;
        }

        case 'SYNC_STATE': {
          const d = msg.data as unknown as SyncStateData | undefined;
          if (d) stableOnSyncState(d.isPlaying, d.currentTime);
          break;
        }

        case 'CONTROL_CHANGED': {
          const d = msg.data as unknown as ControlChangedData | undefined;
          if (d) setControllerId(d.controllerId);
          break;
        }

        case 'MEMBER_JOINED': {
          const d = msg.data as unknown as MemberJoinedData | undefined;
          if (d) {
            addMember({ userId: d.userId, nickname: d.nickname, isAdmin: d.isAdmin });
          }
          break;
        }

        case 'MEMBER_LEFT': {
          const d = msg.data as unknown as MemberLeftData | undefined;
          if (d) removeMember(d.userId);
          break;
        }

        case 'VIDEO_ADDED': {
          const d = msg.data as unknown as VideoAddedData | undefined;
          if (d) {
            addVideo({
              id: d.id,
              objectKey: d.objectKey,
              videoUrl: d.videoUrl,
              fileName: d.fileName,
              uploaderId: d.uploaderId,
              createdAt: d.createdAt,
            });
          }
          break;
        }

        case 'SWITCH_VIDEO': {
          const d = msg.data as unknown as SwitchVideoData | undefined;
          // 后端广播带签名的 videoUrl，直接更新激活视频 URL
          if (d?.videoUrl) setActiveVideoUrl(d.videoUrl);
          break;
        }

        case 'TAG_ADDED': {
          const d = msg.data as unknown as TagAddedData | undefined;
          if (d) stableOnTagAdded(d);
          break;
        }

        case 'TAG_DELETED': {
          const d = msg.data as unknown as TagDeletedData | undefined;
          if (d) stableOnTagDeleted(d.id);
          break;
        }

        case 'ERROR': {
          const d = msg.data as unknown as { message: string } | undefined;
          console.error('[WS] 服务端错误:', d?.message);
          break;
        }

        default:
          console.warn(`[WS] 未知消息类型: ${msg.type}`);
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] 连接错误', err);
    };

    ws.onclose = (e) => {
      console.log(`[WS] 连接关闭: code=${e.code}, reason=${e.reason}`);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [roomId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  return { sendMessage };
}
