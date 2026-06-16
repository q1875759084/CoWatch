import { createContext, useContext, useState, useRef, type ReactNode } from 'react';
import { useMemoizedFn } from 'ahooks';
import type { Member, ControlMode, VideoItem } from '@/types/room';

export interface RoomState {
  roomId: string;
  roomName: string;
  /** 当前激活（正在播放）的视频 URL，由 SWITCH_VIDEO 更新 */
  activeVideoUrl: string | null;
  /** 房间内所有视频列表 */
  videos: VideoItem[];
  members: Member[];
  controlMode: ControlMode;
  controllerId: string | null;
}

interface RoomContextValue {
  roomState: RoomState | null;
  initRoom: (state: RoomState) => void;
  setActiveVideoUrl: (url: string) => void;
  addVideo: (video: VideoItem) => void;
  /**
   * WS ROOM_STATE 到达时，用下发的在线状态列表更新每个成员的 isOnline 字段。
   * 不整体替换成员列表，避免覆盖 HTTP 带来的 avatarUrl 等完整用户信息。
   */
  syncMembersOnlineStatus: (members: Pick<Member, 'userId' | 'isOnline'>[]) => void;
  addMember: (member: Member) => void;
  removeMember: (userId: string) => void;
  /** 单个成员上下线时调用（MEMBER_OFFLINE / MEMBER_JOINED） */
  setMemberOnline: (userId: string, isOnline: boolean) => void;
  setControlMode: (mode: ControlMode) => void;
  setControllerId: (userId: string | null) => void;
  /** 更新视频的自定义展示名（WS VIDEO_RENAMED 广播到来时调用） */
  renameVideo: (videoId: string, displayName: string) => void;
  /** 从列表移除视频（WS VIDEO_DELETED 广播到来时调用） */
  removeVideo: (videoId: string) => void;
  /** 更新视频的 label 列表（WS VIDEO_LABELS_UPDATED 广播到来时调用） */
  updateVideoLabels: (videoId: string, labels: string[]) => void;
}

const RoomContext = createContext<RoomContextValue>({
  roomState: null,
  initRoom: () => {},
  setActiveVideoUrl: () => {},
  addVideo: () => {},
  syncMembersOnlineStatus: () => {},
  addMember: () => {},
  removeMember: () => {},
  setMemberOnline: () => {},
  setControlMode: () => {},
  setControllerId: () => {},
  renameVideo: () => {},
  removeVideo: () => {},
  updateVideoLabels: () => {},
});

