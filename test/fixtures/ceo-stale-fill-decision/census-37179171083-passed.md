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
coordination between a cache fill and a write are proposed in the original draft. **Amended by CEO review decision R1 (D1 → A):** the wrapper MUST NOT install a cache fill from a read that began before a write to the same key committed and whose writeProfile has since run (or is running). Required guarantee: at fill time the wrapper synchronously checks a per-key write generation (or equivalent) recorded while the miss is in flight; if any write to that key committed since the miss began, the fill is skipped, the value is still returned to the caller, and the skipped fill is counted. Coordination state is bounded by in-flight misses and removed when the last in-flight miss for the key settles. Exact data structures and function bodies are left to engineering planning. The original draft below is retained as the baseline being amended:

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
**Added by R1 (D1 → A), deterministic scenarios on the existing contract test
harness with pause/release points:** (S1) read misses and pauses inside
repository.read; write commits and writeProfile fulfills; read resumes with the
earlier snapshot: assert no fill installed, a fresh read observes the committed
version, suppressed-fill count +1. (S2) same but the read resumes BEFORE the write
commits and fills: assert writeProfile's cache.delete removes it and the next read
observes the committed version. (S3) missing record: read obtains the absent DTO,
create commits and completes, read resumes: assert no absent sentinel installed
and the next read observes the created record. (S4) overlapping writes W1, W2 with
a read in flight: assert the next read after both complete observes W2's version.
(S5) rejected read leaves cache untouched; rejected write leaves cache and
generation unchanged. (S6) controller instance swap during an in-flight miss:
old read cannot fill the new instance (existing contract) and the new instance
serves the committed version. The suppressed-fill branch is recorded through the
existing telemetry on the current dashboard with no key labels; no new alert or
metric project.
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

# CEO REVIEW (plan-ceo-review, HOLD SCOPE) — 2026-10-04

## Step 0: setup, ledger and scope challenge

**Review depth:** implementation-ready at the wrapper codepath level (readProfile /
writeProfile, adapter, controller). Per the author's acceptance requirements, exact
data structures, full function bodies and executable test code are reserved for
engineering planning; this review names required guarantees, codepaths, rescue
behavior and regression scenarios only.
**Storage policy:** working plan = this file (requested output). Appends for new
review content, scoped Edits for plan amendments. gstack state/log/telemetry
writes are out of this run's scope (hermetic fixture); such fields are shown
**not persisted**. System audit, environment setup and telemetry skipped per run
instructions. Outside review: `codex_reviews: disabled` in
`.gstack-section-state-b2PTft/config.yaml`.
**Stated limits recorded:** LRU 1000 entries; 16 MiB byte cap; 30 s value TTL;
10 s absent-sentinel TTL; targets hits >= 60% (admitted requests), DB CPU < 50%,
read p95 < 60 ms at 100%; stage baselines 70% CPU / 120 ms p95; alerts: p95 > 120 ms
for 5 min, bypass persisting 1 min, any correctness/error-SLO breach; one healthy
hour per stage at 10% / 50% / 100%. Deliverables counted against scope: 1 wrapper
module (new), 1 wrapper test file (new), controller wiring reuse (unchanged).
Estimated changed files: 2-3 (estimate).

### Decision ledger (continued through all sections)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| R1 — Section 1 (Architecture), carried to Section 4 | PLAN.md "Existing contracts retained": every read begun after writeProfile fulfills must observe the committed version; TTL is not a substitute. PLAN.md "Proposed wrapper integration": `cache.set(key, value)` after `await repository.read` with no fill/write coordination; fixture fact "already-started readers may finish with their earlier snapshot" and "this admission rule does not inspect cache fills". | Wrapper as proposed: unconditional fill after read resolves. | A: suppress fills that overlap a committed write; B: install then delete; C: keep as proposed (rejected: weakens retained contract). | approved | D1 auto-decided → A under the run's author policy ("authorize complete remedies and required verification that restore its retained contracts ... use the recommended option"). Scope: wrapper fill-time guard with bounded in-flight state, suppressed-fill count on existing dashboard (no key labels), scenarios S1–S6 on the existing harness. Not approved: adapter/repository/controller changes, new metrics projects, data-structure or test-code selection. |

### 0A. Premise Challenge
Real problem: ~900 hot profile-summary keys are re-read so often that one DB
carries 70% CPU and 120 ms read p95. Target outcome: >= 60% of admitted reads served
from process memory, DB CPU < 50%, read p95 < 60 ms, SLOs unchanged. Do-nothing
cost: DB stays near saturation; any traffic growth pushes p95 and error rate up.
The plan attacks the pain directly (fewer repeated store reads), not a proxy.
Premise holds under HOLD SCOPE; one consistency contract (R1) is at risk and is
reviewed, not assumed away.

