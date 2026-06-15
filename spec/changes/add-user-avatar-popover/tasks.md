# 用户头像 + 信息卡片 实现任务

## 任务清单

### Dashboard / TopBar

#### 1. TopBar.tsx
- [x] 移除现有昵称文字 + 退出按钮
- [x] 实现 `avatarColor(nickname)` 工具函数：nickname 首字母哈希映射固定色盘，返回背景色
- [x] 用 `antd Popover`（trigger="hover", placement="bottomRight"）包裹 `antd Avatar`
- [x] 实现卡片内容（inline JSX）：
  - 上区：`Avatar` + nickname + `ID: {userId}`
  - `antd Divider`
  - 下区：「退出登录」文字，点击调用 `logout()` 并跳转 `/auth`

#### 2. TopBar.module.scss
- [x] 移除 `.nickname`、`.logoutBtn` 样式
- [x] 新增 `.avatarBtn`：重置 button 样式，cursor: pointer
- [x] 新增 `.popoverCard`：卡片宽度、内边距
- [x] 新增 `.cardHeader`：头像 + 文字并排布局
- [x] 新增 `.cardNickname`、`.cardUid`：文字样式
- [x] 新增 `.logoutText`：默认色 #8b949e，hover 变 #f85149，cursor: pointer

#### 3. antd Popover 深色主题适配
- [x] 通过 `overlayClassName` + SCSS `:global()` 覆写 Popover 背景色为深色（`#1c2128`），边框、箭头同步

---
完成所有任务后将 `- [ ]` 改为 `- [x]`
