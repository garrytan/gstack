# Plan: cache profile summaries in one process

## Measured problem and accepted scope
The existing profile-summary service has one active process. A one-week trace
shows repeated reads of about 900 hot keys: DB CPU is 70%, with read p95 120 ms.
Add a process-local LRU wrapper to the existing repository. Acceptance targets
are at least 60% cache hits, DB CPU below 50%, and read p95 below 60 ms, with the
existing error-rate and correctness SLOs unchanged. This is an internal backend
change with no UI, API, schema, pricing, or developer onboarding change.

## Existing contracts retained
- All reads and writes use this repository in the same process; there are no
  external DB writers. Multi-process operation remains unsupported and startup
  rejects that configuration while caching is enabled.
- These surrounding contracts are accepted fixture facts, supplied by the
  existing repository, cache adapter and rollout controller. Preserve them;
  review the new wrapper ordering below against them.
- Authentication and authorization run before repository access. Keys encode
  the authenticated tenant ID and validated profile ID without ambiguity.
  Values are immutable profile-summary DTOs; secrets and cache keys are never
  logged. Cached results cannot bypass authorization.
- The existing LRU adapter supports 1000 entries, a 16 MiB byte cap, and a
  30-second TTL. Recorded hot data fits those limits. repository.read returns
  an immutable absent-result DTO for a missing record, never undefined. The
  adapter recognizes that DTO in cache.set, stores an internal sentinel with a
  10-second TTL, and cache.get decodes it back to the same absent-result DTO.
  The internal sentinel cannot escape the adapter; undefined means a cache miss.
- Cache operations are synchronous and atomic in the single JS event loop.
  On any cache failure the existing adapter bypasses the cache until an empty
  cache is reinitialized; repository errors keep the current typed API error
  mapping. The existing per-key single-flight wrapper sits inside
  repository.read, coalesces simultaneous store reads and releases on failure.
  A committed repository.write retires that key's old read cohort before its
  promise resolves. A later repository.read starts a fresh cohort; a rejected
  write leaves the cohort unchanged. Already-started readers may finish with
  their earlier snapshot. This admission rule does not inspect cache fills.
- The repository uses an in-process transactional store, with no network
  transport between this wrapper and the store. repository.write is atomic:
  a resolved promise means committed, and every
  rejected promise guarantees no commit; its transaction rolled back before
  rejection. Existing contract tests exercise that guarantee.
- Consistency is measured at the public wrapper boundary. A write completes
  when writeProfile's promise fulfills after cache.delete, not when
  repository.write commits or resolves. A read begins when readProfile is
  invoked. Reads that overlap an unfinished writeProfile may return an earlier
  snapshot, including reads begun after the store commit but before the wrapper
  promise fulfills. Every read begun after that write completes must
  observe the committed version. TTL expiry is not a substitute for this rule.

## Proposed wrapper integration
Keep the current read-through repository interface and shared adapters. These
are the new read/write ordering rules as originally proposed. **Amended by CEO review
D1 (CEO-F1):** the original text proposed no coordination between a cache fill and a
write; that contradicts the retained consistency rule (see CEO-F1 below). Required
guarantee added: `readProfile` must skip its `cache.set` when a `writeProfile` for the
same key completed `cache.delete` after that read began (a per-instance write-completion
token checked synchronously around the fill; representation chosen by engineering). The
sketch below is the pre-amendment baseline, retained for review traceability:

```javascript
async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await repository.read(key);
  cache.set(key, value);
  return value;
}

async function writeProfile(key, update) {
  const saved = await repository.write(key, update);
  cache.delete(key);
  return saved;
}
```

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, authorization, and startup rejection of multi-process
operation while caching is enabled. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, and concurrent-miss coalescing.
**Added by CEO review D1 (CEO-F1), deterministic schedules on the existing harness:**
(a) read pauses after its store snapshot, write commits + deletes + fulfills, read resumes:
fill must be skipped and a fresh read must observe the committed version; (b) read fills
before the write completes: delete must remove it and a fresh read observes the committed
version; (c) same as (a) for a missing record created by the write: absent sentinel must
not be installed after creation; (d) rejected write leaves the cache and token unchanged;
(e) two overlapping writes: a fresh read after both complete observes the last commit.
The rollout uses the existing runtime feature flag: enable for 10% of keys,
then 50%, then all keys after one healthy hour at each stage. Monitor hit/miss,
eviction, cache bytes, fallback errors, DB CPU, and read p95 without raw IDs.
The existing controller uses one shared key-selection predicate for reads and
writes. On any enable, disable or percentage change, it stops admitting work,
awaits every admitted old-instance write, then publishes a new wrapper/cache
instance with a fresh single-flight cohort before admitting new work. Old reads
retain their old instance and cannot fill the new one. Disabled instances
bypass the cache on both paths. Tests cover the old-writer/new-reader ordering,
all those transitions and predicate parity. This lifecycle isolation does not coordinate
an ordinary DB write with a cache fill in the same active instance.
Existing dashboards and runbooks cover these metrics. Before each stage, verify
that alerts page the service owner on any correctness/error-SLO breach, read
p95 above 120 ms for five minutes, or cache bypass persisting for one minute.
Hit rate is hits / (hits + misses) among requests admitted to the cache path;
flag-excluded or adapter-bypassed requests are tracked separately, not as misses.
DB CPU and read p95 are service-wide metrics, including bypassed requests.
At the 10% and 50% stages, a healthy hour requires at least 60% admitted-request
hits, unchanged correctness/error SLOs, no alerts, and aggregate DB CPU/read p95
no worse than their 70%/120 ms pre-rollout baselines. At 100%, the original
absolute acceptance targets (DB CPU below 50%, read p95 below 60 ms, hits at
least 60%) must all hold with unchanged correctness/error SLOs and no alerts.
Any breach disables the flag immediately; the runbook records the incident,
rollback and criteria for resuming. These are existing
rollout-controller and telemetry contracts, not proposed wrapper additions.
Cold starts remain within the existing DB capacity. The service owner monitors
the rollout and records the results against the acceptance targets.

## Out of scope
Distributed caching, cross-process coherence, prewarming, changing consistency
semantics, or adding new product surfaces. The repository interface preserves a
future replacement path without introducing a general cache framework now.

## Author's review and acceptance requirements
This is a full CEO scope and feasibility review. The author has approved the
retained contracts, limits, rollout and acceptance targets above. Evaluate the
proposed wrapper against them; the wrapper itself remains unapproved. An actual
contradiction or missing proof must be reported and resolved, not assumed away.
For a demonstrated gap, amend the plan with the required guarantee, a feasible
remedy, its tradeoffs and deterministic regression scenarios. Those repairs
and their required verification are within the requested scope. The exact data
structures, full function bodies and executable test code belong to subsequent
engineering planning; do not select or implement them during this review when
the required behavior and feasibility can already be established.

Use the existing deterministic repository-contract test harness. Required wrapper
acceptance includes both completion orders of overlapping reads and writes,
missing-record creation, rejected reads/writes, overlapping writes, and isolation
across controller instance changes. Use existing telemetry to record any added
branch on the current dashboard with no key labels; no new alert threshold or metric
project is requested. These are future acceptance requirements, not tests already
implemented or passing. Preserve all 11 review outcomes, required registries,
diagrams, tasks, completion summary and the full GSTACK REVIEW REPORT.

---

# CEO Review (plan-ceo-review, 2026-10-04, HOLD SCOPE)

Run notes: automated fixture run, no human present. Preamble/system audit, environment
setup, telemetry, design-doc offer and learnings-search skipped per run rules. Outside
review: `codex_reviews: disabled` in `.gstack-section-state-Zns2Y9/config.yaml`, so the
outside voice step and its native fallback are skipped and recorded as disabled coverage.
Base branch: main (git read-only snapshot; no git commands run).

## Step 0

**Review depth:** implementation-ready for wrapper ordering, rescue and test behavior.
Author policy limits: data structures, function bodies and executable test code stay
with engineering planning; this review records required guarantees and feasibility.
**Storage policy:** working plan = this file (requested output); scoped Edits at checkpoints.
**Stated limits (kept):** LRU 1000 entries, 16 MiB, 30 s TTL, 10 s absent sentinel;
targets hits >= 60%, DB CPU < 50%, read p95 < 60 ms; rollout 10% -> 50% -> 100%,
one healthy hour per stage. Deliverables: 1 wrapper module edit + 1 wrapper test file
(estimate: 2 changed files, excluding unchanged reused adapter/controller/repository).

