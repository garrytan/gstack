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

### Amendment A1 (accepted via D1/R1, CEO review 2026-10-04)
The ordering above is retained with one added guarantee. **Fill admission:** a
read-miss may fill the cache only if no `repository.write` for that key committed
between the start of that read's `repository.read` call and the fill. Required
behavior: `readProfile` captures the key's write generation before calling
`repository.read` and performs `cache.set` only if the generation is unchanged
when the read resolves; otherwise it skips the fill and still returns the value.
`writeProfile` advances the key's write generation after `repository.write`
resolves (committed) and before `cache.delete`; a rejected write does not advance
it. The absent-result DTO is governed by the same rule. The skipped-fill branch is
counted on the existing dashboard with no key labels. Tradeoff: a read that
overlaps a write may cost one extra DB miss. The generation store's data structure,
bounds and function bodies are engineering-planning choices; they must keep the
operation synchronous in the event loop and must not change the adapter, the
single-flight wrapper, the controller, limits, TTLs or consistency semantics.
Deterministic regression scenarios (existing harness, controlled pause/release):
S1 read resolves and fills before the write commits → delete clears it → next read
observes v1; S2 read snapshot pre-commit, write completes, read resumes → fill
skipped → next read observes v1; S3 same as S2 with a missing record created by
the write → no absent sentinel is cached; S4 rejected write overlapping a read →
fill admitted, v0 correct; S5 rejected read → no fill, typed error unchanged;
S6 overlapping writes W1/W2 with a read between → final read observes W2's
version; S7 controller instance change during an in-flight read → old read cannot
fill the new instance (existing isolation test retained).

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

# CEO Review (plan-ceo-review, 2026-10-04)

## Step 0 — Scope challenge and mode

Review depth: implementation-ready (default; the plan names codepaths). Preamble
skipped per run instructions (no skill-start, no system audit, no telemetry);
AskUserQuestion unavailable; the run instructions authorize auto-decision under
the author policy. Base branch: `main` (git status snapshot; no git run).
Config `.gstack-section-state-aQnx04/config.yaml`: `codex_reviews: disabled`.

**0A Premise.** Real problem: ~900 hot keys re-read from the DB (DB CPU 70%,
read p95 120 ms). Do-nothing cost: DB saturation headroom gone before growth.
A process-local LRU attacks the pain directly (one process, no external writers).
**0B Leverage.** Reuses existing repository, LRU adapter (1000 entries/16 MiB/
30 s TTL, absent sentinel), per-key single-flight, rollout controller,
dashboards and runbooks. No rebuild proposed; nothing to refactor away.
**0C Dream state.**
```
  CURRENT STATE                  THIS PLAN                  12-MONTH IDEAL
  DB serves every read   --->  process-local LRU,   --->  repository interface
  CPU 70%, p95 120 ms          >=60% hits, CPU<50%,       ready for a shared
  single process               p95<60 ms, same SLOs       cache if ever needed
```
Moves toward the ideal without a general cache framework.
**0E Mode.** Explicit user instruction: HOLD SCOPE (no mode question asked, no
handoff script available; provenance = user instruction). Changed files: ~3
(wrapper, wrapper tests, flag wiring) — estimate; complexity check passes
(1 new wrapper, 0 new services). Minimum change = the wrapper; nothing deferrable
without blocking the goal. Invariants and acceptance criteria are kept; repairs
needed to meet them are in scope (0G HOLD rule 3).

**0D required approach choice.** One contradiction found between the proposed
ordering and a retained contract; recorded as row R1 below. No other approach
choice is required.

