# Factory D.1–G0 high-severity fix plan

Date: 2026-05-20
Branch: `pi-software-factory-core`
Input review: `review/factory-d1-g0-subagent-review.md`

## Goal

Make the Pi factory **capability-honest and safe for write-capable automation**.

The target is not “everything read-only.” The target is:

1. Workflows that read, write, browse, run tests, call CI, or prepare releases declare those capabilities truthfully.
2. Write-capable phases are allowed when they are explicit, gated, and auditable.
3. Shell/tool execution is constrained by a non-destructive command policy instead of relying on misleading read-only labels.
4. Inspect/status commands do not unexpectedly mutate durable run state; recovery and completion are explicit actions.
5. Event-store recovery preserves integrity first, then availability, so forged or ambiguous tails do not become authoritative state.
6. Docs and UX match the shipped command contracts.

## Non-goals

- Do not add production deployment, tag pushing, package publishing, or force-push behavior in this hardening pass.
- Do not broaden dependency/package/distribution surface unless explicitly approved.
- Do not make all workflows read-only. Write-capable QA/ship paths are acceptable when modeled and guarded.
- Do not run destructive shell commands during implementation or validation.

## Safety model for write-capable factory phases

Introduce or formalize a factory command-safety layer with at least these concepts:

- `commandSafetyProfile`: `read-only` | `non-destructive-write` | `release-action`
- `non-destructive-write` permits safe local edits and checks, but blocks destructive shell patterns by default.
- Blocked examples should include at minimum:
  - `rm -rf`, `git reset --hard`, `git clean`, `git push --force`, force tags, destructive migration/deploy commands, credential/env dumping.
- Release actions (`git push`, tag creation, publish, deploy, production CI dispatch) stay out of this pass or require a separate explicit G1/G2 gate.

Implementation can start as metadata + runtime adapter enforcement for factory-dispatched skills/commands, then become stricter as the adapter surface grows.

## High-severity findings to fix

### H1 — QA policy mismatch: read-only workflow dispatches write-capable skill

Finding sources:
- `security-auditor`
- `backend-architect`

Files:
- `lib/factory-qa-workflow.ts`
- `.pi/extensions/pi-gstack/index.ts`

Current problem:
- `FACTORY_QA_WORKFLOW` advertises `defaultPolicy.allowWrites: false`.
- `/factory-qa` dispatches `/skill:gstack-qa`, which is a “test and fix” workflow and may edit code.

Planned fix:
1. Split QA into explicit modes:
   - QA audit mode: no repo writes, dispatches `/skill:gstack-qa-only` or equivalent.
   - QA fix mode: write-capable, dispatches `/skill:gstack-qa`, declares filesystem/git/test capabilities, and requires `policy.allowWrites: true` plus `commandSafetyProfile: non-destructive-write`.
2. Choose a clear CLI contract:
   - Preferred: keep `/factory-qa` as audit/no-fix by default, add `/factory-qa --fix` or `/factory-qa-fix` for write-capable QA.
   - Acceptable alternative: make `/factory-qa` explicitly write-capable in title/status/docs, but only if command safety enforcement ships in the same change.
3. Add tests proving:
   - audit mode dispatches the no-fix skill;
   - fix mode requires write policy/capabilities;
   - missing write permission blocks before dispatch;
   - command/status output tells users whether fixes are allowed.

Validation:
- `bun test test/factory-qa-workflow.test.ts test/pi-extension.test.ts test/factory-runner.test.ts test/pi-runtime-adapter.test.ts`

### H2 — `/factory-status` mutates run state via auto-capture

Finding source:
- `api-designer`

Files:
- `.pi/extensions/pi-gstack/index.ts`

Current problem:
- `/factory-status` can auto-capture review artifacts and append completion events.
- A status/inspection command can therefore advance a run.

Planned fix:
1. Make `/factory-status` strictly inspect-only.
2. Move auto-capture/recovery to an explicit command, such as:
   - `/factory-recover-review <run-id>`
   - or `/factory-status <run-id> --recover` only if the command parser has safe flag support.
3. Status should show available recovery actions without doing them.
4. Keep agent-end hook recovery if it is already expected as an action boundary, but ensure it uses idempotent append validation from H8.

Validation:
- Add/adjust Pi extension tests:
  - status on recoverable pending review does not mutate;
  - explicit recovery command mutates and completes;
  - repeated recovery is idempotent or safely rejected.

### H3 — Event-store tail recovery can promote unexpected appended data

Finding source:
- `security-auditor`

Files:
- `lib/factory-event-store.ts`
- `test/factory-event-store.test.ts`

Current problem:
- Recovery accepts sequentially valid tail events beyond `manifest.eventCount` and advances manifest state.
- A forged or unexpected append to `events.jsonl` can become authoritative if it looks valid.

Planned fix:
1. Treat manifest as authoritative for normal reads.
2. Narrow automatic recovery to a writer-produced crash pattern that can be distinguished from arbitrary appended tail data.
3. If no trustworthy crash marker/protocol exists, prefer fail-closed/quarantine over manifest advancement:
   - preserve extra tail in a quarantine/recovery file;
   - report a clear corruption/recovery-needed error;
   - do not include the tail in reducer state.
