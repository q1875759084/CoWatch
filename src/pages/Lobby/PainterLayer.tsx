import {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { useMemoizedFn } from 'ahooks';
import { throttle } from '@/utils/throttle';
import { getCursorStyle } from './cursorStyles';
import type { DrawStrokePoint } from '@/types/room';
import styles from './index.module.scss';

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface CursorState {
  userId: string;
  nickname: string;
  /** 0~1，相对 .playerRatio 容器宽度的百分比 */
  x: number;
  /** 0~1，相对 .playerRatio 容器高度的百分比 */
  y: number;
  styleId: string;
}

/** 一段持久化笔迹（由 mouseup 结束后固化） */
export interface StrokeRecord {
  color: string;
  points: DrawStrokePoint[];
}

export interface PainterLayerHandle {
  /** 通知 canvas 重绘（外部 cursor 数据变化时调用） */
  redraw: () => void;
  /** 追加一段完整笔迹（来自远端广播） */
  addStroke: (stroke: StrokeRecord) => void;
  /** 清空所有笔迹 */
  clearStrokes: () => void;
}

interface PainterLayerProps {
  /**
   * 是否启用虚拟光标样式（用户主动选择了某个样式时为 true）。
   * - true：隐藏系统光标，在 canvas 上渲染自己的虚拟光标图标（本地可见）
   * - false：保留浏览器默认光标，canvas 上不渲染自己的光标（但他人光标仍渲染）
   * 与鼠标共享（enabled）、绘制模式（drawingMode）完全独立。
   */
  cursorStyleActive: boolean;
  /** 是否开启鼠标共享（控制是否广播自己的位置给他人，不影响本地渲染） */
  enabled: boolean;
  /**
   * 是否处于绘制模式。
   *
   * - false（默认）：视频播放器可正常操作
   * - true：父容器 mousedown/move/up 触发笔迹绘制，click 事件被拦截防止触发视频播放
   * 与 cursorStyleActive、enabled 完全独立。
   */
  drawingMode: boolean;
  /** 所有需渲染的光标（含自己，由父组件维护；key 为 userId） */
  cursors: Map<string, CursorState>;
  /** 当前画笔颜色 */
  drawColor: string;
  /** 鼠标在容器内移动时回调，x/y 为 0~1 百分比坐标 */
  onCursorMove: (x: number, y: number) => void;
  /** 鼠标离开容器时回调 */
  onCursorLeave: () => void;
  /** 鼠标进入容器时回调 */
  onCursorEnter: () => void;
  /**
   * 用户完成一笔（mouseup）后回调，用于通过 WS 同步给其他人。
   * 仅在 drawingMode=true 时触发。
   */
  onStrokeComplete: (stroke: StrokeRecord) => void;
}

// ─── 图标缓存（避免重复创建 Image 对象） ─────────────────────────────────────

const imgCache = new Map<string, HTMLImageElement>();

function getOrLoadImg(url: string): HTMLImageElement {
  if (imgCache.has(url)) return imgCache.get(url)!;
  const img = new Image();
  img.src = url;
  imgCache.set(url, img);
  return img;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 光标图标渲染尺寸（CSS px）：对齐系统鼠标视觉大小，不随分辨率变化 */
const ICON_SIZE = 20;
/** 昵称 label 字体 */
const LABEL_FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
/** label 内边距 */
const LABEL_PAD_X = 6;
const LABEL_PAD_Y = 2;
/** label 距图标右下角的偏移 */
const LABEL_OFFSET_X = 12;
const LABEL_OFFSET_Y = 16;
/** 画笔线宽（CSS px） */
const STROKE_WIDTH = 3;

// ─── 组件 ─────────────────────────────────────────────────────────────────────

/**
 * PainterLayer — canvas 蒙层
 *
 * 职责：
 *   1. 锚定在 .playerRatio 容器（position: absolute, top/left: 0），随其宽高自适应
 *   2. 用 ResizeObserver 监听父容器尺寸变化，实时更新 canvas 物理像素 + CSS 尺寸
 *   3. 渲染所有成员的光标图标 + 昵称 label（含自己）
 *   4. 绘制模式下，在父容器上监听 mousedown/mousemove/mouseup，
 *      实时渲染正在绘制的笔迹（currentStroke），mouseup 后固化到 strokes 数组
 *   5. canvas 始终 pointer-events:none，事件穿透到下层（视频播放器可正常操作）
 *      所有事件均绑定在父容器上
 *
 * 坐标系：相对 .playerRatio 容器的百分比（0~1），跨分辨率/窗口尺寸一致。
 */
const PainterLayer = forwardRef<PainterLayerHandle, PainterLayerProps>(
  function PainterLayer(
    {
      cursorStyleActive,
      enabled,
      drawingMode,
      cursors,
      drawColor,
      onCursorMove,
      onCursorLeave,
      onCursorEnter,
      onStrokeComplete,
    },
    // styleId / nickname / userId 由 cursors Map 携带，不在此解构
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    /** 记录上一次绘制请求的 rAF id，用于去重 */
    const rafRef = useRef<number | null>(null);
    /** 当前 canvas 的逻辑宽高（CSS px），供坐标换算使用 */
    const sizeRef = useRef({ w: 0, h: 0 });

    /** 所有已完成笔迹（含本地 + 远端广播），用于每帧重绘 */
    const strokesRef = useRef<StrokeRecord[]>([]);
    /** 当前正在绘制的笔迹（mousedown 到 mouseup 之间的临时状态） */
    const currentStrokeRef = useRef<StrokeRecord | null>(null);
    /** 是否正在按住鼠标绘制 */
    const isDrawingRef = useRef(false);

    // ── 核心绘制函数 ──────────────────────────────────────────────────────────

    const draw = useMemoizedFn(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const { w, h } = sizeRef.current;

      // 清空物理像素画布
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 缩放到逻辑像素空间：之后所有坐标/尺寸直接用 CSS px 值，无需手动 × dpr
      ctx.save();
      ctx.scale(dpr, dpr);

      // ── 绘制所有笔迹 ──
      // 笔迹独立于 enabled（鼠标共享开关），无论是否开启鼠标共享，
      // 只要收到了远端笔迹数据就应该渲染。enabled 只控制光标图标。
      const allStrokes: StrokeRecord[] = [
        ...strokesRef.current,
        ...(currentStrokeRef.current ? [currentStrokeRef.current] : []),
      ];

      for (const stroke of allStrokes) {
        if (stroke.points.length < 2) continue;
        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = STROKE_WIDTH;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.moveTo(stroke.points[0].x * w, stroke.points[0].y * h);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
        }
        ctx.stroke();
      }

      // ── 绘制光标 ──
      // cursorStyleActive=false 时不渲染「自己」的光标（cursors Map 里 userId===自身 的条目由
      // handleSelfCursorEnter 控制是否插入，此处无需额外判断）。
      // enabled（鼠标共享）只控制 WS 广播，不影响渲染。
      cursors.forEach((cursor) => {
        // 逻辑像素坐标（百分比 × 容器逻辑宽高）
        const px = cursor.x * w;
        const py = cursor.y * h;


        // 绘制光标图标（逻辑尺寸 ICON_SIZE px）
        const cs = getCursorStyle(cursor.styleId);
        const img = getOrLoadImg(cs.url);
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, px, py, ICON_SIZE, ICON_SIZE);
        } else {
          // 图片尚未加载完成：注册 onload 后触发重绘
          img.onload = () => scheduleRedraw();
        }

        // 绘制昵称 label
        ctx.font = LABEL_FONT;
        const textW = ctx.measureText(cursor.nickname).width;
        const labelW = textW + LABEL_PAD_X * 2;
        const labelH = 11 + LABEL_PAD_Y * 2;
        const lx = px + LABEL_OFFSET_X;
        const ly = py + LABEL_OFFSET_Y;

        // label 背景
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.beginPath();
        ctx.roundRect(lx, ly, labelW, labelH, 3);
        ctx.fill();

        // label 边框
        ctx.strokeStyle = cs.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(lx, ly, labelW, labelH, 3);
        ctx.stroke();

        // label 文字
        ctx.fillStyle = cs.color;
        ctx.textBaseline = 'middle';
        ctx.fillText(cursor.nickname, lx + LABEL_PAD_X, ly + labelH / 2);

      });

      ctx.restore();
    });

    const scheduleRedraw = useMemoizedFn(() => {
      if (rafRef.current !== null) return; // 已有待执行的绘制，去重
      rafRef.current = requestAnimationFrame(draw);
    });

    // 暴露给父组件的命令式接口
    useImperativeHandle(ref, () => ({
      redraw: scheduleRedraw,
      addStroke: (stroke: StrokeRecord) => {
        strokesRef.current.push(stroke);
        scheduleRedraw();
      },
      clearStrokes: () => {
        strokesRef.current = [];
        currentStrokeRef.current = null;
        scheduleRedraw();
      },
    }), [scheduleRedraw]);

    // ── ResizeObserver：监听父容器尺寸变化，更新 canvas 物理像素 ──────────────

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      const updateSize = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        sizeRef.current = { w, h };
        // 绘图缓冲区用物理像素（HiDPI 清晰）
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        // CSS 尺寸必须等于逻辑像素，否则 canvas 被拉伸，绘制内容会放大 dpr 倍
        canvas.style.width  = `${w}px`;
        canvas.style.height = `${h}px`;
        // 尺寸变化后立即重绘
        scheduleRedraw();
      };

      const ro = new ResizeObserver(updateSize);
      ro.observe(parent);
      updateSize(); // 初始化

      return () => ro.disconnect();
    }, [scheduleRedraw]);

    // ── cursors / cursorStyleActive 数据变化时触发重绘 ───────────────────────

    useEffect(() => {
      scheduleRedraw();
    }, [cursors, cursorStyleActive, scheduleRedraw]);

    // ── 父容器事件监听（mousemove/enter/leave + 绘制 mousedown/up）──────────
    //
    // 业界通用方案（Figma/Excalidraw）：
    //   所有事件绑定在父容器上，canvas 始终 pointer-events:none。
    //   绘制逻辑也在父容器上捕获，不依赖 canvas 自身事件。

    const throttledMove = useRef(
      throttle((clientX: number, clientY: number, moveFn: (x: number, y: number) => void) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const x = (clientX - rect.left) / rect.width;
        const y = (clientY - rect.top)  / rect.height;
        moveFn(x, y);
      }, 50),
    ).current;

    /** 将 clientX/Y 转换为 0~1 百分比坐标 */
    const toRatio = useMemoizedFn((clientX: number, clientY: number): DrawStrokePoint => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
      };
    });

    const handleMouseMove = useMemoizedFn((e: MouseEvent) => {
      // 坐标共享（节流）
      throttledMove(e.clientX, e.clientY, onCursorMove);

      // 绘制模式：鼠标按住时追加坐标点
      if (drawingMode && isDrawingRef.current && currentStrokeRef.current) {
        const pt = toRatio(e.clientX, e.clientY);
        currentStrokeRef.current.points.push(pt);
        scheduleRedraw();
      }
    });

    const handleMouseDown = useMemoizedFn((e: MouseEvent) => {
      if (!drawingMode || e.button !== 0) return;
      // 阻止事件穿透到 <video>：
      //   - preventDefault()：阻止浏览器对 mousedown 的默认行为（如文字选中、拖拽）
      //   - stopPropagation()：阻止事件继续冒泡到 <video>，防止 video controls 收到 click
      e.preventDefault();
      e.stopPropagation();
      isDrawingRef.current = true;
      const pt = toRatio(e.clientX, e.clientY);
      currentStrokeRef.current = { color: drawColor, points: [pt] };
      scheduleRedraw();
    });

    // 绘制模式下拦截 click 事件，防止 mousedown+mouseup 组合被 video 识别为 click
    const handleClick = useMemoizedFn((e: MouseEvent) => {
      if (!drawingMode) return;
      e.preventDefault();
      e.stopPropagation();
    });

    const handleMouseUp = useMemoizedFn(() => {
      if (!drawingMode || !isDrawingRef.current) return;
      isDrawingRef.current = false;
      const stroke = currentStrokeRef.current;
      currentStrokeRef.current = null;
      if (stroke && stroke.points.length >= 2) {
        strokesRef.current.push(stroke);
        onStrokeComplete(stroke);
      }
      scheduleRedraw();
    });

    const handleMouseLeave = useMemoizedFn(() => {
      // 鼠标移出区域时，若正在绘制则终止当前笔迹
      if (isDrawingRef.current) {
        handleMouseUp();
      }
      onCursorLeave();
    });

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      // mousemove / enter / leave：始终绑定。
      //   - cursorStyleActive=true 时负责本地虚拟光标位置更新
      //   - enabled=true 时负责 WS 广播（handleMouseMove / handleSelfCursorEnter 内判断）
      //   - drawingMode=true 时负责笔迹轨迹记录
      parent.addEventListener('mousemove', handleMouseMove);
      parent.addEventListener('mouseenter', onCursorEnter);
      parent.addEventListener('mouseleave', handleMouseLeave);

      // mousedown / click 拦截：仅在绘制模式需要，防止穿透到 <video>
      // capture:true 确保在冒泡到子元素之前先拦截
      if (drawingMode) {
        parent.addEventListener('mousedown', handleMouseDown, { capture: true });
        parent.addEventListener('click', handleClick, { capture: true });
        // mouseup 需要绑在 window 上，防止拖出区域后松开无法触发
        window.addEventListener('mouseup', handleMouseUp);
      }

      return () => {
        parent.removeEventListener('mousemove', handleMouseMove);
        parent.removeEventListener('mouseenter', onCursorEnter);
        parent.removeEventListener('mouseleave', handleMouseLeave);
        if (drawingMode) {
          parent.removeEventListener('mousedown', handleMouseDown, { capture: true });
          parent.removeEventListener('click', handleClick, { capture: true });
          window.removeEventListener('mouseup', handleMouseUp);
        }
      };
    }, [drawingMode, handleMouseMove, handleMouseDown, handleClick, onCursorEnter, handleMouseLeave, handleMouseUp]);

    // ── 父容器 cursor class（绘制模式 crosshair，普通模式 none）────────────

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      // 用 CSS class 覆盖子元素（button/input 等）自带的 cursor:pointer，
      // 直接写 style.cursor 只影响父元素自身，无法压制子元素声明。
      parent.classList.remove(styles.cursorHidden);

      // cursorStyleActive=true → none（隐藏系统光标，展示 canvas 虚拟光标）
      // 其他（含绘制模式）     → 不加任何 class，保留浏览器默认光标
      if (cursorStyleActive) {
        parent.classList.add(styles.cursorHidden);
      }

      return () => {
        parent.classList.remove(styles.cursorHidden);
      };
    }, [cursorStyleActive, drawingMode]);

    // ── drawingMode 关闭时放弃当前未完成的笔迹 ────────────────────────────

    useEffect(() => {
      if (!drawingMode) {
        isDrawingRef.current = false;
        currentStrokeRef.current = null;
        scheduleRedraw();
      }
    }, [drawingMode, scheduleRedraw]);

    return (
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 100,
          // canvas 始终穿透，事件由父容器捕获（业界标准做法）
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
    );
  },
);

export default PainterLayer;
