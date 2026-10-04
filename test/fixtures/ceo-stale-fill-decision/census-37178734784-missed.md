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
are the complete new read/write ordering rules; no additional version checks or
coordination between a cache fill and a write are proposed:

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

### Accepted amendment (D1 / ledger row R1, 2026-10-04)
The sentence above, "no additional version checks or coordination between a
cache fill and a write are proposed", is superseded for one mechanism only.
Required guarantee: a cache fill produced by a readProfile call that missed the
cache before a later writeProfile on the same key completed must never be
admitted into the cache. writeProfile must invalidate the key synchronously in
the same event-loop tick after repository.write resolves (mark the key's write
generation as advanced, then cache.delete). readProfile must note the key's
write generation at miss time, and after repository.read resolves must call
cache.set only if that generation is unchanged, with the check and the set in
one synchronous segment (no await between them). A dropped fill increments an
existing-dashboard counter with no key labels. A rejected repository.write
changes nothing (no commit, no generation change, no delete). The bookkeeping
is only required while a miss is in flight for that key, so its size is bounded
by in-flight miss concurrency; the exact structure and code are engineering's.
Tradeoff: a read that began after the store commit but before writeProfile
completed is also dropped (an allowed earlier snapshot anyway), costing extra
misses only under write contention on the same key. Retained contracts, adapter
limits, TTLs and consistency semantics are unchanged.

Required deterministic regression scenarios (existing contract harness,
controlled promise release order):
- S1 read resolves before write commits: fill v0, write commits v1 and deletes, later read misses and returns v1.
- S2 write completes before the read's fill: read misses (snapshot v0), write commits v1, deletes, fulfills; read resolves v0 -> fill dropped, counter +1; a read begun after the write returns v1 from the store.
- S3 missing-record creation: absent fill (10 s sentinel) in the S1 order, and in the S2 order the absent fill is dropped so the created record is visible.
- S4 rejected read: typed error propagates, no fill, cache unchanged, single-flight released, next read succeeds.
- S5 rejected write: typed error propagates, no delete, no generation change, cached value retained, an overlapping in-flight read fills normally.
- S6 overlapping writes W1 (v1) and W2 (v2) with an interleaved read snapshotting v1: after W2 completes every read returns v2 and the v1 fill is dropped.
- S7 controller instance change during an in-flight read: old read cannot fill the new instance; new instance reads fresh (existing controller tests, re-run with the wrapper).
- S8 adapter failure during a miss: set/delete are bypassed, bypass counter rises, reinitialized cache starts empty, consistency holds.
- S9 generation bookkeeping releases after in-flight misses finish (bounded growth under a long write storm).

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, authorization, and startup rejection of multi-process
operation while caching is enabled. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, and concurrent-miss coalescing.
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

## Step 0 setup
- Platform/base branch: git commands prohibited for this run; base branch `main` taken from the host's git status snapshot. Platform unknown (not probed).
- Preamble/system audit/telemetry/brain/learnings/Aside: skipped per run rules (no skill-start echo; degraded mode, treated as interactive with author-authorized auto-decisions per the run policy). Outside review: `codex_reviews: disabled` in `.gstack-section-state-saJ9ki/config.yaml`.
- Review depth: implementation-ready (interfaces, codepaths, rescue behavior, tests), bounded by the author's rule that exact data structures, function bodies and executable test code stay with engineering.
- Storage policy: working plan and final output = this file (`PLAN.md`), scoped Edits at each checkpoint. TODOS.md: none exists; deferrals are recorded in the NOT in scope section (none so far).
- Mode: HOLD SCOPE, explicit user instruction ("Hold the current scope"). No mode question asked or logged. Section 11: no UI scope (internal backend change).
- Design doc: not probed (prohibited tooling); the plan's own "Measured problem" section is the problem statement.

### 0A. Premise Challenge
Real problem: ~900 hot profile-summary keys are re-read repeatedly from the DB; DB CPU 70%, read p95 120 ms. Target: hits >= 60%, DB CPU < 50%, p95 < 60 ms with correctness/error SLOs unchanged. Do-nothing cost: the DB stays the latency bottleneck and headroom shrinks as read volume grows. The plan attacks the pain directly (serve hot reads from process memory); it is not a proxy fix.

