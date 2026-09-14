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

## CEO REVIEW — HOLD SCOPE

*Mode: HOLD SCOPE. Scope is accepted as stated; review focuses on correctness,
security, observability, and deployment risk. No expansions surfaced.*

### Step 0 — Scope Confirmation

**0A. Premise Challenge**

The problem is measured, not hypothetical. A one-week trace showing 900 hot keys,
70% DB CPU, and p95 120 ms is solid evidence. The acceptance targets (≥60% hits,
DB CPU <50%, p95 <60 ms) are concrete and verifiable. The direct path — process-
local LRU wrapping the existing repository — is correct. Doing nothing leaves the
DB pressure growing as the hot-key set grows.

**0B. Existing Code Leverage**

- The existing LRU adapter is reused without modification.
- The existing single-flight wrapper is reused.
- The existing runtime feature flag is the rollout mechanism.
- The existing repository interface is preserved unchanged.

Nothing is being rebuilt that already exists. The wrapper is purely additive.

**0C. Dream State Mapping**

```
CURRENT STATE              THIS PLAN                  12-MONTH IDEAL
DB CPU 70%        --->     Process-local LRU     --->  DB CPU <50%
p95 120 ms                 wrapper               --->  p95 <60 ms
900 repeated reads         Feature-flag rollout  --->  ≥60% cache hits
                           10% → 50% → 100%            Stable operation
                                                        Distributed cache
                                                        as next step if
                                                        scale requires
```

The 12-month ideal is essentially this plan's success state. The plan explicitly
defers distributed caching, which is the correct next evolution if process-count
scales.

**0C-bis. Implementation Approaches (auto-decided)**

Three approaches evaluated:

```
APPROACH A: Inline cache logic in repository methods
  Summary: Add cache calls directly inside existing read/write methods.
  Effort:  S
  Risk:    Low
  Pros:    Fewest files; no new layer
  Cons:    Harder to test independently; toggle coupling; harder to replace
  Reuses:  Existing adapter

APPROACH B: Wrapper layer (the plan's approach) [SELECTED]
  Summary: Thin wrapper module owns cache interaction; repository unchanged.
  Effort:  S
  Risk:    Low
  Pros:    Independently testable; clean separation; future-replaceable
  Cons:    One extra layer (trivial in practice)
  Reuses:  Existing adapter, single-flight, feature flag

APPROACH C: External cache (Redis)
  Summary: Move caching to Redis for cross-process coherence.
  Effort:  XL
  Risk:    High
  Pros:    Cross-process safe
  Cons:    Out of scope; network latency; cross-process coherence complexity
  Reuses:  None of the existing infrastructure
```

**RECOMMENDATION: Approach B** — matches "engineered enough" preference: clean
separation, independently testable, preserves future replacement path. The wrapper
is thin enough that the extra layer costs nothing. Auto-decided: proceed with the
plan's approach.

**0D. HOLD SCOPE Analysis**

1. *Complexity check:* The plan touches approximately 1 new module (the wrapper)
   and 1 new test file. No new services or classes beyond the wrapper. No
   complexity smell.
2. *Minimum set:* The plan is already scoped to wrapper + tests + rollout
   monitoring. Nothing extraneous.
