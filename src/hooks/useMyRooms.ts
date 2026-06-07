import { useState, useEffect, useCallback } from 'react';
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
  const [rooms, setRooms] = useState<MyRoom[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRooms = useCallback(() => {
    setLoading(true);
    getMyRoomsApi()
      .then((data) => setRooms(data.rooms))
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  return { rooms, loading, refresh: fetchRooms };
}
