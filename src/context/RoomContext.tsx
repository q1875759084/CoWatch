import { createContext, useContext, useState, useRef, type ReactNode } from 'react';
import { useMemoizedFn } from 'ahooks';
import type { Member, ControlMode, VideoItem } from '@/types/room';

export interface RoomState {
  roomId: string;
  roomName: string;
  /**
   * 当前激活（正在播放）的视频 URL。
   * 完全由 WS 管理（ROOM_STATE / SWITCH_VIDEO），HTTP initRoom 不写这个字段。
   * 初始值为 null，VideoPlayer 在此有值时才渲染。
   */
  activeVideoUrl: string | null;
  /** 房间内所有视频列表 */
  videos: VideoItem[];
  members: Member[];
  controlMode: ControlMode;
  controllerId: string | null;
}

/**
 * initRoom 只接收 HTTP 能提供的字段，不含 activeVideoUrl（HTTP 接口不返回播放 URL）。
 */
export type InitRoomPayload = Omit<RoomState, 'activeVideoUrl'>;

interface RoomContextValue {
  roomState: RoomState | null;
  initRoom: (state: InitRoomPayload) => void;
  setActiveVideoUrl: (url: string | null) => void;
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
   * 两个 pending ref，用于 WS 比 HTTP 先到的场景：
   *
   * pendingActiveVideoUrlRef：WS setActiveVideoUrl 在 roomState=null 时存入，
   *   initRoom 执行时读取并写入初始 state。
   *   注意：initRoom 使用函数式更新，读取 prev（此时可能已由 WS 的 setState 更新过）。
   *   若 prev.activeVideoUrl 已有值（WS 的 setState 先于 initRoom 的 setState 执行），
   *   则直接使用 prev 的值；否则使用 pendingUrl。
   *
   * pendingOnlineStatusRef：WS syncMembersOnlineStatus 在 roomState=null 时存入，
   *   initRoom 执行时合并到成员列表。
   */
  const pendingActiveVideoUrlRef = useRef<string | null>(null);
  const pendingOnlineStatusRef = useRef<Pick<Member, 'userId' | 'isOnline'>[] | null>(null);

  /**
   * initRoom：仅由 HTTP 初始化调用，只写 HTTP 能提供的字段。
   * activeVideoUrl 取值优先级：
   *   1. prev.activeVideoUrl（WS 的函数式更新已执行时）
   *   2. pendingActiveVideoUrlRef（WS 存入 pending 但其 setState 还未执行时）
   *   3. null（房间当前没有激活视频）
   * 这样无论 HTTP 和 WS 哪个先到，activeVideoUrl 都不会被覆盖为 undefined。
   */
  const initRoom = useMemoizedFn((payload: InitRoomPayload) => {
    const pendingUrl = pendingActiveVideoUrlRef.current;
    const pendingOnlineStatus = pendingOnlineStatusRef.current;
    pendingActiveVideoUrlRef.current = null;
    pendingOnlineStatusRef.current = null;

    const members = pendingOnlineStatus
      ? payload.members.map((m) => {
          const matched = pendingOnlineStatus.find((s) => s.userId === m.userId);
          return matched ? { ...m, isOnline: matched.isOnline } : m;
        })
      : payload.members;

    setRoomState((prev) => ({
      // activeVideoUrl 优先保留 WS 已设置的值（prev?.activeVideoUrl），
      // 其次用 pendingUrl，最后 fallback null。
      // 绝不用 payload 里的值（HTTP 接口不返回播放 URL，永远是 undefined）。
      activeVideoUrl: prev?.activeVideoUrl ?? pendingUrl ?? null,
      ...payload,
      members,
    }));
  });

  /**
   * setActiveVideoUrl：完全由 WS 调用（ROOM_STATE / SWITCH_VIDEO）。
   * - roomState 已初始化：直接更新
   * - roomState 为 null（WS 早于 HTTP）：存入 pending，initRoom 执行时消费
   */
  const setActiveVideoUrl = useMemoizedFn((url: string | null) => {
    setRoomState((prev) => {
      if (!prev) {
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
        return { ...prev, videos: [...prev.videos, video] };
      }
      const updated = [...prev.videos];
      updated[idx] = { ...updated[idx], ...video };
      return { ...prev, videos: updated };
    });
  });

  const syncMembersOnlineStatus = useMemoizedFn((onlineList: Pick<Member, 'userId' | 'isOnline'>[]) => {
    setRoomState((prev) => {
      if (!prev) {
        pendingOnlineStatusRef.current = onlineList;
        return prev;
      }
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