### Decision ledger

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| CEO-F1 (Section 1 / Section 4; owner: wrapper engineering) | Consistency rule, PLAN.md "Existing contracts retained" last bullet: every read begun after writeProfile completes must observe the committed version; TTL is not a substitute. Single-flight bullet: already-started readers may finish with their earlier snapshot; admission rule does not inspect cache fills. Proposed wrapper (PLAN.md readProfile/writeProfile): fill after `await repository.read` with no guard; plan states no fill/write coordination. | Proposed wrapper as written: unguarded `cache.set` after read; `cache.delete` after commit. | A) fill-after-write guard required in wrapper; B) keep wrapper, accept TTL-bounded staleness; C) move fill coordination into repository single-flight cohort. | approved | D1 answered A (auto-decision authorized by the run's author policy: "Authorize complete remedies and required verification that restore its retained contracts... use the recommended option"). Scope: wrapper must skip a cache fill when a writeProfile for that key completed cache.delete after the read began; deterministic regression schedules for both completion orders and missing-record creation; one added branch recorded on the existing dashboard with no key labels. Token mechanism left to engineering. B declined (weakens retained contract). C declined (changes accepted fixture contract). |

### 0A. Premise Challenge
Real problem: ~900 hot keys re-read from the DB; DB CPU 70%, read p95 120 ms (one-week
trace). Target: hits >= 60%, DB CPU < 50%, p95 < 60 ms, SLOs unchanged. Do-nothing cost:
DB saturation headroom shrinks; latency stays 2x the target. The plan attacks the pain
directly (repeat reads of a small hot set in one process), not a proxy. OK.

### 0B. Existing Code Leverage
Repository (single-flight, typed errors, absent DTO), LRU adapter (limits, sentinel,
bypass-on-failure), rollout controller (instance swap, predicate parity), telemetry and
runbooks are all reused unchanged. Only the thin wrapper and its tests are new. No rebuild.

### 0C. Dream State Mapping
```
  CURRENT STATE                  THIS PLAN                  12-MONTH IDEAL
  Every hot read hits the  --->  process-local LRU in   --->  repository interface
  DB; CPU 70%, p95 120 ms        front of repository;         still the seam; swap
  one process, no cache          hits >= 60%, p95 < 60 ms     adapter if multi-process
                                                              ever becomes supported
```
Moves toward the ideal without committing to a distributed cache. OK.

### 0D
No approach choice was needed in Step 0: the requested plan (A, current) is the only
approach consistent with the accepted contracts. Section findings use 0D below.

### 0E. Mode Selection
Explicit user instruction: HOLD SCOPE. Mode: HOLD SCOPE; approved decisions: none.
Application: preserve scope, maximum rigor on failures, ordering, tests, observability.
Provenance: explicit user choice; no question asked, no question log.
No new approach decision was needed.

### 0G. HOLD SCOPE checks
1. Complexity: ~2 changed files, 0 new classes/services. No challenge needed.
2. Minimum change: wrapper + tests is already minimal. Nothing deferrable without
   blocking the acceptance targets. No deferral questions.
3. Invariants and acceptance criteria retained; repairs needed to meet them (CEO-F1) are in scope.

### 0I. Temporal Interrogation
```
  HOUR 1 (foundations):     Adapter/sentinel semantics; undefined = miss; absent DTO round-trip.
  HOUR 2-3 (core logic):    Fill-after-write race (CEO-F1); where the guard token lives.
  HOUR 4-5 (integration):   Controller instance swap; flag predicate parity; bypass paths.
  HOUR 6+ (polish/tests):   Deterministic pause/release schedules; fake clock for TTL.
```
Feasibility blocker: CEO-F1 (resolved below). Pending choices left to engineering:
guard token representation, TTL clock injection. Effort: human ~2 days / CC ~30 min.

## Section 1: Architecture Review

**Current scope:** Mode HOLD SCOPE (explicit user instruction). Governing rows: CEO-F1
pending. Accepted: wrapper + tests + existing rollout. Deferred/rejected: none.

Dependency graph (new component marked *):
```
  caller -> auth/authz -> [readProfile/writeProfile]* -> LRU adapter (existing)
                                   |                        
                                   +-> repository (single-flight, typed errors) -> in-process store
  rollout controller (existing) --publishes/retires--> wrapper+cache instance*
```
Data paths: happy (miss -> store -> fill -> return), nil (absent DTO -> sentinel 10 s ->
decoded DTO), empty (n/a: DTOs immutable, no empty payloads), error (read rejects -> no
fill -> typed error; write rejects -> no delete -> cache retains committed value, correct
because rollback is guaranteed). Scaling: 10x load is served from cache; 100x saturates
the single process before the DB. SPOF: the one process (pre-existing). Security: no new
surface. Rollback: flag off -> controller swaps to bypass instance; seconds.

**CRITICAL GAP (CEO-F1) — stale fill after a completed write.** A read that starts before
a write can resolve its store snapshot after `writeProfile` has already run `cache.delete`
and fulfilled. Its `cache.set` then installs the pre-write value (or the absent sentinel
for a just-created record). Every later read hits that stale entry for up to 30 s (10 s
for the sentinel), violating the retained rule that every read begun after the write
completes observes the committed version. The retained single-flight rule explicitly lets
already-started readers finish with their earlier snapshot and does not inspect fills; the
controller isolation covers instance swaps only. Nothing in the plan prevents this schedule.
Schedule proof: Section 4.

## currentDecision (CEO-F1)
Commitment comparison:
```text
Commitment | Source/approval or pending | Current | A | B | C
Read-after-write visibility at wrapper boundary | retained contract (PLAN.md consistency bullet) | violated by stale fill | kept | weakened to TTL bound | kept
Wrapper read/write ordering | proposed, unapproved | unguarded fill | fill guarded by write completion | unchanged | unchanged in wrapper
repository single-flight contract | accepted fixture fact | does not inspect fills | unchanged | unchanged | changed (must inspect fills)
Adapter limits / TTL / sentinel | accepted fixture fact | 1000 / 16 MiB / 30 s / 10 s | unchanged | unchanged | unchanged
Regression tests: both completion orders, missing-record creation | author acceptance requirement | required, not implemented | added as deterministic schedules | would need to expect stale reads (not allowed) | added at repository level |
Added branch on dashboard, no key labels | author permits existing telemetry | none | one "fill suppressed" branch | none | none |
Completeness: A=10/10, B=3/10, C=7/10
```

Question: D1 — CEO-F1: How does the wrapper prevent a read begun before a write from filling the cache after that write completes?
Project: profile-summary service, branch main, process-local LRU wrapper plan.
ELI10: A slow read can fetch the old value, then a write finishes and clears the cache, then the slow read puts the old value back. Everyone sees stale data for 30 seconds. The plan promises that never happens after a write completes.
Stakes if we pick wrong: correctness SLO breach and stale profiles after every write that overlaps a read; the rollout would be rolled back on alerts.
Recommendation: A because it keeps the retained consistency contract with the smallest clear diff (explicit over clever) and leaves the token mechanism to engineering.
Completeness: A=10/10, B=3/10, C=7/10
Pros / cons:
A) Require a fill-after-write guard in the wrapper (recommended)
  ✅ Preserves the retained read-after-write rule; stale fill becomes impossible by construction
  ✅ Local to the wrapper; adapter, repository and controller contracts stay untouched
  ❌ Adds one small piece of per-instance state and one extra branch to test and chart