### 0B. Existing Code Leverage
| Sub-problem | Reused existing code | Note |
|---|---|---|
| Bounded in-memory storage, TTL, absent sentinel, failure bypass | existing LRU cache adapter | fixture fact; no rebuild |
| Coalescing concurrent misses | per-key single-flight inside repository.read | fixture fact; does not inspect fills |
| Atomic commit / rollback | repository.write on in-process transactional store | fixture fact |
| Staged rollout, instance isolation, metrics | existing rollout controller + telemetry + dashboards | fixture fact |
| New: read-through ordering + write invalidation | new wrapper (readProfile/writeProfile) | the only new code |
No rebuild is proposed; refactoring the existing path is not needed.

### 0C. Dream State Mapping
```
  CURRENT STATE                      THIS PLAN                         12-MONTH IDEAL
  single process, every read   --->  process-local LRU in front  --->  same single-process service,
  hits the store; DB CPU 70%,        of repository; >=60% hits,        read-through boundary stable
  read p95 120 ms                    DB CPU <50%, p95 <60 ms,          enough that a later replacement
                                     consistency contract intact       (if ever needed) is a swap
                                                                       behind the same interface
```
The plan moves toward the ideal without adding a cache framework. Distributed
caching stays out of scope by author decision.

### 0D. Alternatives
No approach choice was required at Step 0: the requested approach (local LRU
wrapper over the existing repository) is retained. 0D is used later for R1.

### 0E. Mode Selection
Explicit user choice: HOLD SCOPE ("Hold the current scope (HOLD SCOPE mode)").
Steps 2-3 skipped. Mode handoff: `Mode: HOLD SCOPE; approved decisions: none.`
Application: preserve scope, maximum rigor on failures, edge cases, error paths,
tests and observability; repairs needed to meet retained invariants are in scope.
Provenance: explicit user instruction; no question asked, no question log.
No new approach decision was needed.

### 0G. HOLD SCOPE checks
1. Complexity: 2-3 changed files, 1 new module, 0 new services. Below the
   8-file / 2-service threshold. No fewer-moving-parts alternative exists; the
   wrapper is the minimum.
2. Minimum change for the goal: the two wrapper functions plus tests. Nothing in
   the accepted scope is deferrable without blocking acceptance (the contract
   tests, rollout stages and alerts are launch scope under Prime Directive 5).
3. Invariants and acceptance criteria kept as stated; any repair required to meet
   them (R1) is in scope.
Deferral menu: no item proposed for deferral; nothing to ask.

### 0I. Temporal Interrogation
```
  HOUR 1 (foundations):    implementer needs the retained contracts verbatim (absent DTO,
                           sentinel TTL, single-flight cohort rule, write-completion boundary).
  HOUR 2-3 (core logic):   ambiguity: what happens to a fill from a read that began before a
                           write committed and resolves after writeProfile fulfilled (R1).
  HOUR 4-5 (integration):  surprise: controller instance swaps isolate old readers, but do
                           NOT coordinate a fill and a write inside one active instance.
  HOUR 6+ (polish/tests):  wish they had planned pause/release harness hooks for both
                           completion orders of overlapping reads and writes, and for
                           missing-record creation under the absent sentinel.
```
Effort: human ~2-3 days / CC+gstack ~1-2 h for wrapper + tests (tests ~50x ratio).
Feasibility blockers: R1 (resolved below before the sections proceed). Pending
choices: none other than R1.

## Review Sections

**Current scope (published before Section 1):** Mode HOLD SCOPE (explicit user
instruction). Governing rows: R1 unresolved (pending below). Accepted work: the
plan as written above. Deferred: none. Rejected: none. Pending: R1.

