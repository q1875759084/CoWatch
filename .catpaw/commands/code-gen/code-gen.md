---
name: /code-gen
description: 结构化代码生成。强制需求拆解为单文件粒度任务，逐步生成并在每个文件完成后做后置校验，避免单次生成粒度过大导致的规范污染和质量失控。
argument-hint: 可选，描述要实现的功能模块
---

# 结构化代码生成

## 核心原则

- **单次只生成一个文件**，生成后立即校验，有问题才暂停，通过则直接继续
- 生成前必须输出任务拆解计划，用户确认后才开始生成

---

## 阶段一：需求理解与任务拆解

接收用户需求：$ARGUMENTS

**前置扫描：**
- 检查相关目录和已有文件，避免重复创建
- 识别可复用的已有组件、hooks、utils

将需求拆解为**单文件粒度**的任务列表，按执行顺序排列：

```
📋 任务拆解计划（共 N 个文件）

[ ] 1. packages/enterprise/src/api/enterprise.ts
       内容：接口函数定义，ApiResponse<T> 类型约束

[ ] 2. packages/enterprise/src/types/enterprise.ts
       内容：Enterprise、ListParams 等 TS 类型定义

[ ] 3. packages/enterprise/src/pages/List/index.tsx
       内容：列表页主组件，useRequest 发起请求，筛选区 + 表格

[ ] 4. packages/enterprise/src/pages/List/components/FilterPanel.tsx
       内容：筛选区私有组件
```

**拆解约束（必须遵守）：**
- 存在 3 个以上状态变量时，评估是否需要抽离 useXxxState hook
- API 函数与组件文件必须分离，不允许在组件内直接写 axios 调用

**⚠️ 等待用户确认任务列表后，才开始生成第一个文件。**

---

## 阶段二：逐文件生成与即时校验

对每个任务，循环执行以下步骤：

### Step 1：生成单个文件

按任务描述生成文件内容，遵守已加载的 Rules（JS规范、React规范、项目工程规范）。

若涉及以下场景，**生成该文件前**先读取对应 Skill 文件，再开始生成：
- **网络请求** → 读取 `.catpaw/skills/carry-hub-request/SKILL.md`
- **权限控制** → 读取 `.catpaw/skills/carry-hub-auth/SKILL.md`

### Step 2：即时度量校验（每个文件生成后必须执行）

对该文件执行以下度量指标核查（生成时无法精确感知，必须回头数）：

- [ ] 文件行数：组件 ≤ 300 行 / hooks、utils ≤ 150 行
- [ ] 函数入参数量 ≤ 4 个
- [ ] 条件分支（if/else/case）总数 ≤ 5 个
- [ ] if 嵌套层数 ≤ 2 层
- [ ] 多维二元状态组合（≥3维）→ 建议使用 Map 或位掩码方案

**输出格式：**
```
✅ packages/enterprise/src/api/enterprise.ts（34行，分支2，无问题）

⚠️ packages/enterprise/src/pages/List/index.tsx
   行数 320 行 → 建议将筛选区拆为 FilterPanel 组件
   if-else 7 个分支 → 建议改用 STATUS_MAP 对象映射
   是否立即重构？[Y 重构后继续 / N 跳过记录]
```

**校验通过后直接继续下一个文件**；有 ⚠️ 问题时暂停，等用户确认后再继续。

标记当前任务 `[x]`，告知进度（已完成 M/N）。

---

## 阶段三：完成报告

所有文件生成完毕后，执行跨文件一致性检查并输出报告：

**跨文件检查：**
- [ ] TS 类型是否集中在 `types/` 目录，无散落重复定义
- [ ] 涉及新页面时，`router/index.tsx` 是否添加了懒加载路由
- [ ] 涉及新权限点时，`shared/constants/permissions.ts` 是否同步更新权限码常量
- [ ] Mock handler 是否在 `shared/src/mocks/` 中添加对应接口

```
✅ 代码生成完成

已生成文件（N个）：
  ✅ packages/enterprise/src/api/enterprise.ts（34行）
  ✅ packages/enterprise/src/types/enterprise.ts（28行）
  ✅ packages/enterprise/src/pages/List/index.tsx（187行）
  ✅ packages/enterprise/src/pages/List/components/FilterPanel.tsx（94行）

⚠️ 待处理事项：
  - List/index.tsx：STATUS_MAP 重构建议（已跳过，可后续用 /code-review 处理）

建议下一步：运行 /code-review 对本次生成的文件做完整质量审查
```
