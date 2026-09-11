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

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, and authorization. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, and concurrent-miss coalescing.
The rollout uses the existing runtime feature flag: enable for 10% of keys,
then 50%, then all keys after one healthy hour at each stage. Monitor hit/miss,
eviction, cache bytes, fallback errors, DB CPU, and read p95 without raw IDs.
On error-rate or latency regression, disable the flag immediately; both reads
and writes bypass the cache while disabled, and enabling creates an empty cache.
Cold starts remain within the existing DB capacity. The service owner monitors
the rollout and records the results against the acceptance targets.

## Out of scope
Distributed caching, cross-process coherence, prewarming, changing consistency
semantics, or adding new product surfaces. The repository interface preserves a
future replacement path without introducing a general cache framework now.

---

## CEO Review — HOLD SCOPE

*Mode: HOLD SCOPE. Scope accepted as stated. Goal: make it bulletproof.*
*Automated run — AskUserQuestion unavailable; recommended options auto-selected at each decision point.*

---

### Step 0: Premise Challenge

**0A. Is this the right problem?**
Yes. The evidence base is concrete: one-week trace, 900 hot keys, 70% DB CPU,
120ms p95. The plan targets the measured bottleneck directly. Doing nothing risks
CPU headroom exhaustion as write volume grows.

**0B. Existing code leverage**
The plan maximally reuses existing infrastructure: the LRU adapter, the
single-flight wrapper, and the feature flag. No parallel or competing
implementations are proposed.

**0C. Dream state**
```
CURRENT STATE               THIS PLAN              12-MONTH IDEAL
DB CPU 70%,        --->    DB CPU <50%,   --->    DB CPU <35%,
p95 120ms,                 p95 <60ms,             p95 <30ms,
no caching,                ≥60% hit rate,         steady-state hit rate
900 hot key                single-process         management; multi-process
repeated reads             LRU wrapper            path re-evaluated only
                                                  with evidence of need
```

**0C-bis. Implementation alternatives**

```
APPROACH A: Wrapper as specified (plan's approach)
  Summary: Thin LRU wrapper around existing repository; reuse adapter + single-flight.
  Effort:  S
  Risk:    Low
  Pros:    Minimal diff; no new abstractions; existing adapter already battle-tested.
           Adapter failure bypass already proven. Feature flag gives instant rollback.
  Cons:    Stale-set race not addressed in pseudocode (see Section 1).
           No prewarming on cold starts.
  Reuses:  Existing LRU adapter, single-flight wrapper, feature flag.

APPROACH B: Versioned cache with generation counter
  Summary: Add a monotonic generation counter; readProfile checks generation before set.
  Effort:  M
  Risk:    Low-Med
  Pros:    Formally correct against write-then-read interleaving at the cost of a
           counter variable. Documents the invariant in the implementation.
  Cons:    Extra coordination variable. In a single JS event loop, a simpler guard
           (check key absence before set) achieves the same correctness with less code.
  Reuses:  Same adapter and single-flight.

RECOMMENDATION: Approach A, patched with the cache.get guard before cache.set
(see Section 1 finding). The generation counter (B) is unnecessary in a
single-threaded JS event loop; the guard idiom achieves formal correctness
without additional state.
```

**0D. Complexity check (HOLD SCOPE)**
The plan touches 1 file (the repository wrapper) and introduces 0 new
classes/services. No complexity smell. The minimum change set is exactly what
the plan proposes. No deferrable work identified within the core objective.

**0E. Temporal interrogation**
```
HOUR 1 (foundations):   What sentinel value distinguishes absent-record from
                         cache-miss (undefined)? Must be specified in implementation,
                         not just docs.
HOUR 2-3 (core logic):  The stale-set race after a concurrent write. The
                         implementer will hit this when writing the interleaving test.
HOUR 4-5 (integration): Feature flag toggling mid-flight: what happens to an
                         in-progress readProfile when the flag is disabled?
HOUR 6+ (polish/tests): Sentinel TTL (10s) vs regular TTL (30s): the adapter
                         must support per-entry TTL, or the sentinel must be
                         stored with TTL set explicitly. Confirm the existing adapter
                         supports this.
```

---

