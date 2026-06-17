# 鼠标控制逻辑重构 实现任务

## 任务清单

### VideoPlayer.tsx

#### 1. 删除 cursorLocked prop
- [x] 删除 `VideoPlayerProps` 接口中的 `cursorLocked?: boolean` 及其 JSDoc 注释
- [x] 删除函数参数解构中的 `cursorLocked`
- [x] 将 `pointerEvents: (disabled || cursorLocked) ? 'none' : 'auto'` 简化为 `pointerEvents: disabled ? 'none' : 'auto'`

---

### index.tsx

#### 2. 重构 disabled 条件
- [x] 将 `disabled={!isController && followMode}` 改为 `disabled={(!isController && followMode) || (isController && drawingMode)}`

#### 3. 删除 cursorLocked prop 传递
- [x] 删除 `<VideoPlayer>` 上的 `cursorLocked={cursorEnabled && !isController}` 这一行

#### 4. handleFollowModeToggle 补充自由模式重置
- [x] 切到自由模式（`next = false`）时，重置 `cursorEnabled`、`cursorStyleActive`、`selectedStyleId`、`drawingMode`
- [x] 同时删除自己的光标 Map 条目并触发重绘

---

### ControlPanel.tsx

#### 5. 新增 mouseFeatureDisabled prop
- [x] 在 `ControlPanelProps` 接口中新增 `mouseFeatureDisabled: boolean`
- [x] 在函数参数解构中加入 `mouseFeatureDisabled`

#### 6. 鼠标功能区所有可交互元素加 disabled
- [x] 光标样式选择器：每个 `<button>` 加 `disabled={mouseFeatureDisabled}`
- [x] 鼠标共享 `<Switch>` 加 `disabled={mouseFeatureDisabled}`
- [x] 绘制模式 `<Switch>` 加 `disabled={mouseFeatureDisabled}`
- [x] 颜色选择器：每个 `<button>` 加 `disabled={mouseFeatureDisabled}`
- [x] 清除此色 `<button>` 加 `disabled={mouseFeatureDisabled}`
- [x] 清空画布 `<button>` 加 `disabled={mouseFeatureDisabled}`

#### 7. index.tsx 传入新 prop
- [x] 在 `<ControlPanel>` 调用处新增 `mouseFeatureDisabled={!isController && !followMode}`

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