3. *Stated invariants:* The ordering rule ("every read begun after write completes
   must observe the committed version") is a hard requirement. Several sections
   below check the implementation against it.

**0E. Temporal Interrogation**

```
HOUR 1 (foundations):   What is the exact cache key format? The plan asserts
                         "without ambiguity" but doesn't show the format.
                         Implementer needs to specify and document it.

HOUR 2-3 (core logic):  What happens when cache.delete throws during a
                         successful write? The code lets the exception
                         propagate, misleading the caller. Needs handling.

HOUR 4-5 (integration): The in-flight single-flight read can call cache.set
                         AFTER a concurrent write's cache.delete, re-populating
                         the cache with stale data. This violates the ordering
                         invariant. Needs a guard before cache.set.

HOUR 6+ (tests/polish): The rollout "healthy hour" criterion is qualitative.
                         What numeric thresholds govern advancement?
                         What clock mocking strategy handles TTL tests?
```

---

### Section 1: Architecture Review

**System architecture:**

```
  ┌─────────────────────────────────────────────────┐
  │              Profile-Summary Service Process     │
  │                                                 │
  │  Caller ──▶ AuthZ/AuthN ──▶ CacheWrapper        │
  │                                ├── LRU Adapter  │
  │                                │   (1000 keys,  │
  │                                │   16 MiB, 30s) │
  │                                │                │
  │                                │ miss           │
  │                                ▼                │
  │                         SingleFlight            │
  │                                │                │
  │                                ▼                │
  │                         Repository ──▶ Database │
  │                                                 │
  │  Startup guard: rejects multi-process config    │
  │  Feature flag: bypasses wrapper when disabled   │
  └─────────────────────────────────────────────────┘

  Coupling delta: CacheWrapper is a new dependency on top of Repository.
  No other coupling changes.
```

**Data flow — readProfile (all four paths):**

```
  key ──▶ cache.get(key)
            │
            ├─ HIT  ──────────────────────────────────▶ return value  [HAPPY]
            │
            ├─ FAIL ──▶ adapter bypass → treat as miss [ERROR → bypass]
            │
            └─ MISS ──▶ await repository.read(key)
                              │
                              ├─ ERROR ──▶ propagate; sf releases     [ERROR]
                              │
                              └─ OK ──▶ cache.set(key, value) ──▶ return value
                                           │
                                           └─ FAIL ──▶ bypass; return value anyway
```

**Data flow — writeProfile (all four paths):**

```
  key, update ──▶ await repository.write(key, update)
                          │
                          ├─ ERROR ──▶ cache NOT modified; propagate  [ERROR]
                          │
                          └─ OK ──▶ cache.delete(key) ──▶ return saved
                                           │
                                           └─ FAIL ──▶ exception propagates!
                                                        caller sees write failure
                                                        even though write succeeded
                                                        ← GAP (see Finding 2)
```

**State machine — LRU adapter:**

```
  [ACTIVE] ──▶ cache.get/set/delete ──▶ [ACTIVE]
     │
     └─ adapter failure ──▶ [BYPASS] ──▶ empty cache reinit ──▶ [ACTIVE]
                                │
                                └─ feature flag off ──▶ [DISABLED]
  [DISABLED] ──▶ flag on ──▶ [ACTIVE] (empty cache)
```

**CRITICAL FINDING 1: Post-write stale cache re-population**

The proposed code has a correctness gap in the concurrent read-during-write
scenario. The single-threaded JS event loop does not prevent this interleaving:

```
TIMELINE    readProfile(k)              writeProfile(k)      Cache[k]
─────────────────────────────────────────────────────────────────────
T1          cache.get(k) → miss         —                    undefined
T2          sf: await repo.read(k)      —                    undefined
T3          [awaiting at yield point]   repo.write resolves  v0 (old)
T4          [awaiting]                  cache.delete(k)      undefined ✓
T5          repo.read returns v0        return saved         undefined
T6          cache.set(k, v0)  ← STALE  —                    v0 (BAD!)
T7          return v0                   —                    v0 (BAD!)
```

After T4 the cache correctly reflects the new write. At T6, the in-flight read
re-populates the cache with the pre-write snapshot. Reads begun after T7 (after
the write completes) will get v0 from cache until TTL expiry (up to 30 seconds).
This violates the invariant: "every read begun after that write completes must
observe the committed version."

**Recommended fix (auto-decided):** Add a re-check guard before cache.set in the
read path. Because no await occurs between the re-check and cache.set (single JS
event loop), this is safe:

```javascript
async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await repository.read(key);
  // Guard: only cache if write did not invalidate the key during our read
  if (cache.get(key) === undefined) {
    cache.set(key, value);
  }
  return value;
}
```

This requires that the absent-record sentinel is a distinct non-undefined value
(confirmed by the plan: "undefined means a cache miss"). When the write's
cache.delete ran at T4, cache.get(k) at T6 returns undefined → guard fires → we
do not re-populate. The read still returns v0 (which is allowed per the invariant
for reads in-flight during the write). Reads begun after the write see a miss and
fetch the committed version from DB.

**Single points of failure:**
- Cache adapter: covered by bypass fallback.
- DB: covered by existing repository error handling.
- Feature flag: disabling bypasses cache entirely; no SPOF in the flag path.

**Rollback posture:** Flag flip. Seconds. Both read and write bypass the cache
when disabled. Enabling creates an empty cache (no stale data on re-enable).

**Production failure scenario:**
- Cache adapter crashes mid-operation: bypass mode activates; DB load spikes
  temporarily to pre-cache levels. Not a service outage, but a load event.
- DB timeout during a miss: repository error propagates; single-flight releases;
  no cache poisoning (the failed read does not call cache.set).

*Section 1 findings: 1 CRITICAL GAP (post-write stale re-population).*

---

### Section 2: Error & Rescue Map

**Error/Rescue Registry:**

```
METHOD/CODEPATH            | WHAT CAN GO WRONG              | EXCEPTION CLASS
---------------------------|--------------------------------|-------------------
readProfile(key)           | cache.get adapter failure      | CacheAdapterError
                           | repository.read typed failure  | RepositoryError
                           | cache.set adapter failure      | CacheAdapterError
writeProfile(key, update)  | repository.write typed failure | RepositoryError
                           | cache.delete adapter failure   | CacheAdapterError ← GAP

EXCEPTION CLASS              | RESCUED? | RESCUE ACTION                | USER SEES
-----------------------------|----------|------------------------------|------------------
CacheAdapterError (get)      | Y        | Bypass; treat as miss        | Transparent
RepositoryError (read)       | Y        | Propagate typed error        | Typed API error
CacheAdapterError (set)      | Y        | Bypass; return value         | Transparent
RepositoryError (write)      | Y        | Propagate typed error        | Typed API error
CacheAdapterError (delete)   | N ← GAP  | None — exception propagates  | Spurious write
                             |          |                              | failure (BAD)
```

**CRITICAL FINDING 2: cache.delete failure exposes a successful write as failed**

In the proposed writeProfile:
```javascript
const saved = await repository.write(key, update);
cache.delete(key);   // if this throws, caller sees write failure
return saved;
```

If the LRU adapter's delete operation throws, the exception bubbles out of
`writeProfile`. The write succeeded (data is in the DB) but the caller receives
an error. This breaks the typed API contract and may trigger spurious retries,
causing double-writes.

**Recommended fix (auto-decided):** Wrap cache.delete in a try/catch. Cache
failure in the delete path is non-fatal — the adapter's bypass mechanism will
handle ongoing degradation, and the next read will miss (fetching the fresh DB
value after TTL or on the next miss):

```javascript
async function writeProfile(key, update) {
  const saved = await repository.write(key, update);
  try {
    cache.delete(key);
  } catch {
    // Adapter handles bypass; write already committed to DB
  }
  return saved;
}
```

*Section 2 findings: 1 CRITICAL GAP (cache.delete failure during write).*

---

### Section 3: Security & Threat Model

**Attack surface expansion:** None. Process-local in-memory cache has no network
surface. No new endpoints, no new parameters, no new file paths.

**Authorization:** AuthZ runs before repository access. Cached values are DTOs
scoped by the key encoding. Cached results cannot bypass authorization.

**Cross-tenant isolation:** Cache keys encode tenant ID + profile ID. A tenant A
key cannot collide with tenant B unless the key construction is ambiguous.

**FINDING 3 (documentation): Key format not specified**

The plan asserts keys are "without ambiguity" but does not document the format.
For example, if the key is `${tenantId}:${profileId}` and tenant IDs can contain
`:`, collisions are possible and cross-tenant data could leak.

Threat: Low likelihood (internal service, key construction is controlled).
Impact: High (cross-tenant data leakage if collision occurs).

**Recommended fix (auto-decided):** Document the exact key format in the plan and
in a code comment. The format must be collision-resistant (e.g., delimiter
escaping, URL encoding, or a structured separator that tenant/profile IDs cannot
contain).

**PII in cache:** Profile summary DTOs are already in application memory. The
cache holds the same data already in the running process — no additional PII
exposure beyond what the repository already holds. Correct to avoid logging raw
IDs.

**Secrets:** No new secrets. Existing env-var patterns unchanged.

**Dependency risk:** No new npm packages. Existing LRU adapter reused.

**Injection vectors:** Cache keys are constructed internally from authenticated,
validated IDs. No user-supplied raw strings reach cache key construction.

*Section 3 findings: 1 WARNING (key format documentation).*

---

### Section 4: Data Flow & Interaction Edge Cases

**This is a pure backend change. No user-visible interactions exist. The UX edge
case table is N/A.**

**Data flow diagram — full shadow paths:**

```
  readProfile(key):

  INPUT ──▶ [key null?]     ──▶ validated upstream (plan states this)
             │
             ▼
           cache.get(key)
             │
             ├─ HIT        ──▶ return value                  [OK]
             │
             ├─ FAIL       ──▶ bypass mode; proceed as miss  [OK]
             │
             └─ MISS (undefined)
                  │
                  ▼
             [await repo.read(key)] ← yield point; writes can run here
                  │
                  ├─ ERROR   ──▶ propagate; sf releases      [OK]
                  │
                  └─ OK: value
                       │
                       ▼
                  [cache.get(key) === undefined?]   ← ADDED GUARD (Finding 1)
                       │
                       ├─ YES (key was deleted by write) ──▶ skip set [OK]
                       │
                       └─ NO  ──▶ cache.set(key, value)
                                        │
                                        ├─ FAIL ──▶ bypass; return value [OK]
                                        └─ OK   ──▶ return value         [OK]
```

**Async ordering — read-write interleaving (the critical case):**

With the guard added (Finding 1), the race is closed:

```
T1: readProfile miss → sf: await repo.read
T2: writeProfile → repo.write completes → cache.delete(k)  [cache: undefined]
T3: readProfile resumes, value = v0
T4: guard: cache.get(k) === undefined → true → skip cache.set  ✓
T5: readProfile returns v0 (allowed: read was in-flight during write)
T6: new readProfile → cache miss → repo.read → gets committed version ✓
```

Invariant satisfied: reads begun after T2 (write completes) fetch from DB and
get the committed version.

**Concurrent miss coalescing + write interleaving:**

```
T1: read1(k) → miss → sf: await repo.read
T2: read2(k) → sf coalesces with read1
T3: write(k) → repo.write completes → cache.delete(k)
T4: read1 resumes → guard: cache.get(k) === undefined → skip cache.set
T5: sf releases → read1 returns v0; read2 returns v0 (both in-flight during write)
T6: read3(k) → cache miss → repo.read → committed version ✓
```

The guard correctly handles the coalesced case too, because the sf coalescence
means only one cache.set attempt occurs (for the primary flight) — and the guard
blocks it if the key was deleted.

**Absent record path:**

```
T1: readProfile(k) → miss → repo.read(k) → returns absent-sentinel
T2: guard: cache.get(k) === undefined → true (sentinel not yet set) → cache.set(k, sentinel) with 10s TTL
T3: subsequent reads within 10s → HIT → return sentinel quickly
```

Ensure the absent-sentinel is a distinct non-undefined value (confirmed by plan).

*Section 4 findings: 0 new gaps (Findings 1 and 2 from Sections 1 and 2 cover
the identified issues here).*

---

### Section 5: Code Quality Review

**Organization:** Single wrapper module; clean separation from repository.
Appropriate pattern, consistent with existing adapter layer.

**DRY:** No duplication. Cache logic exists only in the wrapper. Repository
unchanged.

**Naming:** `readProfile`, `writeProfile` — imperative, domain-aligned. Correct.

**Error handling patterns:** Two gaps identified (Findings 1 and 2 above). The
wrapper code as proposed does not handle either.

**Missing edge cases in the proposed implementation:**

1. Post-write stale re-population (Finding 1 — CRITICAL).
2. cache.delete failure during successful write (Finding 2 — CRITICAL).
3. `undefined` value guard: the plan relies on `cache.get(key) === undefined`
   as the miss sentinel. If the repository ever returns `undefined` as a
   legitimate value (not the absent-sentinel), the hit/miss detection breaks.
   The plan says values are "immutable profile-summary DTOs" and absent records
   use "a distinct sentinel" — this constraint must be enforced by the repository
   layer and documented as an invariant the wrapper depends on.

**Over-engineering check:** The wrapper is appropriately thin. No unnecessary
abstractions.

**Under-engineering check:** The two critical gaps (Findings 1 and 2) represent
under-engineering — not handling known edge cases of async + cache interactions.

**Cyclomatic complexity:** readProfile: 1 branch. writeProfile: 0 branches.
Complexity is minimal and appropriate.

*Section 5 findings: 0 new (existing findings from Sections 1-2 cover the gaps).*

---

### Section 6: Test Review

**New codepaths introduced:**

```
NEW DATA FLOWS:
  1. Cache hit — readProfile returns cached value without DB call
  2. Cache miss — readProfile reads from DB and populates cache
  3. Absent record cached — sentinel returned and cached with 10s TTL
  4. Absent record expired — TTL expiry triggers re-fetch
  5. Cache failure read — adapter fails, bypass, DB read proceeds
  6. Cache failure write — adapter delete fails, write still succeeds (after fix)
  7. Successful-write invalidation — writeProfile writes then deletes cache key
  8. Failed-write preservation — write fails, cache NOT modified
  9. Concurrent-miss coalescing — single-flight prevents duplicate DB reads
  10. Eviction by count — cache exceeds 1000 entries → LRU eviction
  11. Eviction by bytes — cache exceeds 16 MiB → LRU eviction
  12. TTL expiry (hot key) — cached value expires after 30s
  13. TTL expiry (sentinel) — absent sentinel expires after 10s
  14. Feature flag disabled — all reads/writes bypass cache
  15. Post-write stale guard — concurrent write during in-flight read (FINDING 1)

NEW ERROR/RESCUE PATHS:
  - cache.get failure → bypass mode (test: adapter mock throws → bypass activated)
  - cache.set failure → bypass; value still returned
  - cache.delete failure → caught; write return value unaffected (after fix)
  - repository.read failure → propagate; single-flight releases cleanly
  - repository.write failure → propagate; cache unmodified
```

**Per-codepath test assessment:**

| Codepath | Exists in plan? | Missing test |
|----------|-----------------|--------------|
| Cache hit | Y | — |
| Cache miss | Y | — |
| Absent record | Y | — |
| Adapter failure fallback | Y | — |
| Write invalidation | Y | — |
| Failed-write preservation | Y | — |
| Concurrent miss coalescing | Y | — |
| Eviction (count + bytes) | Y | — |
| TTL expiry | Y | — |
| Feature flag disabled | **N** | Test: flag off → cache.get never called |
| **Post-write stale guard (Finding 1)** | **N — CRITICAL** | See below |
| **cache.delete failure (Finding 2)** | **? (unclear)** | Test: delete throws → writeProfile returns saved |

**Critical missing test — concurrent-read-during-write:**

```javascript
it('does not re-populate cache with stale data when write invalidates during read', async () => {
  // Pre-populate cache with v0
  cache.set('k', v0);
  // Start a read that will pause at the await
  const readPromise = readProfile('k');
  // While read is in-flight, complete a write
  await writeProfile('k', newData);
  // The write should have cleared the cache
  expect(cache.get('k')).toBe(undefined);
  // Let the read complete
  const readResult = await readPromise;
  // The read returns v0 (acceptable — it was in-flight during the write)
  expect(readResult).toBe(v0);
  // The cache must NOT be re-populated with v0
  expect(cache.get('k')).toBe(undefined);
  // A fresh read must get the committed version
  const freshResult = await readProfile('k');
  expect(freshResult).toBe(newData);
});
```

**Test ambition check:**
- "Ship at 2am?" — The concurrent-read-during-write test above. Not in the plan.
- "Hostile QA test?" — Same test. Also: cache.delete throws during successful write → caller should NOT see a write failure.
- "Chaos test?" — Interleaved reads and writes at high frequency verifying no stale cache entry persists for more than TTL after a write.

**Test pyramid:** Unit tests for hit/miss/eviction/TTL + integration tests for
full flow. Appropriate for a single-process in-memory cache.

**Flakiness risk:** TTL tests depending on real wall-clock time will be flaky.
Use clock mocking (e.g., fake timers, dependency-injected clock) for TTL tests.
The plan does not mention this; it should be specified.

*Section 6 findings: 3 test gaps (feature flag, post-write guard, cache.delete
failure path). The post-write guard test is CRITICAL.*

---

### Section 7: Performance Review

**Memory usage:**
- LRU: bounded at 1000 entries and 16 MiB. 900 hot keys fit comfortably.
- No memory leak risk — LRU eviction prevents unbounded growth.
- Worst-case steady-state: 16 MiB additional heap per process.

**N+1 queries:** Cache reduces DB reads. No new query patterns introduced.

**Database indexes:** No new queries. Existing index coverage unchanged.

**Connection pool:** No new connections. Cache is in-memory. DB connections
are only opened on cache misses.

**Slow paths (estimated):**

| Path | Estimated p99 |
|------|---------------|
| Cache hit | < 1 ms (in-memory LRU lookup) |
| Cache miss with DB read | existing p99 (cache adds ~1 ms overhead) |
| Bypass mode | existing p99 (no overhead) |

**FINDING 4 (operational): Rollout advancement criterion is qualitative**

The plan says "enable for 10% of keys, then 50%, then all keys after one healthy
hour at each stage." "Healthy" is undefined. The acceptance targets (DB CPU <50%,
p95 <60 ms, ≥60% cache hits) are stated but not tied to the rollout gate criteria.

