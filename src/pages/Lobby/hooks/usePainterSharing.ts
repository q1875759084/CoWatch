import { useState, useRef } from 'react';
import { useMemoizedFn } from 'ahooks';
import { DEFAULT_STYLE_ID } from '../PainterLayer/cursorStyles';
import { DEFAULT_DRAW_COLOR } from '../constants';
import type { CursorState } from '../PainterLayer';

export interface PainterSharingState {
    /** 是否开启鼠标共享（是否发送自己的位置） */
    cursorEnabled: boolean;
    setCursorEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    /** 当前选中的光标样式 ID */
    selectedStyleId: string;
    setSelectedStyleId: React.Dispatch<React.SetStateAction<string>>;
    /**
     * 是否已激活虚拟光标样式（用户主动点击了某个样式，隐藏系统光标，
     * 本地渲染 canvas 虚拟光标）。
     * 独立于 cursorEnabled（WS 广播）和 drawingMode（绘制）。
     */
    cursorStyleActive: boolean;
    setCursorStyleActive: React.Dispatch<React.SetStateAction<boolean>>;
    /**
     * 是否处于绘制模式。独立于鼠标共享（cursorEnabled），两者互不依赖。
     * - false（默认）：视频播放器可正常操作
     * - true：在视频区按住左键拖动发送笔迹 WS，同时拦截 click 防止触发播放
     */
    drawingMode: boolean;
    setDrawingMode: React.Dispatch<React.SetStateAction<boolean>>;
    /** 当前画笔颜色 */
    drawColor: string;
    setDrawColor: React.Dispatch<React.SetStateAction<string>>;
    /**
     * 所有光标的状态 Map（含自己 + 远端）。
     * key：userId（自己用 userInfo.userId）。
     * 直接操作 Map 引用（不 setState）+ 调 painterRef.redraw() 触发 canvas 重绘，
     * 避免每帧 mousemove 都触发 React re-render。
     */
    cursorsRef: React.MutableRefObject<Map<string, CursorState>>;
    /** 绘制模式开关 handler（传给子组件，需稳定引用） */
    handleDrawingModeToggle: () => void;
}

/**
 * 鼠标共享与协同绘制的状态管理 hook（Step 1：纯状态层）。
 *
 * 当前仅封装：
 *   - 5 个核心 state（cursorEnabled / selectedStyleId / cursorStyleActive / drawingMode / drawColor）
 *   - cursorsRef（光标 Map，命令式更新，不走 setState）
 *   - handleDrawingModeToggle（无跨模块依赖，可安全迁移）
 *
 * 待后续 step 迁移（依赖 painterRef / sendMessage / userInfo）：
 *   - handleCursorToggle, handleCursorStyleSelect
 *   - handleSelfCursorMove, handleSelfCursorLeave
 *   - handleStrokeComplete, handleClearStrokes, handleClearStrokesByColor
 *   - handleCursorMove, handleCursorHide
 *   - handleDrawStroke, handleDrawClear, handleDrawClearColor
 *   - selectedStyleId 同步 useEffect
 */
export function usePainterSharing(): PainterSharingState {
    const [cursorEnabled, setCursorEnabled] = useState(false);
    const [selectedStyleId, setSelectedStyleId] = useState(DEFAULT_STYLE_ID);
    const [cursorStyleActive, setCursorStyleActive] = useState(false);
    const [drawingMode, setDrawingMode] = useState(false);
    const [drawColor, setDrawColor] = useState(DEFAULT_DRAW_COLOR);
    const cursorsRef = useRef<Map<string, CursorState>>(new Map());

    const handleDrawingModeToggle = useMemoizedFn(() => {
        setDrawingMode((prev) => !prev);
    });

    return {
        cursorEnabled,
        setCursorEnabled,
        selectedStyleId,
        setSelectedStyleId,
        cursorStyleActive,
        setCursorStyleActive,
        drawingMode,
        setDrawingMode,
        drawColor,
        setDrawColor,
        cursorsRef,
        handleDrawingModeToggle,
    };
}
