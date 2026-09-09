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
- Authentication and authorization run before repository access. Keys encode
  the authenticated tenant ID and validated profile ID without ambiguity.
  Values are immutable profile-summary DTOs; secrets and cache keys are never
  logged. Cached results cannot bypass authorization.
- The existing LRU adapter supports 1000 entries, a 16 MiB byte cap, and a
  30-second TTL. Recorded hot data fits those limits. Absent records use a
  distinct sentinel with a 10-second TTL; undefined means a cache miss.
- Cache operations are synchronous and atomic in the single JS event loop.
  On any cache failure the existing adapter bypasses the cache until an empty
  cache is reinitialized; repository errors keep the current typed API error
  mapping. The existing per-key
  single-flight wrapper coalesces simultaneous misses and releases on failure.
- A read already in progress when a write commits may return its earlier DB
  snapshot to that caller. Every read begun after that write completes must
  observe the committed version. TTL expiry is not a substitute for this rule.

## Proposed wrapper integration
Keep the current read-through repository interface and shared adapters. These
are the complete new read/write ordering rules:

**AMENDMENT (Finding 1, auto-decided):** The original pseudocode did not satisfy
the "every read begun after write completes" invariant. A write-generation counter
is added to prevent a completing in-flight read from restoring a stale cache entry
after a concurrent write has deleted it. The counter adds two lines to the wrapper.

```javascript
let _writeGen = 0; // process-local; reset on cache disable/enable

async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const gen = _writeGen;               // capture before await
  const value = await repository.read(key);
  if (_writeGen === gen) {             // no write occurred during this read
    cache.set(key, value);
  }
  return value;
}

async function writeProfile(key, update) {
  const saved = await repository.write(key, update);
  _writeGen++;                         // increment before delete
  cache.delete(key);
  return saved;
}
```

**Why:** Without the generation counter, a read that starts before a write and
completes after it calls `cache.set(key, oldValue)` after the write has called
`cache.delete(key)`, restoring a stale entry for all subsequent reads until TTL
expiry. The invariant forbids relying on TTL for this guarantee. The counter
prevents the stale restore with two lines and no new dependencies.

**Residual risk:** If multiple concurrent writes to different keys occur, any
in-flight read skips its cache.set() even if no write touched its specific key.
This increases cache misses conservatively but never produces stale results.
The additional DB load from spurious misses is bounded by the single-flight
wrapper and is acceptable given the hot-key distribution.

**Verification:** The new test for the concurrent read/write ordering (Finding 4)
must confirm: (a) a read that starts before a write and completes after it does
not restore the old value, and (b) a read started after the write returns the new
value from DB.

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, and authorization. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, concurrent-miss coalescing, and
**concurrent read/write ordering (write-generation counter correctness)**.
The rollout uses the existing runtime feature flag: enable for 10% of keys,
then 50%, then all keys after one healthy hour at each stage. Monitor hit/miss,
eviction, cache bytes, fallback errors, DB CPU, and read p95 without raw IDs.
On error-rate or latency regression, disable the flag immediately; both reads
and writes bypass the cache while disabled, and enabling creates an empty cache.
Cold starts remain within the existing DB capacity. The service owner monitors
the rollout and records the results against the acceptance targets.

**AMENDMENT (Finding 3, auto-decided — TODO):** Alert thresholds and a post-deploy
runbook are deferred to a follow-up task (T3). Minimum runbook content: disable the
feature flag if fallback_errors exceeds threshold or hit rate falls below 40% in
steady state; verify DB CPU trend is downward within 10 minutes of each stage
transition; confirm no fallback errors in the first 5 minutes at 10%.

## Out of scope
Distributed caching, cross-process coherence, prewarming, changing consistency
semantics, or adding new product surfaces. The repository interface preserves a
future replacement path without introducing a general cache framework now.

---

## CEO Review — HOLD SCOPE

Mode: **HOLD SCOPE**. Scope is accepted as stated. Review is for correctness,
coverage, and operability only. No scope additions or reductions.

All findings below were auto-decided (spawned session, no human present;
recommended option selected per skill rules). Each finding is recorded once;
cross-references are used in place of repetition.

### Finding 1 — CRITICAL: Stale Write-Back Race (Sections 1, 4)