### Section 1: Architecture Review

**System architecture**

```
                    ┌──────────────────────────────────────────┐
                    │              Single JS Process            │
                    │                                          │
  Caller ──────────▶│  readProfile(key) / writeProfile(key,v)  │
                    │           │              │               │
                    │    ┌──────▼──────┐       │               │
                    │    │  LRU Cache  │       │               │
                    │    │  (adapter)  │◀──delete (write path) │
                    │    │  1000 keys  │       │               │
                    │    │  16 MiB cap │       │               │
                    │    │  30s TTL    │       │               │
                    │    └──────┬──────┘       │               │
                    │           │ miss         │               │
                    │    ┌──────▼──────┐       │               │
                    │    │  Single-    │       │               │
                    │    │  flight     │       │               │
                    │    │  wrapper    │       │               │
                    │    └──────┬──────┘       │               │
                    │           │              │               │
                    │    ┌──────▼──────────────▼──────┐       │
                    │    │       Repository (existing)  │       │
                    │    └──────────────┬──────────────┘       │
                    └──────────────────┼───────────────────────┘
                                       │
                               ┌───────▼──────┐
                               │   Database   │
                               └──────────────┘

Feature flag gate wraps both readProfile and writeProfile;
bypass route goes directly to Repository when flag is off.
```

**Data flow — all four paths**

```
READ (happy):
  KEY ──▶ cache.get ──▶ [HIT, ≠ undefined] ──▶ return cached value

READ (miss):
  KEY ──▶ cache.get ──▶ [MISS, === undefined]
       ──▶ single-flight.get(key)
       ──▶ repository.read(key) ──▶ value
       ──▶ cache.set(key, value)          ← RACE WINDOW (see finding below)
       ──▶ return value

READ (nil/absent sentinel):
  KEY ──▶ cache.get ──▶ [MISS]
       ──▶ repository.read(key) ──▶ sentinel (distinct non-undefined value)
       ──▶ cache.set(key, sentinel, ttl=10s)
       ──▶ return sentinel
  Next read: cache.get ──▶ sentinel (≠ undefined) ──▶ return sentinel

READ (upstream error):
  KEY ──▶ cache.get ──▶ [MISS]
       ──▶ repository.read(key) ──▶ throws TypedError
       ──▶ single-flight releases on failure
       ──▶ cache.set never called
       ──▶ TypedError propagates to caller (existing error mapping)

WRITE (happy):
  KEY + UPDATE ──▶ repository.write(key, update) ──▶ saved
               ──▶ cache.delete(key)
               ──▶ return saved

WRITE (repository failure):
  KEY + UPDATE ──▶ repository.write(key, update) ──▶ throws
               ──▶ cache.delete never called (correct — stale entry preserved)
               ──▶ throws to caller
```

**State machine for cache entries**

```
[ABSENT]
    │ cache miss + repo read + cache.set
    ▼
[PRESENT] ──── TTL 30s expiry ──────────────▶ [ABSENT]
    │                                              ▲
    │ write commit ──▶ cache.delete                │
    ▼                                              │
[INVALIDATED] ──────────────────────────────▶ [ABSENT]
              (immediately, synchronously)

[SENTINEL] (absent-record cached) ──── TTL 10s ──▶ [ABSENT]
```

**CRITICAL FINDING — Write-then-read stale-set race**

The pseudocode's `readProfile` does not guard `cache.set` after the `await`.
In the JS event loop, this interleaving is possible:

```
T1: readProfile(key)
    cache.get(key) → undefined (miss)
    → await repository.read(key)  ← suspended here

T2: writeProfile(key, newData)
    repository.write(key, newData) → committed
    cache.delete(key)              ← runs while T1 is suspended

T1 resumes:
    value = oldData                ← stale snapshot from before T2's write
    cache.set(key, oldData)        ← stale value replaces empty slot!

T3: readProfile(key)               ← started after T2 committed
    cache.get(key) → oldData       ← VIOLATION of the plan's invariant
```

This violates the stated invariant: "Every read begun after that write
completes must observe the committed version."

**Required fix:** Guard `cache.set` with a post-await presence check.
Because `cache.get` and `cache.set` are synchronous within the same event loop
turn (no `await` between them), the check is race-free:

```javascript
async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await repository.read(key);
  // Only cache if no write invalidated this key while we were awaiting
  if (cache.get(key) === undefined) {
    cache.set(key, value);
  }
  return value;
}
```

Auto-selected: **accept fix** — add the guard to the pseudocode and implementation spec.

**Coupling:** The wrapper couples cache lifecycle to repository ops. Intentional, minimal, one-directional. No new coupling introduced outside the wrapper module.

**Scaling:**
- 10x load: Cache hit rate holds (same key distribution). Single-flight protects against miss storms. DB load stays bounded.
- 100x load: Exceeds single-process capacity. Explicitly out of scope. The multi-process startup rejection prevents accidental use.

**SPOF:** LRU adapter. Mitigated: adapter failure bypasses to repository (transparent fallback). No data loss path.

**Rollback:** Feature flag disable. Immediate, zero-downtime, no data migration needed. Both read and write bypass the cache while disabled.

---

### Section 2: Error & Rescue Map

```
METHOD/CODEPATH           | WHAT CAN GO WRONG             | EXCEPTION CLASS
--------------------------|-------------------------------|------------------
readProfile(key)          | cache.get() throws            | CacheAdapterError
                          | repository.read() throws      | [existing typed errors]
                          | cache.set() throws            | CacheAdapterError
writeProfile(key, update) | repository.write() throws     | [existing typed errors]
                          | cache.delete() throws         | CacheAdapterError
single-flight wrapper     | concurrent miss release fails | (internal, clears entry)

EXCEPTION CLASS         | RESCUED? | RESCUE ACTION                  | USER SEES
------------------------|----------|--------------------------------|------------------
CacheAdapterError (get) | Y        | treat as miss, bypass adapter  | transparent
CacheAdapterError (set) | Y        | skip cache set, bypass adapter | transparent
CacheAdapterError (del) | Y        | bypass adapter                 | transparent
[existing typed errors] | Y        | per existing error map         | per existing behavior
```

The plan states: "On any cache failure the existing adapter bypasses the cache."
This is the correct behavior. However, the pseudocode does not show error handling
around `cache.set` or `cache.delete`. The implementation must wrap these calls
with try/catch (or equivalent adapter-level error isolation) to materialize the
documented bypass behavior.

**WARNING:** Pseudocode gap — `cache.set` and `cache.delete` calls are shown as
bare invocations. Make the try/catch (or adapter-level error boundary) explicit
in the implementation to prevent an unhandled CacheAdapterError from propagating
to the caller as an unexpected error type.

Auto-selected: **accept finding** — note explicit error handling requirement in the implementation spec.

---

### Section 3: Security & Threat Model

| Threat | Likelihood | Impact | Mitigated? |
|--------|-----------|--------|-----------|
| Tenant data cross-contamination | Low | High | YES — keys encode tenant ID without ambiguity |
| IDOR via cache | Low | High | YES — auth before cache; keys encode validated profile ID |
| PII in logs | Low | Med | YES — "cache keys never logged"; plan states raw IDs excluded from metrics |
| Cache poisoning | Very Low | High | YES — values are immutable DTOs; no external writer to the in-process cache |
| Bypass of authorization via cache | Low | High | YES — "Cached results cannot bypass authorization" (auth runs before repo access) |

No security findings. The threat model is sound for a single-process in-memory cache on immutable DTOs.

---

### Section 4: Data Flow & Interaction Edge Cases

```
READ DATA FLOW:
  KEY ──▶ CACHE GET ──▶ SINGLE-FLIGHT ──▶ REPO READ ──▶ CACHE SET ──▶ OUTPUT
    │          │               │                │              │           │
    ▼          ▼               ▼                ▼              ▼           ▼
  [key      [HIT→         [coalesces       [throws→       [throws→    [stale?
  validated  return]       concurrent       propagate,     bypass,     see S1
  before     [MISS→        misses]          no cache set]  no set]     finding]
  this       continue]
  layer]
```

**Async ordering — key suspension point analysis:**

The `await repository.read(key)` in `readProfile` is the only suspension point.
During this suspension, `writeProfile` can fully execute (write + cache.delete).
Post-await `cache.set` then installs stale data. This is the race identified in
Section 1; the guard fix closes it.