### 0B. Existing Code Leverage
| Sub-problem | Reused | Rebuild? |
|---|---|---|
| Bounded storage, TTL, byte cap, absent sentinel, failure bypass | existing LRU adapter | no |
| Thundering herd on a miss | existing per-key single-flight in repository.read | no |
| Staged rollout, instance swap, predicate parity | existing rollout controller + runtime flag | no |
| Auth, tenant-scoped keys, DTO immutability | existing repository contracts | no |
| Metrics, dashboards, alerts, runbooks | existing telemetry | no |
| New: read-through / write-invalidate ordering | the proposed wrapper (the only new code) | n/a |

### 0C. Dream State Mapping
```
  CURRENT STATE                      THIS PLAN                           12-MONTH IDEAL
  every hot read hits the DB  --->   process-local LRU in front of  --->  repository interface still the only
  DB CPU 70%, p95 120 ms             repository, same interface,          seam; cache tier replaceable
                                     flagged rollout, DB CPU <50%,        (distributed or not) without
                                     p95 <60 ms                           touching callers
```
The plan moves toward the ideal: it keeps the repository interface as the single seam and adds no framework.

### 0D. Approach decisions
0D was required once: the proposed ordering rules contradict the retained consistency contract (row R1 below). 0E then applied HOLD SCOPE. 0G HOLD SCOPE checks: 1 new wrapper, 0 new services, 2-3 planned changed files (wrapper module, wrapper tests, flag/controller wiring if any; estimate) -> no complexity challenge; minimum change is the wrapper; nothing deferrable without blocking the goal; invariant repairs are in scope.

## Decision ledger

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| R1 — wrapper author (Section 4 owner) | Retained contract "Every read begun after that write completes must observe the committed version. TTL expiry is not a substitute" (PLAN.md, Existing contracts retained, last bullet) vs proposed rules "no additional version checks or coordination between a cache fill and a write" (Proposed wrapper integration) and fixture facts "Already-started readers may finish with their earlier snapshot. This admission rule does not inspect cache fills". Schedule S2 (Section 4) shows a stale fill landing after writeProfile completes, served to later reads for up to 30 s. | readProfile: get -> miss -> await repository.read -> set. writeProfile: await repository.write -> delete. No fill/write coordination. | B: add a per-key fill-admission guarantee (drop any fill whose read missed before a later write to that key completed), synchronous post-commit invalidate, dropped-fill counter on the existing dashboard, scenarios S1–S9 in required acceptance. | approved | D1 auto-decided B under the run's author policy (complete remedy restoring a retained contract). Scope: amend the proposed ordering rules and required acceptance only; data structure and code left to engineering; no change to retained contracts, limits, TTLs or consistency semantics. |
| R2 — service owner | Hit-rate target >= 60% depends on per-key re-read interval vs the 30 s TTL; the trace reports "repeated reads of about 900 hot keys" with no interval. | Target retained; 10% stage gate verifies it. | none (unknown, not a decision) | unresolved risk, no choice needed | Owner verifies at the 10% stage per the existing healthy-hour rule; no limit change authorized. |

## currentDecision (R1)
Commitment comparison:
```text
Commitment                                   | Source/approval or pending                    | Current (plan as written)             | A                         | B                                              | C
---------------------------------------------|-----------------------------------------------|---------------------------------------|---------------------------|------------------------------------------------|------------------------------------------
Read begun after writeProfile completes sees | retained contract, approved by author          | violated by schedule S2               | violated (unchanged)      | guaranteed: stale fill dropped                 | guaranteed via cohort-bound fills
committed version                            |                                               |                                       |                           |                                                |
Read path                                    | proposed, pending                             | get -> miss -> read -> set            | same                      | get -> miss -> note key epoch -> read -> set   | cache moves inside repository.read
                                             |                                               |                                       |                           | only if epoch unchanged                        |
Write path                                   | proposed, pending                             | await write -> delete                 | same                      | await write -> bump epoch + delete (same tick) | await write -> cohort retire also clears cache
Coordination fill vs write                   | proposed text says none; pending              | none                                  | none                      | per-key epoch check at fill time               | repository-level
Absent-result DTO handling                   | retained adapter contract                     | sentinel 10 s                         | same                      | same; absent fills also subject to epoch check | same
Retained single-flight / adapter contracts   | fixture facts, fixed                          | unchanged                             | unchanged                 | unchanged                                      | CHANGED (cohort rule would inspect fills)
Adapter limits 1000 / 16 MiB / 30 s          | retained, fixed                               | unchanged                             | unchanged                 | unchanged                                      | unchanged
Dropped-fill visibility                      | author: record added branches, no key labels  | n/a                                   | n/a                       | counter on existing dashboard, no key labels   | counter inside repository
Regression scenarios                         | author: both completion orders etc. required  | listed categories, no schedules       | same                      | S1–S9 deterministic schedules added            | S1–S9 plus repository contract-test changes
Changed files (estimate)                     | 0E count                                      | 2                                     | 2                         | 2–3                                            | 4+ (repository, single-flight, tests)
Rejected write / rejected read behavior      | retained                                      | preserved                             | preserved                 | preserved (no epoch change on reject)          | preserved
```

