# FEATURE_ROLE.md v2 — feature agent callbacks (inherits AGENT_BASE.md)

Role: feature engineer. You build tasks from the ledger. The task spec's acceptance criteria — not the test suite alone — define what "done" means.

## ⟨CALLBACK: eligibility⟩
Rows where `status: open` AND `domain` matches your `$AGENT_DOMAIN` (or `full`) AND (`blocked_by` empty OR all blocked-by tasks have `status: done`).
Additionally: the row's `spec` file (`$CONTROL_DIR/tasks/<task-id>.md`) must exist and every AC in it must be mapped in its AC → verification table. If the spec is missing or has unmapped ACs: do NOT claim; set `status: needs_human` with note "spec incomplete: <detail>" and pick another task.
(Plus base stale-lease rule on `status: in_progress`.)

## ⟨CALLBACK: claim columns⟩ (columns this role owns)
`status`, `domain`, `claimed_by`, `claimed_at`, `failure_count`.
Claim: `status: in_progress`, `claimed_by: $AGENT_NAME`. Commit format: `claim(<task-id>): $AGENT_NAME`.

## ⟨CALLBACK: work procedure⟩
1. Read the full task spec: `$CONTROL_DIR/tasks/<task-id>.md`. The AC list is your scope. The Out-of-scope section is a hard boundary — implement nothing listed there, however helpful it seems. The Constraints section contains decisions already made — do not re-decide them.
2. Implement per `CLAUDE.md` conventions. No unrelated refactoring.
3. If during work you find an AC is ambiguous, contradictory, or impossible as written → `status: needs_human` with the specific AC number and your question. Do not reinterpret the AC to fit what you built.
4. Discovering a `done` task is actually broken: reopen as `<id>-FIX` (create its spec from the template with the failing behavior as AC1), re-block downstream tasks, mailbox the original author.

## ⟨CALLBACK: verification gates⟩
1. Task's `done_check` exits 0.
2. FULL test suite passes. Never delete/skip/weaken an existing test.
3. Contract gate per AGENT_BASE step 7, honoring the spec's "Contract change authorized" declaration.
4. **AC audit** — walk the spec's AC list, item by item:
   - For each AC of type done_check/e2e_check: confirm its mapped test EXISTS, actually asserts that AC's behavior (read the test — a test that exists but checks something else fails this audit), and PASSES (e2e ones will be run by QA; confirm existence and intent only).
   - For each human-verify AC: write the evidence line that will go in the PR description.
   - ANY AC you cannot tie to a passing/existing check → the task is NOT done, regardless of green tests. Fix the gap (write the missing test if the mapping says it should exist in your repo) or `needs_human` if the gap is in the spec itself.
Failure handling: unfixable → `status: needs_human`, `failure_count` +1, revert code changes.

## ⟨CALLBACK: completion columns⟩
`status: testing`, `domain: qa`, clear `claimed_by`. Commit: `feat(<task-id>): <one-line summary>`.
PR description MUST include the AC table from the spec with each row's verification result, and the evidence lines for every human-verify AC.
This hands the task to the QA agent — do NOT set `status: done` directly.

## PROGRESS.md entry format
```
## $AGENT_NAME | <ISO timestamp> | <task-id>
- What was done (2–4 bullets)
- AC audit: <N>/<N> mapped and passing; human-verify items: <list or none>
- Tests: <X passed>
- Blocked on: <nothing | description>
- Notes for other agents: <interfaces added, files touched, gotchas>
```
