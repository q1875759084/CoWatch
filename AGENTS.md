# Spec Coding Workflow

> Spec Coding (specification-driven development) workflow definition. This file defines the **workflow stages, format rules, and routing**. Detailed execution steps live in slash commands; artifact templates live in `spec/templates/`.

## 每次行动前的规范声明

每次开始生成代码前，必须先输出以下声明，再开始生成：

```
加载的规则文档：[列出本次对话中已加载的规则文档文件名，如：JavaScript通用代码生成指南.md、React代码生成指南.md、项目背景.md ...]
本次适用规范：[列出本次任务涉及的规范条目，如：禁止 any、import 顺序、try/catch 必须、禁止渲染函数内定义子组件 ...]
不适用规范：[列出本次不涉及的规范及原因，如：React 表单规范 — 本次无表单场景]
```

## Where to Find What

| What | Where |
|------|-------|
| Workflow stages & format rules | This file (`spec/AGENTS.md`) |
| Artifact templates (customizable) | `spec/templates/` (`proposal.md`, `spec.md`, `design.md`, `tasks.md`) |
| Project knowledge | `spec/knowledge/` (`constitution.md`, `project.md`, `business.md`) |
| Module Technical knowledge | `.knowledge/` |
| Detailed execution steps | Slash commands: `/spec-proposal`, `/spec-apply`, `/spec-archive`, `/spec-quick` |
| Component library MCP tools | `spec/knowledge/project.md` § 组件库与 MCP 工具 |

## TL;DR Quick Checklist

- Search existing work: `sgfespec list --specs`, `sgfespec list` (use `rg` for full-text search)
- Decide scope: new capability vs modify existing capability
- Pick a unique `change-id`: kebab-case, verb-led (`add-`, `update-`, `remove-`, `refactor-`)
- Artifacts: `proposal.md`, `tasks.md`, `research.md` (optional), `design.md`, and delta specs per affected capability
- Write deltas: use `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`; each requirement needs at least one `#### Scenario:`
- Validate: `sgfespec validate [change-id] --strict`
- Request approval before implementation
- Language: All generated documents and AI responses **MUST be in Chinese (简体中文)**

## Decision Tree

```
New request?
├─ Bug fix restoring spec behavior? → Fix directly
├─ Typo/format/comment? → Fix directly
├─ New feature/capability? → Create proposal (use /proposal command)
├─ Breaking change? → Create proposal
├─ Architecture change? → Create proposal
└─ Unclear? → Create proposal (safer)
```

## Three-Stage Workflow

### Stage 1: Creating Changes

**Trigger**: User mentions `proposal`, `change`, `spec` with `create`, `plan`, `make`, `start`, or `help`.

Use the **/proposal** slash command. It will guide you through:
1. Reading project context and existing specs
2. Retrieving PRD via MCP Tool
3. Scaffolding proposal.md and spec deltas
4. **Research & clarification** — ask user if needed (mandatory interaction point)
5. Generating design.md (confirm with user) and tasks.md
6. **Cross-artifact consistency check** — ask user if needed (mandatory interaction point)
7. Validating and requesting approval

### Stage 2: Implementing Changes

**Trigger**: User asks to implement, apply, or code an existing proposal.

Use the **/apply** slash command. It will guide you through:
1. Reading proposal, design, and task documents
2. Analyzing UI images (if provided)
3. Implementing tasks sequentially, page by page
4. Updating task checklists upon completion

### Stage 3: Archiving Changes

**Trigger**: User asks to archive a deployed change.

Use the **/archive** slash command. It will:
1. Identify and validate the change ID
2. Run `sgfespec archive <id> --yes`
3. Verify specs are updated and change is archived

## Quick Workflow

For lightweight requirements that don't need full spec deltas, use the **/quick** slash command. It combines document generation and implementation into a single streamlined flow. Key mandatory checkpoints: **requirement scope confirmation** (Step 3) and **design.md confirmation** (Step 9) — never skip these.

## Spec File Format

### Scenario Formatting

**CORRECT** (use `####` headers):
```markdown
#### Scenario: User login success
- **WHEN** valid credentials provided
- **THEN** return JWT token
```

**WRONG** (these will be silently ignored by the parser):
```markdown
- **Scenario: User login**  ❌
**Scenario**: User login    ❌
### Scenario: User login    ❌
```

Every requirement MUST have at least one scenario.

### Requirement Wording

- Use SHALL / MUST for normative requirements
- Avoid should / may unless intentionally non-normative

### Delta Operations

- `## ADDED Requirements` — New capabilities
- `## MODIFIED Requirements` — Changed behavior
- `## REMOVED Requirements` — Deprecated features
- `## RENAMED Requirements` — Name changes only

Headers matched with `trim(header)` — whitespace ignored.

### When to Use ADDED vs MODIFIED

- **ADDED**: Introduces a new capability that can stand alone. Prefer ADDED when the change is orthogonal (e.g., adding "Slash Command Configuration") rather than altering an existing requirement.
- **MODIFIED**: Changes the behavior, scope, or acceptance criteria of an existing requirement. Always paste the **full, updated requirement** (header + all scenarios). The archiver replaces the entire requirement; partial deltas will drop previous details.
- **RENAMED**: Use when only the name changes. If behavior also changes, use RENAMED (name) plus MODIFIED (content) referencing the new name.

