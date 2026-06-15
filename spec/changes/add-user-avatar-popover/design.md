# 用户头像 + 信息卡片 技术设计

## 1. 功能概述

将 TopBar 右侧的昵称文字 + 退出按钮，替换为圆形头像入口。鼠标悬浮头像时弹出用户信息卡片，展示头像、nickname、uid 及退出登录入口，为后续用户设置（改名、改密码）预留扩展位。

## 2. 涉及模块

- `src/pages/Dashboard/TopBar.tsx`
- `src/pages/Dashboard/TopBar.module.scss`

## 3. 页面设计

### TopBar（迭代）

#### 功能描述

右侧区域由「昵称文字 + 退出按钮」替换为：
- 圆形头像（`antd Avatar`），背景色由 nickname 哈希决定，内容为 nickname 首字母大写
- hover 头像时，`antd Popover` 弹出用户信息卡片

#### 交互流程

- When 用户将鼠标悬浮在头像上，the system shall 展示用户信息卡片（placement: bottomRight）
- When 用户将鼠标移开头像及卡片区域，the system shall 收起卡片
- When 用户点击卡片内「退出登录」文字，the system shall 调用 logout() 并跳转 /auth

#### 卡片内容结构

```
┌─────────────────────────────┐
│  [Avatar]  nickname         │
│            ID: xxxxxxxx     │
├─────────────────────────────┤  ← antd Divider
│  退出登录                    │  ← 纯文本，cursor: pointer，hover 变红
└─────────────────────────────┘
```

#### 组件结构

```
TopBar
└── UserAvatar（内联，不单独拆文件，逻辑简单）
    ├── antd Popover
    │   ├── trigger: Avatar（antd）
    │   └── content: UserCard（inline JSX）
    │       ├── 头像区（Avatar + nickname + userId）
    │       ├── antd Divider
    │       └── 退出登录文字
    └── （后续可在 Divider 上方扩展菜单项）
```

#### 状态管理

- 无新增状态，数据全部来自 `useUser()` 的 `userInfo`（userId、nickname）
- logout 逻辑复用现有 `useUser().logout()`

## 4. 接口设计

无新增接口。

## 5. 类型定义

无新增类型。

## 6. 权限控制

无，所有已登录用户均可见。

## 7. 关键决策记录

| 项目 | 决策 | 理由 |
|------|------|------|
| 头像组件 | `antd Avatar` | 内置圆形 + 首字母，省去自写样式 |
| 弹出卡片 | `antd Popover` trigger="hover" | 原生防闪（头像→卡片间隙不消失）、边界检测，优于纯 CSS :hover |
| 分割线 | `antd Divider` | 一行代码，风格统一 |
| 退出登录 | 纯文本（非按钮） | 用户要求，点击触发 logout |
| 头像背景色 | nickname 首字母哈希映射固定色盘 | 同一用户颜色稳定，不随刷新变化 |
| 后续扩展 | Divider 上方预留菜单项位置 | 改名/改密码等二期功能插入此处 |
