import { useRequest } from 'ahooks';
import { getMyRoomsApi } from '@/api/room';
import type { MyRoom } from '@/types/api';

interface UseMyRoomsResult {
  rooms: MyRoom[];
  loading: boolean;
  refresh: () => void;
}

/**
 * 拉取当前登录用户参与的所有房间列表
 */
export function useMyRooms(): UseMyRoomsResult {
  const { data, loading, run: refresh } = useRequest(getMyRoomsApi);

  return {
    rooms: data?.rooms ?? [],
    loading,
    refresh,
  };
}