### Decision ledger

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| R1 — Section 4 (async ordering); owner: wrapper author | PLAN.md "Existing contracts retained", last bullet: every read begun after writeProfile fulfills must observe the committed version; TTL is no substitute. PLAN.md "Proposed wrapper integration": `readProfile` awaits `repository.read` then `cache.set` with no fill/write coordination ("no additional version checks or coordination between a cache fill and a write are proposed"); single-flight "does not inspect cache fills"; controller isolation "does not coordinate an ordinary DB write with a cache fill". Schedule S2 below demonstrates a stale fill. | Proposed ordering as written (unapproved) | A) add a fill-admission guard; B) refill on write; C) keep as proposed | approved | D1 → A, auto-decided 2026-10-04 under the run's author policy ("authorize complete remedies and required verification that restore its retained contracts"; recommended option among in-scope alternatives). Scope: the fill-admission guarantee, its write-side generation advance, the skipped-fill counter on the existing dashboard (no key labels), and the listed regression scenarios. Not approved: data structures, function bodies, test code, any change to limits, TTL, consistency semantics or alerts. |

**Decision record D1 (R1).** Selected A. Authority: user run instructions
(author policy), not a human answer and not a preamble SESSION_KIND echo. B was
rejected because it leaves S2 reachable; C was rejected because the author policy
forbids weaker consistency. Lake Score eligible: yes (10/10 option chosen).

### Demonstrated schedule (S2, violating)

```
  t | readProfile R1 (miss)        | writeProfile W            | cache[key] | store
  1 | cache.get -> undefined       |                           | -          | v0
  2 | await repository.read (v0 snapshot taken)                | -          | v0
  3 |                              | repository.write commits  | -          | v1
  4 |                              | cohort retired, resolves  | -          | v1
  5 |                              | cache.delete (no-op)      | -          | v1
  6 |                              | promise fulfills = WRITE COMPLETE       | v1
  7 | resumes: cache.set(key, v0)  |                           | v0 STALE   | v1
  8 | readProfile R2 begins after step 6: cache.get -> v0  <-- VIOLATION      | v1
```
No retained mechanism excludes S2: single-flight admits R1 as an already-started
reader that "may finish with their earlier snapshot"; the controller only isolates
instance changes; the adapter does not know about writes. The same schedule with an
absent-result DTO at step 2 caches "absent" for 10 s after a creating write.

## currentDecision (R1)
Commitment comparison:

```text
Commitment | Source/approval or pending | Current | A | B | C
Read-after-write visibility at wrapper boundary | PLAN.md retained contract (approved) | required | kept | kept | VIOLATED (S2)
Cache fill on read miss | PLAN.md proposed (pending) | unconditional set | set only if no write committed for key since the read's store access began | unconditional set | unconditional set
Write path after commit | PLAN.md proposed (pending) | cache.delete | bump per-key write generation, then cache.delete | cache.set(saved) after commit | cache.delete
Consistency semantics / limits / TTL | PLAN.md retained (approved) | unchanged | unchanged | unchanged | unchanged
Single-flight, adapter, controller contracts | fixture facts (approved) | unchanged | unchanged | unchanged | unchanged
Added telemetry | PLAN.md acceptance reqs (approved) | none | existing counter for skipped fills, no key labels | none | none
Regression tests | PLAN.md acceptance reqs (approved) | required | both orders, absent creation, rejected R/W, overlapping writes, instance isolation | same list but S2 still fails | S2 fails
Data structures / function bodies | engineering planning (pending) | not chosen | not chosen | not chosen | not chosen
```

Question: D1 — R1: How does the wrapper keep a slow cache fill from overwriting a newer committed write?
Project/branch/task: profile-summary service, branch main, process-local LRU wrapper plan.
ELI10: A read can fetch an old copy from the database, pause, and only then put it in the cache. If a write finished during that pause, the cache now holds the old copy and every later reader gets stale data until the 30-second TTL. The plan promises that never happens once a write completes.
Stakes if we pick wrong: users see pre-write profile data for up to 30 s (10 s for "absent") after a confirmed save, breaking the correctness SLO the plan says is unchanged.
Recommendation: A because it closes the only violating schedule with one in-process check and keeps every retained contract and limit unchanged.
Completeness: A=10/10, B=5/10, C=3/10
Pros / cons:
A) Fill-admission guard (recommended)
  ✅ Any fill whose store access began before a commit is dropped, so S2 cannot publish v0 after W completes
  ✅ No change to adapter, single-flight, controller, TTL or consistency contracts; one counter on the existing dashboard
  ❌ Reads overlapping a write pay one extra DB miss; needs per-key generation state in the wrapper (engineering chooses the structure)
