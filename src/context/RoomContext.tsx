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
  /** HTTP 初始化成员名单（不含 isOnline），WS ROOM_STATE 到达后整体替换（含 isOnline） */
  setMembers: (members: Member[]) => void;
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
}

const RoomContext = createContext<RoomContextValue>({
  roomState: null,
  initRoom: () => {},
  setActiveVideoUrl: () => {},
  addVideo: () => {},
  setMembers: () => {},
  addMember: () => {},
  removeMember: () => {},
  setMemberOnline: () => {},
  setControlMode: () => {},
  setControllerId: () => {},
  renameVideo: () => {},
  removeVideo: () => {},
});

export function RoomProvider({ children }: { children: ReactNode }) {
  const [roomState, setRoomState] = useState<RoomState | null>(null);

  /**
   * WS ROOM_STATE / setActiveVideoUrl / setMembers 可能早于 HTTP initRoom 到达。
   * 此时 roomState 为 null，setState 的 prev 为 null 会直接丢弃数据。
   * 用 ref 暂存，initRoom 执行时合并进初始 state。
   */
  const pendingActiveVideoUrlRef = useRef<string | null>(null);
  const pendingMembersRef = useRef<Member[] | null>(null);

  const initRoom = useMemoizedFn((state: RoomState) => {
    const pendingUrl = pendingActiveVideoUrlRef.current;
    const pendingMembers = pendingMembersRef.current;
    pendingActiveVideoUrlRef.current = null;
    pendingMembersRef.current = null;
    setRoomState({
      ...state,
      ...(pendingUrl    ? { activeVideoUrl: pendingUrl }    : {}),
      ...(pendingMembers ? { members: pendingMembers }       : {}),
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

  const setMembers = useMemoizedFn((members: Member[]) => {
    setRoomState((prev) => {
      if (!prev) {
        // WS 早于 HTTP 到达：roomState 尚未初始化，暂存等 initRoom 消费
        pendingMembersRef.current = members;
        return prev;
      }
      return { ...prev, members };
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

  return (
    <RoomContext.Provider
      value={{
        roomState,
        initRoom,
        setActiveVideoUrl,
        addVideo,
        setMembers,
        addMember,
        removeMember,
        setMemberOnline,
        setControlMode,
        setControllerId,
        renameVideo,
        removeVideo,
      }}
    >
      {children}
    </RoomContext.Provider>
  );
}

export function useRoom() {
  return useContext(RoomContext);
}