Question: D1 — R1: How do we close the stale-fill race between a cache miss and a completed write?
Project/branch/task: main — cache profile summaries in one process (PLAN.md review).
ELI10: A read that misses the cache goes to the database and later puts what it found into the cache. If a write finishes in between, the read can put the old value back after the write already cleared the cache. Every later read then sees the old profile for up to 30 seconds, even though the plan promises that reads started after a finished write always see the new data.
Stakes if we pick wrong: users see stale profiles after their own saves, the correctness SLO breaks, and the acceptance test for "both completion orders" fails or has to be weakened.
Recommendation: B because it restores the retained contract with a process-local, O(1), synchronous check and no change to any fixture contract, while A leaves the contradiction and C rewrites retained repository behavior for the same guarantee.
Completeness: A=3/10, B=10/10, C=10/10 (C's coverage is complete but it alters a retained contract the author fixed).
Pros / cons:
A) Keep the proposed ordering as written
  ✅ Zero extra wrapper logic; the two functions stay as drafted in the plan
  ✅ No new counters or test schedules to maintain
  ❌ Schedule S2 violates the retained consistency contract; TTL is explicitly not a substitute
B) Add a per-key fill-admission guarantee (recommended)
  ✅ Stale fills are dropped synchronously in the same tick as cache.set, so post-write reads always miss and re-read
  ✅ Touches only the wrapper; adapter, single-flight, controller and limits stay exactly as accepted
  ❌ Reads that began after the commit but before writeProfile completed are also dropped, costing a few extra misses under write load
C) Move caching inside repository.read's single-flight cohort
  ✅ Fill and cohort retirement live in one place, so no wrapper-level bookkeeping
  ✅ Also fixes the race for any future caller of repository.read
  ❌ Changes the retained single-flight contract ("does not inspect cache fills") and the repository; out of the author's fixed scope
Net: B restores the promise with the smallest diff; A keeps a known contradiction; C buys the same guarantee by changing contracts the author fixed.
Header: Stale-fill race
A) Keep proposed ordering
Effort S (zero implementation work beyond the draft), risk high, reuse: full, verification: existing categories only. ✅ Zero extra wrapper logic; the two functions stay as drafted in the plan. ✅ No new counters or test schedules to maintain. ❌ Schedule S2 violates the retained consistency contract; TTL is explicitly not a substitute.
B) Per-key fill-admission guard (recommended)
Effort S, risk low, reuse: all existing adapters and controller, verification: S1–S9 deterministic schedules plus existing contract tests. ✅ Stale fills are dropped synchronously in the same tick as cache.set, so post-write reads always miss and re-read. ✅ Touches only the wrapper; adapter, single-flight, controller and limits stay exactly as accepted. ❌ Reads that began after the commit but before writeProfile completed are also dropped, costing a few extra misses under write load.
C) Cache inside repository single-flight
Effort L, risk medium, reuse: partial (repository and single-flight change), verification: S1–S9 plus repository contract-test changes. ✅ Fill and cohort retirement live in one place, so no wrapper-level bookkeeping. ✅ Also fixes the race for any future caller of repository.read. ❌ Changes the retained single-flight contract ("does not inspect cache fills") and the repository; out of the author's fixed scope.

