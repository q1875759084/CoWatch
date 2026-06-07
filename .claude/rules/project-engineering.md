---
description: CarryHub 项目工程规范，包含 monorepo 模块边界、包引用规则、路由结构约定
paths:
  - "**/*.{js,ts,jsx,tsx}"
---
# CarryHub 项目工程规范

## Monorepo 模块边界

- 子包之间**禁止直接互相 import**
- 所有跨包共享内容只通过 `@carry/shared` 暴露
- `shared` 包通过 `workspace:*` 引用，不发布到 npm
- 接口定义只放在本子包的 `api/` 目录下，不跨包引用

## 包结构约定

```
packages/
  main/        # 主应用：登录、导航壳、权限初始化，不放任何业务页面
  lol/         # 子包：英雄联盟代练广场
  opportunity/ # 子包：找商机
  tenant-admin/# 子包：租户管理
  shared/      # 公共库：组件、hooks、utils、store、types、constants、mocks
```

## shared 包对外暴露内容

| 路径 | 内容 |
|------|------|
| `@carry/shared/components` | 通用 UI 组件 |
| `@carry/shared/hooks` | usePermission、usePagination 等 |
| `@carry/shared/utils/bizAxios` | 请求基建（禁止绕过直接用 axios） |
| `@carry/shared/store/authStore` | 全局权限/用户状态（Zustand） |
| `@carry/shared/types` | 公共 TS 类型（UserInfo、ApiResponse、CategoryNode 等） |
| `@carry/shared/constants` | 权限码常量、枚举 |

## 子包目录规范

```
<package>/src/
  pages/
    List/
      index.tsx           # 列表页
      components/         # 列表页私有组件（不向外暴露）
    Detail/
      index.tsx
      components/
  hooks/                  # 子包级 hooks
  api/                    # 接口定义（只包含本子包的接口）
  router/
    index.tsx             # 子包路由配置（懒加载导出）
```

## 路由约定

- 路由级别使用 `React.lazy` 懒加载，首屏只加载主应用
- 页签以 `pathname` 为唯一 key，上限 20 个
- 面包屑按路由所属模块计算，与来源页无关

## MSW Mock 规范

- Mock handlers 只放在 `shared/src/mocks/` 下
- **严禁**在业务代码中写入 mock 数据，只有用户明确要求时才可添加
- 仅在开发环境初始化 MSW，删除启动代码即可切换真实接口，业务代码零改动