The `await repository.write(key, update)` in `writeProfile` suspends. During
this suspension, another `readProfile` could start. If the read completes after
the write's `await` resumes and calls `cache.delete`, the delete removes the
fresh data the read just cached. This is benign: the next read will miss and
fetch fresh data from the DB.

**Edge cases:**
| Case | Handled? | How |
|------|----------|-----|
| 1000 concurrent reads on same cold key | YES | Single-flight coalesces to one DB read |
| LRU eviction while read in flight | YES | Read completes, sets value back into cache |
| Byte cap exceeded | YES | Existing adapter evicts LRU entries |
| Flag disabled mid-flight | OK | In-flight request completes using its snapshot; next request bypasses cache |
| Same key written twice before read resumes | OK | Both writes call cache.delete; read's guard sees absence and sets (still first write's data if T1 read started before first write — allowed by invariant) |
| Absent key read concurrently | YES | Single-flight coalesces; sentinel cached with 10s TTL |

No new unhandled edge cases beyond the stale-set race (Section 1).

---

### Section 5: Code Quality Review

- **DRY:** Maximum reuse of existing LRU adapter, single-flight wrapper, feature flag. No repetition.
- **Naming:** `readProfile`, `writeProfile` — clear and consistent with the domain.
- **Error handling patterns:** Relies on adapter-level bypass. Implementation must make this explicit (Section 2).
- **Missing edge case:** The stale-set race (Section 1). No other gaps.
- **Over-engineering:** None. The plan correctly resists introducing a general cache framework.
- **Under-engineering:** The pseudocode omits the post-await guard and the try/catch around cache mutations. Both should be shown explicitly as part of the implementation spec so the implementer has a complete picture.
- **Cyclomatic complexity:** Both functions branch once (readProfile: hit vs miss; writeProfile: success vs throw). No complexity concern.

No new issues beyond those already captured.

---

### Section 6: Test Review

**New UX flows:** None (backend only).

**New data flows:**
- read path: caller → cache get → single-flight → repository → cache set → return
- read path (absent): same, with sentinel and 10s TTL
- write path: caller → repository write → cache delete → return
- adapter-failure bypass: any of the above with cache ops throwing

**New codepaths:**
- `readProfile` (cache hit branch)
- `readProfile` (cache miss branch, including single-flight coalescing)
- `readProfile` (absent-record sentinel branch)
- `writeProfile` (successful write + cache delete)
- `writeProfile` (failed write, no cache delete)
- Adapter failure bypass (all cache ops)
- Feature flag off (full bypass of all cache paths)

**New background jobs/async work:** None.

**New integrations/external calls:** None.

**New error/rescue paths:** CacheAdapterError bypass (Section 2).

**Test coverage per codepath:**

| Codepath | Test in Plan | Type | Happy | Failure | Edge |
|----------|-------------|------|-------|---------|------|
| Cache hit | YES | Unit | ✓ | N/A | — |
| Cache miss | YES | Unit | ✓ | — | — |
| Eviction/byte limits | YES | Unit | ✓ | — | — |
| TTL expiry | YES | Unit | ✓ | — | — |
| Adapter failure bypass | YES | Unit | ✓ | — | — |
| Successful write invalidation | YES | Unit | ✓ | — | — |
| Failed write preservation | YES | Unit | ✓ | — | — |
| Concurrent miss coalescing | YES | Unit | ✓ | — | — |
| Write-while-read stale-set race | **MISSING** | — | — | — | — |
| Sentinel TTL (10s vs 30s) | **MISSING** | — | — | — | — |
| Flag toggle mid-flight | Not mentioned | — | — | — | — |

**WARNING — Missing test: write-while-read stale-set race**

