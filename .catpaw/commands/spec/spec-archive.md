---
name: /spec-archive
description: Archive a deployed OpenSpec change and update specs.
---
<!-- SGFESPEC:START -->
**Guardrails**
- Favor straightforward, minimal implementations first and add complexity only when it is requested or clearly required.
- Keep changes tightly scoped to the requested outcome.
- Refer to `spec/AGENTS.md` (located inside the `spec/` directory—run `ls spec` or `sgfespec update` if you don't see it) if you need additional OpenSpec conventions or clarifications.
- Language: All generated documents and AI responses MUST be in Chinese (简体中文)

**Steps**
1. Determine the change ID to archive:
   - If this prompt already includes a specific change ID (for example inside a `<ChangeId>` block populated by slash-command arguments), use that value after trimming whitespace.
   - If the conversation references a change loosely (for example by title or summary), run `sgfespec list` to surface likely IDs, share the relevant candidates, and confirm which one the user intends.
   - Otherwise, review the conversation, run `sgfespec list`, and ask the user which change to archive; wait for a confirmed change ID before proceeding.
   - If you still cannot identify a single change ID, stop and tell the user you cannot archive anything yet.
2. Validate the change ID by running `sgfespec list` (or `sgfespec show <id>`) and stop if the change is missing, already archived, or otherwise not ready to archive.
3. Run `sgfespec archive <id> --yes` so the CLI moves the change and applies spec updates without prompts (use `--skip-specs` only for tooling-only work).
4. Review the command output to confirm the target specs were updated and the change landed in `changes/archive/`.
5. Validate with `sgfespec validate --strict` and inspect with `sgfespec show <id>` if anything looks off.

**Reference**
- Use `sgfespec list` to confirm change IDs before archiving.
- Inspect refreshed specs with `sgfespec list --specs` and address any validation issues before handing off.
<!-- SGFESPEC:END -->
