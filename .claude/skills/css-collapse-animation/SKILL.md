---
description: CSS 折叠展开动画方案选型指南。当需要为折叠/手风琴组件实现高度过渡动画时激活。覆盖 max-height 方案的卡顿根因、JS scrollHeight 方案的边界 bug、以及 grid-template-rows 纯 CSS 方案的正确实现（双层 DOM 结构、padding 同步处理）。
paths:
  - "src/components/**/*.module.scss"
  - "src/pages/**/*.module.scss"
---

# CSS 折叠展开动画

## 方案对比

| 方案 | 问题 |
|------|------|
| `max-height: 999px → 0` | **卡顿**：过渡范围是 `0~999px`，内容实际高度只有一小段，动画时间大量浪费在空白区间 |
| JS 读取 `scrollHeight` | 需双帧 `rAF` + `transitionend` 清理，`auto → 精确值 → 0` 两步处理，实现复杂易出边界 bug |
| `grid-template-rows: 1fr → 0fr` ✅ | 浏览器自动感知 `1fr` 真实行高，过渡范围精确，纯 CSS，无需 JS |

---

## 正确实现：`grid-template-rows`

### DOM 结构（必须双层）

```tsx
{/* 外层：grid 容器，负责行高过渡 */}
<div className={`${styles.body} ${!open ? styles.bodyClosed : ''}`}>
  {/* 内层：overflow: hidden 裁剪 + padding 声明 */}
  <div className={styles.bodyInner}>
    {children}
  </div>
</div>
```

### SCSS

```scss
.body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.25s ease;
}

.bodyClosed {
  grid-template-rows: 0fr;

  // 收起态同步消除 padding，否则 padding 区域仍然占高
  .bodyInner {
    padding-top: 0;
    padding-bottom: 0;
  }
}

.bodyInner {
  overflow: hidden;               // 必须：grid 行高归 0 时裁剪内容
  padding: 0 12px 12px;
  transition: padding 0.25s ease; // 与 grid 过渡同步，防止 padding 残留空隙
}
```

### 为什么必须双层 DOM

`grid-template-rows: 0fr` 只压缩 grid 行高，不处理子元素的 `padding`。`padding` 不属于内容溢出，不受 `overflow: hidden` 裁剪，收起后会残留空隙。需要内层元素单独同步过渡 `padding → 0`。

---

## 兼容性

Chrome 107+、Firefox 116+、Safari 16+（2022–2023 年落地），不支持 IE。
