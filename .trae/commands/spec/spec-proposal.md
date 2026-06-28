---
name: /spec-proposal
description: Scaffold a new OpenSpec change and validate strictly.
---
<!-- SGFESPEC:START -->
**Guardrails**
- Favor straightforward, minimal implementations first and add complexity only when it is requested or clearly required.
- Keep changes tightly scoped to the requested outcome.
- Refer to `spec/AGENTS.md` (located inside the `spec/` directory—run `ls spec` or `sgfespec update` if you don't see it) if you need additional OpenSpec conventions or clarifications.
- Language: All generated documents and AI responses MUST be in Chinese (简体中文)
- Identify any vague or ambiguous details and ask the necessary follow-up questions before editing files.
- Process integrity: Steps 6 (research & clarification) and 9 (cross-artifact consistency check) are mandatory interaction points — you MUST pause and explicitly ask the user at each. Never decide to skip them on your own.

**Knowledge References**
Before proceeding, consult the knowledge index table in the project root `AGENTS.md`. Based on the "何时读取" column and the nature of this task, read the relevant knowledge files under `spec/knowledge/` and `.knowledge/`.

**Steps**
1. Review `spec/knowledge/project.md`, `sgfespec list`, and `sgfespec list --specs` to understand current context.
2. Retrieve the user-provided PRD (Product Requirements Document).
3. Choose a unique verb-led `change-id`, scaffold `proposal.md` and spec deltas under `spec/changes/<id>/`.
4. Draft spec deltas using `## ADDED|MODIFIED|REMOVED Requirements` with at least one `#### Scenario:` per requirement, then confirm with user before proceeding.
5. Ask the user to provide API documentation and technical choice knowledge (via documentation, MCP Tool, or any other form). Only if the user does not provide technical choice knowledge, invoke MCP Tool `getTechnicalChoiceKnowledge` based on platforms specified in `proposal.md` to retrieve platform-specific technical choices.
6. Ask the user if they need research and clarification (recommended for large or complex projects). If agreed, refer to the `spec-research-clarify` Agent Skill in your project's skills directory (e.g., `.cursor/skills/spec-research-clarify/SKILL.md` or `.catpaw/skills/spec-research-clarify/SKILL.md`) to conduct structured ambiguity analysis and generate clarification questions. Record user decisions in `research.md` under `spec/changes/<id>/` before proceeding to the next step.
7. Generate `design.md` under `spec/changes/<id>/`. Ask the user to verify that the `design.md` content is correct before proceeding to the next step.
8. Generate `tasks.md` under `spec/changes/<id>/`.
9. Use "SDD多产物一致性校验" SubAgent to validate content across `spec/knowledge/project.md`, `proposal.md`, `design.md`, `tasks.md`, and `specs/`.
10. Run `sgfespec validate <id> --strict` and resolve any issues before sharing the proposal.

**Write proposal.md:**

Read `spec/templates/proposal-template.md` for the format and draft the proposal.

**Create spec deltas:** `specs/[page]/spec.md`
[One PRD contains multiple pages, each with one spec.md file. The content should only cover functional requirements without any technical jargon or implementation details.]

Read `spec/templates/spec-template.md` for the format and draft spec deltas.

If multiple pages are affected, create multiple delta files under `changes/[change-id]/specs/<page>/spec.md`—one per page.

**Create design.md:**
[Combine PRD requirements, API documentation, and technical choice knowledge. First outline the modules (functional scenario-related pages), then explain each page's technical implementation]

Processing API Information:
- Extract API functionality, URL, request method, and input/output parameters
- Use EARS (Easy Approach to Requirements Syntax) to describe the relationship between interaction scenarios and API calls
- Define complete API request and response interfaces using TypeScript (include all parameters)
- If an interaction scenario is identified as missing an API, mark it as "⚠️ 缺少接口，待补充"

Read `spec/templates/design-template.md` for the output skeleton and TypeScript interface format.

**Create tasks.md:**
[Break down tasks based on technical implementation from `design.md`. One page per section, including key technical details: files/directories, TS type identifiers, API URLs, libraries, components (with key props), functions, etc.]

For page generation tasks, follow these steps:
1) Create file structure: list file paths to be created
2) Implement TS definitions & API requests: list type identifiers, API URLs
3) Implement UI & business logic by area: break down by page areas, list components, key props, functions, key logic to implement, etc.
4) Create Mock data
5) Configure routes: specify route file location

Read `spec/templates/tasks-template.md` for the output skeleton.

`tasks.md` should NOT include integration, testing, or debugging steps.

**Reference**
- Use `sgfespec show <id> --json --deltas-only` or `sgfespec show <spec> --type spec` to inspect details when validation fails.
- Search existing requirements with `rg -n "Requirement:|Scenario:" spec/specs` before writing new ones.
- Explore the codebase with `rg <keyword>`, `ls`, or direct file reads so proposals align with current implementation realities.
<!-- SGFESPEC:END -->