4. Consider adding a small commit protocol for future safe recovery:
   - pending manifest or append marker written before event append;
   - envelope checksum in manifest;
   - only recover if marker/checksum matches.

Validation:
- Add event-store tests for:
  - stale manifest plus expected writer crash pattern recovers only if authenticated/marked;
  - unmarked valid-looking tail fails closed or is quarantined;
  - malformed tail after manifest fails closed/quarantines;
  - list/status do not include forged tail transitions.

### H4 — Browser-disabled policy is warning-only

Finding source:
- `devops-engineer`

Files:
- `lib/factory-core.ts`
- `test/factory-core.test.ts`
- runner/facade tests as needed

Current problem:
- `policy.allowBrowser: false` produces only a warning risk even when phases require `browser`.
- Runs can still start if runtime advertises browser.

Planned fix:
1. Make `browser-disabled` a blocking risk, consistent with writes/network policy gates.
2. Ensure runner preflight blocks when browser is disabled and a phase requires it.
3. Keep browser-enabled workflows explicit:
   - QA audit/fix workflows can set `defaultPolicy.allowBrowser: true` if browser use is expected.

Validation:
- Add core test: browser-required phase + `allowBrowser:false` has blocking risk.
- Add runner/facade test: run is blocked before dispatch when browser policy denies.

### H5 — Ship workflow can complete without shipping anything

Finding source:
- `backend-architect`

Files:
- `lib/factory-ship-workflow.ts`
- `test/factory-ship-workflow.test.ts`
- docs/UX as needed

Current problem:
- G0 workflow gates readiness/release approval but has no write-capable publication/deploy phase.
- A completed run may imply “shipped” despite no ship action occurring.

Planned fix:
1. In this hardening pass, rename/reframe G0 as **ship readiness**, not ship execution:
   - workflow id/title/description should make clear it produces a readiness plan/approval state;
   - completion summaries should not imply deployment/release happened.
2. Reserve real ship execution for G1 with explicit write/release capabilities:
   - `commandSafetyProfile: release-action`;
   - explicit gates;
   - no production push/deploy implementation until separately approved.
3. Add tests that assert G0 is readiness-only and has no release-action phase.

Validation:
- `bun test test/factory-ship-workflow.test.ts test/factory-runner.test.ts test/pi-extension.test.ts`

### H6 — `appendValidated()` holds the per-run lock across O(n) snapshot validation

Finding source:
- `performance-engineer`

Files:
- `lib/factory-event-store.ts`
- `test/factory-event-store.test.ts`

Current problem:
- `appendValidated()` locks, rereads/parses full event log, runs validation, and appends.
- Lock hold time grows with run history size and can cause avoidable contention/timeouts.

Planned fix:
1. First safe step: keep correctness, reduce duplicate work where possible.
2. Preferred design:
   - read snapshot outside lock;
   - acquire lock;
   - re-read only if manifest sequence changed;
   - validate against final snapshot;
   - append and write manifest;
   - keep the locked section as small as possible.
3. If validation still needs full reducer state, add a cheap indexed summary later.

Validation:
- Preserve existing event-store tests.
- Add contention/regression test around `appendValidated()` sequence behavior if practical without timing flakiness.

### H7 — Roadmap documents stale `/factory-decide` syntax

Finding sources:
- `technical-writer`
- `api-designer`

Files:
- `docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md`

Current problem:
- Docs say `/factory-decide <run-id> <gate-id> <decision>`.
- Shipped CLI requires `<request-sequence>`.

Planned fix:
1. Update examples to:
   - `/factory-gates <run-id>`
   - `/factory-decide <run-id> <gate-id> <request-sequence> <approve|reject|waive|cancel> [reason]`
2. Mention that `/factory-gates` is the source of the current request sequence.

Validation:
- Documentation review only; optionally grep docs for stale syntax.

## Related medium findings to fold into the same work where cheap

These are not high severity but are close to the high-severity changes and should be fixed opportunistically when touching the same files.

### M1 — Status output lacks actionable hints for QA/gate pauses

Files:
- `.pi/extensions/pi-gstack/index.ts`
- `test/pi-extension.test.ts`

Plan:
- Show next actions based on pause type:
  - pending QA manual completion: `/factory-complete-qa <run-id> ...`
  - pending gates: `/factory-gates <run-id>` then `/factory-decide ...`
  - pending review recovery: explicit recovery command.

### M2 — `listFactoryGates()` contract mismatch

Files:
- `lib/factory.ts`
- `.pi/extensions/pi-gstack/index.ts`

Plan:
- Either rename command text to “list all gates” or add pending-only filtering.
- Preferred: facade keeps all-gates DTO; Pi `/factory-gates` displays pending first and labels non-pending clearly.

### M3 — Facade gate decision with no runtime can strand approved runs

Files:
- `lib/factory.ts`
- `test/factory-facade.test.ts`

Plan:
- For non-terminal decisions (`approve`, `waive`), require runtime to resume or explicitly return `paused` with a next-action hint.
- Terminal decisions (`reject`, `cancel`) can remain runtime-free.

