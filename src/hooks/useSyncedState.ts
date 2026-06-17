import { useState, useRef, useCallback } from 'react';

/**
 * 将 state 和 ref 的同步写封装为单一入口。
 * 解决 useMemoizedFn 闭包只能读到初始 state 的 stale closure 问题。
 *
 * 返回：[value, ref, setter]
 *   - value：用于 JSX 渲染（响应式）
 *   - ref：用于 useMemoizedFn 闭包内读取（始终最新）
 *   - setter：同时更新 value 和 ref，不可能遗漏
 */
export function useSyncedState<T>(initial: T) {
    const [value, setValue] = useState<T>(initial);
    const ref = useRef<T>(initial);
    const set = useCallback((next: T) => {
        ref.current = next;
        setValue(next);
    }, []);
    return [value, ref, set] as const;
}
