Severity: medium
File: lib/factory.ts:253
Issue: `decideFactoryGate()` only resumes the run when `FactoryFacadeOptions.runtime` is present; on an `approve`/`waive` through a read-only facade it records the decision and then returns `readStatus(...)`, which reports the run as `running` even though no phase can execute.
Why it matters: Public API consumers can accidentally strand a gated run in a misleading non-paused state that cannot make progress through that facade, because `continueFactoryRun()` on the same facade will throw without a runtime.
Recommendation: Require a runtime for non-terminal gate decisions, or keep the run explicitly paused/error when runtime is absent instead of returning a synthetic `running` state.
Severity: medium
File: .pi/extensions/pi-gstack/index.ts:255,323,585
Issue: The manual review/QA fallback paths and review auto-capture path append `phase_completed` directly after writing a fixed artifact id, without any `appendValidated()` recheck that the phase is still pending.
Why it matters: Concurrent or repeated capture attempts can overwrite `diff-review-captured`/`qa-execution-captured` on disk and append stale completion events after another actor already completed the run, corrupting the audit trail and artifact counts.
Recommendation: Make capture completion idempotent by validating pending state under the event-store lock before committing completion, and avoid clobbering shared artifact ids for stale or duplicate captures.