### M4 — Manual capture paths need append validation and idempotency

Files:
- `.pi/extensions/pi-gstack/index.ts`
- `test/pi-extension.test.ts`

Plan:
- Wrap manual review/QA completion and auto-capture completion in `appendValidated()`.
- Use unique artifact ids or validate no prior completion before writing final artifact.

### M5 — Coverage gaps

Files:
- tests listed in review report

Plan:
- Add negative QA completion tests.
- Add facade legacy gate tests.
- Add scheduler clamp tests.
- Add ship readiness lifecycle tests.

## Execution plan

### Phase 0 — Commit/review artifact hygiene

- Decide whether to commit review artifacts or keep them local.
- Do not stage unrelated dirty files: `CLAUDE.md`, `package-lock.json`.
- Continue using specific `git add` paths only.

### Phase 1 — Capability truthfulness and browser/write policy

Fix H1 and H4 first because they define the policy model for later phases.

Tasks:
1. Add/adjust command-safety/capability metadata in pure workflow specs and runtime adapter types.
2. Split QA audit/fix semantics or make QA honestly write-capable with non-destructive-write safety.
3. Make browser-disabled blocking.
4. Add focused tests.

Suggested validation:
```bash
bun test test/factory-core.test.ts test/factory-qa-workflow.test.ts test/factory-runner.test.ts test/pi-extension.test.ts test/pi-runtime-adapter.test.ts
bun -e "await import('./.pi/extensions/pi-gstack/index.ts'); console.log('pi extension import ok')"
```

### Phase 2 — Inspection/recovery boundaries and idempotent capture

Fix H2 and M4.

Tasks:
1. Make `/factory-status` inspect-only.
2. Add explicit `/factory-recover-review` or opt-in recovery flag.
3. Validate capture completion under lock.
4. Add QA/review negative tests.

Suggested validation:
```bash
bun test test/pi-extension.test.ts test/factory-facade.test.ts test/factory-event-store.test.ts
```

### Phase 3 — Event-store integrity and appendValidated performance

Fix H3 and H6 together because both touch event-store locking/recovery.

Tasks:
1. Redesign tail recovery to fail closed or recover only marked writer crash patterns.
2. Reduce `appendValidated()` lock hold time while preserving compare-and-append semantics.
3. Add corruption, forged-tail, and stale-manifest tests.

Suggested validation:
```bash
bun test test/factory-event-store.test.ts test/factory-runner.test.ts test/factory-facade.test.ts
```

### Phase 4 — Ship readiness naming and docs/UX alignment

Fix H5 and H7, plus M1/M2 where cheap.

Tasks:
1. Reframe G0 as ship readiness only.
2. Update CLI/status wording to avoid implying a release happened.
3. Update roadmap gate command syntax.
4. Improve status hints for QA/gates.
5. Add ship readiness lifecycle tests.

Suggested validation:
```bash
bun test test/factory-ship-workflow.test.ts test/pi-extension.test.ts test/factory-runner.test.ts
rg "/factory-decide <run-id> <gate-id> <decision>" docs review .pi lib test || true
```

### Phase 5 — Full targeted validation and review

Run the focused suite used for D.1–G0 plus import check:

```bash
bun test test/factory-ship-workflow.test.ts test/factory-qa-workflow.test.ts test/factory-review-workflow.test.ts test/factory-scheduler.test.ts test/factory-facade.test.ts test/factory-runner.test.ts test/factory-core.test.ts test/factory-event-store.test.ts test/factory-artifact-store.test.ts test/pi-runtime-adapter.test.ts test/pi-extension.test.ts test/factory-review-capture.test.ts test/pi-compatibility.test.ts
bun -e "await import('./.pi/extensions/pi-gstack/index.ts'); console.log('pi extension import ok')"
git diff --check HEAD
```

Then run a two-agent review pass max:
- `security-auditor` for policy/fail-closed checks.
- `reviewer` or `test-architect` for implementation/test quality.

## Agent/concurrency plan

Use at most two agents at a time.

- Planning/review agents can run in parallel and write only to `review/subagent-findings/` if needed.
- Implementation should be mostly serial in this worktree because the same files overlap heavily.
- If parallel write implementation is desired, create isolated worktrees first and assign non-overlapping scopes:
  - Worktree A: event-store integrity/performance.
  - Worktree B: Pi extension UX/status/recovery.
  - Main/integration: workflow policy semantics.

## Definition of done

All high-severity findings from `review/factory-d1-g0-subagent-review.md` are either:

1. fixed in code/docs/tests, or
2. explicitly reclassified in the plan with rationale and user approval.

Specific acceptance checks:

- QA mode cannot silently run write-capable fixing under a read-only policy.
- Browser-disabled policy blocks browser phases.
- Status does not mutate durable run state without an explicit recovery action.
- Event-store does not promote arbitrary post-manifest tail data.
- G0 completion language cannot be mistaken for a real release/deploy.
- Roadmap and CLI syntax agree for gate decisions.
- Targeted tests and import check pass.