B) Keep the wrapper as proposed; accept staleness bounded by TTL
  ✅ Zero implementation work beyond the proposed wrapper (effort S, nothing new to build)
  ✅ Simplest code; no extra state in the wrapper
  ❌ Weakens a retained contract; TTL is explicitly not a substitute, so this cannot be authorized
C) Move fill coordination into repository single-flight cohort retirement
  ✅ Centralizes ordering in one place for all future callers of the repository
  ✅ Guard would cover any other caller that fills caches from repository reads
  ❌ Changes an accepted fixture contract (admission rule does not inspect fills); wider, riskier diff
Net: A fixes the demonstrated gap inside the new code; B breaks the promise; C fixes it by rewriting an accepted contract.
Header: Stale fill guard
A) Guard wrapper fill (recommended)
Require: a read's cache.set is skipped when a writeProfile for that key completed cache.delete after the read began. Effort S, risk low, reuses adapter and harness; verification: both completion orders and missing-record creation as deterministic schedules. ✅ keeps retained contract ✅ wrapper-local change ❌ one more branch and token state.
B) Keep wrapper, TTL bound
Keep the proposed ordering and rely on 30 s / 10 s TTL to age out stale fills. Effort S, zero implementation work, risk high; verification would have to assert stale reads. ✅ nothing to build ✅ simplest code ❌ violates retained consistency rule, not authorizable.
C) Coordinate in repository
Make repository single-flight retirement reject fills from retired cohorts. Effort M, risk medium, reuses single-flight; verification at repository contract level. ✅ one central guard ✅ covers other callers ❌ rewrites an accepted fixture contract and widens the diff.

