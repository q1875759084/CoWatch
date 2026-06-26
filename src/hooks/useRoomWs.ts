import { useEffect, useRef } from 'react';
import { useMemoizedFn } from 'ahooks';
import { useRoom } from '@/context/RoomContext';
import { apiOrigin } from '@/utils/env';
import type {
  WsMessage,
  SyncProgressData,
  SyncStateData,
  ControlChangedData,
  MemberJoinedData,
  MemberLeftData,
  MemberOfflineData,
  RoomStateData,
  VideoAddedData,
  SwitchVideoData,
  Tag,
  TagAddedData,
  TagDeletedData,
  CursorMoveDownData,
  CursorHideDownData,
  DrawStrokeData,
  DrawClearData,
  DrawClearColorData,
  NoteUpdateData,
  ChatMessageData,
  VideoRenamedData,
  VideoDeletedData,
  VideoLabelsUpdatedData,
} from '@/types/room';

interface UseRoomWsOptions {
  roomId: string;
  /** accessToken，通过 WS 连接参数传给后端鉴权 */
  token: string;
  /** 收到 ROOM_STATE 时通知调用方，直接透传完整 data 对象，由调用方按需解构 */
  onRoomState?: (data: RoomStateData) => void;
  /** 收到 SYNC_PROGRESS 时通知播放器同步（防回环由调用方负责） */
  onSyncProgress?: (currentTime: number) => void;
  /** 收到 SYNC_STATE 时通知播放器同步，seq 由后端分配，用于非主控过期判断 */
  onSyncState?: (isPlaying: boolean, currentTime: number, seq: number) => void;
  /** 收到 TAG_ADDED 时通知调用方追加 tag */
  onTagAdded?: (tag: Tag) => void;
  /** 收到 TAG_DELETED 时通知调用方移除 tag */
  onTagDeleted?: (id: string) => void;
  /**
   * 收到 SWITCH_VIDEO 时通知调用方（非主控远端切换视频时触发）。
   * 主控本地点击已经在 handlePlayVideo 里处理了 tag，
   * 非主控收到广播时用此回调同步 objectKey/videoId 并拉取 tags。
   */
  onSwitchVideo?: (objectKey: string, videoId: string | undefined, videoUrl: string) => void;
  /**
   * 收到 VIDEO_ADDED 时通知调用方（HLS 切片完成后后端广播）。
   * 传入 videoId（uuid），每次写入 DB 唯一，VideoUploader 以此触发状态重置。
   * videoId 为空时表示写入异常，调用方应展示错误提示。
   */
  onVideoAdded?: (videoId: string) => void;
  /** 收到 CURSOR_MOVE 时通知调用方更新他人光标位置 */
  onCursorMove?: (data: CursorMoveDownData) => void;
  /** 收到 CURSOR_HIDE 时通知调用方隐藏对应用户的光标 */
  onCursorHide?: (userId: string) => void;
  /** 收到 DRAW_STROKE 时通知调用方渲染笔迹 */
  onDrawStroke?: (data: DrawStrokeData) => void;
  /** 收到 DRAW_CLEAR 时通知调用方清空画布 */
  onDrawClear?: () => void;
  /** 收到 DRAW_CLEAR_COLOR 时通知调用方清除指定颜色笔迹 */
  onDrawClearColor?: (color: string) => void;
  /** 收到 NOTE_UPDATE 时通知调用方更新笔记内容 */
  onNoteUpdate?: (content: string) => void;
  /** 收到 CHAT_MESSAGE 时通知调用方新增聊天消息（包括自己发送的） */
  onChatMessage?: (data: ChatMessageData) => void;
  /** 收到 VIDEO_RENAMED 时通知调用方更新视频展示名（RoomContext 已直接处理，此回调供额外业务使用） */
  onVideoRenamed?: (videoId: string, displayName: string) => void;
  /** 收到 VIDEO_DELETED 时通知调用方（RoomContext 已直接处理，此回调供 Lobby 处理激活视频被删的播放器重置） */
  onVideoDeleted?: (videoId: string) => void;
  /** 收到 VIDEO_LABELS_UPDATED 时通知调用方（RoomContext 已直接处理，此回调供额外业务使用） */
  onVideoLabelsUpdated?: (videoId: string, labels: string[]) => void;
  /**
   * 收到 CONTROL_CHANGED 时通知调用方（RoomContext 已更新 controllerId，此回调供 Lobby 处理身份切换）。
   * newControllerId：新主控的 userId
   */
  onControlChanged?: (newControllerId: string) => void;
}

