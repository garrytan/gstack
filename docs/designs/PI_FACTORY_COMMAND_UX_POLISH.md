# Pi Factory Command UX Polish

Status: command-output polish pass after factory capability safety hardening.

## Goal

Make Pi factory command output more actionable and safety-honest without changing the underlying workflow semantics. This pass is independent of the web-app design work.

## Scope

Commands reviewed:

- `/factory-status <run-id>`
- `/factory-list`
- `/factory-gates <run-id>`
- `/factory-decide <run-id> <gate-id> <request-sequence> <approve|reject|waive|cancel> [reason]`
- `/factory-qa <goal-or-url>`
- `/factory-complete-qa <run-id> <summary>`
- `/factory-recover-review <run-id>`
- `/factory-complete-review <run-id> <summary>`

## UX principles applied

1. **Status is inspection-only.**
   - Status output should not imply that reading status recovers or completes runs.

2. **Next action should be obvious.**
   - Status and list output should show the next useful command when a run is paused.

3. **Safety posture should be visible.**
   - QA audit output should clearly say it is audit-only and does not edit repository files.

4. **Gate decisions must be sequence-aware.**
   - Gate output should show `requestSequence` and command syntax so users do not guess.

5. **Ship readiness is not deployment.**
   - Ship workflow status should remind users that readiness verification does not tag, publish, push, or deploy.

## Changes made

### `/factory-status`

Added to status output:

- workflow id/title;
- mode;
- goal;
- progress as completed/total phases;
- ship-readiness note for `ship` workflow;
- inspect-only note for pending external review and QA;
- summary next action when a run is paused or failed.

Pending external QA now includes:

```text
- mode: audit-only; /factory-qa does not edit repository files or apply fixes.
Status is inspect-only; use /factory-complete-qa to attach a manual QA summary.
```

Pending external review now includes:

```text
Status is inspect-only; use an explicit recovery/completion command to mutate this run.
```

Ship workflow status now includes:

```text
Ship readiness note: this workflow verifies readiness only; it does not tag, publish, push, or deploy.
```

### `/factory-list`

Each row now includes:

- completed/total progress;
- calculated next action;
- readiness-only marker for ship runs.

This makes list output useful as a triage surface instead of only an inventory.

### `/factory-gates`

Gate output now:

- sorts pending gates first;
- warns that stale decisions are rejected;
- shows exact `/factory-decide` syntax for pending gates.

Example shape:

```text
Factory gates for run-id:
Pending gates are listed first. Use the shown requestSequence; stale decisions are rejected.
- approve-review: status=pending, phase=review, requestSequence=2
  allowed=approve|cancel
  next=/factory-decide run-id approve-review 2 <approve|cancel> [reason]
```

## Tests added/updated

Updated `test/pi-extension.test.ts` assertions for:

- `/factory-status` review output includes the inspect-only note and summary next action;
- `/factory-list` includes next-action hints;
- `/factory-status` QA audit output includes audit-only/no-edit and inspect-only guidance;
- `/factory-status` QA fix output does not incorrectly label persisted `qa-fix` runs as audit-only;
- `/factory-status` ship output includes readiness-only/no-deploy copy;
- `/factory-status` suppresses untrusted event-provided artifact paths and URIs;
- `/factory-gates` output includes stale-decision warning and exact `/factory-decide` syntax;
- `/factory-decide` can reject a ship-readiness gate in headless contexts without requiring question-capable runtime resume;
- `/factory-decide` refuses ship-readiness approvals until a ship-capable runtime exists;
- duplicate manual QA/review completion and repeated recovery coverage added in the adjacent test coverage pass remains green.

## Commands validated

```bash
bun test test/pi-extension.test.ts test/factory-qa-workflow.test.ts test/factory-facade.test.ts test/factory-event-store.test.ts
```

## Remaining command UX opportunities

1. **Recovery replay UX copy.**
   - Repeated `/factory-recover-review` is idempotent, but the user-facing no-pending wording could be friendlier.

2. **Command help text.**
   - Consider a `/factory-help` or richer descriptions if Pi exposes command help in a useful way.

3. **Ship command lifecycle.**
   - There is no public `/factory-ship` command in this pass. When one is added, its output must preserve the readiness-only language unless release-action support is implemented separately.

4. **Machine-readable status.**
   - Future SDK/web consumers should use facade DTOs, not parse Pi notification text.

## Bottom line

The Pi command UX is now more explicit about what is happening, what action is needed, and what safety boundary applies. The changes are output/coverage polish only; they do not broaden automation authority or start any release/deploy behavior.