**Answer D1: A (authorized auto-decision, see ledger row CEO-F1).** Plan amended in
"Proposed wrapper integration" and "Verification and rollout". Section 1 outcome: 1 issue (CEO-F1, remedied).

## Section 2: Error & Rescue Map
```
  METHOD/CODEPATH          | WHAT CAN GO WRONG                    | EXCEPTION CLASS
  -------------------------|--------------------------------------|------------------
  readProfile#cache.get    | adapter failure                      | adapter-internal (bypass)
  readProfile#repo.read    | store failure / timeout              | typed repository error
                           | invalid key / unauthorized           | typed validation/auth error
  readProfile#cache.set    | adapter failure, byte cap, stale fill| adapter-internal / CEO-F1 guard
  writeProfile#repo.write  | rejected (rolled back)               | typed repository error
  writeProfile#cache.delete| adapter failure after commit         | adapter-internal (bypass)

  EXCEPTION CLASS          | RESCUED? | RESCUE ACTION                         | USER SEES
  -------------------------|----------|---------------------------------------|---------------
  adapter-internal         | Y        | adapter bypasses cache until reinit;  | transparent;
                           |          | fallback error metric + 1-min alert   | slower reads
  typed repository error   | Y (exist)| existing API error mapping; no fill;  | existing typed
                           |          | single-flight released                | API error
  stale fill (CEO-F1)      | Y (D1)   | fill skipped; "fill suppressed" branch| fresh value
```
No catch-alls. **WARNING (W1, verification only):** a `cache.delete` adapter failure after
a committed write must not be reported as a write failure; the retained adapter contract
says failures bypass internally, so this is a determined check within the accepted
"adapter-failure fallback" coverage (write path), not a new choice. Outcome: 6 paths mapped, 0 open GAPS.

## Section 3: Security & Threat Model
No new endpoints, params, jobs or dependencies. Keys carry authenticated tenant + validated
profile ID (retained), so cross-tenant IDOR via cache is prevented (likelihood Low, impact
High, mitigated). Values are immutable DTOs; secrets and keys never logged (retained).
Stale-fill (CEO-F1) is correctness, not confidentiality. Flag predicate shared by reads
and writes prevents write-path/read-path asymmetry. Outcome: No issues found, 0 High.

## Section 4: Data Flow & Interaction Edge Cases
```
  INPUT(key) -> VALIDATION(auth/key, existing) -> cache.get -> [hit] OUTPUT
                                                     \-> [miss] repo.read -> guard -> cache.set -> OUTPUT
  shadow: absent -> absent DTO -> sentinel(10 s) -> decoded DTO     tested (accepted)
  shadow: read rejects -> no fill -> typed error                     tested (accepted)
  shadow: adapter failure -> bypass -> store read                    tested (accepted)
  shadow: byte cap / eviction -> entry dropped -> next read misses   tested (accepted)
```
Async ordering (invariant: a read begun after writeProfile fulfills observes the committed
version; boundary = readProfile call vs writeProfile fulfillment):
```
  t | readProfile R1 (begun before W) | writeProfile W        | cache[key] | store
  1 | get -> undefined (miss)         |                       | -          | v0
  2 | await repo.read (snapshot v0)   |                       | -          | v0
  3 |                                 | await repo.write      | -          | v1 committed
  4 |                                 | cache.delete; fulfill | -          | v1   <- W complete
  5 | resume: cache.set(key, v0)      |                       | v0 STALE   | v1
  6 | R2 begins: get -> v0            |                       | v0         | v1   <- VIOLATION
```
Reverse order (R1 fills at t3 before W deletes at t4) is safe: delete removes v0 and R2
misses to v1. Only the schedule above violates; single-thread execution does not exclude
it because the violation spans the `await`. Mechanism after D1: at t5 the guard sees a
write completion for the key after R1 began and skips the fill; R2 misses to v1. Same
proof covers the absent sentinel for missing-record creation. Regression proof: schedules
(a)-(e) in "Verification and rollout". Overlapping writes W1/W2: both delete; store holds
last commit; fresh read observes it. Interaction edge cases: no UI; double-submit handled
by store atomicity. Outcome: 6 edge cases mapped, 0 unhandled after D1.

