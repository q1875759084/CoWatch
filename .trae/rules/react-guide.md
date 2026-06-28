---
description: React 代码生成指南，涵盖组件写法、状态管理、Hooks 规范、表单、性能优化等
globs: "**/*.{jsx,tsx}"
alwaysApply: false
---

# React 代码生成指南

React 代码生成应遵循以下规范。

## 组件写法

- 函数组件 + Hooks，**禁止 Class 组件**
- Props 用 `interface` 定义，不用 `type`（便于扩展）
- **禁止在渲染函数内定义子组件**：每次渲染都会创建新组件引用，导致子组件完全 unmount/remount、状态丢失。子组件必须定义在父组件函数体外部，需要传值时通过 props 传递

## 状态管理

- Context 避免用于频繁更新的数据以避免全局状态污染
- 局部状态共享（弹窗内部、表单组件树）用 Context + Provider
- 全局状态（登录态、权限、页签）用 Zustand，从 `@carry/shared` 引入

## Hooks 使用规范

- 用 `useMemoizedFn`（ahooks）替代 `useCallback`，避免依赖数组遗漏问题
- 用 `useRequest`（ahooks）替代手写 `useEffect` 请求逻辑
- `useEffect` 避免将导航对象直接放入依赖数组
- 不可以通过 `||` 或者 `??` 来设置非基本类型（对象、数组、函数）的默认值

## 列表渲染

- 列表渲染的 `key` 必须使用**唯一业务 ID**（如 `item.id`），**禁止使用数组 index**
- 例外：纯展示、不重排、不增删的完全静态列表可以使用 index

## 表单

- 3 个及以上字段的表单**统一使用 Ant Design `Form`**，通过 `Form.Item + name` 绑定字段和校验规则
- **禁止**手写多个 `useState + onChange` 的受控表单（字段少于 3 个的简单场景除外）

## 性能优化

- 路由级别 `React.lazy` 懒加载，首屏只加载主应用
- 重计算逻辑用 `useMemo`，回调用 `useMemoizedFn`
- 列表页数据量大时使用虚拟滚动
- `React.memo` 只用于：接受对象/数组 props 且父组件频繁重渲染的**纯展示组件**；含 `useContext` 的组件、简单叶子节点不需要 memo

## 渲染规范

- 避免直接使用 `&&` 运算符进行组件条件渲染，优先使用三目运算符 `? :` 或 `!!` 进行条件判断