**Recommended (auto-decided):** Define explicit gate criteria in the plan. Example:
"Advance when cache hit rate ≥50% AND fallback error rate <0.1% AND p95 <80 ms
AND no error-rate regression, sustained over the preceding hour."

*Section 7 findings: 1 WARNING (undefined rollout gate criterion).*

---

### Section 8: Observability & Debuggability Review

**The plan specifies monitoring:** hit/miss, eviction, cache bytes, fallback
errors, DB CPU, read p95 — all without raw IDs. This is correct.

**Gaps:**

**FINDING 5 (observability): Metric names, alert thresholds, and "healthy" gate
criteria not defined**

The plan lists what to monitor but not:
1. Specific metric names (how to query them in the observability stack)
2. Alert thresholds (e.g., "alert when fallback error rate > 1%")
3. Dashboard panels (what does day-1 monitoring look like?)
4. Quantitative gate criteria for rollout advancement (links to Finding 4)
5. Runbook: "Cache fallback rate spiked — what do I do?"

Without metric names, the monitors cannot be set up before rollout, which
violates "observability is scope, not afterthought."

**Recommended (auto-decided):** Add an observability spec to the plan listing:
- Metric names for hit count, miss count, eviction count, byte usage, fallback
  error count, DB CPU, read p95
- Alert thresholds for fallback error rate and p95 regression
- Runbook stub: fallback spike → check adapter health → disable flag if
  error rate sustained > threshold → investigate adapter failure mode

