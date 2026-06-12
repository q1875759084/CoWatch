---
name: painter-layer
description: CoWatch 鼠标共享与协同绘制实现指南。覆盖方案选型（Canvas 蒙层 vs DOM img）、DPR 适配、事件架构（pointer-events:none + 父容器捕获阶段拦截）、绘制模式下阻止视频播放/暂停的完整方案。当需要实现鼠标共享、协同绘制、PainterLayer 相关改动，或排查光标偏移/视频被意外触发等问题时激活。
---

# PainterLayer：鼠标共享与协同绘制

## ⚠️ 方案选型：必须用 Canvas，不要用 DOM img

| 方案 | 问题 |
|------|------|
| DOM `<img>` / `<div>` 跟随鼠标 | 频繁移动时触发大量 style/layout 计算，帧率抖动；多光标叠加时每个都是独立 DOM 节点；无法支持笔迹绘制 |
| **Canvas 蒙层** ✅ | 单 canvas 一次 `clearRect` + 重绘所有光标，GPU 合成，帧率稳定；天然支持笔迹渲染；坐标换算统一 |

**结论：鼠标共享与绘制功能统一交给一个 Canvas 组件（`PainterLayer`）管理。**

---

## 架构核心：事件在父容器，Canvas 永远穿透

```
.playerRatio（父容器，所有事件监听在此）
  └── <canvas>（position:absolute, pointer-events:none）  ← 永远穿透
  └── <video controls>（底层，正常接收事件）
```

**关键规则：**
- `canvas` 始终设 `pointer-events: none`，不监听任何鼠标事件
- 所有事件（`mousemove` / `mousedown` / `mouseup` / `click`）绑定在**父容器**上
- `mouseup` 额外绑在 `window` 上，防止拖出区域后松鼠标无法触发

这是 Figma / Excalidraw 的标准做法。

---

## DPR 适配（HiDPI 必须处理，否则光标虚化偏大）

```ts
const dpr = window.devicePixelRatio || 1;
const w = parent.clientWidth;
const h = parent.clientHeight;

// ✅ 物理像素：绘图缓冲区用物理像素
canvas.width  = Math.round(w * dpr);
canvas.height = Math.round(h * dpr);

// ✅ CSS 尺寸：必须等于逻辑像素，否则内容被拉伸放大 dpr 倍
canvas.style.width  = `${w}px`;
canvas.style.height = `${h}px`;
```

绘制时统一在逻辑像素空间操作：

```ts
ctx.save();
ctx.scale(dpr, dpr);  // ← 缩放后，所有坐标直接用 CSS px，无需手动 × dpr
// ... 绘制光标、笔迹 ...
ctx.restore();
```

用 `ResizeObserver` 监听父容器，容器变化时更新 canvas 尺寸并立即重绘。

---

## 坐标系：百分比（0~1），跨分辨率一致

所有坐标存储为相对 `.playerRatio` 容器的百分比，不存 CSS px 或物理像素：

```ts
// clientX → 0~1 百分比
const rect = canvas.getBoundingClientRect();
const x = (clientX - rect.left) / rect.width;
const y = (clientY - rect.top)  / rect.height;

// 绘制时还原为逻辑 px
ctx.moveTo(x * logicalWidth, y * logicalHeight);
```

这样跨不同窗口尺寸/分辨率的客户端，光标和笔迹位置完全一致。

---

## 绘制模式：阻止 `<video>` 被意外触发

**问题根因：** 绘制时 `mousedown` 在父容器发生，但事件冒泡阶段 `<video>` 也能收到，`mousedown + mouseup` 被浏览器合成为 `click`，触发视频播放/暂停。

**解决：两道捕获阶段拦截，均使用 `{ capture: true }`**

```ts
// ① mousedown 捕获阶段（早于 <video> 接收）
const handleMouseDown = (e: MouseEvent) => {
  if (!drawingMode || e.button !== 0) return;
  e.preventDefault();    // 阻止文字选中、拖拽等默认行为
  e.stopPropagation();   // 阻止事件继续传递到 <video>
  // 开始记录笔迹...
};
parent.addEventListener('mousedown', handleMouseDown, { capture: true });

// ② click 捕获阶段（兜底，防止其他路径生成的 click）
const handleClick = (e: MouseEvent) => {
  if (!drawingMode) return;
  e.preventDefault();
  e.stopPropagation();
};
parent.addEventListener('click', handleClick, { capture: true });
```

两道拦截均只在 `drawingMode=true` 时生效，关闭绘制模式后视频控件恢复正常。

---

## `cursor: none` 的两个坑

### 坑 1：子元素 `cursor: pointer` 会覆盖父元素 `cursor: none`

直接 `parent.style.cursor = 'none'` 无效——子元素（`button`、`input`）自身的 `cursor: pointer` 优先级更高。

**解决：CSS class + `& *` + `!important`**

```scss
.cursorHidden {
  &, & * { cursor: none !important; }
}
.cursorCrosshair {
  &, & * { cursor: crosshair !important; }
}
```

通过 `classList.add/remove` 切换，不要直接操作 `style.cursor`。

### 坑 2：`<video controls>` Shadow DOM 无视外部 CSS

`<video controls>` 的控制栏在 Shadow DOM 内，任何外部 CSS（含 `!important`）无法穿透。

**解决：给 `<video>` 设 `pointer-events: none`**

```tsx
// 非主控时 cursorLocked=true，视频控件不接收鼠标事件，浏览器不显示系统光标
<video style={{ pointerEvents: cursorLocked ? 'none' : 'auto' }} />
```

注意：主控不能设 `pointer-events:none`，否则无法操作播放/进度条。  
条件：`cursorEnabled && !isController`。

---

## 性能：不走 React state，直接操作 ref + rAF

光标位置频繁更新（每帧 mousemove），走 React state 会导致大量 re-render：

```ts
// ❌ 不要
const [cursors, setCursors] = useState(new Map());

// ✅ 正确：直接操作 ref，手动触发 canvas 重绘
cursorsRef.current.set(userId, { ...cursor });
painterRef.current?.redraw(); // scheduleRedraw → requestAnimationFrame(draw)
```

`scheduleRedraw` 用 rAF 去重（如果已有待执行的帧则跳过），避免同一帧内多次绘制。

---

## WS 消息类型

| 方向 | 类型 | 数据 | 说明 |
|------|------|------|------|
| 上行/下行 | `CURSOR_MOVE` | `{ x, y, styleId }` | 鼠标移动（节流 50ms） |
| 上行/下行 | `CURSOR_HIDE` | `{}` | 鼠标离开视频区 |
| 上行/下行 | `DRAW_STROKE` | `{ color, points: [{x,y}] }` | 完成一笔（mouseup 后发送） |
| 上行/下行 | `DRAW_CLEAR` | `{}` | 清空画布 |

后端直接 `broadcastExcept` 转发，不做状态持久化。

---

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/pages/Lobby/PainterLayer.tsx` | Canvas 蒙层：光标渲染、笔迹绘制、事件监听 |
| `src/pages/Lobby/index.tsx` | 状态管理：`cursorsRef`、`drawColor`、WS 回调连接 |
| `src/pages/Lobby/ControlPanel.tsx` | UI：鼠标共享开关、样式选择、绘制模式开关、颜色选择 |
| `src/types/room.ts` | WS 消息类型定义（`DrawStrokeData`、`DrawClearData`） |
| `src/hooks/useRoomWs.ts` | WS 消息分发，`onDrawStroke` / `onDrawClear` 回调 |