export function RoomProvider({ children }: { children: ReactNode }) {
  const [roomState, setRoomState] = useState<RoomState | null>(null);

  /**
   * WS ROOM_STATE / setActiveVideoUrl 可能早于 HTTP initRoom 到达。
   * 此时 roomState 为 null，setState 的 prev 为 null 会直接丢弃数据。
   * 用 ref 暂存，initRoom 执行时合并进初始 state。
   */
  const pendingActiveVideoUrlRef = useRef<string | null>(null);
  /**
   * WS ROOM_STATE 比 HTTP 先到时，暂存在线状态列表（{ userId, isOnline }[]）。
   * initRoom 执行后合并到成员列表里的 isOnline 字段。
   */
  const pendingOnlineStatusRef = useRef<Pick<Member, 'userId' | 'isOnline'>[] | null>(null);

  const initRoom = useMemoizedFn((state: RoomState) => {
    const pendingUrl = pendingActiveVideoUrlRef.current;
    const pendingOnlineStatus = pendingOnlineStatusRef.current;
    pendingActiveVideoUrlRef.current = null;
    pendingOnlineStatusRef.current = null;
    // 合并在线状态：HTTP 成员列表 + WS 带来的 isOnline
    const members = pendingOnlineStatus
      ? state.members.map((m) => {
          const matched = pendingOnlineStatus.find((s) => s.userId === m.userId);
          return matched ? { ...m, isOnline: matched.isOnline } : m;
        })
      : state.members;
    setRoomState({
      ...state,
      members,
      ...(pendingUrl ? { activeVideoUrl: pendingUrl } : {}),
    });
  });

  const setActiveVideoUrl = useMemoizedFn((url: string) => {
    setRoomState((prev) => {
      if (!prev) {
        // roomState 尚未初始化（WS 早于 HTTP 到达），暂存等 initRoom 消费
        pendingActiveVideoUrlRef.current = url;
        return prev;
      }
      return { ...prev, activeVideoUrl: url };
    });
  });

  const addVideo = useMemoizedFn((video: VideoItem) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      const idx = prev.videos.findIndex((v) => v.id === video.id);
      if (idx === -1) {
        // 新视频：追加到列表末尾
        return { ...prev, videos: [...prev.videos, video] };
      }
      // 已存在：合并更新（ROOM_STATE 下发的含签名 videoUrl，覆盖 HTTP 初始化时的 null）
      const updated = [...prev.videos];
      updated[idx] = { ...updated[idx], ...video };
      return { ...prev, videos: updated };
    });
  });

  const syncMembersOnlineStatus = useMemoizedFn((onlineList: Pick<Member, 'userId' | 'isOnline'>[]) => {
    setRoomState((prev) => {
      if (!prev) {
        // WS 早于 HTTP 到达：roomState 尚未初始化，暂存在线状态等 initRoom 消费
        pendingOnlineStatusRef.current = onlineList;
        return prev;
      }
      // 只更新 isOnline，保留 HTTP 带来的 avatarUrl / nickname 等完整信息
      return {
        ...prev,
        members: prev.members.map((m) => {
          const matched = onlineList.find((s) => s.userId === m.userId);
          return matched ? { ...m, isOnline: matched.isOnline } : m;
        }),
      };
    });
  });

  const addMember = useMemoizedFn((member: Member) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      // 已存在则更新 isOnline：HTTP 名单里的成员 isOnline 为 undefined，
      // MEMBER_JOINED 到达时补上 isOnline: true（成员重新连上 WS）
      if (prev.members.some((m) => m.userId === member.userId)) {
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.userId === member.userId ? { ...m, isOnline: member.isOnline } : m
          ),
        };
      }
      return { ...prev, members: [...prev.members, member] };
    });
  });

  const setMemberOnline = useMemoizedFn((userId: string, isOnline: boolean) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        members: prev.members.map((m) =>
          m.userId === userId ? { ...m, isOnline } : m
        ),
      };
    });
  });

  const removeMember = useMemoizedFn((userId: string) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return { ...prev, members: prev.members.filter((m) => m.userId !== userId) };
    });
  });

  const setControlMode = useMemoizedFn((mode: ControlMode) => {
    setRoomState((prev) => prev ? { ...prev, controlMode: mode } : prev);
  });

  const setControllerId = useMemoizedFn((userId: string | null) => {
    setRoomState((prev) => prev ? { ...prev, controllerId: userId } : prev);
  });

  const renameVideo = useMemoizedFn((videoId: string, displayName: string) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        videos: prev.videos.map((v) =>
          v.id === videoId ? { ...v, displayName } : v
        ),
      };
    });
  });

  const removeVideo = useMemoizedFn((videoId: string) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return { ...prev, videos: prev.videos.filter((v) => v.id !== videoId) };
    });
  });

  const updateVideoLabels = useMemoizedFn((videoId: string, labels: string[]) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        videos: prev.videos.map((v) =>
          v.id === videoId ? { ...v, labels } : v
        ),
      };
    });
  });

  return (
    <RoomContext.Provider
      value={{
        roomState,
        initRoom,
        setActiveVideoUrl,
        addVideo,
        syncMembersOnlineStatus,
        addMember,
        removeMember,
        setMemberOnline,
        setControlMode,
        setControllerId,
        renameVideo,
        removeVideo,
        updateVideoLabels,
      }}
    >
      {children}
    </RoomContext.Provider>
  );
}

export function useRoom() {
  return useContext(RoomContext);
}
