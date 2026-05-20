## Files Reviewed
- `review/factory-d1-g0-high-severity-fix-plan.md` lines 29-62, 88-104, 169-176, 299-303
- `lib/factory-core.ts` lines 119-143
- `lib/factory-capabilities.ts` lines 11-29
- `.pi/extensions/pi-gstack/index.ts` lines 222-225, 266-363, 653-654, 776-780, 862-867, 816-817, 896-897
- `lib/factory-artifact-store.ts` lines 26-45

## Critical
- `lib/factory-core.ts:119-143`, `lib/factory-capabilities.ts:11-29`, `.pi/extensions/pi-gstack/index.ts:224-225, 864-867` — `qa-fix`'s non-destructive safety requirement is still carried only as ad-hoc `request.context` on the Pi slash command. The workflow/plan/runtime contracts do not model `commandSafetyProfile`, so any non-Pi caller that uses `planFactoryRun`/`FactoryRunner`/`createFactoryFacade` can execute the same write-capable `qa-fix` workflow without any safety metadata or enforcement. That misses the plan’s Phase 1 requirement to add command-safety metadata to the factory contracts, and it means the write-capable safety boundary is still command-local instead of factory-wide. Recommended fix: make command safety a typed part of the workflow/phase/plan contracts and require runtimes to validate/enforce it before dispatch, rather than hiding it in an untyped context bag.

## Warnings
- `.pi/extensions/pi-gstack/index.ts:266-290, 341-363, 653-654`, `lib/factory-artifact-store.ts:26-45` — manual review completion, manual QA completion, and review auto-recovery still write their final artifact files *before* the guarded `appendValidated()` call. Because `writeText()` blindly overwrites `diff-review-captured.*` / `qa-execution-captured.*`, a second concurrent or repeated completion attempt can clobber the on-disk artifact even when its `phase_completed` append is rejected as stale. Impact: durable artifact contents can drift from the accepted event history, which is exactly the idempotency/integrity gap M4 was trying to close. Recommended fix: move capture validation ahead of final artifact publication, or write to a unique/temp artifact id and only promote the canonical artifact after `appendValidated()` succeeds.

## Suggestions
- `.pi/extensions/pi-gstack/index.ts:816-817, 896-897` — `qa-fix` still falls through `plan.workflow === 'qa' ? 'QA' : 'Review'`, so its intake/summary artifacts are labeled as “Review” instead of QA. This weakens the audit-vs-fix UX clarity the hardening pass introduced; use an explicit workflow-to-title map or treat both `qa` and `qa-fix` as QA.

## Test Gaps
- Add a plan/facade/runtime test that proves `qa-fix` carries a required command-safety contract through factory planning, not just through the Pi slash command wrapper.
- Add idempotency tests for duplicate `/factory-complete-review`, duplicate `/factory-complete-qa`, and repeated `/factory-recover-review` attempts to verify rejected retries cannot overwrite the accepted artifact payload.

## Summary
The latest fixes materially improved the high-severity items: QA audit/fix are now split, browser policy blocks, status is inspect-only, and the event store now fails closed on post-manifest tails. Two important gaps remain, though: the non-destructive safety contract is still not modeled at the factory-contract level, and the capture paths can still overwrite accepted artifact evidence on duplicate completion/recovery attempts.