## Files Reviewed
- `lib/factory-event-store.ts` lines 84-184
- `.pi/extensions/pi-gstack/index.ts` lines 220-225, 400-417, 760-846
- `lib/factory-qa-workflow.ts` lines 61-69
- `test/factory-event-store.test.ts` lines 92-98
- `test/factory-qa-workflow.test.ts` lines 24-36

## Critical
- `lib/factory-event-store.ts:84,176-184` — `readManifest()` still auto-recovers a missing manifest by reparsing the full `events.jsonl`, and `factory-status` calls it even though the command is documented as non-mutating (`.pi/extensions/pi-gstack/index.ts:400-417`). This means an inspect-only read can rewrite durable state, and a deleted/missing manifest lets any valid-looking appended tail become authoritative again, which reopens the H2/H3 integrity hole the plan was supposed to close. Recommended fix: make normal reads fail closed when `manifest.json` is missing or inconsistent, move manifest reconstruction behind an explicit recovery path, and update `test/factory-event-store.test.ts:97-98` so missing-manifest reads no longer self-heal.
- `lib/factory-qa-workflow.ts:63-66` — the new `qa-fix` workflow says fixes happen only after an “explicit write opt-in”, but its `defaultPolicy` already sets `allowWrites: true`. Any future caller that forgets to pass `policy.allowWrites: true` will still get a write-capable plan, so the factory no longer proves explicit user consent before dispatching `/skill:gstack-qa`. Recommended fix: keep `FACTORY_QA_FIX_WORKFLOW.defaultPolicy.allowWrites` false and require the Pi command (or any other caller) to opt in explicitly; add a negative test that compiling/running `qa-fix` without `allowWrites:true` produces `writes-disabled`.

## Warnings
- `.pi/extensions/pi-gstack/index.ts:224-225,760-766,771-774,835-846` — the promised non-destructive QA-fix safety contract is metadata-only. `commandSafetyProfile: 'non-destructive-write'` is attached to request context, but there is no factory-core/runtime consumer for it, the dispatch runtime unconditionally reports `filesystem|git|test-runner` whenever the cwd is a git repo, and the actual `/skill:gstack-qa` prompt only adds correlation text, not the non-destructive restrictions. In practice, `/factory-qa-fix` is still trusting convention rather than enforcing the plan’s safety model. Recommended fix: plumb `commandSafetyProfile` into a real runtime/policy check, advertise write/test capabilities from actual runtime support instead of `isGitRepository()`, and include the non-destructive contract in `factoryQaSkillRequest()` before dispatch.

## Suggestions
- `test/factory-qa-workflow.test.ts:24-36` — add the missing negative cases from the plan: `qa-fix` without `allowWrites:true` should block, and a runtime missing write/test capabilities should fail before dispatch.
- `test/pi-extension.test.ts` — add an assertion that `/factory-status` does not create or rewrite `manifest.json` for a damaged run, and that `/factory-qa-fix` dispatch text includes the safety contract users are being promised.

## Test Gaps
- No test currently proves that a missing `manifest.json` fails closed for read-only commands; the existing event-store test still encodes auto-recovery.
- No test proves `qa-fix` requires an explicit write opt-in instead of inheriting it from workflow defaults.
- No test proves the non-destructive safety profile is enforced or even communicated to the dispatched `gstack-qa` skill.

## Summary
The patch moves the factory in the right direction, especially on QA mode splitting and request-sequence cleanup, but two core guarantees from the fix plan are still not actually true in code: read-only inspection can still mutate run state, and write-capable QA is not explicitly or enforceably gated. I would fix those before treating the high-severity plan as complete.