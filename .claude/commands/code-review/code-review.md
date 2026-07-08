---
name: /code-review
description: 对指定文件或目录执行 CoWatch 项目规范的后置代码质量审查。先做 Skill 诊断按需加载专业规范，再执行通用规范检查，输出分级问题报告和重构建议。
argument-hint: 可选，指定文件路径或目录（不填则审查本次对话中涉及的文件）
---

# CoWatch 代码质量审查

## 第一步：确定审查范围

**优先级（按顺序判断）：**
1. 用户通过 `$ARGUMENTS` 指定了路径 → 审查该路径下所有 `.ts/.tsx` 文件
2. 当前对话有生成/修改记录 → 审查本次涉及的文件
3. 两者都无 → 询问用户要审查哪些文件

确定范围后，列出待审查文件清单，告知用户共 N 个文件。

---

## 第二步：Skill 诊断（按需加载专业规范）

**扫描所有待审查文件，识别以下代码模式，按需读取对应 Skill 文件：**

| 检测到的代码模式 | 激活 Skill | 读取路径 |
|----------------|-----------|---------|
| 使用 `PainterLayer` / `canvas` / `mousemove` / `CURSOR_MOVE` / `DRAW_STROKE` 相关绘制或鼠标共享逻辑 | painter-layer | `.catpaw/skills/painter-layer/SKILL.md` |
| 使用 `RoomContext` / `setRoomState` / `initRoom` / `useRoomWs` / Context 多异步数据源写入 | react-context-async-init | `.catpaw/skills/react-context-async-init/SKILL.md` |
| 使用 `ServiceWorker` / `CacheStorage` / `Range` 请求 / HLS 视频缓存 | video-sw-cache | `.catpaw/skills/video-sw-cache/SKILL.md` |
| 多维布尔状态组合（≥3个布尔维度的 if-else 组合判断） | ⚠️ 标记为位掩码重构候选 | 在报告中说明 |
| 超长条件分支链（单文件 if/else/case > 5 个） | ⚠️ 标记为 Map/策略模式重构候选 | 在报告中说明 |

**激活规则：**
- 检测到对应模式 → 立即读取该 Skill 文件，将其规范作为该文件的专项审查标准
- 未检测到 → 不加载，避免无关 Skill 污染审查上下文
- 同一文件可同时激活多个 Skill

诊断完成后，告知用户本次激活了哪些 Skill，然后进入逐文件审查。

---

## 第三步：逐文件审查

对每个文件，按以下顺序检查，**发现问题记录，所有文件审查完后统一输出报告**。

### A. 结构规模

| 检查项 | 阈值 | 级别 |
|--------|------|------|
| 组件文件行数 | > 300 行 | 🔴 必须处理 |
| hooks/utils 文件行数 | > 150 行 | 🟡 建议处理 |
| 函数入参数量 | > 4 个 | 🟡 建议处理 |
| 单函数行数 | > 80 行 | 🟡 建议处理 |

### B. 条件逻辑复杂度

| 检查项 | 阈值 | 级别 |
|--------|------|------|
| 单文件 if/else/case 分支总数 | > 5 个 | 🔴 必须处理 |
| if 嵌套层数 | > 2 层 | 🟡 建议处理 |
| 多维二元状态组合（≥3维） | 存在即标记 | 🔴 必须处理 |

多维状态检测模式：
```ts
if (isA && isB) { ... }
else if (isA && !isB) { ... }
else if (!isA && isB) { ... }
```

### C. React 规范

| 检查项 | 级别 |
|--------|------|
| 手写 `useEffect` 发起网络请求（应改用 `useRequest`） | 🔴 必须处理 |
| `&&` 条件渲染（应改用三目或 `!!`） | 🟡 建议处理 |
| 非基本类型用 `\|\|` / `??` 设置默认值 | 🔴 必须处理 |
| Class 组件 | 🔴 必须处理 |
| Props 用 `type` 定义（应改用 `interface`） | 🟡 建议处理 |
| `useCallback` 未用 `useMemoizedFn` 替代 | 🟡 建议处理 |