**Debuggability:** "If a bug is reported 3 weeks post-ship..." — The plan specifies
logging hit/miss and errors without raw IDs. Structured log lines at entry (key
hash, not raw key), exit (HIT/MISS/BYPASS), and on cache failure should give
enough context to reconstruct behavior. The plan does not specify log levels or
format; this should be added.

*Section 8 findings: 1 WARNING (observability spec incomplete).*

---

### Section 9: Deployment & Rollout Review

**Migration safety:** No DB migrations. Pure in-process change. Zero downtime.

**Feature flag:** Existing runtime feature flag is the deployment gating
mechanism. Correct.

**Rollout order:** Flag disabled by default. Enable at 10% → 50% → 100%.

**Rollback:**
1. Disable feature flag. (Seconds.)
2. Reads and writes bypass cache immediately.
3. Re-enable when ready — starts with empty cache.
4. No data migration, no schema rollback.

**Deploy-time risk:** Old code and new code run simultaneously only during the
deploy itself. Since the cache is disabled by default, there is no cache-state
risk during the deploy window.

**FINDING 6 (deployment): Multi-process detection relies only on startup check**

The plan says "startup rejects that configuration while caching is enabled." This
covers process boot. It does not cover:
- A process crash and respawn in an environment that has since added a second
  process (e.g., autoscaling event between restarts)