**Evidence:** In the JS event loop, `readProfile` has an `await` at
`repository.read(key)`. Between that await and the subsequent `cache.set()`, the
event loop can run `writeProfile`, which calls `cache.delete(key)`. When the
original `readProfile` resumes, it calls `cache.set(key, oldValue)`, restoring the
stale entry. Subsequent reads started after the write return the stale cached value
until TTL (up to 30 s). The plan's invariant prohibits this: "TTL expiry is not a
substitute for this rule."

Schedule showing the violation:
```
T   | readProfile(K)           | writeProfile(K)         | cache[K]
----|--------------------------|-------------------------|----------
0   | cache.get(K) → miss      |                         | absent
1   | await repo.read(K)...    |                         | absent
2   |                          | await repo.write(K)...  | absent
3   |                          | cache.delete(K)         | absent
4   |                          | return saved            | absent
5   | ...read resolves         |                         | absent
6   | cache.set(K, old)        |                         | old ← VIOLATION
7   | return old to caller*    |                         | old
    *T=7 return is explicitly allowed; cache[K]=old is not.
```

**Remedy (accepted):** Write-generation counter — see amended pseudocode above.
**Residual risk:** Conservative miss-skip under concurrent multi-key writes (bounded).
**Verification:** Concurrent read/write ordering test (Finding 4 → T2).

### Finding 2 — OK: Cache Adapter Error Handling (Section 2)

The plan states the existing adapter bypasses the cache on any internal failure and
never propagates LRU errors to callers. The pseudocode correctly relies on this
contract. The "adapter-failure fallback" test verifies it. No gap.

### Finding 3 — TODO: Alert Thresholds and Post-Deploy Runbook (Sections 8, 9)

**Evidence:** The plan specifies metrics to monitor but does not specify alert
thresholds (e.g., hit rate <40%, fallback_errors >N/min) or a runbook (what to do,
in order, when each metric fires). Without thresholds, the rollout is monitored by
inspection rather than automation.

**Remedy (deferred to T3):** Minimum viable runbook: disable flag if fallback_errors
spikes or hit rate below 40% in steady state; DB CPU downward trend expected within
10 minutes of each stage; no fallback errors in first 5 minutes at 10% stage.
Alert thresholds to be set based on baseline metrics at initial 10% stage.

**Residual risk:** Rollout relies on manual inspection until runbook is written. The
feature flag mitigates this (fast disable path is documented).

**Verification:** Runbook reviewed by service owner before 50% stage.

---

## NOT in scope

1. Distributed caching — explicitly excluded; multi-process unsupported at startup.
2. Cross-process cache coherence — single process only; enforced by startup check.
3. Cache prewarming — hot data fills naturally via feature flag rollout.
4. Changing consistency semantics — existing read/write ordering rules are preserved.
5. New product surfaces (UI, API, schema, pricing) — internal backend change only.
6. General cache framework — this wrapper is specific to this repository.
7. Per-key write-gen tracking — conservative global counter accepted; per-key adds
   complexity without changing the correctness guarantee (see Finding 1 residual risk).

## What already exists

| Sub-problem | Existing code | Reused? |
|-------------|---------------|---------|
| LRU storage | Existing LRU adapter (1000 entries, 16 MiB, 30 s TTL) | Yes — unchanged |
| Repository interface | Existing read-through repo | Yes — wrapper sits above it |
| Single-flight for concurrent misses | Existing per-key single-flight in repo layer | Yes — transparent to wrapper |
| Auth/authorization | Runs before any repo access | Yes — no change |
| Feature flag | Existing runtime flag | Yes — rollout gated by it |
| Key validation | Existing tenant+profile key encoding | Yes — unchanged |
| Error mapping | Existing typed API error classes | Yes — unchanged |
| Contract tests | Existing repo contract test suite | Yes — extended with new cases |

## Dream state delta

```
CURRENT STATE                 THIS PLAN                  12-MONTH IDEAL
─────────────────────         ─────────────────────      ──────────────────────
DB CPU 70%, p95 120ms  ──▶   Cache wrapper added  ──▶   If multi-process needed:
900 hot keys hit DB           LRU in single process       Redis or distributed LRU
Single process                60%+ hit rate               (separate decision gate)
No caching layer              DB CPU <50%, p95 <60ms     Current: single-process
                              Feature-flagged rollout      constraint continues to
                              Write-gen counter added       serve well if load stays
                              (correctness gap closed)      single-process
```