Test spec:
```javascript
it('does not cache stale value when write invalidates key during read', async () => {
  // Arrange: prime a controlled repository.read that we can pause and resume
  let resolveRead;
  repository.read.mockImplementation(() => new Promise(r => { resolveRead = r; }));
  repository.write.mockResolvedValue(newValue);

  // Start read (suspended at await)
  const readPromise = readProfile(key);

  // Write commits and invalidates cache
  await writeProfile(key, update);         // cache.delete runs here
  expect(cache.get(key)).toBeUndefined();

  // Resume read with old value
  resolveRead(oldValue);
  await readPromise;

  // Cache must NOT contain stale old value
  const subsequent = await readProfile(key); // fresh miss → DB → newValue
  expect(subsequent).toEqual(newValue);
});
```

Auto-selected: **accept finding** — add this test to the plan's test list.

**WARNING — Missing test: sentinel TTL differentiation**

The plan specifies absent records use a 10s TTL vs 30s for regular entries.
A test must verify the adapter is invoked with `ttl=10000` (or equivalent) for
sentinels and `ttl=30000` for populated records.

Auto-selected: **accept finding** — add sentinel TTL test.

**Test ambition check:**
- Ship at 2am: The concurrent-miss coalescing test and adapter-failure bypass together cover the main operational risks. With the stale-set test added, confidence is high.
- Hostile QA: The write-while-read interleaving (above) plus "disable flag while 100 reads are in flight and verify none error."
- Chaos test: "Cycle the adapter into failure mode 1000 times under load; verify fallback count equals failure count and zero errors propagate."

---

### Section 7: Performance Review

- **N+1 queries:** Not applicable (no ORM traversal).
- **Memory:** 1000 entries × ~10 KB average DTO = ~10 MB. Well within 16 MiB cap. At maximum sentinel inflation (1000 absent keys), same bound applies.
- **DB indexes:** No new queries. Existing query patterns unchanged.
- **Cache operations:** O(1) average for LRU get/set/delete. Negligible CPU overhead.
- **Connection pool:** No new DB connections. Cache hits eliminate DB round trips.
- **Cold start at rollout stages:** 10% of keys see cache on first enable. DB gets ~100% reads from uncached keys initially. Plan explicitly notes: "Cold starts remain within the existing DB capacity." Confirmed acceptable given 10% staging.
- **Slow paths:** The only non-O(1) path is cache miss + DB read. This is the existing p95 path; caching reduces its frequency by the hit rate target (≥60%).

No performance findings.

---

### Section 8: Observability & Debuggability

**Plan specifies:** hit/miss, eviction, cache bytes, fallback errors, DB CPU, read p95 — all without raw IDs.

**Gaps:**

**WARNING 1 — No alerting thresholds defined**

The plan says "monitor" but not "alert." When should on-call be paged?
Recommended thresholds to define:
- Fallback errors > 1% of cache ops for 2 consecutive minutes → page
- DB CPU > 65% (approaching current 70%) post-rollout → page
- Read p95 > 100ms (regression toward baseline) post-rollout → page

Auto-selected: **accept finding** — add alerting threshold table to rollout section.

**WARNING 2 — No runbook for cache-bypass mode**

When the adapter enters bypass mode, all reads hit the DB. The monitoring shows
"fallback errors" spiking, but what does on-call do?

Runbook skeleton to add:
```
SYMPTOM: fallback_errors > threshold
ROOT CAUSE: Cache adapter failed; service is in bypass mode.
IMPACT: DB CPU returns to ~70%; p95 returns to ~120ms. SLOs not immediately breached.
ACTION 1: Check adapter logs for the specific error class.
ACTION 2: If transient (OOM eviction), cache self-heals on next request.
ACTION 3: If persistent, disable cache feature flag (disabling is idempotent and safe).
ACTION 4: File post-mortem. Adapter failure is unexpected; investigate root cause.
ROLLBACK: gstack-config set cache_enabled false (or equivalent feature flag disable).
```

Auto-selected: **accept finding** — add runbook to the plan's rollout/verification section.

**Additional gaps:**
- TTL expiry rate metric: distinguishes eviction (capacity pressure) from TTL expiry (freshness pattern). Useful for tuning TTL.
- Single-flight coalescing count: shows whether miss storms are common. If high, indicates load spikes.
- Sentinel cache count: tracks how many absent-record lookups are being cached; anomaly spike could indicate key enumeration.

These are **INFO** level — recommended additions, not required. Not surfacing as individual decisions in HOLD SCOPE mode.

---

