# CarryHub — Claude Code 配置

> 每次对话自动加载。包含项目背景、关键约定，以及各规范文件的引用。

## 项目背景

**游戏代练 SaaS 平台**，帮助玩家快速找到合适的代练者完成游戏目标。

### 用户类型

| 租户类型 | 说明 |
|---------|------|
| `buyer` | 采购方，发起招标 |
| `personal_enterprise` | 个人企业，参与投标 |
| `org_enterprise` | 组织企业，需通过资质认证审核激活，拥有更多权限 |

每个租户下有子账号，角色分 `admin`（管理员）和 `member`（普通成员）。

### 核心功能模块

| 子包 | 路由前缀 | 功能 |
|------|---------|------|
| `coach` | `/coach` | 代练广场：搜索/查看代练者信息 |
| `lol` | `/lol` | 英雄联盟代练广场，含级联分类筛选 |
| `opportunity` | `/opportunity` | 找商机：商机推荐与管理 |
| `tenant-admin` | `/tenant-admin` | 租户管理：子账号、套餐、权限配置 |
| `main` | `/login` `/dashboard` | 主应用壳：登录、导航、权限初始化 |

### 技术栈

- **框架**：React 19 + TypeScript strict
- **状态**：Zustand（全局）/ Context（局部）
- **请求**：bizAxios（自研封装，双 Token + 重试）
- **UI**：Ant Design 5.x，主题色 `#1677ff`
- **样式**：CSS Modules + Sass
- **路由**：React Router v6，应用内页签（react-activation KeepAlive）
- **仓库**：pnpm monorepo + Turborepo，共享库 `@carry/shared`
- **Mock**：MSW，开发环境拦截请求

## 关键约定（每次生成代码必须遵守）

- 子包间禁止直接互相 import，跨包内容只通过 `@carry/shared` 暴露
- 请求必须走 `bizAxios`，禁止直接用 `axios`
- 权限判断用 `usePermission` hook 或 `PermissionRoute` 组件
- 403 错误由 bizAxios 拦截器统一跳页，**不要在业务层再弹 toast**

## 编码规范

详细规范见以下 Rules 文件（自动按文件类型加载）：

@.claude/rules/project-engineering.md
@.claude/rules/js-guide.md
@.claude/rules/react-guide.md