### Section 1: Architecture Review
Dependency graph (new component marked *):
```
  caller --> rollout controller (predicate, instance swap)
                 |
                 v
         *wrapper {readProfile, writeProfile}
             |              |
             v              v
      LRU cache adapter   repository.read / repository.write
      (1000 / 16 MiB /      |  (single-flight cohort inside read)
       30 s, sentinel 10 s) v
                       in-process transactional store
```
Data flow, readProfile:
```
  happy : get(key) hit -> return DTO            | miss -> await read -> set -> return DTO
  nil   : record missing -> read returns absent DTO -> set stores sentinel (10 s) -> get decodes to absent DTO
  empty : key validation runs before repository access (fixture); empty/invalid key never reaches wrapper
  error : read rejects -> no set, cache untouched -> typed API error (existing mapping)
          adapter failure -> adapter bypasses cache until reinit -> read goes to store
```
Data flow, writeProfile:
```
  happy : await write (commit) -> delete(key) -> fulfill   (write "completes" at fulfill)
  error : write rejects (rolled back) -> no delete -> reject with typed error; cache preserved (correct)
  adapter failure on delete -> adapter bypass (fixture); write already committed; wrapper fulfills
```
Coupling: wrapper depends on adapter + repository only; controller owns lifecycle.
Justified; no new cross-module coupling. Scaling: 10x load keeps the hot set at
~900 keys < 1000 entries; 100x load with the same key set is served from memory;
a key set beyond 1000 entries thrashes the LRU and the hit target fails loudly on
the dashboard (no silent failure). SPOF: unchanged (single process, single DB).
Security: no new endpoint or mutation surface; auth precedes repository access
(fixture). Rollback: flag disable -> controller publishes a disabled instance
(bypass both paths); seconds.

**Production failure scenario (CRITICAL GAP, row R1):** a read misses, awaits
repository.read and obtains snapshot v0; a write commits v1, cache.delete runs
(no entry yet), writeProfile fulfills; the read then resolves with v0 and
`cache.set(key, v0)` installs a stale entry. A read begun after the write
completed hits v0 for up to 30 s (or 10 s for an absent sentinel after a create).
This violates the retained contract "every read begun after that write completes
must observe the committed version". Evidence: the plan states no fill/write
coordination; the fixture cohort rule explicitly lets already-started readers
finish with their earlier snapshot and does not inspect fills; controller
isolation only applies across instance swaps. This is a contract-level
contradiction, not an unavailable-implementation guess.

Other outcome: **OK** on boundaries, coupling, scaling, SPOF, security, rollback.
**Decision gate:** Resolve path 1 (new choice). 0D plan-decision route, row R1.

## currentDecision (R1)
Commitment comparison:
```text
Commitment                                   | Source/approval or pending        | Current (plan as written)        | A                                        | B                                              | C
Reads after a completed write see committed  | PLAN.md retained contracts (fixed) | violated by stale fill (gap)     | met: fill suppressed when a write to key | met: fill suppressed by re-deleting key after | not met: contract would be weakened
version                                      |                                    |                                  | committed during the in-flight miss      | every fill whose read overlapped a write      | (not authorizable in this review)
Wrapper ordering rules                       | pending (R1)                       | get -> await read -> set         | add synchronous per-key write-generation | add per-key "write-seen" flag consulted after | unchanged
                                             |                                    |                                  | check at fill time (in wrapper instance) | set to delete; still momentarily installs     |
Memory for coordination state                | pending (R1)                       | none                             | bounded by in-flight misses (entries     | bounded by in-flight misses                  | none
                                             |                                    |                                  | removed when last miss settles)          |                                               |
Adapter / repository / controller contracts  | fixture facts (fixed)              | unchanged                        | unchanged                                | unchanged                                     | unchanged
Regression scenarios (both completion orders,| author acceptance reqs (fixed)     | listed as required, not yet      | deterministic pause/release scenarios    | same scenarios                                | same scenarios, but one must be
missing-record create, rejected ops,         |                                    | specified against R1             | specified below; fill-suppressed branch  |                                               | changed to expect stale data
overlapping writes, instance isolation)      |                                    |                                  | asserted                                 |                                               | (forbidden)
Telemetry for added branch                   | author acceptance reqs (fixed)     | n/a                              | count suppressed fills on existing       | same                                          | n/a
                                             |                                    |                                  | dashboard, no key labels                 |                                               |
Changed files                                | estimate                           | 2-3                              | 2-3 (same files)                         | 2-3 (same files)                              | 2-3
```

