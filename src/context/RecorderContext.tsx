import { createContext, useContext, useState, type ReactNode } from 'react';

import type { RecorderState } from '@/types/recorder';

interface RecorderContextValue {
  /** 当前录制状态机状态 */
  recorderState: RecorderState;
  setRecorderState: (state: RecorderState) => void;
}

const RecorderContext = createContext<RecorderContextValue>({
  recorderState: 'idle',
  setRecorderState: () => {},
});

interface RecorderProviderProps {
  children: ReactNode;
}

/**
 * 轻量录制状态 Context，仅在 Lobby 路由层挂载。
 * 供路由守卫读取 recorderState，判断是否允许离开房间。
 */
export function RecorderProvider({ children }: RecorderProviderProps) {
  const [recorderState, setRecorderState] = useState<RecorderState>('idle');

  return (
    <RecorderContext.Provider value={{ recorderState, setRecorderState }}>
      {children}
    </RecorderContext.Provider>
  );
}

/**
 * 读取当前录制状态，供路由守卫和 Recorder 组件使用。
 * 必须在 RecorderProvider 内部调用。
 */
export function useRecorderState(): RecorderContextValue {
  return useContext(RecorderContext);
}