## Section 5: Code Quality Review
Wrapper fits the existing read-through pattern; no duplication (adapter owns sentinel/TTL,
repository owns single-flight). Naming fine. The D1 guard adds one branch (<= 3 branches
per function). No over-engineering; keep the token per wrapper instance so the controller
swap discards it. Outcome: No issues found.

## Section 6: Test Review
```
  NEW THING                      | TYPE        | HAPPY             | FAILURE                 | EDGE
  readProfile hit/miss/fill      | unit (harness)| miss->fill->hit | repo.read rejects       | absent sentinel
  writeProfile commit+delete     | unit        | commit->delete    | write rejects, no delete| overlapping writes
  fill-after-write guard (D1)    | unit sched. | schedule (b)      | schedule (a),(c)        | (d),(e)
  adapter bypass                 | unit        | n/a               | get/set/delete failures | bypass persists alert
  controller instance swap       | integration (existing)| swap   | old writer/new reader   | predicate parity
```
Assertion check: each accepted requirement maps to an observable assertion (committed
version visible to a read begun after fulfillment; no sentinel after creation; cache
unchanged after rejected write). 2 am test: schedule (a). Hostile QA: schedule (c) plus
eviction mid-schedule. Chaos: adapter failure injected at t5. Pyramid: unit-heavy, correct.
Flakiness: TTL tests must use the harness's controlled clock (engineering detail, owner:
wrapper engineering; not a new decision). Outcome: diagram produced, 0 gaps after D1.

## Section 7: Performance Review
900 hot keys fit 1000 entries / 16 MiB (retained). Guard is O(1) synchronous per op; its
state must stay bounded (per-instance; engineering chooses per-key map with cleanup or a
process-wide generation; either satisfies D1). Slowest new path: miss + store read, same as
today. No new connections. Outcome: No issues found.

## Section 8: Observability & Debuggability Review
Existing metrics cover hit/miss/eviction/bytes/fallback/DB CPU/p95 without raw IDs. D1 adds
one "fill suppressed" counter on the current dashboard, no key labels (author-permitted).
Alerts and runbooks are existing contracts. Outcome: 0 gaps.

## Section 9: Deployment & Rollout Review
No migration. Flag-staged 10/50/100 with instance swap; rollback = disable flag (seconds).
Risk window: old-instance reads cannot fill the new instance (retained). D1 token lives in
the instance, so swaps reset it safely. Smoke: hit rate, fallback errors, suppressed-fill
count visible within first 5 minutes. Outcome: 0 new risks beyond retained contracts.

## Section 10: Long-Term Trajectory Review
Debt: 1 small item (guard token state). Path dependency: none; repository seam preserved.
Reversibility 5/5. Ecosystem fit: yes. 1-year clarity: add an ASCII comment of the
schedule above next to the guard. Outcome: Reversibility 5/5, debt items 1.

## Section 11: Design & UX Review
SKIPPED (no UI scope).

## Closing sequence
**Outside Voice:** Codex review skipped (codex_reviews disabled). Re-enable:
`gstack-config set codex_reviews enabled`. No native fallback (disabled means no extra
step). Disabled-coverage review-log write not persisted: gstack binaries are not installed
in this fixture and mutating commands are disallowed.
**TODO choices:** none proposed (HOLD SCOPE; no evidenced deferred gap). TODOS.md unchanged.
**Approval readiness: PASS** — CEO-F1: D1 answered A (authorized auto-decision, scope as
recorded in the ledger). No other rows. Declined B/C kept out of accepted work.

## NOT in scope
Deferred: none. Rejected: D1-B (TTL-bounded staleness; violates retained contract),
D1-C (repository-level fill coordination; changes an accepted fixture contract).
Original out-of-scope list retained above.

## What already exists
Repository single-flight + typed errors + absent DTO (reused); LRU adapter with limits,
sentinel and bypass (reused); rollout controller instance swap (reused); dashboards,
alerts, runbooks (reused). Nothing rebuilt.

## Dream state delta
After this plan: hot reads served in-process at target latency; repository seam intact
for a future adapter swap. Remaining distance to the 12-month ideal: multi-process
coherence stays unsupported by design.

## Error & Rescue Registry
See Section 2 table: 6 method/codepath rows, 3 exception classes, all rescued, 0 CRITICAL GAPS.

