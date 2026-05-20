# Factory D.1 through G0 parallel subagent review

Date: 2026-05-18
Branch: `pi-software-factory-core`
Reviewed range: `e6c6b64b^..HEAD` after G0 commit `22a4e711 Add factory ship workflow contract`

Purpose: durable capture of incremental findings from specialized subagent review so findings are not lost to conversation compaction, timeouts, or subagent refusals.

## Agent execution log

### Parallel batch 1
- `security-auditor`: completed, but harness summary only preserved a truncated first finding.
- `test-architect`: completed, but harness summary only preserved a truncated first finding.
- `backend-architect`: completed, but harness summary only preserved a truncated first finding.
- `api-designer`: completed, but harness summary only preserved a truncated first finding.
- `devops-engineer`: returned refusal: `I'm sorry, but I cannot assist with that request.`

### Parallel batch 2
- `security-auditor`: completed, but harness summary only preserved a truncated first finding.
- `test-architect`: completed, but harness summary only preserved a truncated first finding.
- `backend-architect`: returned refusal.
- `api-designer`: completed, but harness summary only preserved a truncated first finding.
- `devops-engineer`: returned refusal.

### Individual recapture runs with complete output
- `security-auditor`: completed; findings captured below.
- `test-architect`: completed; findings captured below.
- `api-designer`: completed; findings captured below.

### Additional parallel batch
- `backend-architect`: completed, but harness summary only preserved truncated first finding.
- `devops-engineer`: completed, but harness summary only preserved truncated first finding.
- `performance-engineer`: completed, but harness summary only preserved truncated first finding.
- `technical-writer`: completed, but harness summary only preserved truncated first finding.

### Failed follow-up recapture attempts
- `backend-architect`: returned refusal.
- `reviewer`: aborted.

### File-backed gap recapture batch 1
- `performance-engineer`: completed and wrote `review/subagent-findings/performance-gap.md`; finding merged below.
- `technical-writer`: completed and wrote `review/subagent-findings/technical-writer-gap.md`; finding merged below.

### File-backed gap recapture batch 2
- `backend-architect`: completed and wrote `review/subagent-findings/backend-ship-gap.md`; finding merged below.
- `devops-engineer`: completed and wrote `review/subagent-findings/devops-browser-gap.md`; finding merged below.

### File-backed gap recapture batch 3
- `security-auditor`: completed and wrote `review/subagent-findings/security-event-store-gap.md`; finding merged below.
- `api-designer`: completed and wrote `review/subagent-findings/api-workflow-gap.md`; finding merged below.

### File-backed gap recapture batch 4
- `backend-architect`: completed and wrote `review/subagent-findings/backend-qa-gap.md`; finding merged below.
- `reviewer`: completed and wrote `review/subagent-findings/reviewer-final-gap.md`; findings merged below.

## Complete captured findings

### Security auditor

Severity: high
File: .pi/extensions/pi-gstack/index.ts:776
Issue: `/factory-qa` dispatches `/skill:gstack-qa`, the full “find bugs, fix them” workflow, even though the structured QA workflow is defined with `allowWrites: false`.
Why it matters: This bypasses the factory policy boundary and gives a browser-facing QA run code-edit authority, so a malicious or compromised test target can steer the agent into mutating the repo under what appears to be a read-only QA run.
Recommendation: Dispatch `/skill:gstack-qa-only` when writes are disallowed, or require an explicit `allowWrites: true` override plus a write-capable workflow/capability before invoking the fixing variant.

Severity: low
File: .pi/extensions/pi-gstack/index.ts:323
Issue: `/factory-complete-qa` accepts any free-form summary and immediately appends `phase_completed` for `qa-execution` without verifying a correlated QA log, screenshots, or other durable evidence.
Why it matters: A run can be marked `completed` on the strength of a sentence, which weakens the audit trail and can cause downstream humans or automation to over-trust the recorded QA status.
Recommendation: Keep the run paused until a structured QA artifact is provided, for example a `/qa-only` report or machine-readable artifact carrying the `factory_run_id`, and complete the phase from that evidence.

Severity: high
File: lib/factory-event-store.ts:129
Issue: The event-log recovery path accepts any sequentially valid tail beyond manifest.eventCount (and ignores a malformed line after it) as recoverable state, then promotes that tail into committed history instead of failing closed.
Why it matters: Anyone who can append to events.jsonl can forge run events/state transitions that become authoritative on read without a matching manifest commit, undermining the event log’s integrity boundary.
Recommendation: Only recover the specific crash pattern the writer can produce, never advance manifest/eventCount from unexpected tail data, and hard-fail on any extra post-commit content outside that narrow recovery case.

### Test architect