### D. TypeScript 规范

| 检查项 | 级别 |
|--------|------|
| 使用 `any`（无注释说明原因） | 🔴 必须处理 |
| 使用 `@ts-ignore` | 🔴 必须处理 |
| 公共类型未在 `types/` 目录定义 | 🟡 建议处理 |
| 类型转换无默认值（如 `Number(x)` 未加 `\|\| 0`） | 🟡 建议处理 |

### E. 依赖与架构规范

| 检查项 | 级别 |
|--------|------|
| 组件内直接写请求逻辑（应封装到 `api/` 目录） | 🟡 建议处理 |
| 常量未在 `constants/` 维护（魔法数字/字符串） | 🟡 建议处理 |
| Mock 数据硬编码在业务代码中 | 🔴 必须处理 |
| Context state 直接整体替换（未使用函数式更新） | 🔴 必须处理 |
| Canvas 事件未绑定在父容器而绑在 canvas 本身 | 🔴 必须处理 |
| 光标位置用 React state 驱动（应改用 ref + rAF） | 🔴 必须处理 |

### F. 错误处理

| 检查项 | 级别 |
|--------|------|
| 异步操作无 `try/catch`（静默失败） | 🔴 必须处理 |
| 错误未展示给用户 | 🟡 建议处理 |

### G. Skill 专项审查（仅对激活了对应 Skill 的文件执行）

- **painter-layer 已激活**：对文件中的 Canvas / 鼠标共享 / 协同绘制相关代码，按 Skill 规范逐条核查（Canvas vs DOM 方案、DPR 适配、pointer-events 架构、绘制模式阻止视频触发、性能规范）
- **react-context-async-init 已激活**：对文件中的 Context 初始化 / 多异步写入相关代码，按 Skill 规范逐条核查（函数式更新、字段归属、pending 机制、类型约束）
- **video-sw-cache 已激活**：对文件中的 Service Worker / 视频缓存相关代码，按 Skill 规范逐条核查（Cache API 限制、Range 请求处理、缓存 key 规范）

---

## 第四步：输出报告

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 CoWatch 代码质量审查报告
审查文件：N 个 | 激活 Skill：painter-layer, react-context-async-init
发现问题：🔴 X 个 | 🟡 Y 个
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【src/pages/Lobby/PainterLayer.tsx】
🔴 [painter-layer] canvas 事件直接绑在 canvas 元素（应绑在父容器）（第 23 行）
   → parent.addEventListener('mousemove', handler) 替代 canvas.addEventListener(...)
🟡 [painter-layer] DPR 未适配，canvas.width 直接赋 clientWidth（第 12 行）
   → canvas.width = Math.round(clientWidth * devicePixelRatio)

【src/context/RoomContext.tsx】
🔴 [react-context-async-init] initRoom 直接整体替换 state（第 45 行）
   → 改为函数式更新：setRoomState(prev => ({ ...prev, ...payload }))
🟡 [通用] 行数 287 行（接近 300 行上限）

【src/hooks/useRoomWs.ts】
🔴 [通用] 手写 useEffect 发起请求（第 23 行）
   → 替换为 useRequest：useRequest(fetchRoomInfo, { refreshDeps: [roomId] })
🔴 [通用] 多维状态组合（第 56-78 行，3维×8种组合）
   → 建议使用 Map 或位掩码方案重构

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 必须处理（4项）
🟡 建议处理（2项）

是否立即处理 🔴 问题？[Y 开始逐个修复 / N 仅记录]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 第五步：修复阶段

用户确认处理后，**按文件逐个修复**，修复完成后对该文件重新执行对应检查项，确认无遗留问题。

🟡 问题由用户决定是否处理，不强制介入。