### D1 answer
Auto-decided D1 (R1) → B under the run's author policy: "Authorize complete remedies and required verification that restore its retained contracts and acceptance targets; use the recommended option." Authority: user run instructions for this capture (no human present; AskUserQuestion unavailable). Exact scope: amend "Proposed wrapper integration" with the fill-admission guarantee, the synchronous post-commit invalidate, the dropped-fill counter on the existing dashboard, and scenarios S1–S9 as required acceptance. Not authorized: data-structure or code selection, new metrics projects or alert thresholds, any change to retained contracts, limits or consistency semantics.
Post-answer checkpoint: amendment applied to "Proposed wrapper integration" (Accepted amendment D1/R1) and read back.

### 0I. Temporal Interrogation (HOLD SCOPE)
```
  HOUR 1 (foundations):    retained contracts above; the fill-admission guarantee (D1); harness with controlled promise release.
  HOUR 2-3 (core logic):   check-and-set must be one synchronous segment; absent DTO goes through the same check; rejected write changes nothing.
  HOUR 4-5 (integration):  controller swap tests re-run with the wrapper; dropped-fill counter wired to the existing dashboard with no key labels.
  HOUR 6+ (polish/tests):  S1–S9 schedules; bounded bookkeeping (S9); ASCII comment of the ordering rules in the wrapper module.
```
Feasibility blockers: none after D1. Pending choices: bookkeeping structure (engineering). Effort: human ~2 days / CC+gstack ~40 min.

## Current scope (Section 1 preface)
Mode HOLD SCOPE (explicit user instruction). Governing rows: R1 approved (D1 → B, author-policy auto-decision); R2 unresolved risk with verification owner, no choice. Accepted: original plan + D1 amendment. Deferred: none. Rejected: none. Pending: bookkeeping structure (engineering).

## Section 1: Architecture Review
Outcome: 1 finding (F1, CRITICAL GAP, resolved by D1); otherwise OK.
```
  caller --auth/authz--> readProfile/writeProfile (NEW wrapper, per controller instance)
                              |            |
                              v            v
                      LRU adapter     repository.read / repository.write
                      (1000/16MiB/30s)   |  single-flight cohort per key
                                         v
                                  in-process transactional store
  rollout controller --flag/predicate--> publishes wrapper+cache instance (fresh cohort)
  telemetry <-- hit/miss/evict/bytes/bypass/dropped-fill counters (no key labels)
```
- Data flow paths: happy = miss -> store -> fill -> hit; nil (missing record) = absent DTO -> 10 s sentinel -> decoded absent DTO; empty (zero-size DTO) = stored as a normal immutable value under the byte cap; error = repository rejection -> typed API error, no fill.
- State machine (cache entry): `absent --miss fill--> present(v) --TTL/evict/delete--> absent`; `absent --miss on missing record--> sentinel(10 s) --delete/TTL--> absent`; `any --adapter failure--> bypass --reinit--> absent`. Invalid transition prevented by D1: `present(stale) <-- fill after invalidate`.
- Coupling: wrapper -> adapter + repository only; no new coupling into controller beyond the existing instance publish. Justified.
- Scaling: 10x reads -> evictions rise, hit rate falls, DB load approaches today's; 100x -> single process CPU (existing limit, multi-process out of scope).
- SPOF: single process (pre-existing). Security: no new surface (Section 3). Production failure: adapter failure -> bypass alert at 1 min; store failure -> typed errors, existing SLO alert.
- Rollback: flag off -> controller swaps to bypass instance after admitted writes drain; seconds.
- F1 **CRITICAL GAP** (R1): stale fill after invalidation violates the retained consistency contract. Remedy: D1 → B. Residual: extra misses under same-key write contention. Verification: S2, S3, S6.

