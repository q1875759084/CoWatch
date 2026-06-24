import { useState, useRef, type MutableRefObject } from 'react';
import { useMemoizedFn } from 'ahooks';
import { DEFAULT_STYLE_ID } from '../PainterLayer/cursorStyles';
import { DEFAULT_DRAW_COLOR } from '../constants';
import type { CursorState, PainterLayerHandle } from '../PainterLayer';

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
    /**
     * PainterLayer 命令式句柄（只读）。
     * 供 Lobby 内仍未迁移的 handlers（handleCursorToggle 等）访问。
     * Step 3 完成后可移除此暴露。
     */
    painterRef: React.RefObject<PainterLayerHandle | null>;
    /**
     * PainterLayer callback ref，传给 JSX 的 ref prop。
     * 封装了"挂载时消费 pendingStrokes"的逻辑，避免 Lobby 直接感知 pendingStrokesRef。
     */
    setPainterRef: (handle: PainterLayerHandle | null) => void;
    /**
     * 写入待恢复的历史笔迹（由 handleRoomState 在 PainterLayer 未就绪时调用）。
     * 挂载时 setPainterRef 会自动消费并清空。
     */
    setPendingStrokes: (strokes: Array<{ color: string; points: Array<{ x: number; y: number }> }>) => void;
    /** 绘制模式开关 handler（传给子组件，需稳定引用） */
    handleDrawingModeToggle: () => void;
}

/**
 * 鼠标共享与协同绘制的状态管理 hook（Step 2：封装 painterRef + pendingStrokesRef）。
 *
 * 当前封装：
 *   - 5 个核心 state（cursorEnabled / selectedStyleId / cursorStyleActive / drawingMode / drawColor）
 *   - cursorsRef（光标 Map，命令式更新，不走 setState）
 *   - painterRef（PainterLayer 命令式句柄）
 *   - pendingStrokesRef（历史笔迹暂存，WS 比挂载先到时使用）
 *   - setPainterRef（callback ref，含 pendingStrokes 消费逻辑）
 *   - setPendingStrokes（供 handleRoomState 写入）
 *   - handleDrawingModeToggle
 *
 * 待后续 step 迁移（依赖 sendMessage / userInfo）：
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
    const painterRef = useRef<PainterLayerHandle | null>(null);
    /**
     * 暂存 ROOM_STATE 下发的历史笔迹。
     * WS 比 PainterLayer 挂载早到，painterRef.current 此时为 null，
     * 先存入此 ref，等 PainterLayer callback ref 触发时再消费。
     */
    const pendingStrokesRef = useRef<Array<{ color: string; points: Array<{ x: number; y: number }> }> | null>(null);

    /**
     * PainterLayer callback ref：挂载时同步写入 painterRef，并消费暂存的历史笔迹。
     * 封装在 hook 内，Lobby 的 JSX 只需 ref={setPainterRef}，无需感知 pendingStrokesRef。
     */
    const setPainterRef = useMemoizedFn((handle: PainterLayerHandle | null) => {
        (painterRef as MutableRefObject<PainterLayerHandle | null>).current = handle;
        if (handle && pendingStrokesRef.current) {
            const pending = pendingStrokesRef.current;
            pendingStrokesRef.current = null;
            handle.clearStrokes();
            pending.forEach((s) => handle.addStroke(s));
        }
    });

    /**
     * 写入待恢复的历史笔迹。
     * handleRoomState 在 PainterLayer 未挂载时调用此方法暂存，
     * 等 setPainterRef 触发时自动消费。
     * 若 PainterLayer 已挂载（painterRef.current 存在），直接应用，不暂存。
     */
    const setPendingStrokes = useMemoizedFn(
        (strokes: Array<{ color: string; points: Array<{ x: number; y: number }> }>) => {
            if (painterRef.current) {
                painterRef.current.clearStrokes();
                strokes.forEach((s) => painterRef.current?.addStroke(s));
            } else {
                pendingStrokesRef.current = strokes;
            }
        }
    );

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
        painterRef,
        setPainterRef,
        setPendingStrokes,
        handleDrawingModeToggle,
    };
}