B) Refill cache from the write result
  ✅ Readers after a write get an immediate hit on the saved DTO
  ✅ Simple to describe and no per-key bookkeeping
  ❌ Does not prevent S2: R1's late cache.set(v0) still lands after the write's set(v1); also changes the write path from delete to fill
C) Keep as proposed
  ✅ Zero extra work and smallest diff
  ✅ Matches the current code sketch exactly
  ❌ Leaves the retained read-after-write guarantee violated; not permitted by the author policy (no weaker consistency)
Net: A trades a rare extra miss for a provable guarantee; B and C both leave the demonstrated stale fill in place.
Header: R1 stale fill guard
A) Fill-admission guard (recommended)
Guard every cache fill: readProfile records the key's write generation before calling repository.read and sets the cache only if it is unchanged afterwards; writeProfile advances the generation after commit and before cache.delete, recording skipped fills on the existing dashboard without key labels. Effort S, risk low, reuses all existing adapters, verification: both completion orders, absent-record creation, rejected reads/writes, overlapping writes, instance isolation. ✅ closes S2 ✅ keeps all retained contracts ❌ extra miss for reads overlapping a write.
B) Refill cache from the write result
writeProfile replaces cache.delete with cache.set(saved) after commit; reads stay as proposed. Effort S, risk medium, reuses adapters, verification: same scenario list. ✅ immediate hits after writes ✅ no bookkeeping ❌ S2 still overwrites v1 with v0 so the guarantee stays broken.
C) Keep as proposed
No implementation work (effort S, zero changes), risk high, verification: existing list only. ✅ smallest diff ✅ matches sketch ❌ demonstrated contract violation remains and cannot be accepted under the author policy.

## 0I Temporal interrogation
```
  HOUR 1   wrapper sits between callers and repository; adapter/single-flight/controller are fixed facts
  HOUR 2-3 ambiguity: where the per-key write generation lives and when it is pruned (engineering choice, A1 constraints)
  HOUR 4-5 surprise: S2 only reproduces with a controlled pause inside repository.read; harness pause points needed
  HOUR 6+  wish: skipped-fill counter wired before the 10% stage so the branch is visible on day 1
```
Effort: human ~1.5 days / CC+gstack ~40 min. Feasibility blockers: none after D1.
Pending (engineering): generation-store structure and bounds; harness pause-point selection.

## Current scope (Section 1 preface)
Mode HOLD SCOPE (user instruction). Governing rows: R1 approved (D1 → A, author
policy). Accepted: original plan + A1. Deferred: none. Rejected: options B and C
of R1. Pending: engineering-planning details named in A1.

## Section 1: Architecture Review
```
  callers -> [flag predicate] -> readProfile/writeProfile (wrapper, +gen guard)
                |                      |            |
                | excluded             v            v
                +--------------> repository.read/write (single-flight, txn store)
                                       ^
                           cache adapter (LRU 1000/16MiB/30s, absent sentinel)
```
Data flow paths: happy = miss→store→fill→hit; nil = absent DTO cached via
sentinel 10 s; empty = `undefined` only ever means miss (adapter contract);
error = repository rejection propagates with typed mapping, no fill.
State machine (per key, wrapper view): `empty → filled (gen g) → deleted (gen g+1)`;
invalid transition `filled(g) ← fill from read captured at g' < g` is now
prevented by A1. Coupling: wrapper gains a per-key generation; justified by the
retained contract. Scaling: 10x hot keys exceed 1000 entries → eviction, lower
hit rate, not a correctness issue; 100x → DB load returns to baseline, same as
today. SPOF: the single process (already the case). Security: no new surface.
Production failure: adapter failure → bypass until reinit (fixture). Rollback:
flag disable → new bypassing instance, seconds.
**Finding 1.1 (WARNING, resolved via R1):** stale-fill schedule S2. Remedy A1.
Outcome: 1 issue, resolved. Decision gate: R1 answer applied; no new choice.