## Section 2: Error & Rescue Map
Outcome: 7 error paths mapped, 0 unrescued GAPS after D1.
```
  METHOD/CODEPATH          | WHAT CAN GO WRONG                      | EXCEPTION CLASS / SIGNAL
  -------------------------|----------------------------------------|---------------------------
  readProfile#cache.get    | adapter failure                        | adapter bypass (no throw)
  readProfile#repo.read    | store rejection, validation, authz     | existing typed API errors
  readProfile#cache.set    | adapter failure / byte cap             | adapter bypass / evict
  readProfile#fill guard   | generation advanced during read        | dropped fill (counter)
  writeProfile#repo.write  | rejected (rolled back)                 | existing typed API errors
  writeProfile#cache.delete| adapter failure                        | adapter bypass
  controller swap          | old write still admitted               | awaited before publish

  EXCEPTION CLASS          | RESCUED? | RESCUE ACTION                         | USER SEES
  -------------------------|----------|---------------------------------------|------------------
  adapter bypass           | Y        | serve from store until reinit; alert  | slower reads
  typed API errors (read)  | Y        | propagate unchanged, no fill          | existing error
  typed API errors (write) | Y        | propagate, cache untouched            | existing error
  dropped fill             | Y        | skip set, count on dashboard          | one extra miss
```
No catch-alls are proposed; the wrapper adds no try/catch. Decision gate: covered by D1; no new choice.

## Section 3: Security & Threat Model
Outcome: 4 threats assessed, 0 High, no issues.
| Threat | L | I | Mitigated |
|---|---|---|---|
| Cross-tenant read via key collision | Low | High | retained: keys encode tenant + validated profile ID unambiguously |
| Authz bypass via cached value | Low | High | retained: authn/authz run before repository access on every call |
| Key/secret leakage in logs or metrics | Low | Med | retained: never logged; counters carry no key labels (D1 keeps this) |
| Memory exhaustion via key churn | Low | Med | 1000 entries / 16 MiB cap; bookkeeping bounded by in-flight misses (S9) |
No new inputs, endpoints, dependencies or secrets. Decision gate: no choice needed.

## Section 4: Data Flow & Interaction Edge Cases
Outcome: 9 edge schedules mapped (S1–S9), 1 unhandled before D1 (S2/S3/S6), 0 after.
Invariant and boundary: a read begun (readProfile invoked) after writeProfile's promise fulfilled must return the committed version; reads overlapping an unfinished writeProfile may return the earlier snapshot (retained contract).
```
  tick | readProfile R1 (miss)          | writeProfile W (v1)              | cache[k]        | R2 (begun after W)
  -----|--------------------------------|----------------------------------|-----------------|-------------------
   1   | get -> undefined; repo.read ↓  |                                  | -               |
   2   |   (cohort c0 reading v0)       | repo.write commits v1; retires c0|                 |
   3   |                                | resolves; cache.delete; fulfills | -               |
   4   | repo.read resolves v0          |                                  |                 | get -> ? 
   5a  | PLAN AS WRITTEN: cache.set(v0) |                                  | v0 (stale 30 s) | hit v0  ✗ violates
   5b  | D1: generation changed -> drop |                                  | -               | miss -> store v1 ✓
```
Favorable order (S1): R1 resolves at tick 2 before the commit; the fill lands first and W's delete clears it. Mechanism excluding 5a after D1: the generation check and cache.set run in one synchronous segment of the single event loop, and the generation advanced at tick 3 in the same tick as the delete. Regression proof: S1–S9 with controlled release points (both orders of each overlapping pair).
Interaction edge cases (backend-only): concurrent misses -> single-flight coalesces (retained); repeated writes -> S6; retry after failed write -> S5 then S1; flag flip mid-flight -> S7. Decision gate: D1 covers; no new choice.

## Section 5: Code Quality Review
Outcome: 1 finding (F2, WARNING), covered by D1's wording.
- F2 **WARNING**: the check-and-set must not be split by an await; D1 states the one-synchronous-segment rule. Verification: S2 plus a code-review checklist item in T1.
- Fits existing patterns (read-through wrapper over repository); no duplicated behavior (eviction, TTL, sentinel, single-flight all reused). Naming: readProfile/writeProfile describe behavior. Branching stays under 5 per function. No premature abstraction; no general cache framework.