### Section 9: Deployment & Rollout

**Migration safety:** No DB migration. **OK.**

**Feature flag:** Existing runtime flag. Instant enable/disable. **OK.**

**Rollout sequence:** 10% → 50% → 100% after one healthy hour each. **OK.**

**Rollback:** "Disable the flag immediately." Clear, instant. **OK.**

**WARNING — No explicit numeric rollback threshold**

"On error-rate or latency regression" is the rollback trigger, but the plan's
acceptance targets are specific numbers. The rollback trigger should be equally
specific. Without a number, the service owner must exercise judgment under
pressure, which creates room for under-reaction.

Recommended:
```
ROLLBACK TRIGGER (disable flag immediately if ANY of):
- Fallback error rate > 0.5% of ops over a 5-minute window
- Read p95 > 90ms (75% of the regression budget toward the 120ms baseline)
- DB CPU > 60% over 5 minutes (regression toward the 70% baseline)
- Any unhandled exception propagating from cache paths
```

Auto-selected: **accept finding** — add rollback threshold table to the rollout section.

**Post-deploy verification checklist (first 5 minutes):**
The plan mentions what to monitor but not a concrete first-5-minutes checklist.

Recommended additions:
1. Confirm feature flag is active for target percentage.
2. Verify hit/miss metric is being emitted (not zero/null).
3. Confirm fallback error metric is zero.
4. Spot-check cache bytes > 0 (cache is filling).
5. Check read p95 trend — should be dropping or flat, never rising.

Auto-selected: **accept finding** — add to the verification section.

---

### Section 10: Long-Term Trajectory

- **Technical debt:** Minimal. The plan explicitly says it "preserves a future replacement path without introducing a general cache framework now." Correct choice.
- **Path dependency:** Single-process constraint is documented. The startup rejection for multi-process prevents silent correctness violations. Good.
- **Reversibility:** 5/5. Feature flag makes this a two-way door. No schema changes, no interface changes.
- **Ecosystem fit:** Node.js + LRU + single-flight is a well-understood pattern. Aligns with the existing codebase.
- **1-year readability:** The plan is precise and well-scoped. A new engineer will understand it immediately.

**INFO — No code comment documenting the single-process constraint**

