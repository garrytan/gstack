## Scope
Reviewed the current uncommitted factory hardening changes only for security/fail-closed behavior in these areas:
- missing-manifest / read-only status handling
- QA-fix explicit write opt-in and safety contract
- facade gate-history parsing for orphan decisions
- manual/auto capture paths after the `appendValidated()` changes

## Critical Findings
- None.

## High / Medium Findings
- `.pi/extensions/pi-gstack/index.ts:225,778-781,864-867` — `factory-qa-fix` now requires `policy.allowWrites: true` and tags the request with `commandSafetyProfile: 'non-destructive-write'`, but the only runtime use of that profile is an equality check before dispatching `/skill:gstack-qa`; the rest of the safety contract is prompt prose only, and there is no repo-side runtime/tool enforcement consumer for `commandSafetyProfile`. Impact: the command still relies on model obedience instead of a fail-closed guardrail, so a buggy or prompt-injected QA fixer can execute destructive local Bash/git operations even though the factory command promises “non-destructive local fixes only.” Confidence: medium-high. Recommended fix: bind `commandSafetyProfile` to actual execution restrictions (for example, a destructive-command pre-tool guard, scoped write boundary, or dispatch through an enforced safety wrapper) and add a negative regression test that dangerous commands are denied, not just discouraged.

- `.pi/extensions/pi-gstack/index.ts:267,342,652-654` + `lib/factory-artifact-store.ts:26,44-45` — The capture paths now use `appendValidated(...)`, but they still write fixed artifact ids (`diff-review-captured`, `qa-execution-captured`) before the validated append, and `writeText()` overwrites existing artifact files in place. Impact: concurrent or replayed capture/recovery attempts can lose the phase race yet still mutate the already-committed captured artifact on disk, corrupting the durable audit record instead of failing closed. Confidence: medium. Recommended fix: make captured artifact writes create-only/idempotent under the same run lock, or reserve a unique artifact id during the validated append before any file write so stale captures cannot overwrite previously committed artifacts.

## Low / Hardening
- None.

## Secret Handling
- None found in reviewed scope.

## Validation / Follow-up
- Add a targeted regression proving `factory-qa-fix` denies a destructive command path through an actual runtime/tool guard, not just by including warning text in the dispatched prompt.
- Add replay/race tests for `/factory-complete-review`, `/factory-complete-qa`, and `/factory-recover-review` showing a second stale capture cannot change `artifacts/diff-review-captured.*` or `artifacts/qa-execution-captured.*` after the first capture commits.

## Summary
The missing-manifest and orphan-gate fail-closed fixes look materially improved, but two security-relevant integrity gaps remain: QA-fix safety is still prompt-level rather than enforced, and captured review/QA artifacts are still mutable under replay/race conditions.