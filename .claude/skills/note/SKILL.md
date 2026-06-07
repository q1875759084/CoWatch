# 对话沉淀

> 回顾当前对话，提炼值得沉淀的内容，按类型分别更新 dev-notes.md、Rules、Skills、项目背景等文档。在对话结束前调用，趁上下文还在时完成沉淀。
>
> **触发方式**：用户输入 `/note [可选补充说明]` 时激活本流程。

## 第一步：回顾对话，按类型提炼内容

回顾当前完整对话，识别以下四类可沉淀内容：

### A. 技术笔记 → dev-notes.md
- 技术方案选择（选 A 而不是 B，原因）
- 踩坑记录（现象、根因、解决方案）
- 设计决策（某个边界/约束为什么这样定）
- 通用技术洞察（前端开发中普遍有价值的知识点）

**不收录**：纯环境问题、一次性操作步骤、已在 `frontend-architecture.md` 完整描述的内容

### B. 项目背景更新 → `.claude/CLAUDE.md`（同步更新 `.catpaw/rules/aiPartner/项目背景.md`）
- 新增了业务模块或功能
- 用户类型/租户类型定义有变化
- 技术栈发生了调整
- 关键约定有新增或修改

### C. 新增/更新 Rules
- CatPaw Rules → `.catpaw/rules/aiPartner/`
- Claude Code Rules → `.claude/rules/`（两处同步更新）
- 发现了新的通用编码规范（所有文件都适用）
- 现有 Rule 有遗漏或需要修正的约束

### D. 新增/更新 Skills
- CatPaw Skills → `.catpaw/skills/`
- Claude Code Skills → `.claude/skills/`（两处同步更新）
- 发现了值得复用的业务专属场景
- 现有 Skill 有遗漏的规范或示例

如果 `$ARGUMENTS` 有补充说明，优先围绕该主题提炼。

---

## 第二步：读取现有文档，做去重比对

对每类提炼内容，**先读取对应文档全文**，按以下三原则判断处理方式：

| 原则 | 情况 | 处理 |
|------|------|------|
| **新增** | 文档中不存在相关内容 | 追加到对应位置 |
| **更新** | 已有同主题内容，本次是补充/修正 | 合并进原条目，以最终结论为准，不新增重复章节 |
| **跳过** | 内容完全相同，无新增价值 | 不写入 |

---

## 第三步：向用户展示提炼结果，等待确认

```
📝 本次对话沉淀计划，确认后执行：

━━ dev-notes.md ━━
【新增】踩坑：xxx
  现象：...  根因：...  解决：...
【更新】已有条目「yyy」→ 补充 zzz
【跳过】aaa（已有完整记录）

━━ 项目背景 ━━
【更新】新增 opportunity 模块的路由前缀说明（CLAUDE.md + 项目背景.md 同步）

━━ Rules（CatPaw + Claude Code 同步） ━━
【新增】React代码生成指南 → 新增：避免在 render 函数内定义子组件
【跳过】JS规范（无需更新）

━━ Skills（CatPaw + Claude Code 同步） ━━
【新增】carry-hub-upload/SKILL.md → 文件上传场景规范
【跳过】carry-hub-request（无需更新）

没有需要沉淀的内容时，直接回复：「本次对话无需更新任何文档。」

是否按以上计划执行？[Y 全部执行 / 逐条确认 / N 放弃]
```

---

## 第四步：执行写入

用户确认后，**CatPaw 和 Claude Code 两套文件同步更新**，按类型依次执行：

### dev-notes.md 写入规则

- 「新增」→ 追加到对应章节末尾：
  - 踩坑类 → `## 踩坑记录`
  - 通用技术类 → `## 工具与概念`
  - 决策类 → `## 架构决策`（不存在则新建）
  - 待了解 → `## 待了解` 列表
- 「更新」→ 找到原条目，将新内容合并进去，不新增重复章节
- 「跳过」→ 不操作

写入格式参考现有条目风格：
```markdown
### [标题]

**现象/背景：** 一句话描述触发场景

**原因：** 根本原因说明

**解决/结论：** 具体方案或决策结论

（如有对比）**为什么不用 XX：** 放弃原因
```

### 项目背景写入规则

- 同时更新 `.catpaw/rules/aiPartner/项目背景.md` 和 `.claude/CLAUDE.md`
- 「更新」→ 找到对应章节，在原内容基础上修改或补充，保持表格/列表格式一致
- 保持 `项目背景.md` 精简（< 60 行），不要将 `frontend-architecture.md` 的内容照搬进来

### Rules 写入规则

- 「新增条目」→ 同时追加到 `.catpaw/rules/aiPartner/` 和 `.claude/rules/` 对应文件的合适章节末尾
- 「新建 Rule 文件」→ 两处同步创建，CatPaw 版含 frontmatter（description、globs、ruleType），Claude Code 版含 frontmatter（description、paths）
- 「更新」→ 两处同步修改

### Skills 写入规则

- 「更新现有 Skill」→ 同时更新 `.catpaw/skills/<name>/SKILL.md` 和 `.claude/skills/<name>/SKILL.md`
- 「新建 Skill」→ 两处同步创建，SKILL.md 顶部写 description 注释（问题形态描述，而不是方案名）

---

## 第五步：完成报告

写入完成后，输出：
```
✅ 沉淀完成

已更新：
  dev-notes.md → 新增「xxx」，更新「yyy」
  项目背景.md + CLAUDE.md → 更新「功能模块」章节
  React代码生成指南.md（CatPaw + Claude Code）→ 新增 1 条规范
  carry-hub-upload/SKILL.md（CatPaw + Claude Code）→ 新建

跳过：3 条（内容已存在）
```