Question: D1 — R1: How should the wrapper stop a stale cache fill from a read that began before a write committed?
Project/branch/task: main branch, PLAN.md "cache profile summaries in one process", CEO review in HOLD SCOPE.
ELI10: A reader asks the database for a profile, and while it waits, a writer saves a newer profile and clears the cache. The reader's old answer then arrives and gets stored in the cache, so everyone after sees the old profile for up to 30 seconds. The plan promises that never happens, so the wrapper needs a rule that refuses to store an answer that is older than a write that already finished.
Stakes if we pick wrong: users read a profile they just updated and see the previous version; the correctness SLO breaks; the rollout trips its alert and rolls back.
Recommendation: A because a synchronous fill-time check against a per-key write generation is the smallest explicit mechanism that satisfies the contract in a single event loop, with bounded state and one testable branch (explicit over clever).
Completeness: A=10/10, B=7/10, C=3/10
Pros / cons:
A) Suppress fills that overlap a committed write (recommended)
  ✅ Meets the retained contract in both completion orders without touching the adapter, repository or controller.
  ✅ Adds one synchronous branch with bounded state; the suppressed-fill count is observable on the existing dashboard.
  ❌ A hot key under constant writes may rarely fill, so its reads keep going to the store (visible as lower hit rate, not as incorrectness).
B) Install the fill, then delete it when a write overlapped
  ✅ Also keeps the adapter and repository unchanged and reuses cache.delete.
  ✅ Simple to reason about: every overlapped fill is removed before the reader returns.
  ❌ The stale entry exists for a moment between set and delete; a concurrent synchronous get in that window is impossible, but the design relies on strict ordering inside one function and is harder to prove and test than never installing.
C) Keep the wrapper as proposed and accept TTL-bounded staleness
  ✅ Zero implementation work beyond the plan as written (effort S, no new state).
  ✅ Simplest code path.
  ❌ Contradicts the retained consistency contract and the "TTL is not a substitute" clause; not authorizable by this review.
Net: A pays a tiny amount of bounded in-process state to make the contract hold by construction; B pays the same but with a weaker proof; C is not an option under the retained requirements.

Header: R1 stale cache fill
A) Suppress fills that overlap a committed write (recommended)
Effort S, risk low. Reuse: existing adapter, repository and controller unchanged; one new synchronous check in the wrapper instance keyed by the same cache key, tracking a per-key write generation (or equivalent) only while a miss is in flight, removed when the last in-flight miss for that key settles. Verification coverage: both completion orders of overlapping read/write, missing-record creation under the absent sentinel, overlapping writes, rejected reads/writes, instance isolation, suppressed-fill branch asserted and counted. ✅ Meets the retained contract in both completion orders without touching the adapter, repository or controller. ✅ Adds one synchronous branch with bounded state; the suppressed-fill count is observable on the existing dashboard. ❌ A hot key under constant writes may rarely fill, so its reads keep going to the store (visible as lower hit rate, not as incorrectness).
B) Install the fill, then delete it when a write overlapped
Effort S, risk medium. Reuse: adapter, repository and controller unchanged; wrapper installs the value, then calls cache.delete when a per-key write flag was raised during the miss. Verification coverage: same scenarios as A plus an ordering assertion that no get can observe the entry between set and delete. ✅ Also keeps the adapter and repository unchanged and reuses cache.delete. ✅ Simple to reason about: every overlapped fill is removed before the reader returns. ❌ The stale entry exists for a moment between set and delete; a concurrent synchronous get in that window is impossible, but the design relies on strict ordering inside one function and is harder to prove and test than never installing.
C) Keep the wrapper as proposed and accept TTL-bounded staleness
Effort S, risk high; zero implementation work. Reuse: everything as written. Verification coverage: would require changing a required scenario to expect stale data, which the retained contract forbids. ✅ Zero implementation work beyond the plan as written (effort S, no new state). ✅ Simplest code path. ❌ Contradicts the retained consistency contract and the "TTL is not a substitute" clause; not authorizable by this review.

**D1 answer record (R1):** Auto-decided D1 → A (authority: this run's author policy
authorizes the recommended complete remedy restoring retained contracts; no human
present). Applied: "Proposed wrapper integration" amended with the required
guarantee; "Verification and rollout" amended with scenarios S1–S6 and the
suppressed-fill telemetry branch; ledger row R1 → approved. Residual risk: a key
under constant writes may rarely fill (visible as lower hit rate, not stale data).

