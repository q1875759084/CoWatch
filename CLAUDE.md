# CoWatch

多人游戏录屏同步复盘平台。本项目采用**规格驱动开发（Spec-Driven Development）**流程，重大变更需先创建 proposal 再实施。

## 关键入口

| 内容 | 位置 |
|------|------|
| 项目背景、技术栈、关键约定 | `.claude/CLAUDE.md` |
| 编码规范（按文件类型自动加载） | `.claude/rules/` |
| 规格驱动工作流定义 | `AGENTS.md` |
| Skill 专项规范（按需激活） | `.claude/skills/` |

## 快速原则

- 先查 spec 再写代码：重大功能变更走 `/proposal` → `/apply` 流程
- HTTP 请求走封装 `request`，禁止原生 `fetch`/`axios`
- 异步操作必须有 `try/catch`，不允许静默失败
- 禁止 `any`、禁止 `@ts-ignore`、禁止渲染函数内定义子组件
- Provider 单向数据流：内层不得引用外层 Context