- Docker/k8s restart policies that could instantiate multiple replicas

The check runs once at startup; it does not re-validate at runtime.

**Recommended (auto-decided):** Document this as a known constraint: the startup
check is a single-point guard. If the deployment environment is changed (e.g.,
replica count increased), the operator must disable caching before scaling to
multiple processes. Add this to the runbook stub.

**Post-deploy verification:**

The plan mentions monitoring targets. The first-5-minutes check should include:
- Cache hit rate > 0% (cache is being used)
- Fallback error rate = 0% (adapter is healthy)
- p95 not elevated (no regression)
- DB CPU not elevated vs. baseline

*Section 9 findings: 1 WARNING (multi-process check robustness).*

---

### Section 10: Long-Term Trajectory Review

**Technical debt introduced:** Minimal. The wrapper is thin, testable, and
flag-controlled. No locking-in debt.

**Path dependency:** The plan explicitly preserves "a future replacement path
without introducing a general cache framework now." Distributed cache (Redis)
or a different LRU implementation can replace this without changing the
repository interface.

**Knowledge concentration:** The concurrent-read-during-write ordering rule is
subtle. It must be documented in a code comment in the wrapper, not just in this
plan. A new engineer who reads only the code needs to understand why the
post-write guard exists.

**Reversibility:** 5/5 — Feature flag makes this completely reversible. Disabling
returns the system to identical behavior as pre-cache with an empty-cache
clean state.