### Section 2: Error & Rescue Map
```
  METHOD/CODEPATH            | WHAT CAN GO WRONG                          | EXCEPTION CLASS
  ---------------------------|--------------------------------------------|---------------------------
  readProfile#cache.get      | adapter failure                            | adapter internal (bypass)
  readProfile#repository.read| store read fails / rejects                 | existing typed repository error
                             | record missing                             | none (absent DTO, not an error)
                             | stale snapshot resolves after completed    | none (logic gap) -> R1 guard
                             | write                                      |
  readProfile#cache.set      | adapter failure / byte cap exceeded        | adapter internal (bypass / evict)
  writeProfile#repository.write | write rejects (rolled back)             | existing typed repository error
  writeProfile#cache.delete  | adapter failure after commit               | adapter internal (bypass)
  controller swap            | in-flight old reads during swap            | none (isolation contract)
  ---------------------------|--------------------------------------------|---------------------------

  EXCEPTION / CONDITION         | RESCUED?        | RESCUE ACTION                         | USER SEES
  ------------------------------|-----------------|---------------------------------------|------------------
  adapter failure (any op)      | Y (adapter)     | bypass cache until empty reinit;      | normal result, slower;
                                |                 | bypass alert at 1 min                 | owner paged
  typed repository read error   | Y (existing map)| re-raise via existing API mapping;    | existing API error
                                |                 | no fill                               |
  typed repository write error  | Y (existing map)| re-raise; cache untouched (no commit) | existing API error
  absent record                 | n/a             | absent DTO; sentinel 10 s             | not-found result
  stale fill after write (R1)   | Y after R1      | skip fill, return value, count branch | committed version
```
No catch-alls proposed; the wrapper adds no new exception classes. **Outcome:**
1 GAP (R1) mapped and resolved by D1 → A; otherwise OK. Decision gate: path 2
(R1 exact answer cited); no new choice.

### Section 3: Security & Threat Model
| Threat | Likelihood | Impact | Mitigated |
|---|---|---|---|
| Cross-tenant cache read via key collision | Low | High | Yes: keys encode authenticated tenant + validated profile ID unambiguously (fixture); authz precedes repository access |
| Cached result bypassing authorization | Low | High | Yes: fixture contract; cache sits below the authz boundary |
| Key or secret leakage in logs/metrics | Low | Med | Yes: no raw IDs in metrics; the R1 suppressed-fill counter must carry no key labels (author requirement) |
| Memory exhaustion via unbounded coordination state | Low | Med | Yes by R1 scope: state bounded by in-flight misses |
| Cache poisoning via mutable DTO | Low | High | Yes: values are immutable DTOs (fixture) |
No new endpoint, input, dependency or background job. **Outcome:** No issues
found (0 High-severity open). Decision gate: no choice needed.

### Section 4: Data Flow & Interaction Edge Cases
Data flow with shadow paths:
```
  INPUT key -> VALIDATION (upstream authz/key validation) -> TRANSFORM (get / read) -> PERSIST (set / delete) -> OUTPUT DTO
    nil/empty key ........ rejected upstream before wrapper (fixture)            tested: existing contract tests
    invalid DTO .......... impossible; immutable DTO from repository              n/a
    exception/timeout .... read rejects -> no set -> typed error                  tested: rejected reads (S5)
    conflict/dup ......... overlapping writes -> last committed wins (S4)         tested: S4
    stale/partial ........ stale snapshot fill -> R1 guard skips fill (S1)        tested: S1-S3
```
Async ordering, boundary = "read begun after writeProfile fulfills observes the
committed version":
```
  t | readProfile R (miss)              | writeProfile W                   | cache[key]      | gen[key]
  --|-----------------------------------|----------------------------------|-----------------|---------
  1 | get -> miss; record gen=g0; await |                                  | empty           | g0
  2 |   (paused in repository.read, v0) | await write -> commit v1         | empty           | g0
  3 |                                   | gen++ ; delete(key); fulfill     | empty           | g1
  4 | read resolves v0; gen g1 != g0    |                                  | empty (skipped) | g1
  5 | return v0 to R's caller (allowed: R began before W completed)        |                 |
  6 | fresh read R2: miss -> read v1 -> gen unchanged -> set v1           | v1              | g1
```
Order 2 (read resolves before commit): t2 read resolves v0, gen==g0, set v0;
t3 W commits, gen++, delete(key) removes v0; R2 reads v1. Both orders satisfy the
boundary with the R1 guard; without it, order 1 leaves v0 cached (violation).
The excluded schedule "get observes an entry between set and delete" is prevented
by synchronous atomic cache ops in one event loop (fixture). Regression proof:
S1 (order 1), S2 (order 2), S3 (absent sentinel), S4 (overlapping writes), S6
(instance swap), with controlled pause/release points on the existing harness.
Interaction edge cases: no user-visible interaction changes (backend only).
**Outcome:** 5 edge cases mapped, 0 unhandled after R1. Decision gate: path 2
(cites R1).

