import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Member, ControlMode, VideoItem } from '@/types/room';

export interface PlaybackState {
  currentTime: number;
  isPlaying: boolean;
}

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
  playbackState: PlaybackState;
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
  setPlaybackState: (state: Partial<PlaybackState>) => void;
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
  setPlaybackState: () => {},
});

export function RoomProvider({ children }: { children: ReactNode }) {
  const [roomState, setRoomState] = useState<RoomState | null>(null);

  const initRoom = useCallback((state: RoomState) => {
    setRoomState(state);
  }, []);

  const setActiveVideoUrl = useCallback((url: string) => {
    setRoomState((prev) => prev ? { ...prev, activeVideoUrl: url } : prev);
  }, []);

  const addVideo = useCallback((video: VideoItem) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      // 避免重复追加
      const exists = prev.videos.some((v) => v.id === video.id);
      if (exists) return prev;
      return { ...prev, videos: [...prev.videos, video] };
    });
  }, []);

  const setMembers = useCallback((members: Member[]) => {
    setRoomState((prev) => prev ? { ...prev, members } : prev);
  }, []);

  const addMember = useCallback((member: Member) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      // 已存在则跳过（幂等）
      if (prev.members.some((m) => m.userId === member.userId)) return prev;
      return { ...prev, members: [...prev.members, member] };
    });
  }, []);

  const removeMember = useCallback((userId: string) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return { ...prev, members: prev.members.filter((m) => m.userId !== userId) };
    });
  }, []);

  // setMemberOnline 已移除：isOnline 语义废弃，在房间即在线，离开即从列表移除

  const setControlMode = useCallback((mode: ControlMode) => {
    setRoomState((prev) => prev ? { ...prev, controlMode: mode } : prev);
  }, []);

  const setControllerId = useCallback((userId: string | null) => {
    setRoomState((prev) => prev ? { ...prev, controllerId: userId } : prev);
  }, []);

  const setPlaybackState = useCallback((state: Partial<PlaybackState>) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return { ...prev, playbackState: { ...prev.playbackState, ...state } };
    });
  }, []);

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
        setPlaybackState,
      }}
    >
      {children}
    </RoomContext.Provider>
  );
}

export function useRoom() {
  return useContext(RoomContext);
}