**Common pitfall**: Using MODIFIED to add a new concern without including the previous text — this causes loss of detail at archive time. If you aren't changing the existing requirement's semantics, use ADDED instead.

**Authoring a MODIFIED requirement correctly:**
1. Locate the existing requirement in `spec/specs/<page>/spec.md`
2. Copy the entire requirement block (from `### Requirement: ...` through its scenarios)
3. Paste under `## MODIFIED Requirements` and edit to reflect new behavior
4. Ensure the header text matches exactly (whitespace-insensitive) and keep at least one `#### Scenario:`

**Example for RENAMED:**
```markdown
## RENAMED Requirements
- FROM: `### Requirement: Login`
- TO: `### Requirement: User Authentication`
```

## Naming Conventions

### Change ID

- kebab-case, short and descriptive: `add-two-factor-auth`
- Verb-led prefixes: `add-`, `update-`, `remove-`, `refactor-`
- Must be unique; if taken, append `-2`, `-3`, etc.

### Capability (Spec) Naming

- Use verb-noun: `user-auth`, `payment-capture`
- Single purpose per capability
- 10-minute understandability rule
- If description needs "AND", split into two capabilities

## Before Any Task

**Context Checklist:**
- [ ] Read relevant specs in `spec/specs/[page]/spec.md`
- [ ] Check pending changes in `spec/changes/` for conflicts
- [ ] Read `spec/knowledge/project.md` for project conventions
- [ ] Run `sgfespec list` to see active changes
- [ ] Run `sgfespec list --specs` to see existing capabilities

**Before Creating Specs:**
- Always check if capability already exists
- Prefer modifying existing specs over creating duplicates
- Use `sgfespec show [spec]` to review current state
- If request is ambiguous, ask 1-2 clarifying questions before scaffolding

## Search Guidance

- Enumerate specs: `sgfespec list --specs` (`--json` for scripts)
- Enumerate changes: `sgfespec list`
- Show details:
  - Spec: `sgfespec show <spec-id> --type spec` (`--json` for filters)
  - Change: `sgfespec show <change-id> --json --deltas-only`
- Full-text search: `rg -n "Requirement:|Scenario:" spec/specs`

## CLI Reference

```bash
# Core commands
sgfespec list                    # List active changes
sgfespec list --specs            # List specifications
sgfespec show [item]             # Display change or spec
sgfespec validate [item]         # Validate changes or specs
sgfespec archive <change-id> -y  # Archive after deployment

# Project management
sgfespec init [path]             # Initialize OpenSpec
sgfespec update [path]           # Update instruction files
```

**Command Flags:**
- `--json` — Machine-readable output
- `--type change|spec` — Disambiguate items
- `--strict` — Comprehensive validation
- `--no-interactive` — Disable prompts
- `--skip-specs` — Archive without spec updates
- `--yes` / `-y` — Skip confirmation prompts

## MCP Tools

| Tool | Purpose |
|------|---------|
| `getTechnicalChoiceKnowledge` | Get terminal-specific technical choice knowledge |
| `generatePage` | Get page-level code generation knowledge |

## Agent Skills

| Skill | Purpose | Location |
|-------|---------|----------|
| `spec-research-clarify` | Requirement research, clarification, and ambiguity analysis | `<skills-dir>/spec-research-clarify/SKILL.md` |
| `spec-analyze-ui-images` | Systematic UI image analysis | `<skills-dir>/spec-analyze-ui-images/SKILL.md` |

## SubAgents

| SubAgent | Purpose | Location |
|----------|---------|----------|
| `SDD多产物一致性校验` | Multi-artifact consistency validation | `<agents-dir>/SDD多产物一致性校验.md` |

## Directory Structure

```
spec/
├── templates/              # Artifact templates (customizable)
│   ├── proposal.md
│   ├── spec.md
│   ├── design.md
│   └── tasks.md
├── specs/                  # Current truth — what IS built
│   └── [page]/
│       ├── spec.md         # Requirements and scenarios
│       └── design.md       # Technical patterns
├── changes/                # Proposals — what SHOULD change
│   ├── [change-name]/
│   │   ├── proposal.md     # Why, what, impact
│   │   ├── tasks.md        # Implementation checklist
│   │   ├── research.md     # Research findings (optional)
│   │   ├── design.md       # Technical decisions
│   │   └── specs/          # Delta changes
│   │       └── [page]/
│   │           └── spec.md # ADDED/MODIFIED/REMOVED
│   └── archive/            # Completed changes
```

## Troubleshooting

**"Change must have at least one delta"**
- Check `changes/[name]/specs/` exists with .md files
- Verify files have operation prefixes (`## ADDED Requirements`)

**"Requirement must have at least one scenario"**
- Scenarios must use `#### Scenario:` format (4 hashtags)
- Don't use bullet points, bold, or `###` for scenario headers

**Silent scenario parsing failures**
- Exact format required: `#### Scenario: Name`
- Debug: `sgfespec show [change] --json --deltas-only`

**Change conflicts**: Run `sgfespec list`, check for overlapping specs, coordinate with owners, consider combining proposals.

**Missing context**: Read `spec/knowledge/project.md` first, check related specs, review recent archives, ask for clarification.

**Validation commands:**

```bash
sgfespec validate [change] --strict
sgfespec show [change] --json | jq '.deltas'
sgfespec show [spec] --json -r 1
```

Remember: Specs are truth. Changes are proposals. Keep them in sync.
