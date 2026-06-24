import { useState } from 'react';
import { DEFAULT_STYLE_ID } from '../PainterLayer/cursorStyles';
import { DEFAULT_DRAW_COLOR } from '../constants';

/**
 * 用户的鼠标/画笔偏好配置。
 *
 * 管理以下"用户主动设置"的静态偏好（与帧级协作数据 cursorsRef/painterRef 无关）：
 *   - cursorEnabled：是否向他人广播自己的鼠标位置
 *   - selectedStyleId / cursorStyleActive：当前光标样式及虚拟光标激活状态（联动）
 *   - drawingMode：是否处于协同绘制模式
 *   - drawColor：当前画笔颜色
 *
 * 这些 state 只由用户主动操作改变（点击 UI 控件），不由 WS 消息驱动，
 * 因此与 sendMessage / cursorsRef / painterRef 完全解耦，无循环依赖。
 *
 * 进入自由模式时只关闭 cursorEnabled 和 drawingMode（广播相关开关），
 * 光标样式/颜色等本地视觉偏好保留，切回跟随模式时体验更连贯。
 */
export function useCursorSettings() {
    /** 是否开启鼠标共享（是否向他人广播自己的位置） */
    const [cursorEnabled, setCursorEnabled] = useState(false);

    /**
     * 当前选中的光标样式 ID。
     * 与 cursorStyleActive 联动：通过 selectStyle() 同时修改两者，
     * 避免调用方需要分别维护两个 state 的一致性。
     */
    const [selectedStyleId, setSelectedStyleId] = useState(DEFAULT_STYLE_ID);

    /**
     * 是否已激活虚拟光标样式（用户主动选择了某个非默认样式）。
     * true → 隐藏系统光标，在 canvas 上渲染虚拟光标图标。
     * 独立于 cursorEnabled（广播控制）和 drawingMode（绘制模式）。
     */
    const [cursorStyleActive, setCursorStyleActive] = useState(false);

    /**
     * 是否处于绘制模式。
     * true → 鼠标拖动触发笔迹绘制，click 被拦截防止触发视频播放。
     * 独立于 cursorEnabled 和 cursorStyleActive。
     */
    const [drawingMode, setDrawingMode] = useState(false);

    /** 当前画笔颜色 */
    const [drawColor, setDrawColor] = useState(DEFAULT_DRAW_COLOR);

    /**
     * 选择光标样式（封装 selectedStyleId + cursorStyleActive 的联动规则）：
     *   - 'default' → 关闭虚拟光标，恢复系统光标
     *   - 其他 styleId → 激活虚拟光标，切换样式
     *
     * 注意：选择 'default' 时还需要从 cursorsRef 中删除自己的条目并重绘，
     * 那部分操作依赖运行时 ref，由调用方（handleCursorStyleSelect）在调用
     * selectStyle 之后自行处理。
     */
    const selectStyle = (styleId: string) => {
        setSelectedStyleId(styleId);
        setCursorStyleActive(styleId !== 'default');
    };

    return {
        cursorEnabled,
        setCursorEnabled,
        selectedStyleId,
        cursorStyleActive,
        drawingMode,
        setDrawingMode,
        drawColor,
        setDrawColor,
        selectStyle,
    };
}