export function useRoomWs({
  roomId,
  token,
  onRoomState,
  onSyncProgress,
  onSyncState,
  onTagAdded,
  onTagDeleted,
  onSwitchVideo,
  onVideoAdded,
  onCursorMove,
  onCursorHide,
  onDrawStroke,
  onDrawClear,
  onDrawClearColor,
  onNoteUpdate,
  onChatMessage,
  onVideoRenamed,
  onVideoDeleted,
  onVideoLabelsUpdated,
  onControlChanged,
}: UseRoomWsOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const {
    syncMembersOnlineStatus,
    addMember,
    removeMember,
    setMemberOnline,
    setControllerId,
    setActiveVideoUrl,
    addVideo,
    renameVideo,
    removeVideo,
    updateVideoLabels,
  } = useRoom();

  /**
   * 解决 ws.onmessage 闭包只能捕获初始回调的问题，无需手动维护 callbacksRef。
   */
  const stableOnRoomState    = useMemoizedFn(onRoomState    ?? (() => {}));
  const stableOnSyncProgress = useMemoizedFn(onSyncProgress ?? (() => {}));
  const stableOnSyncState    = useMemoizedFn(onSyncState    ?? (() => {}));
  const stableOnTagAdded     = useMemoizedFn(onTagAdded     ?? (() => {}));
  const stableOnTagDeleted   = useMemoizedFn(onTagDeleted   ?? (() => {}));
  const stableOnSwitchVideo  = useMemoizedFn(onSwitchVideo  ?? (() => {}));
  const stableOnVideoAdded   = useMemoizedFn(onVideoAdded   ?? (() => {}));
  const stableOnCursorMove   = useMemoizedFn(onCursorMove   ?? (() => {}));
  const stableOnCursorHide   = useMemoizedFn(onCursorHide   ?? (() => {}));
  const stableOnDrawStroke   = useMemoizedFn(onDrawStroke   ?? (() => {}));
  const stableOnDrawClear      = useMemoizedFn(onDrawClear      ?? (() => {}));
  const stableOnDrawClearColor = useMemoizedFn(onDrawClearColor ?? (() => {}));
  const stableOnNoteUpdate     = useMemoizedFn(onNoteUpdate     ?? (() => {}));
  const stableOnChatMessage    = useMemoizedFn(onChatMessage    ?? (() => {}));
  const stableOnVideoRenamed      = useMemoizedFn(onVideoRenamed      ?? (() => {}));
  const stableOnVideoDeleted      = useMemoizedFn(onVideoDeleted      ?? (() => {}));
  const stableOnVideoLabelsUpdated = useMemoizedFn(onVideoLabelsUpdated ?? (() => {}));
  const stableOnControlChanged      = useMemoizedFn(onControlChanged      ?? (() => {}));

  // 发送消息的稳定引用
  const sendMessage = useMemoizedFn((type: string, data?: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  });

  useEffect(() => {
    if (!roomId || !token) return;

    const { protocol: originProtocol, host } = new URL(apiOrigin);
    const wsProtocol = originProtocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${host}/socket?roomId=${roomId}&token=${encodeURIComponent(token)}`;

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
              // WS ROOM_STATE 只用来同步 isOnline，不整体替换（避免覆盖 HTTP 带来的 avatarUrl 等完整信息）
              syncMembersOnlineStatus(
                d.members.map((m) => ({ userId: m.userId, isOnline: m.isOnline }))
              );
            }
            // 初始化当前激活视频播放地址
            if (d.videoUrl) {
              setActiveVideoUrl(d.videoUrl);
            }
            console.log('[WS] ROOM_STATE received', { isPlaying: d.isPlaying, currentTime: d.currentTime, videoUrl: d.videoUrl });
            stableOnRoomState(d);
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
          if (d) stableOnSyncState(d.isPlaying, d.currentTime, d.seq ?? 0);
          break;
        }

        case 'CONTROL_CHANGED': {
          const d = msg.data as unknown as ControlChangedData | undefined;
          if (d) {
            setControllerId(d.controllerId);
            stableOnControlChanged(d.controllerId);
          }
          break;
        }

        case 'MEMBER_JOINED': {
          const d = msg.data as unknown as MemberJoinedData | undefined;
          if (d) {
            // isOnline: true —— 加入即代表当前在线
            addMember({ userId: d.userId, nickname: d.nickname, isAdmin: d.isAdmin, isOnline: true });
          }
          break;
        }

        case 'MEMBER_LEFT': {
          // 保留：未来退群/踢人时后端会改发此消息，届时前端需要从列表中删除
          const d = msg.data as unknown as MemberLeftData | undefined;
          if (d) removeMember(d.userId);
          break;
        }

        case 'MEMBER_OFFLINE': {
          // 成员 WS 断线，仅标记离线，不从列表移除
          const d = msg.data as unknown as MemberOfflineData | undefined;
          if (d) setMemberOnline(d.userId, false);
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
            // 通知 VideoUploader：切片完成，传 videoId（uuid，每次写入 DB 唯一）
            // 切片失败由独立的 VIDEO_SLICE_ERROR 消息处理，此处 d.id 必然有值
            stableOnVideoAdded(d.id);
          }
          break;
        }

        case 'SWITCH_VIDEO': {
          const d = msg.data as unknown as SwitchVideoData | undefined;
          if (!d?.videoUrl) break;
          // 将 videoUrl 透传给调用方，由调用方决定是否更新（自由模式下拦截）
          stableOnSwitchVideo(d.objectKey, d.videoId, d.videoUrl);
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

        case 'CURSOR_MOVE': {
          const d = msg.data as unknown as CursorMoveDownData | undefined;
          if (d) stableOnCursorMove(d);
          break;
        }

        case 'CURSOR_HIDE': {
          const d = msg.data as unknown as CursorHideDownData | undefined;
          if (d) stableOnCursorHide(d.userId);
          break;
        }

        case 'DRAW_STROKE': {
          const d = msg.data as unknown as DrawStrokeData | undefined;
          if (d) stableOnDrawStroke(d);
          break;
        }

        case 'DRAW_CLEAR': {
          const d = msg.data as unknown as DrawClearData | undefined;
          if (d) stableOnDrawClear();
          break;
        }

        case 'DRAW_CLEAR_COLOR': {
          const d = msg.data as unknown as DrawClearColorData | undefined;
          if (d) stableOnDrawClearColor(d.color);
          break;
        }

        case 'NOTE_UPDATE': {
          const d = msg.data as unknown as NoteUpdateData | undefined;
          if (d) stableOnNoteUpdate(d.content);
          break;
        }

        case 'CHAT_MESSAGE': {
          const d = msg.data as unknown as ChatMessageData | undefined;
          if (d) stableOnChatMessage(d);
          break;
        }

        case 'VIDEO_RENAMED': {
          const d = msg.data as unknown as VideoRenamedData | undefined;
          if (d) {
            renameVideo(d.videoId, d.displayName);
            stableOnVideoRenamed(d.videoId, d.displayName);
          }
          break;
        }

        case 'VIDEO_DELETED': {
          const d = msg.data as unknown as VideoDeletedData | undefined;
          if (d) {
            removeVideo(d.videoId);
            stableOnVideoDeleted(d.videoId);
          }
          break;
        }

        case 'VIDEO_LABELS_UPDATED': {
          const d = msg.data as unknown as VideoLabelsUpdatedData | undefined;
          if (d) {
            updateVideoLabels(d.videoId, d.labels);
            stableOnVideoLabelsUpdated(d.videoId, d.labels);
          }
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