This plan moves toward the ideal. The multi-process path is preserved (startup
rejection is explicit, not buried). The 12-month ideal requires a separate decision
only if the service scales to multiple processes.

---

## Diagrams

### 1. System Architecture

```
┌─────────────────────────────────────────────────┐
│              Single JS Process                   │
│                                                  │
│  Caller                                          │
│    │                                             │
│    ▼                                             │
│  ┌─────────────────────────────────────┐         │
│  │         Cache Wrapper (NEW)          │         │
│  │  readProfile / writeProfile          │         │
│  │  _writeGen counter (NEW)            │         │
│  └──────┬────────────────┬────────────┘         │
│         │ read-through   │ invalidate            │
│         ▼                ▼                       │
│  ┌─────────────┐  ┌──────────────┐               │
│  │ LRU Adapter  │  │  Repository  │               │
│  │ (existing)   │  │  (existing)  │               │
│  │ 1000 entries │  │  single-flt  │               │
│  │ 16 MiB cap   │  │  (existing)  │               │
│  │ 30 s TTL     │  └──────┬───────┘               │
│  └─────────────┘         │                       │
│    bypass on fail         ▼                       │
│                      Database                    │
└─────────────────────────────────────────────────┘
```

### 2. Data Flow (all four paths)

```
KEY ──▶ [cache.get(key)]
            │
     ┌──────┴──────────┐
     │ hit             │ miss
     ▼                 ▼
  RETURN          capture gen = _writeGen
  cached              │
                  [await repo.read(key)]
                      │
         ┌────────────┼────────────┐
         │ success    │ error      │ nil/not-found
         ▼            ▼            ▼
   _writeGen==gen?  propagate   sentinel set
         │           typed        (10 s TTL)
     ┌───┴───┐       error
     │Y      │N
     ▼       ▼
  cache.set  skip set
  (key,val)  (stale guard)
     │
     └──▶ RETURN value

WRITE PATH:
KEY + UPDATE ──▶ [await repo.write(key, update)]
                        │
             ┌──────────┴──────────┐
             │ success             │ error
             ▼                     ▼
       _writeGen++            propagate
       cache.delete(key)       typed error
       RETURN saved            (cache unchanged)
```

### 3. Cache State Machine

```
         enable flag           adapter failure
              │                      │
              ▼                      ▼
         ┌─────────┐          ┌──────────┐
         │  ACTIVE  │─────────▶  BYPASS  │
         │ (hit/miss│  error   │(all ops  │
         │  served) │          │ skip     │
         └────┬─────┘          │ cache)   │
              │                └────┬─────┘
              │ disable flag        │ empty cache
              ▼                     │ reinit
         ┌─────────┐                │
         │ DISABLED │◀──────────────┘
         │(no cache │
         │ ops)     │
         └──────────┘
```

### 4. Error Flow

```
                 ┌─────────────────────┐
                 │   readProfile(key)   │
                 └──────────┬──────────┘
                            │
                   cache.get() throws?
                   ┌────────┴────────┐
                   │ Y (adapter err) │ N
                   ▼                 ▼
              adapter bypass      cache hit?
              (internal to        ┌────┴────┐
               adapter)          │Y        │N
                                 ▼         ▼
                             return      repo.read()
                             cached          │
                                     ┌──────┴──────┐
                                     │ success     │ error
                                     ▼             ▼
                               gen check?     propagate
                               ┌──┴──┐        typed err
                               │Y    │N
                               ▼     ▼
                            cache.  skip
                            set()   set
                            return  return
                            value   value
```

### 5. Rollout Sequence

```
CODE DEPLOY
     │
     ▼
Flag: DISABLED (0%)
  All reads bypass cache → DB
     │
     ▼ enable at 10%
Flag: 10% of keys cached
  Monitor: hit/miss, fallback_errors, DB CPU, p95
  Wait: 1 healthy hour
  Gate: error rate and latency within SLO
     │
     ▼ promote to 50%
Flag: 50% of keys cached
  Monitor same metrics
  Wait: 1 healthy hour
  Gate: same
     │
     ▼ promote to 100%
Flag: ALL keys cached
  Acceptance: ≥60% hit, DB CPU <50%, p95 <60 ms
     │
  On regression at any stage:
     ▼
Flag: DISABLED immediately
  Both reads and writes bypass cache
  Re-enable creates empty cache
```

