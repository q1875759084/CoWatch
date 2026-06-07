---
name: spec-research-clarify
description: When user agrees to conduct research and clarification for a change proposal, this skill performs structured ambiguity analysis to identify gaps and risks. It generates prioritized clarification questions and records the user's decisions and findings in research.md.
---

# Spec Research & Clarify Guide

## Objective

Through research and clarification questioning, establish clear key decisions, eliminate gaps and misunderstandings, and ensure the subsequent technical solution is more accurate and complete.

## Steps

1. Research existing implementation patterns and generate research.md
2. Ask user clarification questions
3. Record user's final decisions and update research.md
4. Report completion

## Step 1: Research Existing Implementation Patterns and Generate research.md

Research existing implementation patterns based on requirements (e.g., code repositories, user-provided files, etc.). Consolidate findings in `research.md` using format:
- Decision: [what was chosen]
- Rationale: [why chosen]
- Alternatives considered: [what else evaluated]

Generate `research.md` in the `spec/changes/<id>/` directory.

## Step 2: Ask User Clarification Questions

Detect and reduce ambiguity or missing decision points and record the clarifications directly in the `research.md`, follow these steps:
1) Perform a structured ambiguity & coverage scan using this taxonomy. For each category, mark status: Clear / Partial / Missing. Produce an internal coverage map used for prioritization (do not output raw map unless no questions will be asked).
    Functional Scope & Behavior:
    - Core user goals & success criteria
    - Explicit out-of-scope declarations
    - User roles / personas differentiation

    Domain & Data Model:
    - Entities, attributes, relationships
    - Identity & uniqueness rules
    - Lifecycle/state transitions
    - Data volume / scale assumptions

    Interaction & UX Flow:
    - Critical user journeys / sequences
    - Error/empty/loading states
    - Accessibility or localization notes

    Non-Functional Quality Attributes:
    - Performance (latency, throughput targets)
    - Scalability (horizontal/vertical, limits)
    - Reliability & availability (uptime, recovery expectations)
    - Observability (logging, metrics, tracing signals)
    - Security & privacy (authN/Z, data protection, threat assumptions)
    - Compliance / regulatory constraints (if any)

    Integration & External Dependencies:
    - External services/APIs and failure modes
    - Data import/export formats
    - Protocol/versioning assumptions

    Edge Cases & Failure Handling:
    - Negative scenarios
    - Rate limiting / throttling
    - Conflict resolution (e.g., concurrent edits)

    Constraints & Tradeoffs:
    - Technical constraints (language, storage, hosting)
    - Explicit tradeoffs or rejected alternatives

    Terminology & Consistency:
    - Canonical glossary terms
    - Avoided synonyms / deprecated terms

    Completion Signals:
    - Acceptance criteria testability
    - Measurable Definition of Done style indicators

    Misc / Placeholders:
    - TODO markers / unresolved decisions
    - Ambiguous adjectives ("robust", "intuitive") lacking quantification

    For each category with Partial or Missing status, add a candidate question opportunity unless:
    - Clarification would not materially change implementation or validation strategy
    - Information is better deferred to planning phase (note internally)
2) Generate (internally) a prioritized queue of candidate clarification questions (maximum 5). Do NOT output them all at once. Apply these constraints:
    - Each question must be answerable with EITHER:
        - A short multiple‑choice selection (2–5 distinct, mutually exclusive options), OR
        - A one-word / short‑phrase answer (explicitly constrain: "Answer in <=5 words").
    - Only include questions whose answers materially impact architecture, data modeling, task decomposition, test design, UX behavior, operational readiness, or compliance validation.
    - Exclude questions already answered, trivial stylistic preferences, or plan-level execution details (unless blocking correctness).
    - Favor clarifications that reduce downstream rework risk or prevent misaligned acceptance tests.
3) Sequential questioning loop (interactive)
    - Present EXACTLY ONE question at a time.
    - For multiple‑choice questions:
        - **Analyze all options** and determine the **most suitable option** based on:
            - Best practices for the project type
            - Common patterns in similar implementations
            - Risk reduction (security, performance, maintainability)
            - Alignment with any explicit project goals or constraints visible in the spec
        - Present your **recommended option prominently** at the top with clear reasoning (1-2 sentences explaining why this is the best choice).
        - Format as: `**Recommended:** Option [X] - <reasoning>`
        - Then render all options as a Markdown table:

        | Option | Description |
        |--------|-------------|
        | A | <Option A description> |
        | B | <Option B description> |
        | C | <Option C description> (add D/E as needed up to 5) |
        | Short | Provide a different short answer (<=5 words) (Include only if free-form alternative is appropriate) |

        - After the table, add: `You can reply with the option letter (e.g., "A"), accept the recommendation by saying "yes" or "recommended", or provide your own short answer.`
    - For short‑answer style (no meaningful discrete options):
        - Provide your **suggested answer** based on best practices and context.
        - Format as: `**Suggested:** <your proposed answer> - <brief reasoning>`
        - Then output: `Format: Short answer (<=5 words). You can accept the suggestion by saying "yes" or "suggested", or provide your own answer.`
    - After the user answers:
        - If the user replies with "yes", "recommended", or "suggested", use your previously stated recommendation/suggestion as the answer.
        - Otherwise, validate the answer maps to one option or fits the <=5 word constraint.
        - If ambiguous, ask for a quick disambiguation (count still belongs to same question; do not advance).
        - Once satisfactory, record it in working memory (do not yet write to disk) and move to the next queued question.
    - Stop asking further questions when:
        - All critical ambiguities resolved early (remaining queued items become unnecessary), OR
        - User signals completion ("done", "good", "no more"), OR
        - You reach 5 asked questions.
    - Never reveal future queued questions in advance.
    - If no valid questions exist at start, immediately report no critical ambiguities.

## Step 3: Record User's Final Decisions

Record the user's final decisions in `research.md`

## Step 4: Report Completion

Report completion after the questioning loop ends or when terminating early:
   - Number of questions asked & answered.
   - Key decisions made and recorded in research.md.
   - Path to updated spec.
   - Sections touched (list names).
   - Coverage summary table listing each taxonomy category with Status: Resolved (was Partial/Missing and addressed), Deferred (exceeds question quota or better suited for planning), Clear (already sufficient), Outstanding (still Partial/Missing but low impact).
   - Suggested next command.

## Behavior rules

- If no meaningful ambiguities found (or all potential questions would be low-impact), respond: "No critical ambiguities detected worth formal clarification." and suggest proceeding.
- Never exceed 5 total asked questions (clarification retries for a single question do not count as new questions).
- Avoid speculative tech stack questions unless the absence blocks functional clarity.
- Respect user early termination signals ("stop", "done", "proceed").
- If no questions asked due to full coverage, output a compact coverage summary (all categories Clear) then suggest advancing.
- If quota reached with unresolved high-impact categories remaining, explicitly flag them under Deferred with rationale.