### Section 5: Code Quality Review
Two small functions fit the existing read-through repository pattern. No
duplicated behavior: invalidation and fill live only in the wrapper. Naming
(readProfile/writeProfile) describes outcome. Error handling delegates to
existing typed mapping and adapter bypass (Section 2). The R1 guard adds one
branch; readProfile stays well under 5 branches. Not over-engineered: no
framework, no version column, no adapter change. Under-engineering risk was the
unconditional fill (R1, resolved). Require an ASCII comment above the wrapper
describing the fill/write ordering (engineering preference: ASCII comments for
complex state). **Outcome:** 1 issue (R1, resolved); comment requirement is a
task (T2). Decision gate: no new choice.

### Section 6: Test Review
```
  NEW THING                        | TEST TYPE   | HAPPY                      | FAILURE                        | EDGE
  ---------------------------------|-------------|----------------------------|--------------------------------|-----------------------------
  readProfile hit/miss             | unit        | hit returns cached DTO     | read rejects -> typed error    | absent DTO -> sentinel decode
  readProfile fill guard (R1)      | unit/harness| S2 fill then delete        | S1 stale fill suppressed       | S3 absent sentinel suppressed
  writeProfile invalidation        | unit        | commit -> delete -> fulfil | rejected write preserves cache | S4 overlapping writes
  adapter failure fallback         | unit        | bypass, results correct    | bypass persists -> alert       | failure on delete after commit
  eviction / byte cap / TTL        | unit        | LRU evicts oldest          | over-cap value not stored      | 1000th vs 1001st entry
  controller swap isolation        | integration | new instance fresh cohort  | old reader cannot fill new     | S6 swap mid-miss
  suppressed-fill telemetry        | unit        | counter +1 on S1           | no key labels asserted         | zero when no overlap
```
Assertion check: every row maps to a retained contract or to R1's approved scope;
S1–S6 are the exact scenarios the author required (both orders, missing-record
creation, rejected ops, overlapping writes, instance isolation). Existing contract
tests cover tenant isolation, key validation, absence, DB failures, authz,
multi-process rejection. 2am test: S1. Hostile QA: S4 plus swap mid-miss (S6).
Chaos: adapter failure injected mid-fill while a write commits (bypass must win).
Pyramid: mostly unit, few integration, no E2E (correct for backend). Flakiness:
TTL tests must use the harness's controlled clock, not wall time. Load: existing
rollout stages serve as the load test; no separate load test requested.
**Outcome:** diagram produced, 0 gaps after R1 (TTL-clock note is a task, T3).
Decision gate: path 2 (R1) and settled proof reuse; no new choice.

