import {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from 'react';
import styles from './index.module.scss';
import { useMemoizedFn } from 'ahooks';
import { throttle } from '@/utils/throttle';
import { getCursorStyle } from './cursorStyles';

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface CursorState {
  userId: string;
  nickname: string;
  /** 0~1，相对 .playerRatio 容器宽度的百分比 */
  x: number;
  /** 0~1，相对 .playerRatio 容器高度的百分比 */
  y: number;
  styleId: string;
  /** 0~1，淡出动画用 */
  opacity: number;
}

export interface PainterLayerHandle {
  /** 通知 canvas 重绘（外部 cursor 数据变化时调用） */
  redraw: () => void;
  /** 获取父容器 DOM 节点（供外部绑定 mousemove 事件） */
  getContainer: () => HTMLElement | null;
}

interface PainterLayerProps {
  /** 是否开启鼠标共享（关闭时 canvas 完全透明，不渲染任何内容） */
  enabled: boolean;
  /**
   * 是否处于绘制模式。
   *
   * - false（默认）：canvas pointer-events:none，事件穿透到下层（视频播放器可正常操作）
   *                   鼠标坐标由父组件通过 container 的 mousemove 事件追踪
   * - true：canvas pointer-events:auto，阻断所有事件，用于绘制交互
   */
  drawingMode: boolean;
  /** 当前用户选择的光标样式 ID */
  styleId: string;
  /** 当前用户昵称（用于渲染自己的 label） */
  nickname: string;
  /** 当前用户 ID */
  userId: string;
  /** 所有需渲染的光标（含自己，由父组件维护） */
  cursors: Map<string, CursorState>;
  /** 鼠标在容器内移动时回调，x/y 为 0~1 百分比坐标 */
  onCursorMove: (x: number, y: number) => void;
  /** 鼠标离开容器时回调 */
  onCursorLeave: () => void;
  /** 鼠标进入容器时回调 */
  onCursorEnter: () => void;
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

// ─── 组件 ─────────────────────────────────────────────────────────────────────

/**
 * PainterLayer — canvas 蒙层
 *
 * 职责：
 *   1. 锚定在 .playerRatio 容器（position: absolute, top/left: 0），随其宽高自适应
 *   2. 用 ResizeObserver 监听父容器尺寸变化，实时更新 canvas 物理像素 + CSS 尺寸
 *   3. 渲染所有成员的光标图标 + 昵称 label（含自己）
 *   4. canvas 始终 pointer-events:none，事件穿透到下层（视频播放器可正常操作）
 *      绘制模式下由父组件在容器上设置 cursor 样式
 *   5. 鼠标坐标追踪通过 getContainer() 暴露父容器节点，由外部（index.tsx）
 *      在父容器上绑定 mousemove/enter/leave，不依赖 canvas 自身事件
 *
 * 坐标系：相对 .playerRatio 容器的百分比（0~1），跨分辨率/窗口尺寸一致。
 */
const PainterLayer = forwardRef<PainterLayerHandle, PainterLayerProps>(
  function PainterLayer(
    { enabled, drawingMode, cursors, onCursorMove, onCursorLeave, onCursorEnter },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    /** 记录上一次绘制请求的 rAF id，用于去重 */
    const rafRef = useRef<number | null>(null);
    /** 当前 canvas 的逻辑宽高（CSS px），供坐标换算使用 */
    const sizeRef = useRef({ w: 0, h: 0 });

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

      if (!enabled) return;

      // 缩放到逻辑像素空间：之后所有坐标/尺寸直接用 CSS px 值，无需手动 × dpr
      ctx.save();
      ctx.scale(dpr, dpr);

      cursors.forEach((cursor) => {
        if (cursor.opacity <= 0) return;

        // 逻辑像素坐标（百分比 × 容器逻辑宽高）
        const px = cursor.x * w;
        const py = cursor.y * h;

        ctx.globalAlpha = cursor.opacity;

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
        ctx.font = `${LABEL_FONT}`;
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

        ctx.globalAlpha = 1;
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
      getContainer: () => canvasRef.current?.parentElement ?? null,
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

    // ── cursors / enabled 数据变化时触发重绘 ─────────────────────────────────

    useEffect(() => {
      scheduleRedraw();
    }, [cursors, enabled, scheduleRedraw]);

    // ── 父容器事件监听（mousemove/enter/leave）────────────────────────────────
    //
    // 业界通用方案（Figma/Excalidraw）：
    //   坐标追踪绑定在父容器上，不依赖 canvas 自身的 pointer-events。
    //   这样 canvas 可以始终保持 pointer-events:none，事件穿透到下层视频播放器，
    //   同时坐标也能被正确追踪。
    //   绘制模式下由父容器的 cursor 样式表达（crosshair），canvas 依然穿透。

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

    const handleMouseMove = useMemoizedFn((e: MouseEvent) => {
      throttledMove(e.clientX, e.clientY, onCursorMove);
    });

    const handleMouseEnter = useMemoizedFn(() => {
      onCursorEnter();
    });

    const handleMouseLeave = useMemoizedFn(() => {
      onCursorLeave();
    });

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      if (!enabled) return;

      parent.addEventListener('mousemove', handleMouseMove);
      parent.addEventListener('mouseenter', handleMouseEnter);
      parent.addEventListener('mouseleave', handleMouseLeave);

      return () => {
        parent.removeEventListener('mousemove', handleMouseMove);
        parent.removeEventListener('mouseenter', handleMouseEnter);
        parent.removeEventListener('mouseleave', handleMouseLeave);
      };
    }, [enabled, handleMouseMove, handleMouseEnter, handleMouseLeave]);

    // ── 父容器 cursor 样式（绘制模式 crosshair，普通模式 none）──────────────

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      // 用 CSS class 覆盖子元素（button/input 等）自带的 cursor:pointer，
      // 直接写 style.cursor 只影响父元素自身，无法压制子元素声明。
      parent.classList.remove(styles.cursorHidden, styles.cursorCrosshair);

      if (enabled) {
        if (drawingMode) {
          parent.classList.add(styles.cursorCrosshair);
        } else {
          parent.classList.add(styles.cursorHidden);
        }
      }

      return () => {
        parent.classList.remove(styles.cursorHidden, styles.cursorCrosshair);
      };
    }, [enabled, drawingMode]);

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
