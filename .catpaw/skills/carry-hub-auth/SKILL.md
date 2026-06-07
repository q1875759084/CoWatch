---
name: carry-hub-auth
description: CarryHub 项目权限校验规范。当需要实现路由守卫、菜单过滤、按钮级权限控制、读取用户信息/租户类型、使用 usePermission/useAuthStore/PermissionRoute 时激活。
---
# CarryHub 权限校验规范

## 权限模型

```
租户类型（tenantType）：buyer | personal_enterprise | org_enterprise
  └── 绑定一组功能权限码（后端计算返回）

用户角色（role）：admin | member
  └── 在租户允许范围内进一步细分
```

## 读取权限状态

```ts
// 从 shared 引入 Zustand store，无需 Provider，任意位置可用
import { useAuthStore } from '@carry/shared/store/authStore';

const { userInfo, permissions } = useAuthStore();
// userInfo.tenantType: 'buyer' | 'personal_enterprise' | 'org_enterprise'
// userInfo.role: 'admin' | 'member'
// permissions: string[]  后端计算好的权限码列表
```

## 权限码常量

```ts
import { PERMISSIONS } from '@carry/shared/constants/permissions';

// PERMISSIONS.COACH_VIEW      = 'coach:view'
// PERMISSIONS.LOL_VIEW         = 'lol:view'
// PERMISSIONS.LOL_CONTACT      = 'lol:contact'
// PERMISSIONS.OPPORTUNITY_VIEW = 'opportunity:view'
// PERMISSIONS.TENANT_ADMIN     = 'tenant:admin'
```

## 三层权限控制

### 1. 路由守卫（拦截无权限页面）

```tsx
// 使用 shared 提供的 PermissionRoute 组件
function PermissionRoute({ permission, children }) {
  const { permissions } = useAuthStore();
  if (permission && !permissions.includes(permission)) {
    return <Navigate to="/403" replace />;
  }
  return children;
}

// 路由配置中
<PermissionRoute permission={PERMISSIONS.ENTERPRISE_VIEW}>
  <EnterpriseList />
</PermissionRoute>
```

### 2. 导航菜单过滤（不展示无权限入口）

```tsx
const { permissions } = useAuthStore();
const visibleMenus = ALL_MENUS.filter(m => permissions.includes(m.permission));
```

### 3. 页面内按钮（细粒度控制）

```tsx
// 使用 shared 提供的 usePermission hook
import { usePermission } from '@carry/shared/hooks/usePermission';

const { hasPermission } = usePermission();

// 有权限才渲染按钮
{hasPermission(PERMISSIONS.LOL_CONTACT) && <Button>立即联系</Button>}
```

## Dashboard 按租户类型分流

```tsx
const { userInfo } = useAuthStore();

// tenantType 决定展示哪个 Dashboard
{userInfo.tenantType === 'buyer'
  ? <BuyerDashboard />
  : <EnterpriseDashboard orgType={userInfo.tenantType === 'org_enterprise' ? 'org' : 'personal'} />
}
```

## 注意事项

- 组织企业需通过企业资质认证审核后才激活 `org_enterprise` 身份，未激活时视作 `personal_enterprise`
- `useAuthStore` 是 Zustand store，**不需要 Provider**，跨包直接 import 使用
- 权限码由后端在登录响应中计算返回，前端只做比对，不做计算
