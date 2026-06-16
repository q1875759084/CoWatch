# 重构：消除 state + ref 双写模式

## 问题描述

`src/pages/Lobby/index.tsx` 中存在 3 组 `state + ref` 必须同步双写的状态：

```typescript
const [activeObjectKey, setActiveObjectKey] = useState<string | null>(null);
const activeObjectKeyRef = useRef<string | null>(null);

const [activeVideoId, setActiveVideoId] = useState<string>('');
const activeVideoIdRef = useRef<string>('');

const [followMode, setFollowMode] = useState(true);
const followModeRef = useRef(true);
```

**每次写入必须同时更新 state 和 ref，否则 useMemoizedFn 闭包读到的是旧值，引发 bug。**
这个约束没有语言层面的强制，完全靠人工记忆，每次改动 WS handler 都有漏写风险。

## 历史已发的 bug

- `handleSwitchVideo` 中 `objectKey === activeObjectKey` 永远不成立（stale closure），导致主控切换视频无反应
- 控制权转移后，新主控的当前视频未同步到后端，原因是 `activeVideoIdRef` 漏写

## 解决方案

新建 `src/hooks/useSyncedState.ts`：

```typescript
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
```

## 改动范围

### 1. 新建 `src/hooks/useSyncedState.ts`

### 2. 修改 `src/pages/Lobby/index.tsx`

替换三组双写为：

```typescript
const [activeObjectKey, activeObjectKeyRef, setActiveObjectKey] = useSyncedState<string | null>(null);
const [activeVideoId, activeVideoIdRef, setActiveVideoId] = useSyncedState('');
const [followMode, followModeRef, setFollowMode] = useSyncedState(true);
```

删除所有 `xxxRef.current = ...` 的手动同步行（这些调用变成多余的，全部可以删除），
只保留单一的 `setXxx(value)` 调用即可。

**需要删除的手动 ref 写入（共约 15 处）：**

- `activeObjectKeyRef.current = objectKey` → 删除，改为只调 `setActiveObjectKey(objectKey)`
- `activeObjectKeyRef.current = activeObjectKey` → 删除
- `activeObjectKeyRef.current = null` → 删除
- `activeVideoIdRef.current = matched.id` → 删除（所有 4 处）
- `activeVideoIdRef.current = videoId` → 删除（所有 2 处）
- `activeVideoIdRef.current = ''` → 删除
- `followModeRef.current = next` → 删除（handleFollowModeToggle 内）
- `followModeRef.current = false` → 删除（handleControlChanged 内两处）
- `followModeRef.current = true` → 删除（handleRoomState forceSynced 处）

## 注意事项

- `useSyncedState` 的 setter 内部调用 `setValue` 和同步写 `ref.current`，和之前手动双写语义完全一致
- `followMode` 的 `handleFollowModeToggle` 里用了 `setFollowMode((prev) => ...)` 函数式更新，改造时需改为先算出 `next` 再调 `set(next)`（`useSyncedState` 的 setter 不接受函数，只接受值）