The constraint is in the plan and in the startup rejection, but a comment at the
cache initialization site ("this cache is process-local; multi-process operation
is intentionally unsupported while caching is enabled — see startup check in
[file]") would prevent a future engineer from reasoning that the constraint is
accidental. This is a low-cost improvement that pays dividends when the team grows.

Not a blocking finding in HOLD SCOPE mode. Adding as an INFO item in implementation tasks.

---

### Section 11: Design & UX Review

**SKIPPED** — The plan explicitly states "no UI, API, schema, pricing, or developer onboarding change." No UI scope detected.

---

## Outside Voice

Codex review skipped (`codex_reviews: disabled`). Re-enable: `gstack-config set codex_reviews enabled`.

`outside_status: disabled`

---

## Required Outputs

### NOT in scope

| # | Item | Rationale |
|---|------|-----------|
| 1 | Distributed caching (Redis, Memcached) | Single-process service; no cross-process coherence needed |
| 2 | Cross-process coherence protocol | Multi-process explicitly unsupported |
| 3 | Cache prewarming | Not required; cold starts within DB capacity |
| 4 | Changing consistency semantics | Existing invariants retained without modification |
| 5 | New product surfaces (UI, API, schema) | Internal backend optimization only |
| 6 | General cache framework abstraction | Single-use wrapper; YAGNI applies |

### What already exists

| Component | Partially/fully solves | Plan reuses? |
|-----------|----------------------|--------------|
| LRU adapter | Storage, eviction, TTL, byte cap | YES — wrapper delegates to it |
| Single-flight wrapper | Concurrent miss coalescing | YES — unchanged, wraps existing |
| Feature flag | Safe rollout and instant rollback | YES — existing runtime flag |
| Repository contract tests | Tenant isolation, key validation, auth, DB failures, absence | YES — new tests extend, not replace |
| Typed error mapping | Repository error propagation | YES — preserved unchanged |

### Dream state delta

This plan closes 60–70% of the gap to the 12-month ideal. Remaining delta:
- TTL expiry rate metric not yet tracked
- Alerting thresholds need definition (finding accepted)
- Multi-process path remains blocked (out of scope; acceptable)
- No prewarming (cold starts remain a brief inefficiency; tolerable)

### Error & Rescue Registry

| Method | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|--------|-----------------|----------------|---------|--------------|-----------|
| readProfile | cache.get throws | CacheAdapterError | Y | bypass adapter, treat as miss | transparent |
| readProfile | repository.read throws | TypedError (existing) | Y | propagate per existing map | per existing behavior |
| readProfile | cache.set throws | CacheAdapterError | Y | bypass adapter | transparent |
| writeProfile | repository.write throws | TypedError (existing) | Y | propagate; cache NOT deleted | per existing behavior |
| writeProfile | cache.delete throws | CacheAdapterError | Y | bypass adapter | transparent |
| adapter (any) | adapter enters failure mode | CacheAdapterError | Y | bypass entire adapter until reinit | transparent |

### Failure Modes Registry

| Codepath | Failure Mode | Rescued? | Test? | User Sees | Logged? |
|----------|-------------|---------|-------|-----------|---------|
| readProfile | cache.get error | Y | YES (adapter-failure fallback test) | transparent | should be (WARNING: not specified) |
| readProfile | repo.read error | Y | YES (existing contract tests) | per error type | YES (existing) |
| readProfile | cache.set error | Y | YES (adapter-failure fallback test) | transparent | should be |
| readProfile | **stale-set after write** | **N (gap)** | **N (gap)** | stale data for up to 30s | **N — CRITICAL GAP** |
| writeProfile | repo.write error | Y | YES (failed-write preservation test) | per error type | YES |
| writeProfile | cache.delete error | Y | YES (implied by adapter-failure test) | transparent | should be |
| adapter (global) | bypass mode entered | Y | YES | transparent | should be |

**CRITICAL GAP:** Stale-set race in readProfile — no rescue, no test, silent to user (returns stale data). Fix: add post-await guard (Section 1). Test: add write-while-read test (Section 6).

### TODOS.md Updates

No TODO items surfaced in HOLD SCOPE mode. The findings above are all in-scope
correctness and operability gaps, not future features or optional enhancements.
The observability additions (alerting thresholds, runbook, TTL rate metric) are
treated as required for the rollout section, not deferred.

### Diagrams produced

1. **System architecture** — Section 1 (full component diagram with feature flag bypass)
2. **Data flow (all four paths)** — Section 1 and Section 4
3. **State machine** — Section 1 (cache entry states)
4. **Error flow** — Section 2 (error & rescue table)
5. **Read flow with suspension analysis** — Section 4

Rollback flowchart and deployment sequence are narrative (no complex branching warranting
ASCII art beyond what is in Section 9).

### Stale Diagram Audit

No existing ASCII diagrams in the plan file before this review. No stale diagrams to audit.

---

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~30min / CC: ~5min)** — readProfile — Add post-await stale-set guard
  - Surfaced by: Section 1 — write-then-read stale-set race violates stated consistency invariant
  - Files: repository wrapper module
  - Verify: unit test for write-while-read interleaving (T3 below) must pass; interleaving test must fail without the guard

- [ ] **T2 (P1, human: ~20min / CC: ~3min)** — cache adapter calls — Add explicit error handling around cache.set and cache.delete
  - Surfaced by: Section 2 — pseudocode shows bare cache.set/cache.delete with no try/catch; adapter failure bypass behavior undocumented in code
  - Files: repository wrapper module
  - Verify: adapter-failure test exercises set and delete failure paths; no unhandled CacheAdapterError propagates to caller

- [ ] **T3 (P1, human: ~45min / CC: ~10min)** — test suite — Add write-while-read stale-set interleaving test
  - Surfaced by: Section 6 — missing test for the specific race identified in Section 1
  - Files: repository wrapper test file
  - Verify: test fails on unpatched readProfile (before T1), passes after T1