## Section 2: Error & Rescue Map
```
  METHOD/CODEPATH   | WHAT CAN GO WRONG                      | EXCEPTION CLASS
  readProfile       | cache.get throws / adapter failure     | CacheAdapterError (fixture: bypass)
                    | repository.read rejects (DB/timeout)   | RepositoryError (typed API mapping)
                    | fill skipped by generation guard       | not an error; counted
  writeProfile      | repository.write rejects (rolled back) | RepositoryError; no gen advance, no delete
                    | cache.delete throws                    | CacheAdapterError (fixture: bypass)
  controller        | flag transition mid-flight             | n/a; isolation (fixture)

  EXCEPTION CLASS    | RESCUED?        | RESCUE ACTION                  | USER SEES
  CacheAdapterError  | Y (adapter)     | bypass until reinit; alert 1m  | normal, slower
  RepositoryError    | Y (API layer)   | typed error, no fill/no delete | existing API error
```
No catch-alls introduced; the wrapper adds no rescue of its own. Outcome: 5
error paths mapped, 0 GAPS. Decision gate: nothing new.

## Section 3: Security & Threat Model
Attack surface unchanged (no endpoints, params, files, jobs). Tenant-scoped keys
and pre-repository authz are fixture facts; cached values cannot bypass authz.
Threat: cross-tenant leak via key collision — likelihood Low, impact High,
mitigated (unambiguous tenant+profile key). Threat: key/secret in logs —
Low/Med, mitigated (no raw IDs; counter has no key labels). No new secrets or
dependencies. Outcome: 0 issues, 0 High unmitigated.

## Section 4: Data Flow & Interaction Edge Cases
```
  INPUT key -> (validated upstream) -> cache.get -> miss -> repository.read -> gen check -> cache.set -> OUTPUT
   shadow: nil/absent -> absent DTO -> sentinel 10s | error -> reject, no fill | stale -> gen changed -> skip fill
```
Async ordering: invariant = reads begun after writeProfile fulfills observe the
committed version. Both orders: S1 (fill before commit → delete clears) safe by
the existing delete; S2 (fill after commit) violating as proposed, safe under A1
because the generation advanced before the write could fulfil. Mechanism named:
per-key write generation compared at fill time. Regression proof: S1–S7 in A1.
No user-visible interactions (backend only). Outcome: 7 edge cases mapped, 0
unhandled after A1 (1 was unhandled before). Decision gate: R1 reused.

## Section 5: Code Quality Review
Wrapper fits the existing read-through pattern; no duplication (single-flight
and sentinel stay in their owners). Naming: `readProfile`/`writeProfile` fine.
Under-engineering fixed by A1; no over-engineering (no framework). Branching
stays under 5 per function. Outcome: 0 new issues.

## Section 6: Test Review
```
  new thing                 | type        | happy             | failure                | edge
  readProfile hit/miss      | unit        | hit returns DTO   | adapter failure bypass | absent sentinel 10s
  readProfile fill guard    | integration | S1                | S5 rejected read       | S2, S3 (absent)
  writeProfile invalidate   | integration | delete after commit| S4 rejected write      | S6 overlapping writes
  controller isolation      | integration | instance swap     | transition mid-read    | S7
  eviction/bytes/TTL        | unit        | 1000/16MiB/30s    | over cap evicts        | boundary sizes
```
Assertion check: each S1–S7 names the observed version and the wrong result it
rejects (exact version, not "eventually"). 2am test: S2. Hostile QA: S3 absent
creation. Chaos: adapter failure mid-fill. Pyramid: mostly unit/integration, no
E2E needed. Flakiness: all schedules use deterministic pause/release, not timers.
Load: existing capacity statement covers cold start. Outcome: diagram produced,
0 gaps after A1 (the S2/S3 assertions were missing before).

