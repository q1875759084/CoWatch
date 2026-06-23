import { createContext, useContext, useState, type ReactNode } from 'react';
import { useMemoizedFn } from 'ahooks';
import type { RoomPlanLevel } from '@/types/room';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface RoomMeta {
  roomId: string;
  roomName: string;
  /**
   * 房间当前等级。
   *   'free'      → 已过期，Lobby 渲染 <RoomExpired />，不初始化 WS 和视频列表
   *   'vip:basic' → 普通会员房间
   *   'vip:pro'   → 高级会员房间
   */
  planLevel: RoomPlanLevel;
}

interface RoomMetaContextValue {
  /** null = 尚未进入任何房间（HTTP getInfo 还未完成） */
  roomMeta: RoomMeta | null;
  setRoomMeta: (meta: RoomMeta) => void;
  clearRoomMeta: () => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const RoomMetaContext = createContext<RoomMetaContextValue>({
  roomMeta: null,
  setRoomMeta: () => {},
  clearRoomMeta: () => {},
});

// ─── Provider ─────────────────────────────────────────────────────────────────

export function RoomMetaProvider({ children }: { children: ReactNode }) {
  const [roomMeta, setRoomMetaState] = useState<RoomMeta | null>(null);

  const setRoomMeta = useMemoizedFn((meta: RoomMeta) => {
    setRoomMetaState(meta);
  });

  const clearRoomMeta = useMemoizedFn(() => {
    setRoomMetaState(null);
  });

  return (
    <RoomMetaContext.Provider value={{ roomMeta, setRoomMeta, clearRoomMeta }}>
      {children}
    </RoomMetaContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

/**
 * 消费房间元信息（roomId、roomName、planLevel）。
 *
 * 适用于：视频上传、编码设置、过期检测等需要感知房间等级的子模块。
 * 这些模块无需关心成员列表、控制权等其他房间状态。
 */
export function useRoomMeta(): RoomMetaContextValue {
  return useContext(RoomMetaContext);
}

/**
 * 仅消费 planLevel 的轻量 hook。
 * 未进入房间时返回 'free'（兜底，阻止子模块误操作）。
 */
export function useRoomPlanLevel(): RoomPlanLevel {
  const { roomMeta } = useContext(RoomMetaContext);
  return roomMeta?.planLevel ?? 'free';
}