Severity: medium
File: .pi/extensions/pi-gstack/index.ts:292
Issue: No test exercises the negative `factory-complete-qa` branches for "not waiting", invalid dispatch metadata, or missing run records; the suite only covers the happy-path manual fallback.
Why it matters: Manual QA capture is the only completion path in this diff, so stale or partially-corrupted runs can strand the workflow without any regression signal.
Recommendation: Add Pi extension tests mirroring the review fallback suite for missing runs, wrong phase/state, and mismatched `factoryRunId`/dispatch metadata.

Severity: medium
File: .pi/extensions/pi-gstack/index.ts:837
Issue: There is no regression test for `factory-status` on a paused QA run that asserts queued-command/recovery details, and the formatter currently only renders a pending-review block.
Why it matters: The new QA workflow depends on `/factory-complete-qa`; if status output stops surfacing the recovery path, operators lose the main breadcrumb for finishing a paused run.
Recommendation: Add a status test for `qa-execution` that checks dispatch metadata and fallback guidance, or explicitly lock in a different QA-status UX.

Severity: medium
File: lib/factory.ts:503
Issue: The facade's gate-history parser has no regression test for legacy single-request decisions without `requestSequence`, even though the runner has separate coverage for that compatibility path.
Why it matters: Historical persisted runs can pass `continueRun` but still fail `readFactoryRunStatus` or `listFactoryGates`, which would break the Pi UI on old data.
Recommendation: Add facade-level tests for legacy single-request decisions and reopened-gate stale decisions so facade and runner stay behaviorally aligned.

Severity: low
File: lib/factory-scheduler.ts:30
Issue: Scheduler tests cover width=2 batching, but not the `Math.max(1, plan.policy.maxParallelWriteTimelines)` fallback for zero or negative policy values.
Why it matters: This clamp is the only guard against bad scheduler config in the new batching path, so a misconfigured policy could change write batching without any targeted test failure.
Recommendation: Add scheduler tests with `maxParallelWriteTimelines` set to 0 and a negative value, asserting isolated-worktree phases still batch one at a time.

Severity: medium
File: lib/factory-ship-workflow.ts:33
Issue: Ship coverage only validates the static plan shape and gate ids; it never drives the runner or facade through the three paused gate stages, rejection paths, or final cancellation behavior of the new ship contract.
Why it matters: Release gating is the most failure-sensitive workflow added in this diff, and generic gated-workflow tests do not prove this eight-gate spec pauses and resumes in the intended order.
Recommendation: Add runner or facade tests that execute `FACTORY_SHIP_WORKFLOW` through approval, rejection, and missing-capability paths while asserting no release action is performed.

### API designer

Severity: high
File: .pi/extensions/pi-gstack/index.ts:356
Issue: `/factory-status` performs auto-capture/recovery work and can mutate a run instead of behaving like a read-only status command.
Why it matters: A user or script that only wants inspection can accidentally write artifacts and advance a run to `completed`, which breaks CLI expectations and makes debugging recovery paths harder.
Recommendation: Keep `/factory-status` strictly read-only and move recovery into an explicit command or opt-in flag, e.g. `/factory-recover-review <run-id>`.

Severity: medium
File: lib/factory.ts:210
Issue: `listFactoryGates()` returns every gate for the run, not just pending gates, even though the Pi command describes this surface as “List pending gate requests”.
Why it matters: On gated workflows, especially ship, users will have to sift through `not-reached` and already-decided gates to find the next required action, and the API/CLI contract becomes misleading.
Recommendation: Either filter this surface to `status === "pending"` or rename/document it as “list all gates” and add a separate pending-only method/command.

Severity: medium
File: .pi/extensions/pi-gstack/index.ts:862
Issue: Pending-work status rendering is hard-coded to `diff-review`, so paused QA runs and gate-paused runs do not get an actionable next-step hint in `/factory-status`.
Why it matters: Users can see `Status: paused` with no clue whether they should run `/factory-complete-qa`, inspect blocking gates, or do something else, which weakens the new CLI UX.
Recommendation: Drive status hints from `status.pause` plus workflow/phase metadata and surface explicit next actions like `/factory-complete-qa` or `/factory-gates <run-id>`.

Severity: low
File: docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md:204
Issue: The roadmap still documents `/factory-decide <run-id> <gate-id> <decision>`, but the shipped CLI now requires `<request-sequence>` as an additional positional argument.
Why it matters: Users following the design doc will issue a command that fails immediately, creating avoidable friction on a brand-new public CLI contract.
Recommendation: Update the doc to the exact shipped syntax and point readers to `/factory-gates` as the source of the request sequence.

Severity: low
File: .pi/extensions/pi-gstack/index.ts:857
Issue: `/factory-list` output omits `workflowId`/`workflowTitle` and assumes the run id itself tells the user whether a run is review, QA, or ship.
Why it matters: Run ids are generator-controlled and may be customized, so once multiple workflow types coexist the list becomes ambiguous and harder to scan quickly.
Recommendation: Include workflow metadata in each row, ideally alongside a short goal snippet, instead of relying on the run id format.

