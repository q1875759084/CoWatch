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
  setMembers: (members: Member[]) => void;
  addMember: (member: Member) => void;
  removeMember: (userId: string) => void;
  setControlMode: (mode: ControlMode) => void;
  setControllerId: (userId: string | null) => void;
}

const RoomContext = createContext<RoomContextValue>({
  roomState: null,
  initRoom: () => {},
  setActiveVideoUrl: () => {},
  addVideo: () => {},
  setMembers: () => {},
  addMember: () => {},
  removeMember: () => {},
  setControlMode: () => {},
  setControllerId: () => {},
});

export function RoomProvider({ children }: { children: ReactNode }) {
  const [roomState, setRoomState] = useState<RoomState | null>(null);

  /**
   * WS ROOM_STATE 可能早于 HTTP initRoom 到达，此时 roomState 为 null，
   * setActiveVideoUrl 的 setState(prev => prev ? ... : prev) 会丢弃 url。
   * 用 ref 暂存，initRoom 完成时将其合并进初始 state。
   */
  const pendingActiveVideoUrlRef = useRef<string | null>(null);

  const initRoom = useMemoizedFn((state: RoomState) => {
    const pending = pendingActiveVideoUrlRef.current;
    pendingActiveVideoUrlRef.current = null;
    // 若 WS 先于 HTTP 写入了 activeVideoUrl，合并进初始 state
    setRoomState(pending ? { ...state, activeVideoUrl: pending } : state);
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
    setRoomState((prev) => prev ? { ...prev, members } : prev);
  });

  const addMember = useMemoizedFn((member: Member) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      // 已存在则跳过（幂等）
      if (prev.members.some((m) => m.userId === member.userId)) return prev;
      return { ...prev, members: [...prev.members, member] };
    });
  });

  const removeMember = useMemoizedFn((userId: string) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return { ...prev, members: prev.members.filter((m) => m.userId !== userId) };
    });
  });

  // setMemberOnline 已移除：isOnline 语义废弃，在房间即在线，离开即从列表移除

  const setControlMode = useMemoizedFn((mode: ControlMode) => {
    setRoomState((prev) => prev ? { ...prev, controlMode: mode } : prev);
  });

  const setControllerId = useMemoizedFn((userId: string | null) => {
    setRoomState((prev) => prev ? { ...prev, controllerId: userId } : prev);
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
        setControlMode,
        setControllerId,
      }}
    >
      {children}
    </RoomContext.Provider>
  );
}

export function useRoom() {
  return useContext(RoomContext);
}
