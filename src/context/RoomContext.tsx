import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Member, ControlMode, RoomStatus } from '@/types/room';

export interface PlaybackState {
  currentTime: number;
  isPlaying: boolean;
}

export interface RoomState {
  roomId: string;
  videoUrl: string | null;
  status: RoomStatus;
  members: Member[];
  controlMode: ControlMode;
  controllerId: string | null;
  playbackState: PlaybackState;
}

interface RoomContextValue {
  roomState: RoomState | null;
  initRoom: (state: RoomState) => void;
  setVideoUrl: (url: string) => void;
  setMembers: (members: Member[]) => void;
  addMember: (member: Member) => void;
  removeMember: (userId: string) => void;
  setMemberOnline: (userId: string, isOnline: boolean) => void;
  setControlMode: (mode: ControlMode) => void;
  setControllerId: (userId: string | null) => void;
  setPlaybackState: (state: Partial<PlaybackState>) => void;
  setRoomStatus: (status: RoomStatus) => void;
}

const RoomContext = createContext<RoomContextValue>({
  roomState: null,
  initRoom: () => {},
  setVideoUrl: () => {},
  setMembers: () => {},
  addMember: () => {},
  removeMember: () => {},
  setMemberOnline: () => {},
  setControlMode: () => {},
  setControllerId: () => {},
  setPlaybackState: () => {},
  setRoomStatus: () => {},
});

export function RoomProvider({ children }: { children: ReactNode }) {
  const [roomState, setRoomState] = useState<RoomState | null>(null);

  const initRoom = useCallback((state: RoomState) => {
    setRoomState(state);
  }, []);

  const setVideoUrl = useCallback((url: string) => {
    setRoomState((prev) => prev ? { ...prev, videoUrl: url } : prev);
  }, []);

  const setMembers = useCallback((members: Member[]) => {
    setRoomState((prev) => prev ? { ...prev, members } : prev);
  }, []);

  const addMember = useCallback((member: Member) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      // 避免重复添加
      const exists = prev.members.some((m) => m.userId === member.userId);
      if (exists) return prev;
      return { ...prev, members: [...prev.members, member] };
    });
  }, []);

  const removeMember = useCallback((userId: string) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        members: prev.members.map((m) =>
          m.userId === userId ? { ...m, isOnline: false } : m,
        ),
      };
    });
  }, []);

  const setMemberOnline = useCallback((userId: string, isOnline: boolean) => {
    setRoomState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        members: prev.members.map((m) =>
          m.userId === userId ? { ...m, isOnline } : m,
        ),
      };
    });
  }, []);

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

  const setRoomStatus = useCallback((status: RoomStatus) => {
    setRoomState((prev) => prev ? { ...prev, status } : prev);
  }, []);

  return (
    <RoomContext.Provider
      value={{
        roomState,
        initRoom,
        setVideoUrl,
        setMembers,
        addMember,
        removeMember,
        setMemberOnline,
        setControlMode,
        setControllerId,
        setPlaybackState,
        setRoomStatus,
      }}
    >
      {children}
    </RoomContext.Provider>
  );
}

export function useRoom() {
  return useContext(RoomContext);
}