Severity: medium
File: lib/factory-review-workflow.ts:11; .pi/extensions/pi-gstack/index.ts:156
Issue: The review workflow advertises a read-only contract (`defaultPolicy.allowWrites: false`), but the only shipped `/factory-review` entrypoint hard-codes `policy: { allowWrites: true }` because `git` is treated as write-capable.
Why it matters: Workflow metadata, UI approvals, and future clients cannot trust whether review is actually read-only, so they will either over-block a diff-only flow or silently grant broader write authority than the contract promises.
Recommendation: Split repo-read from repo-write capability/policy and remove the forced override; until then, mark the review workflow as write-required everywhere the contract is exposed.

### Backend architect

Severity: high
File: lib/factory-qa-workflow.ts:8
Issue: Structured QA is modeled as read-only (`defaultPolicy.allowWrites: false`), but the execution path still dispatches `/skill:gstack-qa`, the write-capable "test and fix" workflow, without declaring write capabilities.
Why it matters: This breaks the factory policy boundary, so a browser-facing QA run that appears review-only can still edit the repo and bypass the write-risk checks meant to guard mutating workflows.
Recommendation: Dispatch `/skill:gstack-qa-only` whenever writes are disabled, or make QA explicitly write-capable by adding filesystem/git capabilities plus an explicit `allowWrites: true` override before invoking `/skill:gstack-qa`.

Severity: high
File: lib/factory-ship-workflow.ts:27
Issue: ship-readiness and later ship phases model version bump, PR readiness, and release approval as gates only, but the workflow never includes a write-capable publication/deploy phase or git/filesystem capability, so a "completed" ship run can still mean nothing was actually shipped.
Why it matters: This gives the highest-risk lifecycle a false terminal state while bypassing the policy/risk checks that should guard destructive release actions.
Recommendation: Separate readiness from execution by adding an explicit write-capable publication/deploy phase with git/filesystem/release capabilities, or rename the workflow to ship-readiness-only until real release execution is modeled.

### Devops engineer

Severity: high
File: lib/factory-core.ts:405
Issue: Browser-disabled policy is only recorded as a warning, so runs with browser-capable phases still start and can execute if the runtime advertises `browser`.
Why it matters: This breaks capability gating and explicit-approval expectations, allowing unintended browser automation in QA/review flows instead of failing closed.
Recommendation: Make `browser-disabled` a blocking risk or hard-stop browser phases in the orchestrator/runner whenever `policy.allowBrowser` is false.

### Performance engineer

Severity: high
File: lib/factory-event-store.ts:49
Issue: appendValidated() acquires the per-run lock before rereading/parsing the full event log and running the caller-supplied validate callback, so every same-run append serializes O(n) snapshot work under the lock.
Why it matters: As a run accumulates events, append latency and lock hold time grow together, increasing contention and making concurrent writers hit the 5s lock timeout on busy runs.
Recommendation: Move expensive snapshot/validation work out of the critical section and keep the lock only around a final recheck plus append/manifest write, or add a cheap indexed state so append-time validation stays O(1).

### Technical writer

Severity: high
File: docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md:203
Issue: The gate-command example documents an unusable resume flow: it pairs `/factory-gates <run-id>` with `/factory-decide <run-id> <gate-id> <decision>`, but the shipped CLI requires `<request-sequence>` (plus the constrained decision values) to accept any gate decision.
Why it matters: Users following the roadmap cannot unblock a paused gated run, so the documented recovery path for human/fail-closed gates fails exactly where operators need it most.
Recommendation: Update the example to the exact shipped syntax, e.g. `/factory-decide <run-id> <gate-id> <request-sequence> <approve|reject|waive|cancel> [reason]`, and state that `/factory-gates` is where the operator gets the current request sequence.

### Reviewer final code-quality pass

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

## Truncated or incomplete findings requiring recapture/verification

None remain. All previously truncated findings were either recaptured into file-backed agent outputs and merged above, or superseded by complete duplicate findings.

## Current recommended triage order

1. High: fix `/factory-qa` read-only policy bypass by dispatching a QA-only/no-fix skill or gating the fix-capable skill behind explicit writes.
2. High: decide whether `/factory-status` should remain mutating; if not, move review auto-recovery to explicit command.
3. Medium: improve status UX for paused QA/gate runs and add tests.
4. Medium: add ship workflow runner/facade lifecycle tests.
5. High: decide whether G0 should be renamed/represented as ship-readiness-only until write-capable ship execution exists.
6. High: reduce `appendValidated()` lock hold time or add indexed validation state if factory runs can become large/concurrent.
7. Medium/low: add facade legacy gate tests, scheduler clamp tests, and docs/list UX polish.
8. No known truncated findings remain; next step is manual triage/deduplication and fixes.