**Ecosystem fit:** In-process LRU in a Node.js single-threaded event loop is
idiomatic. The pattern is standard.

**1-year question:** The ordering invariant and the post-write guard are the only
non-obvious elements. With a code comment explaining the invariant and the guard's
purpose, a new engineer would understand the design. Without those comments, the
guard looks like dead code and may be "cleaned up" incorrectly.

**Dream state delta:** After this plan ships successfully:
- DB CPU: ~45% (estimated from ≥60% cache hit rate on 900 hot keys)
- p95: ~50 ms (estimated)
- Headroom for user growth before DB becomes the bottleneck

*Section 10 findings: 0 new. Documentation of the ordering invariant in code is
implied by Finding 1's fix.*

---

### Section 11: Design & UX Review

**SKIPPED — no UI scope detected.**

The plan states: "This is an internal backend change with no UI, API, schema,
pricing, or developer onboarding change." Section 11 does not apply.

---

## Required Outputs

### NOT in scope

| Item | Rationale |
|------|-----------|
| Distributed cache (Redis) | Out of scope; single-process constraint |
| Cross-process coherence | Not needed in single-process model |
| Cache prewarming | Complexity not justified by 900-key set |
| Changing consistency semantics | Out of scope; read-during-write window accepted |
| New product surfaces | Backend-only change |

### What already exists

| Component | Status |
|-----------|--------|
| LRU adapter (1000 entries, 16 MiB, 30s TTL) | Exists; reused unchanged |
| Single-flight per-key coalescing wrapper | Exists; reused unchanged |
| Runtime feature flag for rollout | Exists; reused unchanged |
| Repository contract tests (tenant isolation, key validation, absence, DB failures, auth) | Exists; unchanged |
| Typed API error mapping | Exists; preserved |

### Dream state delta

```
THIS PLAN LEAVES US AT:
  DB CPU: ~45% (from ~70%) — target met if ≥60% hit rate
  p95:    ~50 ms (from 120 ms) — target met
  Cache:  Process-local; no cross-process coherence

REMAINING GAP TO 12-MONTH IDEAL:
  Distributed caching (if process count scales)
  Prewarming strategies (if cold-start spikes become a concern)
  Full observability stack integration (metric names, dashboards, runbooks)
```

### Error & Rescue Registry