## Section 7: Performance Review
No N+1, no new queries or indexes. Memory: 16 MiB cap plus generation state
(bounded per A1 engineering constraint). Slow paths: miss (= today), guarded
miss overlapping a write (= today + one skipped fill). Connection pools unchanged.
Outcome: 0 issues.

## Section 8: Observability & Debuggability Review
Existing metrics: hit/miss, eviction, bytes, fallback errors, DB CPU, p95.
Added branch: skipped-fill counter on the current dashboard, no key labels
(within accepted scope; no new alert). Debuggability: counter + existing error
logs reconstruct a stale-fill suspicion without raw IDs. Runbook: existing
breach → disable flag. Outcome: 0 gaps (1 counter required by A1, accepted).

## Section 9: Deployment & Rollout Review
No migration. Flag staged 10% → 50% → 100% with one healthy hour each; breach
disables immediately; controller swaps instances safely (fixture). Old/new code
window: wrapper is additive; disabled instances bypass both paths. Post-deploy:
first 5 min watch fallback errors and skipped fills; first hour the healthy-hour
criteria. Smoke: hit/miss counters move; no bypass alert. Outcome: 0 new risks;
1 note: verify alerts page before each stage (already in plan).

## Section 10: Long-Term Trajectory Review
Debt: one per-key generation structure (documented in A1). Path dependency: low;
the repository interface keeps a replacement path. Reversibility 5/5 (flag off).
Ecosystem fit: yes. 1-year question: obvious if A1's guarantee is commented at
the fill site. Outcome: debt items 1, reversibility 5/5.

## Section 11: Design & UX Review
SKIPPED (no UI scope).

## Closing sequence
**Outside Voice:** `codex_reviews: disabled` in the isolated config. Codex review
skipped (codex_reviews disabled). Re-enable: `gstack-config set codex_reviews enabled`.
No native fallback; coverage recorded as disabled (review-log helper not run in
this fixture; disabled record **not persisted**).
**TODO choices:** none proposed (HOLD SCOPE; no evidenced deferred gap).
**Approval readiness: PASS** — R1: D1 → A (author-policy auto-decision, scope as
recorded in the ledger). No other rows.

## Required Outputs

### Review facts
Mode HOLD SCOPE; findings 1 (1.1, resolved via R1/A1); unresolved choices 0;
critical gaps 0 after A1; scope proposals 0; outside coverage: codex disabled.
Status: clean.

### NOT in scope
Deferred: none. Rejected: R1 option B (refill on write — leaves S2 reachable);
R1 option C (keep as proposed — violates retained read-after-write rule). Plan's
own out-of-scope list retained (distributed cache, cross-process coherence,
prewarming, semantic changes, new surfaces).

### What already exists
Repository with single-flight and typed errors (reused); LRU adapter with limits
and absent sentinel (reused); rollout controller with instance isolation (reused);
dashboards, alerts and runbooks (reused); deterministic contract harness (reused).

### Dream state delta
After this plan: hot reads served in-process with a provable read-after-write
guarantee; the repository interface still allows a shared cache later. Gap to the
12-month ideal: only the multi-process story, deliberately out of scope.

### Error & Rescue Registry
See Section 2 map (cross-reference). Rows: 5; CRITICAL GAPS: 0.