## Section 6: Test Review
Outcome: diagram produced, 0 gaps after S1–S9.
```
  NEW THING                     | TYPE        | HAPPY            | FAILURE            | EDGE
  ------------------------------|-------------|------------------|--------------------|------------------
  readProfile hit/miss/fill     | unit        | hit after miss   | S4 rejected read   | S3 absent DTO
  writeProfile invalidate       | unit        | S1               | S5 rejected write  | S6 overlapping
  fill-admission guard (D1)     | unit        | S1 no drop       | S2 drop + counter  | S9 bounded
  adapter bypass path           | unit        | reinit empty     | S8 mid-miss        | delete during bypass
  controller instance isolation | integration | swap drains      | S7 old reader      | predicate parity
  limits: 1000 / 16 MiB / 30 s  | unit        | eviction/TTL     | byte cap reject    | boundary sizes
```
Assertion check: each scenario names the exact observed value (v0/v1/v2/absent/error) and the counter delta; counts are exact, not lower bounds. Hostile QA: write storm on one key during a slow read (S6 + S9). 2 am test: S2. Chaos: adapter failure during a miss (S8). Pyramid: unit-heavy, few integration, no E2E. Flakiness: none, controlled release order, no timers. Load: production stage gates measure hit rate; no synthetic load test requested (HOLD SCOPE). LLM/prompt patterns: none.

## Section 7: Performance Review
Outcome: 1 risk (R2), no issues.
No N+1, no new queries or indexes. Memory: 16 MiB cap + bounded bookkeeping (S9). Hit path: synchronous map lookup (microseconds); miss path: unchanged store read + set; dropped-fill path: one extra miss. Connection pools unchanged. R2: 60% hit target depends on per-key re-read interval < 30 s TTL; unknown from the trace, verified at the 10% stage (owner: service owner). No limit change authorized.

## Section 8: Observability & Debuggability Review
Outcome: 0 gaps after D1's counter.
Existing: hit/miss, eviction, bytes, bypass errors, DB CPU, p95, existing alerts (SLO breach, p95 > 120 ms for 5 min, bypass > 1 min) and runbooks. Added by D1: dropped-fill counter on the current dashboard, no key labels, no new alert (author constraint). Debuggability at 3 weeks: counters per stage plus runbook incident records; per-key logs are intentionally absent (secrets rule). Runbook response for a rising dropped-fill counter: expected under same-key write contention; investigate only with a correctness alert.

## Section 9: Deployment & Rollout Review
Outcome: 1 risk flagged (R2 stage failure path), no issues.
No migrations. Flag stages 10% -> 50% -> 100% after one healthy hour each; controller swap drains admitted writes before publishing. Rollback: flag off (seconds), runbook records incident. Deploy-time window: flag off at deploy, wrapper inert. Parity: run S1–S9 and the contract harness in staging. First 5 minutes: hit/miss, bypass, dropped fills, error rate. First hour: healthy-hour criteria. Smoke: read-after-write check through the wrapper in staging.

## Section 10: Long-Term Trajectory Review
Outcome: reversibility 5/5, 1 debt item.
Debt: per-key write-generation bookkeeping is new state; document the ordering rules with an ASCII comment in the wrapper module (T3). Path dependency: none; repository interface remains the seam. Knowledge: this plan plus the comment suffice. 1-year: obvious if the comment ships.

## Section 11: Design & UX Review
SKIPPED (no UI scope).

## Closing sequence
- Outside Voice: `codex_reviews: disabled` → skipped; no outside process, no native fallback. Disabled-coverage review-log write: not persisted (gstack binaries and mutating commands unavailable in this run).
- TODO choices: none proposed (HOLD SCOPE; R2 is already required verification in the plan).
- Approval readiness: PASS — R1 (D1 → B, author-policy auto-decision, scope as recorded); R2 (no choice; verification owner named). No declined, deferred or unanswered changes in accepted work.

## NOT in scope
Deferred: none. Rejected: none. Unchanged original exclusions: distributed caching, cross-process coherence, prewarming, consistency-semantics changes, new product surfaces.

## What already exists
See 0B: adapter, single-flight, controller, repository contracts and telemetry are all reused; only the wrapper is new.

## Dream state delta
See 0C: the plan plus D1 keeps the repository interface as the single seam and adds no framework.

## Error & Rescue Registry
See Section 2 map: 7 codepaths, 4 exception classes/signals, all rescued, 0 CRITICAL GAPS.

