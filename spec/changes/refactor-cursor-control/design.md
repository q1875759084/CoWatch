# 鼠标控制逻辑重构 技术设计

## 1. 功能概述

修复自由模式下非主控开启鼠标共享后无法操作视频的 bug，并借此机会彻底重构鼠标功能区的控制逻辑，消除 `cursorLocked` 这个职责混乱的 prop，让"视频是否可操作"、"是否隐藏系统光标"、"鼠标共享 WS 广播"三者职责完全分离。

## 2. 涉及模块

`src/pages/Lobby/`：
- `index.tsx`（父组件，状态管理）
- `VideoPlayer.tsx`（视频播放器）
- `ControlPanel.tsx`（右侧控制面板）

## 3. 核心问题分析

### 当前混乱点

**问题一：`cursorLocked` 职责混乱**

`cursorLocked` 的原始意图是压制 `<video controls>` Shadow DOM 内无法被外部 CSS 覆盖的手型光标（通过 `pointer-events: none` 实现）。但它绑定的触发条件是：

```
cursorLocked = cursorEnabled && !isController
```

即"鼠标共享开启 && 非主控"，而鼠标共享（WS 广播坐标）和手型光标的显示完全是两件无关的事情。

**问题二：漏掉自由模式场景**

原始注释假设"非主控开了鼠标共享，那他一定也是 disabled=true（跟随模式）"，但自由模式破坏了这个假设：
- 自由模式：`disabled = false`（视频本应可操作）
- 但 `cursorEnabled && !isController = true`（鼠标共享开着）
- 结果：`pointer-events: none` 被设上，视频控件被锁死 ❌

**问题三：主控绘制模式未在 `disabled` 层面表达**

主控开绘制模式时依赖 PainterLayer 的 `stopPropagation` 拦截事件，是打补丁行为，语义上应该在 `disabled` 层面直接表达。

### 三个独立职责的正确映射

| 职责 | 控制变量 | 说明 |
|------|---------|------|
| 视频是否可操作 | `disabled` | `(非主控 && 跟随模式) \|\| (主控 && 绘制模式)` |
| 是否隐藏系统光标（本地视觉） | `cursorStyleActive` | 用户选了自定义图标才隐藏，与共享/绘制无关 |
| 鼠标坐标广播（WS） | `cursorEnabled` | 只管发消息，不影响任何本地视觉或交互 |

## 4. 页面设计

### index.tsx

#### disabled 条件重构

```tsx
// 旧
disabled={!isController && followMode}

// 新
disabled={(!isController && followMode) || (isController && drawingMode)}
```

#### cursorLocked 删除

`cursorLocked` prop 从 `VideoPlayer` 调用处完全删除。`pointer-events` 由 `disabled` 单独决定，不再需要 `cursorLocked`。

#### handleFollowModeToggle 补充重置

切换到自由模式时，自动重置所有鼠标相关状态（因为自由模式下鼠标功能区全部不可用）：

```tsx
const handleFollowModeToggle = useMemoizedFn(() => {
    const next = !followModeRef.current;
    setFollowMode(next);
    if (next) {
        sendMessageRef.current?.('FORCE_SYNC', {});
    } else {
        // 切到自由模式：重置所有鼠标状态
        setCursorEnabled(false);
        setCursorStyleActive(false);
        setSelectedStyleId(DEFAULT_STYLE_ID);
        setDrawingMode(false);
        // 清空自己的光标（不再广播位置，Map 条目需要清理）
        const uid = userInfo?.userId ?? '__self__';
        cursorsRef.current.delete(uid);
        painterRef.current?.redraw();
    }
});
```

### VideoPlayer.tsx

#### 删除 cursorLocked prop

```tsx
// 旧 interface
cursorLocked?: boolean;

// 新：删除该 prop

// 旧 style
pointerEvents: (disabled || cursorLocked) ? 'none' : 'auto'

// 新
pointerEvents: disabled ? 'none' : 'auto'
```

### ControlPanel.tsx

#### 自由模式下鼠标功能区全部 disabled

新增 prop `mouseFeatureDisabled: boolean`（`!isController && !followMode`），传给鼠标功能区内所有可交互元素：

- 光标样式选择器的每个 `<button>`
- 鼠标共享 `<Switch>`
- 绘制模式 `<Switch>`
- 颜色选择器的每个 `<button>`
- 清除此色 `<button>`
- 清空画布 `<button>`

## 5. 类型定义

无新增类型。仅删除 `VideoPlayerProps` 中的 `cursorLocked?: boolean`。

## 6. 权限控制

无权限相关变更。

## 7. 关键决策记录

| 问题 | 决策 | 理由 |
|------|------|------|
| 主控绘制模式下进度条/音量可否操作 | 均不可操作 | `pointer-events: none` 是最简实现，语义也清晰 |
| `cursorLocked` 去向 | 直接删除 | `disabled` 已经涵盖其全部作用，无需保留 |
| 自由模式下鼠标功能 | 全部 disabled，切换时自动重置 | 自由模式本意是脱离共享，不应影响他人画布/光标 |
| 自由模式切换时是否广播 CURSOR_HIDE | 不需要 | 删除光标 Map 条目后 `redraw()` 本地不再渲染，对其他人无影响（已超出 WS 广播范围的设计边界） |