### Failure Modes Registry
```
  CODEPATH                 | FAILURE MODE                  | RESCUED? | TEST? | USER SEES?        | LOGGED?
  readProfile              | adapter failure               | Y        | Y     | slower, correct   | Y (fallback)
  readProfile              | repository.read rejects       | Y        | Y(S5) | typed API error   | Y
  readProfile fill         | stale fill after commit (S2)  | Y (A1)   | Y(S2) | correct version   | Y (skip counter)
  readProfile fill         | stale absent after create (S3)| Y (A1)   | Y(S3) | correct record    | Y (skip counter)
  writeProfile             | repository.write rejects      | Y        | Y(S4) | typed API error   | Y
  writeProfile             | cache.delete throws           | Y        | Y     | slower, correct   | Y (fallback)
  controller               | transition mid-read           | Y        | Y(S7) | correct           | Y
```
Total 7, CRITICAL GAPS 0.

### Diagrams
1. System architecture: Section 1. 2. Data flow with shadow paths: Section 4.
3. State machine: Section 1 (per-key `empty → filled(g) → deleted(g+1)`).
4. Error flow: Section 2.
5. Deployment sequence:
```
  deploy wrapper (flag off) -> enable 10% -> healthy hour -> 50% -> healthy hour -> 100% -> acceptance check
```
6. Rollback flowchart:
```
  breach (SLO / p95>120ms 5m / bypass 1m)? --yes--> flag off -> controller drains writes, publishes bypass instance -> runbook incident
                                           --no---> continue stage
```

### Stale Diagram Audit
No existing ASCII diagrams in touched files were supplied; the plan's own code
sketch is amended by A1 (not stale: A1 states the added guarantee alongside it).

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~4h / CC: ~15min)** — wrapper — Implement the fill-admission guard (A1): generation capture before `repository.read`, conditional `cache.set`, generation advance after commit before `cache.delete`
  - Surfaced by: Section 4 — Finding 1.1 / schedule S2 (R1, D1 → A)
  - Files: to be determined (wrapper module)
  - Verify: S1–S6 pass in the deterministic harness with controlled pause/release
- [ ] **T2 (P1, human: ~4h / CC: ~10min)** — tests — Add regression scenarios S1–S7 to the existing contract harness
  - Surfaced by: Section 6 — S2/S3 assertions missing before A1
  - Files: to be determined (wrapper test suite)
  - Verify: each scenario asserts the exact observed version and fails against the unguarded sketch
- [ ] **T3 (P2, human: ~1h / CC: ~5min)** — telemetry — Count skipped fills on the existing dashboard without key labels
  - Surfaced by: Section 8 — added branch must be visible
  - Files: to be determined (existing telemetry wiring)
  - Verify: counter increments in S2/S3 runs; dashboard panel shows it
_No new tasks from Sections 2, 3, 5, 7, 9, 10, 11._
Task JSONL: **not persisted** (no gstack state root in this fixture).

### Completion Summary
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | HOLD SCOPE                                  |
  | System Audit         | skipped per run instructions                |
  | Step 0               | HOLD SCOPE; R1 → A (fill-admission guard)    |
  | Section 1  (Arch)    | 1 issues found (resolved)                   |
  | Section 2  (Errors)  | 5 error paths mapped, 0 GAPS                |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 7 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 0 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 0 gaps found                                |
  | Section 9  (Deploy)  | 0 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 5/5, debt items: 1           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (2 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 5 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 7 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 0 proposed, 0 accepted (EXP + SEL)          |
  | CEO plan             | skipped by mode                             |
  | Outside voice        | codex disabled                              |
  | Lake Score           | 1/1 recommendations chose complete option   |
  | Diagrams produced    | 6 (arch, data flow, state, error, deploy, rollback) |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0 (listed below)                            |
  +====================================================================+
```

### Unresolved Decisions
None. D1 was resolved by authorized auto-decision (author policy).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (not persisted) | CLEAR | mode: HOLD SCOPE, 0 critical gaps |
| Outside Review | codex (`codex_reviews: disabled`) | Independent 2nd opinion | 0 | DISABLED | disabled by config; no completed external review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** provider codex, phase plan-review, disabled by `codex_reviews: disabled`; no outside process, no native fallback, no findings claimed.
- **VERDICT:** CEO CLEARED — eng review required

NO UNRESOLVED DECISIONS