## Failure Modes Registry
```
  CODEPATH                 | FAILURE MODE              | RESCUED? | TEST?  | USER SEES?       | LOGGED?
  -------------------------|---------------------------|----------|--------|------------------|---------
  readProfile fill         | stale fill after write    | Y (D1)   | S2,S3,S6 | one extra miss | counter
  readProfile repo.read    | rejected read             | Y        | S4     | existing error   | existing
  readProfile cache ops    | adapter failure           | Y        | S8     | slower reads     | bypass
  writeProfile repo.write  | rejected write            | Y        | S5     | existing error   | existing
  writeProfile delete      | adapter failure           | Y        | S8     | slower reads     | bypass
  controller swap          | old reader fills new      | Y        | S7     | none             | existing
  bookkeeping              | unbounded growth          | Y (D1)   | S9     | none             | bytes
```
7 rows, 0 CRITICAL GAPS.

## Diagrams
1. System architecture: Section 1. 2. Data flow with shadow paths: Section 1 paths + Section 4 schedule. 3. State machine: Section 1. 4. Error flow: Section 2. 5. Deployment sequence:
```
  deploy (flag off) -> staging S1–S9 -> 10% keys -> healthy hour -> 50% -> healthy hour -> 100% -> acceptance targets
```
6. Rollback flowchart:
```
  alert or breach? --yes--> flag off -> controller drains writes -> bypass instance -> runbook incident -> resume criteria
                   --no---> next stage
```
Stale diagram audit: PLAN.md had no ASCII diagrams before this review; wrapper source files were not inspected (out of this run's scope), none known.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~20min)** — profile-summary wrapper — Implement the D1 fill-admission guarantee and synchronous post-commit invalidate
  - Surfaced by: Section 4 — schedule tick 5a (F1, R1)
  - Files: to be determined (wrapper module and its tests)
  - Verify: S1–S9 pass in the deterministic contract harness; review checklist confirms check-and-set has no intervening await
- [ ] **T2 (P1, human: ~2h / CC: ~5min)** — telemetry wiring — Add the dropped-fill counter to the existing dashboard with no key labels
  - Surfaced by: Section 8 — D1 added branch visibility
  - Files: to be determined
  - Verify: S2 asserts counter +1; dashboard panel shows the series in staging
- [ ] **T3 (P2, human: ~30min / CC: ~5min)** — wrapper module — Add an ASCII comment documenting the read/write ordering rules and the guarantee
  - Surfaced by: Section 10 — debt item
  - Verify: comment present and matches the Accepted amendment text
_No new tasks from Sections 3, 5 (covered by T1), 6, 7, 9, 11._
Task JSONL: not persisted (gstack state paths unavailable; mutating commands prohibited this run).

## Completion Summary
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | HOLD SCOPE                                  |
  | System Audit         | skipped per run rules; plan-only review     |
  | Step 0               | HOLD SCOPE; D1/R1 → B (fill guard)          |
  | Section 1  (Arch)    | 1 issue found (F1, resolved by D1)          |
  | Section 2  (Errors)  | 7 error paths mapped, 0 GAPS                |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 9 edge cases mapped, 0 unhandled after D1   |
  | Section 5  (Quality) | 1 issue found (F2, covered by D1)           |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 0 issues found (R2 risk, owner verifies)    |
  | Section 8  (Observ)  | 0 gaps found                                |
  | Section 9  (Deploy)  | 1 risk flagged                              |
  | Section 10 (Future)  | Reversibility: 5/5, debt items: 1           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (0 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 7 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 7 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
  | CEO plan             | skipped by mode                             |
  | Outside voice        | codex disabled (codex_reviews: disabled)    |
  | Lake Score           | 1/1 recommendations chose complete option   |
  | Diagrams produced    | 6 (arch, data flow, state, error, deploy,   |
  |                      | rollback)                                   |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```
Review Log / decision log / dashboard: not persisted (gstack binaries unavailable, mutating commands prohibited); this run is unlogged. Telemetry and learnings: skipped per run rules; no durable learnings this session.

### Unresolved Decisions
None. D1 was auto-decided under the run's author policy, not left unanswered.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (not persisted) | CLEAR | mode: HOLD SCOPE, 0 critical gaps open (1 found, resolved by D1) |
| Outside Review | codex (`codex_reviews: disabled`) | Independent 2nd opinion | 0 | DISABLED | codex_reviews disabled; no completed external review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | not run |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI scope) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **OUTSIDE COVERAGE:** provider codex, phase plan-review, disabled by `codex_reviews: disabled`; no outside process or native fallback ran; no findings.
- **VERDICT:** CEO CLEARED — eng review required

NO UNRESOLVED DECISIONS