```
METHOD/CODEPATH            | WHAT CAN GO WRONG              | EXCEPTION CLASS
---------------------------|--------------------------------|-------------------
readProfile(key)           | cache.get adapter failure      | CacheAdapterError
                           | repository.read typed failure  | RepositoryError
                           | cache.set adapter failure      | CacheAdapterError
writeProfile(key, update)  | repository.write typed failure | RepositoryError
                           | cache.delete adapter failure   | CacheAdapterError ← GAP

EXCEPTION CLASS              | RESCUED? | RESCUE ACTION                   | USER SEES
-----------------------------|----------|---------------------------------|------------------
CacheAdapterError (get)      | Y        | Bypass; treat as miss           | Transparent
RepositoryError (read)       | Y        | Propagate typed error           | Typed API error
CacheAdapterError (set)      | Y        | Bypass; return value            | Transparent
RepositoryError (write)      | Y        | Propagate typed error           | Typed API error
CacheAdapterError (delete)   | N ← GAP  | None — propagates as write fail | Spurious error
```

### Failure Modes Registry

```
CODEPATH              | FAILURE MODE                     | RESCUED? | TEST? | USER SEES?           | LOGGED?
----------------------|----------------------------------|----------|-------|----------------------|--------
readProfile           | cache.get fails                  | Y        | Y     | transparent          | Y
readProfile           | repo.read fails                  | Y        | Y     | typed API error      | Y
readProfile           | cache.set fails                  | Y        | Y     | transparent          | Y
readProfile           | stale re-pop after write         | N ← GAP  | N     | stale data (silent)  | N  ← CRITICAL
writeProfile          | repo.write fails                 | Y        | Y     | typed API error      | Y
writeProfile          | cache.delete fails               | N ← GAP  | ?     | false write failure  | N  ← CRITICAL
writeProfile          | write succeeds, delete succeeds  | Y        | Y     | transparent          | Y
sf coalescing         | read fails while coalesced       | Y        | Y     | propagated error     | Y
adapter bypass        | bypass active, reads continue    | Y        | Y     | transparent          | Y
```

### Diagrams

**System architecture:** See Section 1.

**Data flow (including shadow paths):** See Section 1 and Section 4.

**State machine:** See Section 1.

**Error flow:**

```
  Error in readProfile:
  cache.get throws ──▶ bypass mode ──▶ treat as miss ──▶ repo.read
  repo.read throws ──▶ propagate ──▶ sf releases ──▶ caller gets RepositoryError
  cache.set throws ──▶ bypass mode ──▶ value still returned to caller

  Error in writeProfile (proposed fix applied):
  repo.write throws ──▶ propagate ──▶ cache not modified ──▶ caller gets error
  cache.delete throws ──▶ caught ──▶ bypass mode activates ──▶ caller gets saved
```

**Deployment sequence:**

```
  1. Deploy new code (cache disabled by default)
  2. Verify: no errors, p95 stable, DB CPU stable
  3. Enable flag at 10%
  4. Wait 1 healthy hour (gate criteria: see Finding 4)
  5. Advance to 50%
  6. Wait 1 healthy hour
  7. Advance to 100%
  8. Record results vs acceptance targets
```

**Rollback flowchart:**

```
  Error/regression detected
        │
        ▼
  Disable feature flag (seconds)
        │
        ▼
  Cache bypassed; empty on re-enable
        │
        ▼
  Investigate: adapter failure? Race? Load?
        │
        ├─ Adapter issue ──▶ fix adapter ──▶ re-enable
        └─ Race issue ──▶ apply guards (Finding 1/2) ──▶ re-enable
```

### Stale Diagram Audit

No existing ASCII diagrams found in plan or noted codebase files. N/A.

---

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code; checkbox as you ship.

- [ ] **T1 (P1, human: ~1h / CC: ~5min)** — CacheWrapper — Add post-write stale re-population guard
  - Surfaced by: Section 1 (Finding 1), Section 4 — concurrent-read-during-write race violates ordering invariant
  - Files: `cacheWrapper.js` (or equivalent wrapper module)
  - Code: add `if (cache.get(key) === undefined)` guard before `cache.set(key, value)` in readProfile
  - Verify: new concurrent-read-during-write test (see T3); existing tests pass

- [ ] **T2 (P1, human: ~30min / CC: ~5min)** — CacheWrapper — Handle cache.delete failure in writeProfile
  - Surfaced by: Section 2 (Finding 2) — delete failure propagates as spurious write error
  - Files: `cacheWrapper.js`
  - Code: wrap `cache.delete(key)` in try/catch in writeProfile; return saved regardless
  - Verify: test — delete throws → writeProfile resolves with saved value

- [ ] **T3 (P1, human: ~1h / CC: ~10min)** — Tests — Add concurrent-read-during-write test
  - Surfaced by: Section 6 — no test covers the post-write stale re-population scenario
  - Files: `cacheWrapper.test.js`
  - Test: pause read at await, complete write, resume read, assert cache not re-populated with stale value
  - Verify: test fails without T1 fix, passes with it