### 6. Rollback Flowchart

```
Regression detected (error rate or latency)
     │
     ▼
Disable feature flag (seconds, no deploy needed)
     │
     ▼
Verify: all reads/writes bypass cache, metrics normalize
     │
     ▼
Investigate root cause (logs: fallback_errors, eviction rate)
     │
     ┌──────────────────────────────┐
     │ Code bug?      │ Config bug? │
     ▼                ▼             │
  Code fix +       Adjust LRU       │
  re-deploy        limits           │
     │                ▼             │
     └──────────▶ Re-enable flag    │
                  at 10% and        │
                  retest            │
                                    ▼
                              If unresolvable:
                              git revert wrapper
                              (feature flag already
                               prevents cache ops,
                               revert is belt-and-
                               suspenders)
```

### Stale Diagram Audit

No existing ASCII diagrams found in this plan's files (new plan). No stale diagrams.

---

## Error & Rescue Registry

| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `cache.get()` | LRU internal error | LRUError | Y (adapter) | Adapter bypasses cache | DB read (transparent) |
| `cache.set()` | LRU internal error | LRUError | Y (adapter) | Adapter bypasses cache | DB read (transparent) |
| `cache.delete()` | LRU internal error | LRUError | Y (adapter) | Adapter bypasses cache | Next read hits DB |
| `repository.read()` | DB connection failure | DatabaseError | Y (existing) | Typed API error | Error response |
| `repository.read()` | Record not found | RecordNotFound | Y (existing) | Sentinel (10 s TTL) | Not-found response |
| `repository.write()` | DB write failure | DatabaseError | Y (existing) | Typed API error; cache NOT deleted | Error response |
| `repository.write()` | Conflict/constraint | ConflictError | Y (existing) | Typed API error; cache NOT deleted | Conflict response |

No CRITICAL GAPS. All error paths are handled via existing adapter and repository contracts.

---

## Failure Modes Registry

| Codepath | Failure Mode | Rescued? | Test? | User Sees | Logged? |
|----------|-------------|----------|-------|-----------|---------|
| `readProfile` | cache.get() throws | Y (adapter bypass) | Y (adapter-failure fallback test) | Transparent DB hit | Y (adapter internal) |
| `readProfile` | DB read error | Y (existing typed) | Y (existing contract) | Error response | Y (existing) |
| `readProfile` | Stale write-back (in-flight read after write) | Y (write-gen counter — **AMENDED**) | Y (T2 — new test required) | Correct value | N/A (prevented) |
| `writeProfile` | DB write fails, cache preserved | Y (existing typed) | Y (failed-write preservation test) | Error response | Y (existing) |
| `writeProfile` | cache.delete() throws after successful write | Y (adapter bypass) | Y (adapter-failure fallback) | Transparent; next read is DB miss | Y (adapter internal) |
| LRU adapter | Full bypass state | Y (adapter) | Y (adapter-failure fallback) | All reads/writes hit DB | Y (fallback_errors metric) |

**CRITICAL GAPS resolved:** Finding 1 (stale write-back) is addressed by the write-gen counter amendment. The test (T2) is required before ship.

---

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code; checkbox as you ship.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — Cache Wrapper — Add write-generation counter to `readProfile`
  - Surfaced by: Finding 1 — stale write-back race violates "reads begun after write" invariant
  - Change: add `let _writeGen = 0`, capture `gen = _writeGen` before `await repo.read()`, conditional `cache.set()` only when `_writeGen === gen`; increment `_writeGen++` in `writeProfile` before `cache.delete()`
  - Files: cache wrapper module (new file wrapping the repository)
  - Verify: all new wrapper tests pass; T2 test specifically confirms ordering invariant

- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — Tests — Add concurrent read/write ordering test
  - Surfaced by: Finding 4 (Section 6) — no test for stale write-back race; required to verify T1
  - Scenario: pause readProfile after cache miss, run writeProfile to completion, resume readProfile, assert next read returns new value not old
  - Files: cache wrapper test file
  - Verify: test fails without write-gen counter, passes with it; CI must include this test

- [ ] **T3 (P3, human: ~30min / CC: ~5min)** — Observability — Alert thresholds and post-deploy runbook
  - Surfaced by: Finding 3 (Sections 8, 9) — metrics listed but no thresholds or runbook
  - Content: hit rate alert (<40% in steady state), fallback_errors threshold, 5-minute post-deploy checklist per rollout stage, disable-flag runbook
  - Files: ops/runbook-cache-wrapper.md (or equivalent)
  - Verify: service owner reviews before 50% stage promotion

_No new tasks from Sections 3, 5, 7, 10, 11._

---

## Completion Summary

```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
+====================================================================+
| Mode selected        | HOLD SCOPE                                  |
| System Audit         | Skipped (test instructions)                 |
| Step 0               | HOLD SCOPE confirmed; premise valid;        |
|                      | measured problem, direct solution           |
| Section 1  (Arch)    | 1 critical finding (stale write-back race)  |
| Section 2  (Errors)  | 7 error paths mapped, 0 GAPS                |
| Section 3  (Security)| 0 issues found, 0 High severity             |
| Section 4  (Data/UX) | 1 ordering violation confirmed → Finding 1  |
| Section 5  (Quality) | 0 new issues                                |
| Section 6  (Tests)   | Diagram produced, 1 gap (race test)         |
| Section 7  (Perf)    | 0 issues found                              |
| Section 8  (Observ)  | 1 gap (no alert thresholds or runbook)      |
| Section 9  (Deploy)  | 1 gap (no post-deploy checklist — merged    |
|                      | into Finding 3 / T3)                        |
| Section 10 (Future)  | Reversibility: 4/5, 0 new debt items        |
| Section 11 (Design)  | SKIPPED (no UI scope)                       |
+--------------------------------------------------------------------+
| NOT in scope         | written (7 items)                           |
| What already exists  | written (8 items)                           |
| Dream state delta    | written                                     |
| Error/rescue registry| 7 methods, 0 CRITICAL GAPS                  |
| Failure modes        | 6 total, 1 CRITICAL GAP found and closed by |
|                      | write-gen counter amendment (T1 required)   |
| TODOS.md updates     | 1 item (T3: runbook + thresholds)           |
| Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
| CEO plan             | skipped (HOLD SCOPE)                        |
| Outside voice        | disabled (codex_reviews: disabled)          |
| Lake Score           | 3/3 recommendations chose complete option   |
| Diagrams produced    | 6 (architecture, data flow, state machine,  |
|                      | error flow, rollout sequence, rollback)     |
| Stale diagrams found | 0 (new plan)                                |
| Unresolved decisions | 0 (all auto-decided, spawned session)       |
+====================================================================+
```

### Auto-Decided Items (spawned session)

All AskUserQuestion decision points were auto-decided per skill rules (spawned
session, recommended option selected, no destructive choices):

- **Finding 1 remedy** → write-generation counter (recommended: minimal, correct,
  no new dependencies). Alternative considered: setIfAbsent semantics (requires
  LRU adapter API change — more invasive). Counter selected.
- **Finding 3** → deferred to T3 as TODO (recommended: defer; rollout proceeds
  with manual monitoring; fast flag disable remains the primary safety mechanism).
- **Stale write-back test (Finding 4)** → required as T2 (P1, blocks ship with T1).

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open (T1+T2 required) | mode: HOLD_SCOPE, 1 critical gap (stale write-back, write-gen remedy accepted), 0 unresolved |
| Outside Review | codex_reviews=disabled | Independent 2nd opinion | 0 | disabled | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** disabled — `codex_reviews: disabled` in `.gstack-section-state-4pqsxp/config.yaml`. No fallback dispatched; disabled is an intentional opt-out. Re-enable: `gstack-config set codex_reviews enabled`.

**VERDICT:** CEO review complete. Eng Review required before ship (not yet run). T1 (write-gen counter) and T2 (race test) are P1 blockers. T3 (runbook) is P3. eng review required.

NO UNRESOLVED DECISIONS