## Failure Modes Registry
```
  CODEPATH                 | FAILURE MODE            | RESCUED? | TEST? | USER SEES?      | LOGGED?
  -------------------------|-------------------------|----------|-------|-----------------|--------
  readProfile#cache.get    | adapter failure         | Y        | Y     | slower read     | Y (fallback metric)
  readProfile#repo.read    | store failure           | Y        | Y     | typed error     | Y (existing)
  readProfile#cache.set    | stale fill after write  | Y (D1)   | Y (a,c)| fresh value    | Y (suppressed counter)
  readProfile#cache.set    | byte cap / eviction     | Y        | Y     | miss next time  | Y (eviction metric)
  writeProfile#repo.write  | rejected / rolled back  | Y        | Y (d) | typed error     | Y (existing)
  writeProfile#cache.delete| adapter failure         | Y        | Y (W1)| slower reads    | Y (fallback metric)
```
6 total, 0 CRITICAL GAPS.

## Diagrams
1. System architecture: Section 1. 2. Data flow with shadow paths: Section 4.
3. State machine (cache entry):
```
  [absent] --fill(value)--> [cached v] --delete/TTL/evict--> [absent]
  [absent] --fill(absent DTO)--> [sentinel 10 s] --delete/TTL--> [absent]
  [any] --adapter failure--> [bypassed] --reinit--> [absent]
  invalid: fill after write completion -> prevented by D1 guard
```
4. Error flow: Section 2. 5. Deployment sequence: flag 10% -> healthy hour -> 50% ->
healthy hour -> 100% -> acceptance check (Section 9). 6. Rollback flowchart:
```
  alert/breach --> disable flag --> controller drains writes --> bypass instance --> incident + runbook
```
Stale diagram audit: no ASCII diagrams exist in touched files; 0 stale.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~20min)** — profile-summary wrapper — Add the fill-after-write guard required by D1 (CEO-F1) with the "fill suppressed" dashboard branch
  - Surfaced by: Section 1 / Section 4 — CEO-F1 stale fill after a completed write
  - Files: to be determined (wrapper module)
  - Verify: deterministic schedules (a)-(e) pass on the existing repository-contract harness
- [ ] **T2 (P1, human: ~1 day / CC: ~15min)** — wrapper tests — Implement schedules (a)-(e) plus W1 write-path adapter-failure check and TTL tests on a controlled clock
  - Surfaced by: Section 2 (W1), Section 4, Section 6
  - Files: to be determined (wrapper test file)
  - Verify: harness run green; each schedule fails when the guard is removed
_No new tasks from Sections 3, 5, 7, 8, 9, 10, 11._
Task JSONL: not persisted (gstack state root unavailable in this fixture).

## Completion Summary
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | HOLD SCOPE                                  |
  | System Audit         | skipped per run rules; fixture facts used   |
  | Step 0               | HOLD SCOPE (explicit); D1 CEO-F1 -> A       |
  | Section 1  (Arch)    | 1 issue found (CEO-F1, remedied)            |
  | Section 2  (Errors)  | 6 error paths mapped, 0 GAPS                |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 6 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 0 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 0 gaps found                                |
  | Section 9  (Deploy)  | 0 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 5/5, debt items: 1           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (2 rejected, 0 deferred)            |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 6 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 6 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
  | CEO plan             | skipped by mode                             |
  | Outside voice        | codex: disabled (no fallback)               |
  | Lake Score           | 1/1 recommendations chose complete option   |
  | Diagrams produced    | 6 (arch, data flow, state, error, deploy,   |
  |                      | rollback)                                   |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```
Review Log / dashboard: not persisted (gstack-review-log and gstack-review-read are not
installed in this fixture; mutating commands disallowed). Prior review history: unknown.
No durable learnings this session.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (not persisted) | CLEAR | mode: HOLD SCOPE, 0 critical gaps open (1 found, remedied by D1) |
| Outside Review | codex (disabled) | Independent 2nd opinion | 0 | DISABLED | codex_reviews disabled; no completed external review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | not run |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI scope) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **OUTSIDE COVERAGE:** provider codex, phase plan-review, disabled by config; no outside process started, no native fallback; 0 completed external reviews, no findings implied.
- **VERDICT:** CEO CLEARED — eng review required

NO UNRESOLVED DECISIONS