- [ ] **T4 (P2, human: ~20min / CC: ~5min)** — test suite — Add sentinel TTL differentiation test
  - Surfaced by: Section 6 — plan specifies 10s TTL for absent records vs 30s for populated; not currently in test list
  - Files: repository wrapper test file
  - Verify: test confirms adapter invoked with ttl=10000 for sentinels, ttl=30000 for regular entries

- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — rollout doc — Add numeric rollback thresholds to rollout plan
  - Surfaced by: Section 9 — "error-rate or latency regression" is not actionable under pressure
  - Files: rollout runbook / operational doc
  - Verify: thresholds table covers fallback error rate, p95, and DB CPU with specific values

- [ ] **T6 (P2, human: ~30min / CC: ~5min)** — ops runbook — Write cache-bypass-mode runbook
  - Surfaced by: Section 8 — no documented operational response when adapter enters bypass mode
  - Files: operational runbook (new or appended)
  - Verify: runbook covers symptom, impact, action sequence, and rollback command

- [ ] **T7 (P2, human: ~15min / CC: ~3min)** — rollout doc — Add post-deploy first-5-minutes checklist
  - Surfaced by: Section 9 — plan specifies what to monitor but not a concrete verification sequence
  - Files: rollout section of this plan or separate runbook
  - Verify: checklist covers flag confirmation, metric emission, fallback error count, cache bytes, p95 trend

- [ ] **T8 (P3, human: ~10min / CC: ~2min)** — code comment — Document single-process constraint at cache initialization
  - Surfaced by: Section 10 — constraint exists in docs and startup check but not at the cache init site
  - Files: cache initialization module
  - Verify: comment references the startup rejection and explains multi-process is intentionally unsupported

---

### Completion Summary

```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
+====================================================================+
| Mode selected        | HOLD SCOPE                                  |
| System Audit         | Skipped (automated run)                     |
| Step 0               | HOLD SCOPE confirmed; Approach A + guard fix |
| Section 1  (Arch)    | 1 CRITICAL issue found (stale-set race)     |
| Section 2  (Errors)  | 6 error paths mapped, 1 WARNING (no try/catch) |
| Section 3  (Security)| 0 issues found, 0 High severity             |
| Section 4  (Data/UX) | 7 edge cases mapped, 0 unhandled (race in S1) |
| Section 5  (Quality) | 0 new issues found                          |
| Section 6  (Tests)   | Diagram produced, 2 gaps (stale-set, sentinel TTL) |
| Section 7  (Perf)    | 0 issues found                              |
| Section 8  (Observ)  | 2 WARNING gaps (alerting, runbook)          |
| Section 9  (Deploy)  | 2 gaps (rollback threshold, first-5 checklist) |
| Section 10 (Future)  | Reversibility: 5/5, debt items: 0, 1 INFO  |
| Section 11 (Design)  | SKIPPED (no UI scope)                       |
+--------------------------------------------------------------------+
| NOT in scope         | written (6 items)                           |
| What already exists  | written                                     |
| Dream state delta    | written                                     |
| Error/rescue registry| 6 methods, 0 CRITICAL (stale-set in failure modes) |
| Failure modes        | 7 total, 1 CRITICAL GAP (stale-set race)    |
| TODOS.md updates     | 0 items (all findings are in-scope)         |
| Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
| CEO plan             | skipped (HOLD/REDUCTION mode)               |
| Outside voice        | disabled (codex_reviews=disabled)           |
| Lake Score           | 8/8 sections chose the complete option      |
| Diagrams produced    | 5 (arch, data flow, state machine, error flow, read flow) |
| Stale diagrams found | 0                                           |
| Unresolved decisions | 0                                           |
+====================================================================+
```

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_found | mode: HOLD_SCOPE, 1 critical gap (stale-set race), 6 warnings accepted |
| Outside Review | disabled | Independent 2nd opinion | 0 | disabled | codex_reviews=disabled; no fallback dispatched |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | not yet run |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not applicable (no UI scope) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not yet run |

**OUTSIDE COVERAGE:** disabled — `codex_reviews` is set to `disabled` in config. No outside review step dispatched and no native fallback run. Re-enable: `gstack-config set codex_reviews enabled`.

**VERDICT:** CEO Review complete (HOLD SCOPE). Eng Review required before ship — not yet run.

NO UNRESOLVED DECISIONS
