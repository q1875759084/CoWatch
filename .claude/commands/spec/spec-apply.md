---
name: /spec-apply
description: Implement an approved OpenSpec change and keep tasks in sync.
---
<!-- SGFESPEC:START -->
**Guardrails**
- Favor straightforward, minimal implementations first and add complexity only when it is requested or clearly required.
- Keep changes tightly scoped to the requested outcome.
- Refer to `spec/AGENTS.md` (located inside the `spec/` directory—run `ls spec` or `sgfespec update` if you don't see it) if you need additional OpenSpec conventions or clarifications.
- Language: All generated documents and AI responses MUST be in Chinese (简体中文)

**Knowledge References**
Before proceeding, consult the knowledge index table in the project root `AGENTS.md`. Based on the "何时读取" column and the nature of this task, read the relevant knowledge files under `spec/knowledge/` and `.knowledge/`.

**Steps**
Implement pages one at a time, following steps 1-11 below for each page, then track these steps as TODOs and complete them one by one.
1. Ask user if there are any **additional documentation materials** (e.g., design screenshots, development docs) to supplement
2. **Read proposal.md** - Understand what's being built
3. **Read design.md** - Review technical decisions
4. **Read tasks.md** - Get implementation checklist
5. **Analyze UI Images** - If user-provided UI screenshots are available, invoke the `spec-analyze-ui-images` skill (refer to `<skills-dir>/spec-analyze-ui-images/SKILL.md`) to systematically analyze UI images and extract key information about terminal, layout, components, interactions, content, and states
6. **Ask the user to provide page generation knowledge** (via documentation, MCP Tool, or any other form). Only if the user does not provide it, invoke `generatePage` Tool based on platform and page type to get page-level knowledge
7. **Invoke component-level MCP tools** as needed - Read `spec/knowledge/project.md` section "组件库与 MCP 工具" for the component library to MCP tool mapping, then query the appropriate tool for finer-grained component details
8. **Implement tasks sequentially** - Complete in order. For multiple pages, generate one at a time and confirm before proceeding
9. **Confirm completion** - Ensure every item in `tasks.md` is finished before updating statuses
10. **Update checklist** - After all work is done, set every task to `- [x]` so the list reflects reality
11. **Approval gate** - Do not start implementation until the proposal is reviewed and approved

**Reference**
- Use `sgfespec show <id> --json --deltas-only` if you need additional context from the proposal while implementing.
<!-- SGFESPEC:END -->