- [ ] **T4 (P2, human: ~30min / CC: ~5min)** — Docs/Security — Document exact cache key format
  - Surfaced by: Section 3 (Finding 3) — "without ambiguity" asserted but format not specified
  - Files: plan doc + code comment in key construction logic
  - Specify: exact format, collision-resistance guarantee, characters that tenant/profile IDs may not contain

- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — Rollout — Define quantitative gate criteria for rollout advancement
  - Surfaced by: Section 7 (Finding 4) and Section 8 (Finding 5)
  - Files: plan doc + runbook
  - Add: explicit numeric thresholds (hit rate, fallback error rate, p95, DB CPU) that define "healthy hour"

- [ ] **T6 (P2, human: ~20min / CC: ~5min)** — Observability — Add metric names, alert thresholds, and runbook stub
  - Surfaced by: Section 8 (Finding 5) — metric names and alert thresholds not defined
  - Files: plan doc + observability config (metrics definitions, alert rules)
  - Include: metric names for hit/miss/eviction/bytes/fallback/p95/DB CPU; alert on fallback spike and p95 regression

- [ ] **T7 (P3, human: ~20min / CC: ~5min)** — Deployment — Document multi-process constraint in runbook
  - Surfaced by: Section 9 (Finding 6) — startup check does not cover post-startup process scaling
  - Files: runbook
  - Add: "disable caching before scaling to multiple replicas; re-enable only after confirming single-process config"

- [ ] **T8 (P2, human: ~30min / CC: ~5min)** — Tests — Add clock-mocked TTL tests
  - Surfaced by: Section 6 — TTL tests depending on real wall-clock time are flaky
  - Files: `cacheWrapper.test.js`
  - Use fake timers / dependency-injected clock for 30s and 10s TTL expiry tests

- [ ] **T9 (P2, human: ~20min / CC: ~5min)** — Tests — Add feature-flag-disabled test
  - Surfaced by: Section 6 — no test verifies that flag-off bypasses cache entirely
  - Files: `cacheWrapper.test.js`
  - Test: flag disabled → cache.get never called → reads go directly to repository

---

```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
+====================================================================+
| Mode selected        | HOLD SCOPE                                  |
| System Audit         | Skipped (per run instructions)              |
| Step 0               | HOLD SCOPE confirmed; Approach B selected;  |
|                      | ordering invariant identified as critical    |
| Section 1  (Arch)    | 1 CRITICAL GAP (post-write stale re-pop)    |
| Section 2  (Errors)  | 4 error paths mapped, 1 CRITICAL GAP        |
|                      | (cache.delete failure)                      |
| Section 3  (Security)| 1 WARNING (key format not documented)        |
| Section 4  (Data/UX) | 0 new gaps (Findings 1-2 cover)             |
| Section 5  (Quality) | 0 new (covered by Sections 1-2)             |
| Section 6  (Tests)   | Diagram produced, 3 gaps                    |
| Section 7  (Perf)    | 1 WARNING (rollout gate criterion undefined) |
| Section 8  (Observ)  | 1 WARNING (metric names/alerts/runbook)      |
| Section 9  (Deploy)  | 1 WARNING (multi-process check robustness)   |
| Section 10 (Future)  | Reversibility: 5/5, debt items: 0           |
| Section 11 (Design)  | SKIPPED (no UI scope)                       |
+--------------------------------------------------------------------+
| NOT in scope         | written (5 items)                           |
| What already exists  | written                                     |
| Dream state delta    | written                                     |
| Error/rescue registry| 5 methods, 1 CRITICAL GAP                   |
| Failure modes        | 9 total, 2 CRITICAL GAPS                    |
| TODOS.md updates     | 0 items proposed (all addressed in tasks)   |
| Scope proposals      | 0 (HOLD SCOPE)                              |
| CEO plan             | skipped (HOLD SCOPE)                        |
| Outside voice        | disabled (codex_reviews: disabled)          |
| Lake Score           | N/A (HOLD SCOPE, no coverage options)       |
| Diagrams produced    | 6 (architecture, data flow, state machine,  |
|                      | error flow, deployment, rollback)           |
| Stale diagrams found | 0                                           |
| Unresolved decisions | 0                                           |
+====================================================================+
```

### Unresolved Decisions

None. All findings were auto-decided in HOLD SCOPE mode as per run instructions.
All decisions favor the more complete, conservative fix option.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open | HOLD SCOPE, 2 critical gaps, 5 warnings |
| Outside Review | disabled | Independent 2nd opinion | 0 | disabled | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** codex_reviews: disabled. Outside review step skipped per configuration. No outside review was run or attempted. Re-enable: `gstack-config set codex_reviews enabled`.

**VERDICT:** CEO Review run (HOLD SCOPE). 2 critical gaps found (post-write stale re-population; cache.delete failure propagation). eng review required before shipping.

NO UNRESOLVED DECISIONS