### Section 7: Performance Review
N+1: none (point reads). Memory: <= 1000 entries / 16 MiB adapter cap plus R1
state bounded by in-flight misses (hundreds of entries at most). Indexes: no new
queries. Caching: this is the caching. Jobs: none. Slow paths: cold miss = store
read (today's p95 120 ms); hit = sub-millisecond; suppressed fill = store read on
the next read of that key. Floor: 900 hot keys / 30 s TTL >= 30 store reads/s
plus suppressed fills on write-hot keys; within existing DB capacity (fixture:
cold starts remain within capacity). Connection pools: unchanged. **Outcome:** No
issues found; residual note: write-hot keys lower the hit rate, surfaced on the
dashboard. Decision gate: no choice.

### Section 8: Observability & Debuggability Review
Metrics (existing telemetry): hit, miss, eviction, cache bytes, fallback/bypass
errors, DB CPU, read p95, plus the R1 suppressed-fill count on the current
dashboard with no key labels (author requirement; not a new metric project).
Logging: adapter failure already logs without keys/secrets; the wrapper adds no
key logging. Alerts: existing (SLO breach, p95 > 120 ms for 5 min, bypass > 1 min);
no new threshold requested. Debuggability: a stale-read report three weeks later is
reconstructable from suppressed-fill and bypass counters plus the flag stage
timeline. Runbook: existing; it must name "suppressed fills climbing" as expected
on write-hot keys, not an incident (task T4, documentation only). **Outcome:** 1
gap (runbook note), resolved as a documentation task within existing runbook
scope. Decision gate: no choice (no new observability project).

### Section 9: Deployment & Rollout Review
No migration. Feature flag: existing runtime flag, 10% -> 50% -> 100% with one
healthy hour each and defined criteria (plan). Rollout order: deploy wrapper
disabled, then raise percentage. Rollback: disable flag -> controller stops
admitting, drains old writes, publishes disabled instance; seconds; runbook
records incident. Deploy-time risk window: one process, so no mixed versions; the
controller swap contract covers in-flight work. Environment parity: stage runs
under the same harness; first 5 minutes watch bypass and hit rate; first hour
watch the healthy-hour criteria. Smoke: hit/miss counters moving, zero bypass.
**Outcome:** 0 risks flagged beyond the plan's existing controls. Decision gate:
no choice.

### Section 10: Long-Term Trajectory Review
Debt: small (one guard with bounded state, one ASCII comment, runbook note).
Path dependency: none; the repository interface preserves a replacement path.
Knowledge: the ordering diagram in Section 4 belongs in the wrapper comment (T2).
Reversibility: 5/5 (flag off or delete two functions). Ecosystem fit: uses the
existing adapter and harness. 1-year question: obvious, provided the comment
explains why fills are suppressed. **Outcome:** reversibility 5/5, debt items 2
(comment, runbook note). Decision gate: no choice.

### Section 11: Design & UX Review
`SKIPPED (no UI scope)` — internal backend change, no UI, API or user-visible state.

## Closing sequence

### Outside Voice
`codex_reviews: disabled` (`.gstack-section-state-b2PTft/config.yaml`). Codex
review skipped (codex_reviews disabled). Re-enable: `gstack-config set
codex_reviews enabled`. No prompt, outside process or native fallback. Disabled
coverage record (`gstack-review-log` codex-plan-review, status skipped,
outside_status disabled): **not persisted** (state writes out of this run's scope).

### Resolve remaining TODO choices
None remain. HOLD SCOPE: no evidenced gap is deferred; every finding is in
accepted scope (R1) or a same-branch task.

### Approval readiness
Checked rows: R1 — approved via D1 auto-decision (authority: run author policy;
recommended option A). Plan applies only that scope (wrapper guard, bounded state,
S1–S6, suppressed-fill count on the existing dashboard). No declined, deferred or
unanswered changes in accepted work. Option C declined and kept out.
`Approval readiness: PASS` (R1 → D1/A).

## Required Outputs

### Review facts
Mode HOLD SCOPE; 1 critical gap found (R1) and resolved; 0 unresolved choices;
0 critical gaps open; scope proposals 0 / accepted 0 / deferred 0; outside
coverage: codex disabled, no completed external review. Status: `clean`.

### NOT in scope
Deferred: none. Rejected: D1 option C "keep the wrapper as proposed and accept
TTL-bounded staleness" — contradicts the retained consistency contract. Author's
out-of-scope list retained: distributed caching, cross-process coherence,
prewarming, consistency-semantics changes, new product surfaces.

### What already exists
See 0B: LRU adapter (limits, TTL, sentinel, bypass), single-flight cohort in
repository.read, atomic repository.write, rollout controller with instance
isolation, telemetry/dashboards/runbooks, contract test harness. All reused.

### Dream state delta
See 0C. After this plan the service meets its DB CPU / p95 targets with the
consistency contract intact and a stable read-through boundary; the 12-month
ideal needs no further caching work unless the key set outgrows 1000 entries.

### Error & Rescue Registry
See Section 2 tables (7 codepath rows, 1 GAP → resolved by R1; 0 CRITICAL GAPS).

### Failure Modes Registry
```
  CODEPATH                    | FAILURE MODE                 | RESCUED?     | TEST?      | USER SEES?          | LOGGED?
  ----------------------------|------------------------------|--------------|------------|---------------------|---------------------
  readProfile#cache.get/set   | adapter failure              | Y (bypass)   | Y          | slower, correct     | Y (no keys)
  readProfile#repository.read | store error                  | Y (typed)    | Y          | existing API error  | Y (existing)
  readProfile#repository.read | record missing               | n/a          | Y          | not-found result    | n/a
  readProfile fill            | stale snapshot after write   | Y (R1 guard) | Y (S1,S3)  | committed version   | Y (suppressed count)
  writeProfile#repository.write| write rejected              | Y (typed)    | Y (S5)     | existing API error  | Y (existing)
  writeProfile#cache.delete   | adapter failure after commit | Y (bypass)   | Y          | correct, slower     | Y (no keys)
  controller swap             | in-flight miss during swap   | Y (isolation)| Y (S6)     | committed version   | Y (existing)
  LRU                         | hot set > 1000 / 16 MiB      | Y (evict)    | Y          | lower hit rate      | Y (eviction metric)
```
8 rows, 0 CRITICAL GAPS.

### Diagrams
1. System architecture: Section 1. 2. Data flow with shadow paths: Sections 1
and 4. 3. State machine: cache entry per key —
```
  [absent] --fill(gen unchanged)--> [value v, TTL 30s] --write commit+delete--> [absent]
  [absent] --fill(absent DTO)-----> [sentinel, TTL 10s] --create commit+delete--> [absent]
  [absent] --fill(gen changed)----> [absent]  (suppressed; impossible: stale value installed after completed write)
  [value]  --TTL expiry/evict-----> [absent]
  any      --adapter failure------> [bypass] --empty reinit--> [absent]
```
4. Error flow: Section 2. 5. Deployment sequence:
```
  deploy wrapper (flag off) -> 10% keys, 1 healthy hour -> 50%, 1 healthy hour -> 100%, acceptance targets
```
6. Rollback flowchart:
```
  breach/alert -> disable flag -> controller stops admitting -> await old writes -> publish disabled instance -> runbook incident record -> resume criteria
```

### Stale Diagram Audit
No existing ASCII diagrams in files this plan touches (new module). 0 stale.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~30min)** — wrapper — Implement the R1 fill guard (skip fills whose read overlapped a committed write; bounded in-flight state) and scenarios S1–S6 on the existing harness
  - Surfaced by: Section 1 / Section 4 — R1 stale fill after completed write (D1 → A)
  - Files: to be determined (new wrapper module and its test file)
  - Verify: S1–S6 pass deterministically with pause/release points; S1 asserts no fill and suppressed-fill count +1
- [ ] **T2 (P2, human: ~1h / CC: ~5min)** — wrapper — Add the fill/write ordering ASCII comment (Section 4 schedule) above the wrapper
  - Surfaced by: Section 5 / Section 10 — knowledge concentration
  - Files: to be determined (wrapper module)
  - Verify: comment present and matches Section 4 schedule in review
- [ ] **T3 (P2, human: ~1h / CC: ~5min)** — tests — Drive TTL and sentinel-expiry tests from the harness's controlled clock
  - Surfaced by: Section 6 — flakiness risk
  - Files: to be determined (wrapper test file)
  - Verify: TTL tests pass repeatedly with no wall-clock sleeps
- [ ] **T4 (P2, human: ~30min / CC: ~5min)** — runbook — Add the note that rising suppressed fills on write-hot keys is expected, with the existing bypass/p95 alerts unchanged
  - Surfaced by: Section 8 — runbook coverage of the new branch
  - Files: to be determined (existing runbook)
  - Verify: runbook reviewed by service owner before the 10% stage
_No new tasks from Sections 3, 7, 9, 11._
Task JSONL for /autoplan: **not persisted** (state writes out of this run's scope).
Ratios assumed: bug fix with regression ~20x, docs ~10x.

### Completion Summary
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | HOLD SCOPE                                  |
  | System Audit         | skipped per run rules (fixture)             |
  | Step 0               | HOLD SCOPE; R1 approved (D1 → A)            |
  | Section 1  (Arch)    | 1 issue found (R1, resolved)                |
  | Section 2  (Errors)  | 7 error paths mapped, 1 GAP (resolved)      |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 5 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 1 issue found (R1; comment task T2)         |
  | Section 6  (Tests)   | Diagram produced, 0 gaps (T3 note)          |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 1 gap found (runbook note, T4)              |
  | Section 9  (Deploy)  | 0 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 5/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (1 rejected, 0 deferred)            |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 7 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 8 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
  | CEO plan             | skipped by mode                             |
  | Outside voice        | codex disabled (no completed review)        |
  | Lake Score           | 1/1 recommendations chose complete option   |
  | Diagrams produced    | 6 (arch, data flow, state, error, deploy,   |
  |                      | rollback)                                   |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```
Review Log / decision log / dashboard read: **not persisted / not run** (state
writes and gstack history are out of this run's scope; no write attempted).
No durable learnings this session.

### Unresolved Decisions
None. D1 was resolved by authorized auto-decision (A).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (not persisted) | CLEAR | mode: HOLD SCOPE, 0 critical gaps |
| Outside Review | codex (`codex_reviews: disabled`) | Independent 2nd opinion | 0 | DISABLED | disabled by config; no completed external review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | not run |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI scope) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**OUTSIDE COVERAGE:** provider codex, phase plan-review, disabled by `codex_reviews: disabled`; no outside process or native fallback ran; no findings; disabled record not persisted.
**VERDICT:** CEO CLEARED (HOLD SCOPE; R1 resolved by D1 → A) — eng review required

NO UNRESOLVED DECISIONS
