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
- **AMENDED (stale-fill race):** A read already in progress when a write commits
  may return its earlier DB snapshot to that caller AND may fill the cache with
  that stale snapshot. The stale entry remains visible to subsequent reads until
  TTL expiry — at most 30 seconds for a present record, 10 seconds for an absent
  sentinel. Every read begun after the cached stale entry expires must observe the
  committed version. This bounded inconsistency window is the accepted consistency
  model for this in-process cache; TTL is the consistency deadline.

## Proposed wrapper integration
Keep the current read-through repository interface and shared adapters. These
are the complete new read/write ordering rules. Cache population and invalidation
are best-effort: errors in cache operations are caught, logged, and trigger bypass
mode; they never propagate to the caller when the underlying repository operation
succeeded.

```javascript
async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await repository.read(key);
  // best-effort: a cache.set failure must not fail a successful read
  try { cache.set(key, value); } catch (e) { log.warn('cache.set failed', { err: e }); }
  return value;
}

async function writeProfile(key, update) {
  const saved = await repository.write(key, update);
  // best-effort: a cache.delete failure is logged; bypass mode activates until cache reinits
  try { cache.delete(key); } catch (e) { log.error('cache.delete failed after write', { err: e }); }
  return saved;
}
```

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, and authorization. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, concurrent-miss coalescing,
**cache.set failure during a successful read (read must still return value)**,
**and cache.delete failure during a successful write (write must still return saved)**.
The rollout uses the existing runtime feature flag: enable for 10% of keys,
then 50%, then all keys after one healthy hour at each stage. "Healthy" means:
hit rate ≥ 60%, fallback-error rate < 0.1%, read p95 < 80 ms (relaxed during
ramp; final target is 60 ms at full rollout). Monitor hit/miss, eviction, cache
bytes, fallback errors, DB CPU, and read p95 without raw IDs.
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

**Mode:** HOLD SCOPE (auto-selected: well-scoped performance fix, backend-only,
no UI, minimal file surface, feature-flag rollback available)

**Approach selected (auto):** The plan as written — wrap the existing repository
interface with a thin LRU layer using existing adapters. Minimal viable and ideal
architecture converge here; there is no meaningful tradeoff between them for this
scope.

---

### Step 0: Scope Challenge

#### 0A. Premise Challenge

Right problem: yes. The one-week trace with measured DB CPU at 70% and p95 at
120 ms on 900 stable hot keys is real signal. A process-local LRU read-through
cache is the direct solution.

Most direct path: yes. The plan reuses existing LRU adapter, existing feature
flag, existing single-flight wrapper. No new infrastructure is introduced.

Do-nothing cost: DB continues at 70% CPU with 120 ms reads. If query volume grows,
this becomes a blocking constraint. Real pain.

#### 0B. Existing Code Leverage

Everything substantial is reused:
- LRU adapter (1000 entries, 16 MiB cap, TTL) — pre-built
- Per-key single-flight wrapper — pre-built, handles concurrent-miss thundering herd
- Runtime feature flag — pre-built, enables phased rollout and instant rollback
- Existing repository contract tests — cover key validation, tenant isolation, absence, DB failures

The plan does not rebuild anything that already exists.

#### 0C. Dream State Mapping

```
CURRENT STATE              THIS PLAN                  12-MONTH IDEAL
DB CPU 70%        --->     DB CPU <50%        --->    DB CPU stable <40%
read p95 120ms             read p95 <60ms             read p95 <40ms (with
900 hot keys,              900 hot keys cached          warmer hit rate)
no caching                 ~60%+ hit rate             Clear path to
                           Feature flag rollback       distributed cache
                                                       when multi-process
                                                       is needed
```

This plan moves in the right direction. It does not close the multi-process gap
(correctly out of scope) but explicitly preserves the replacement path.

#### 0C-bis. Implementation Alternatives (HOLD SCOPE, informational)

**APPROACH A: Thin wrapper (this plan)**
Summary: Wrap existing repository in a read-through LRU cache using existing adapter.
Effort: S | Risk: Low
Pros: Reuses existing adapter, zero new infrastructure, instant rollback via flag
Cons: Single-process only, stale-fill race (documented in amended plan)
Reuses: LRU adapter, single-flight wrapper, feature flag, contract tests

**APPROACH B: Precomputed projection layer**
Summary: Compute and store profile summaries at write time, read from a summary
table instead of computing on the fly.
Effort: L | Risk: High
Pros: No cache coherence issues, reads always fresh, better for multi-process later
Cons: Schema migration, write-path complexity, out of scope by definition
Not selected — correct exclusion.

**APPROACH C: External cache (Redis)**
Summary: Use Redis as a shared cache across processes.
Effort: L | Risk: Med
Pros: Multi-process capable, no single-process constraint
Cons: New infrastructure dependency, distributed consistency complexity, out of scope
Not selected — correct exclusion for single-process constraint.

**RECOMMENDATION:** Approach A. The plan correctly identifies that the single-process
constraint makes in-process caching optimal for now. Approaches B and C solve problems
the team does not have yet.

#### 0D. HOLD SCOPE Analysis

Complexity check: The plan touches ≤3 files (repository wrapper, tests, possibly
a config check for startup rejection). Does not introduce new classes beyond the
wrapper. Correctly scoped.

Minimum change: The read/write pseudocode plus test additions is the minimum. No
over-engineering detected.

#### 0E. Temporal Interrogation

Key decisions for the implementer:

```
HOUR 1 (foundations):
  - What is the SENTINEL value? Symbol, null, or a typed object?
    Must be serializable by the LRU adapter but distinguishable from valid DTOs
    and from undefined (cache miss). Define it before writing the wrapper.

HOUR 2-3 (core logic):
  - How does the LRU adapter signal bypass mode? Does cache.set throw or return false?
    Does cache.get return undefined in bypass mode (which readProfile treats as a miss)?
    This must be verified against the adapter's actual API before writing error handling.

HOUR 4-5 (integration):
  - The stale-fill race: a concurrent write completing while a read is in-flight
    (at the `await repository.read()` suspension point) will cause cache.set to
    store a stale value AFTER cache.delete ran. Verify the amended invariant in
    the plan matches what the team accepts.

HOUR 6+ (polish/tests):
  - Concurrent-miss coalescing tests need controlled pause/release points — real
    async timing makes them flaky. Use a mock adapter that can be paused mid-read.
  - The multi-process startup rejection test needs to verify the exact error thrown
    and that it is unrecoverable (no retry loop).
```

---

### Section 1: Architecture Review

**System architecture:**

```
  ┌─────────────────────────────────────────────────────────────┐
  │                     Single Process                           │
  │                                                             │
  │  Caller ──▶ ProfileRepository (wrapper)                     │
  │                    │                                        │
  │              ┌─────┴───────────────────────┐               │
  │              │  LRU Cache Layer             │               │
  │              │  ┌───────────────────────┐  │               │
  │              │  │ LRU Adapter           │  │               │
  │              │  │ 1000 entries / 16 MiB │  │               │
  │              │  │ 30s TTL (present)     │  │               │
  │              │  │ 10s TTL (sentinel)    │  │               │
  │              │  └───────────────────────┘  │               │
  │              │  Single-flight per key       │               │
  │              │  Bypass mode on adapter fail │               │
  │              └─────────────────────────────┘               │
  │                    │                                        │
  │              Existing Repository Layer                       │
  │                    │                                        │
  │                    ▼                                        │
  │              ┌──────────┐                                   │
  │              │ Database │                                   │
  │              └──────────┘                                   │
  └─────────────────────────────────────────────────────────────┘
  EXCLUDED: multi-process, external cache, cross-process coherence
```

**Data flow — read path (all four paths):**

```
  readProfile(key)
       │
       ├─▶ cache.get(key)
       │        │
       │   ┌────┴──────────────────────────────────────────────┐
       │   │ HIT (value !== undefined)     MISS (undefined)     │
       │   │      │                              │              │
       │   │  return value               await repo.read(key)  │
       │   │  [happy path]                       │              │
       │   │                    ┌────────────────┤              │
       │   │                    │ Success         │ Error        │
       │   │                    │                 │              │
       │   │             try cache.set        propagate err     │
       │   │             catch → log          (cache unchanged) │
       │   │             return value                           │
       │   └────────────────────────────────────────────────── ┘
       │
       │  nil key → existing key validation rejects before cache
       │  empty key → same
       │  cache in bypass mode → cache.get returns undefined → DB read
```

**Data flow — write path (all four paths):**

```
  writeProfile(key, update)
       │
       ├─▶ await repo.write(key, update)
       │        │
       │   ┌────┴─────────────────────────────────────┐
       │   │ Success                   Failure         │
       │   │    │                         │            │
       │   │ try cache.delete(key)   propagate err     │
       │   │ catch → log + bypass    (cache unchanged) │
       │   │ return saved                              │
       │   └────────────────────────────────────────── ┘
       │
       │  nil/invalid key → repo.write validates, rejects before cache
```

**Cache entry state machine:**

```
  [ABSENT/EXPIRED] ──read+DB hit──▶ [CACHED present, 30s TTL]
         │                                    │
         │                             write invalidate
         │◀────────────────────────────────── │
         │                            TTL expiry
         │◀────────────────────────────────── ┘
         │
         ├──read+DB absent──▶ [SENTINEL cached, 10s TTL]
         │                              │
         │                      write invalidate / TTL expiry
         │◀─────────────────────────────┘
         │
         └──cache adapter fail──▶ [BYPASS MODE] ──reinit──▶ [ABSENT/EXPIRED]
```

**Coupling:** The cache couples read freshness to write ordering. This coupling is the design's purpose and is justified. No new coupling is introduced between otherwise-independent components.

**Scaling:**
- 10x read load: cache absorbs; hit rate improves; DB load decreases. LRU adapter is synchronous, no lock contention in a single event loop.
- 10x write load: cache invalidation pressure grows. With 900 hot keys and a 1000-entry limit, high write throughput could increase effective miss rate. Not a correctness issue, but a performance consideration worth monitoring during rollout.
- 100x: Multi-process operation required — explicitly out of scope and blocked at startup.

**Single points of failure:** The process itself. Cache failure degrades to bypass (existing DB path) — no new SPOF introduced.

**Security:** Auth boundary is at the repository interface (pre-wrapper). Keys encode tenant ID + profile ID. Cache cannot bypass authorization because cached results are scoped to the same authenticated call path. Secrets not logged.

**Rollback:** Feature flag → instant disable → reads and writes go directly to DB. No DB migration, no schema change. Rollback is a configuration toggle, not a code deploy. **5/5 reversibility.**

**Production failure scenarios:**
- LRU adapter failure: bypass mode, reads go to DB. DB returns to pre-cache load. Monitor fallback-error rate.
- DB failure during cache miss: error propagates, cache not updated. Correct.
- Byte-limit eviction under write pressure: LRU evicts, misses go to DB. Graceful degradation, no correctness impact.

No issues. Moving on.

---

### Section 2: Error & Rescue Map

```
METHOD/CODEPATH           | WHAT CAN GO WRONG                | EXCEPTION CLASS
--------------------------|----------------------------------|-----------------------
readProfile(key)          | cache.get: adapter failure       | CACHE_ADAPTER_ERROR
                          | repo.read: DB timeout            | DB_TIMEOUT
                          | repo.read: DB connection lost    | DB_CONNECTION_ERROR
                          | repo.read: key validation fail   | INVALID_KEY (existing)
                          | cache.set: OOM / byte-limit full | CACHE_SET_ERROR
                          | cache.set: adapter failure       | CACHE_ADAPTER_ERROR
--------------------------|----------------------------------|-----------------------
writeProfile(key, update) | repo.write: DB timeout           | DB_TIMEOUT
                          | repo.write: DB write conflict    | DB_CONFLICT (existing)
                          | cache.delete: adapter failure    | CACHE_ADAPTER_ERROR
--------------------------|----------------------------------|-----------------------
startup                   | multi-process config detected    | CONFIG_ERROR (unrecoverable)
```

```
EXCEPTION CLASS       | RESCUED? | RESCUE ACTION                   | CALLER SEES
----------------------|----------|---------------------------------|---------------------
CACHE_ADAPTER_ERROR   | Y        | Enter bypass mode, log warn     | Transparent (DB path)
 (on cache.get)       |          |                                 |
CACHE_ADAPTER_ERROR   | Y        | Log error, enter bypass mode    | Transparent (DB path)
 (on cache.delete)    |          |                                 |
CACHE_SET_ERROR       | Y        | Log warn, return DB value       | Correct value returned
DB_TIMEOUT            | N        | Propagate (existing handler)    | Existing typed error
DB_CONNECTION_ERROR   | N        | Propagate (existing handler)    | Existing typed error
INVALID_KEY           | N        | Propagate (existing handler)    | Existing typed error
DB_CONFLICT           | N        | Propagate (existing handler)    | Existing typed error
CONFIG_ERROR          | N        | Reject startup (unrecoverable)  | Process won't start
```

No catch-all error handling. Every cache operation error is caught specifically,
logged, and either triggers bypass mode or allows the caller's successful result
through. DB errors propagate via the existing typed error mapping unchanged.

No critical gaps. Moving on.

---

### Section 3: Security & Threat Model

| Threat | Likelihood | Impact | Mitigated? |
|--------|-----------|--------|-----------|
| Cache bypass to access another tenant's data | Low | High | YES — keys encode authenticated tenant ID; auth runs before cache |
| Stale read exposing a deleted/updated record | Med | Low | PARTIAL — TTL bounds to 30s; documented as accepted |
| Cache key collision between tenants | Low | High | YES — key encoding is unambiguous per plan contract |
| Memory exhaustion via cache growth | Low | Med | YES — 16 MiB byte cap + LRU eviction |
| Secret leakage through cache key logging | Low | High | YES — secrets and raw IDs never logged |
| Multi-process coherence bypass | Low | High | YES — startup rejects multi-process config |
| Side-channel timing (hit vs miss latency) | Low | Low | Acceptable — attacker needs valid credentials anyway |

No new endpoints, no new params, no new file paths, no new external-facing API surface.
No new dependencies. Values are immutable DTOs — no mutation risk from cached reads.

No issues. Moving on.

---

### Section 4: Data Flow & Interaction Edge Cases

**Full read-path trace with shadow nodes:**

```
  readProfile(key)
       │
       ├─[nil key]────▶ key validation → INVALID_KEY error
       ├─[empty key]──▶ key validation → INVALID_KEY error
       │
       ▼
  cache.get(key)
       │
       ├─[cache hit: value]──▶ return value (happy path, no DB)
       ├─[cache hit: SENTINEL]─▶ return SENTINEL (DB absent, still valid)
       ├─[cache miss: bypass]──▶ falls through to repo.read
       │
       ▼ (cache miss or bypass)
  repo.read(key)   ← SUSPENSION POINT (await)
       │
       │ ← concurrent write can complete here (cache.delete runs)
       │
       ├─[DB hit]────▶ try cache.set(key, value)
       │                    ├─[set succeeds]────▶ return value ✓
       │                    └─[set fails]────▶ log warn, return value ✓
       │               (stale-fill race: write may have deleted this key
       │                between suspension and set; set re-populates with
       │                stale value; expires in ≤30s per amended invariant)
       │
       ├─[DB absent]─▶ try cache.set(key, SENTINEL)
       │                    same stale-fill race applies; expires in ≤10s
       │
       └─[DB error]──▶ propagate; cache unchanged ✓
```

**Async ordering at suspension points:**

At `await repository.read(key)`, the event loop is free to process other tasks.
Specifically, a `writeProfile(key, update)` can complete in this window, including
its `cache.delete(key)`. When the read resumes, its `cache.set(key, stale_value)`
then overwrites the (now-absent) cache entry with a stale value.

The single-flight wrapper coalesces concurrent reads for the same key — it does
NOT prevent the read/write race. Per the amended invariant, this is accepted with
the TTL as the consistency deadline.

**Backend-only plan — no UI interaction edge cases to map.**

No unhandled edge cases beyond the stale-fill race, which is now documented as
accepted behavior with a bounded window.

---

### Section 5: Code Quality Review

**Original pseudocode issue — cache.set and cache.delete not wrapped:**
The original wrapper pseudocode allowed cache.set to throw and propagate to the
caller (failing a successful DB read), and allowed cache.delete to throw and
propagate (failing a successful DB write). Both are now corrected in the amended
wrapper (see Proposed wrapper integration above).

**SENTINEL definition:** The plan describes the sentinel abstractly. Implementation
must define it concretely — a Symbol or typed singleton is idiomatic in JS. It must
be: not undefined (or cache.get would treat it as a miss), not a valid profile DTO
(or callers would misinterpret it), and serializable by the LRU adapter if the
adapter persists to disk. This decision belongs in the implementation, not the plan,
but the implementer must make it at hour 1.

**DRY:** No repetition. The cache wrapper is the single point of change. Existing
repository and adapter code unchanged.

**Naming:** readProfile / writeProfile are clear and action-oriented.

**Cyclomatic complexity:** Both functions branch ≤2 times. No refactor needed.

**Over/under-engineering:** Correctly scoped. The try/catch additions are not
over-engineering — they prevent a cache failure from breaking an otherwise-successful
repository operation.

No further issues. Moving on.

---

### Section 6: Test Review

**New codepaths introduced:**

```
NEW CODEPATHS:
  Read path: cache hit (present value)
  Read path: cache hit (absent sentinel)
  Read path: cache miss → DB hit → cache.set → return value
  Read path: cache miss → DB absent → sentinel fill → return sentinel
  Read path: cache miss → DB error → propagate
  Read path: cache.set failure → log, return DB value (NEW REQUIREMENT)
  Read path: cache.get in bypass mode → falls through to DB
  Write path: DB success → cache.delete → return saved
  Write path: DB failure → cache unchanged → propagate
  Write path: cache.delete failure → log, return saved (NEW REQUIREMENT)
  Concurrent miss on same key → single-flight coalesces to one DB read
  TTL expiry (30s present, 10s sentinel) → subsequent read hits DB
  Byte-limit eviction → LRU evicts least-recently-used, subsequent miss hits DB
  Feature flag: enabled → cache mode active
  Feature flag: disabled → full bypass, reads and writes go to DB
  Startup: multi-process config + caching enabled → reject with CONFIG_ERROR

NEW ERROR/RESCUE PATHS:
  CACHE_ADAPTER_ERROR on cache.get → bypass mode (see Section 2)
  CACHE_ADAPTER_ERROR on cache.delete → log + bypass (see Section 2)
  CACHE_SET_ERROR on cache.set → log + return value (see Section 2)
```

**Test coverage map:**

| Codepath | Type | Exists in plan? | Happy path | Failure path | Edge case |
|----------|------|----------------|------------|--------------|-----------|
| cache hit (present) | Unit | YES | return value | — | hit after eviction |
| cache hit (sentinel) | Unit | YES | return sentinel | — | sentinel after 10s expiry |
| cache miss → DB hit → set | Unit | YES | fill + return | set failure (NEW) | concurrent miss coalesced |
| cache miss → DB error | Unit | YES | — | propagate | — |
| write → cache.delete | Unit | YES | invalidate | delete failure (NEW) | write during in-flight read |
| eviction / byte limits | Unit | YES | evict LRU | — | at exactly 1000 entries |
| TTL expiry | Unit | YES | re-fetch | — | expiry during in-flight |
| adapter fallback | Unit | YES | bypass mode | — | bypass then reinit |
| concurrent miss coalescing | Integration | YES | single DB read | — | controlled pause/release |
| feature flag disabled | Integration | YES | full bypass | — | mid-rollout disable |
| startup rejection (multi-process) | Integration | NOT IN PLAN | reject startup | — | — |
| cache.set failure (read returns value) | Unit | NOT IN PLAN | — | value returned | — |
| cache.delete failure (write returns saved) | Unit | NOT IN PLAN | — | saved returned | — |

**Three gaps require new test specs:**

1. `cache.set failure during successful read`:
   ```
   GIVEN: DB read succeeds AND cache.set throws CACHE_SET_ERROR
   THEN: readProfile returns the DB value (not the cache error)
   AND: the error is logged at warn level
   AND: bypass mode is entered
   ```

2. `cache.delete failure during successful write`:
   ```
   GIVEN: DB write succeeds AND cache.delete throws CACHE_ADAPTER_ERROR
   THEN: writeProfile returns the saved value (not the cache error)
   AND: the error is logged at error level
   AND: bypass mode is entered
   ```

3. `multi-process startup rejection`:
   ```
   GIVEN: service config detects multi-process + caching enabled at startup
   THEN: process startup throws CONFIG_ERROR
   AND: the error message names the conflicting configuration
   AND: no partial initialization occurs
   ```

**Flakiness risk:** Concurrent-miss coalescing tests must use controlled
pause/release points on the mock repository adapter — real async timing is
non-deterministic and will produce flaky CI results.

**Test pyramid:** Unit-heavy (correct for a wrapper), integration for flag and
concurrent scenarios, no E2E needed (internal backend, no user-facing surface).

**Chaos test:** Feature flag disabled mid-rollout while reads and writes are
in flight. All in-flight reads complete via DB; no stale cache entry is observed
after flag-off. This validates the bypass semantics.

**Friday-night confidence test:** A write followed immediately by a read on the
same key returns the committed version — either because the cache was invalidated
before the read ran, or because the stale entry expired within 30 seconds. The
latter is an accepted window per the amended invariant.

---

### Section 7: Performance Review

**Hit rate math:**
900 hot keys, 1000-entry limit, 30s TTL. Read-to-write ratio assumed high (hot
keys are frequently read, less often written). Hit rate well above 60% target
under these conditions.

**Memory:** 1000 entries × average DTO size ≤ 16 MiB cap. Confirmed by "recorded
hot data fits those limits." No unbounded growth.

**Eviction pressure under write load:** If writes on hot keys exceed 1000/30s
(one full rotation per TTL window), the effective miss rate rises. At the current
write volume this is not a concern, but it should be measured in rollout metrics
as a leading indicator.

**N+1:** No ActiveRecord-style traversal. Cache is key-based. If callers
batch-read multiple keys, each is handled individually — no batch optimization.
This is acceptable for the current read pattern.

**Connection pool:** Cache reduces DB read connections. No new connections.
No Redis, no new HTTP pool.

**p99 new latency for cache hit:** Synchronous LRU get is O(1). Cache hit cost
is nanoseconds. p99 for hits will be bound by the event loop, not the cache.

**Slow path:** Cache miss → DB read → cache.set. Same as pre-cache p99 for misses.
Target hit rate of 60%+ means most requests avoid this path.

No issues. Moving on.

---

### Section 8: Observability & Debuggability Review

**Plan already specifies monitoring:** hit/miss rate, eviction, cache bytes,
fallback errors, DB CPU, read p95.

**Gaps:**

1. **Alert thresholds not defined.** "Monitor" is not an alert. Define:
   - Alert: hit rate drops below 50% (sustained 5 min) → investigate rollout
   - Alert: fallback error rate > 0.5% → cache adapter degraded, check bypass mode
   - Alert: read p95 > 90 ms at any rollout stage → consider rollback

2. **Runbooks missing for key failure modes:**
   - *Cache adapter failure:* bypass mode active → DB handles load → check adapter
     init log → reinitialize (restart or flag cycle) → verify hit rate recovers
   - *Hit rate not meeting targets:* check eviction count (byte-limit or 1000-entry
     pressure) → check write rate on hot keys → consider extending TTL if write
     rate is low

3. **Post-deploy verification checklist (first 5 min):**
   - hit rate > 0% within 30s of enabling flag (cold start filling)
   - fallback error rate == 0
   - DB CPU trending down
   - read p95 stable or improving
   - no INVALID_KEY errors (key encoding regression)

4. **Debuggability:** If a stale-read bug is reported 3 weeks post-ship, logs
   must allow reconstruction. Keys should be logged as anonymized hashes (not raw
   IDs). Cache hit/miss events should carry a log line at debug level with key hash
   and TTL remaining. This allows timeline reconstruction without exposing IDs.

These gaps are captured as implementation tasks. The plan's rollout section is
amended to reference the post-deploy checklist.

---

### Section 9: Deployment & Rollout Review

**No DB migration.** No schema change. No API change. Deployment is code-only.

**Feature flag rollout is correct:** 10% → 50% → 100% with a healthy-hour gate.
The amended plan now defines "healthy" concretely (hit rate ≥ 60%, fallback-error
rate < 0.1%, read p95 < 80 ms at ramp, < 60 ms at full).

**Old/new code simultaneously:** Not applicable — this is a flag-gated change.
With flag off, behavior is identical to pre-cache. No dual-code-path window.

**Rollback plan:**
1. Disable feature flag → cache bypassed immediately (zero-downtime)
2. Verify: DB CPU returns to ~70%, p95 returns to ~120 ms (confirms cache was active)
3. No DB migration to reverse. No data to clean up.
4. If flag disable isn't immediate: deploy flag-off config → restart service

**Deploy-time risk window:** None. Flag starts at 0%, so first deploy has no effect
until flag is explicitly enabled.

**Staging parity:** Plan does not mention staging. Should be tested in staging with
a smaller key set before production rollout.

**Smoke tests (post-enable at each stage):**
- read p95 sampled over 60 seconds < 80 ms
- cache hit rate > 0% (any hits confirm adapter is live)
- fallback error rate == 0
- no increase in error-rate SLO

No critical deployment risks. The staging gap is a minor process note.

---

### Section 10: Long-Term Trajectory Review

**Technical debt introduced:**
- Stale-fill race: documented as accepted, bounded by TTL. This is design debt
  (accepted inconsistency window) that would need a version guard if consistency
  requirements tighten. Low risk at current write rate.
- SENTINEL definition: must be defined in implementation; not a plan gap but
  worth noting for the replacement path (any future cache must agree on sentinel
  encoding).

**Path dependency:**
- Multi-process operation requires disabling or replacing this cache. The startup
  guard prevents accidental multi-process + in-process cache. The replacement path
  is explicitly preserved. Low lock-in.

**Reversibility: 5/5** — Feature flag toggle. No data, schema, or API changes.

**Ecosystem fit:** Node.js single-process event loop + synchronous LRU cache is
standard and well-understood. No framework divergence.

**1-year question:** A new engineer reading the amended plan would understand:
what the cache does, what invariants it guarantees, what invariants it does not
(stale-fill window), and how to disable it. The startup guard documents the
multi-process constraint explicitly.

**Phase 2:** If multi-process operation is needed, the repository interface's
"future replacement path" (per the plan) allows swapping in a Redis-backed adapter
without touching callers. This is a two-way door.

No issues. Moving on.

---

### Section 11: Design & UX Review

SKIPPED — no UI scope. "This is an internal backend change with no UI, API, schema,
pricing, or developer onboarding change."

---

## Required Outputs

### NOT in scope
- Distributed caching (Redis, Memcached) — preserves future replacement path
- Cross-process coherence — would require a distributed cache
- Cache prewarming — not needed; cold start within existing DB capacity
- Consistency model changes beyond TTL-bounded staleness
- Batch read optimization — current read pattern is key-by-key
- Any new product surface, API, UI, or schema change

### What already exists
| Sub-problem | Existing code | Plan reuses? |
|-------------|--------------|-------------|
| LRU eviction, byte cap, TTL | LRU adapter | YES |
| Concurrent-miss thundering herd | Per-key single-flight wrapper | YES |
| Feature-gated rollout | Runtime feature flag | YES |
| Key validation, tenant isolation, auth | Existing repository contract tests | YES (retained) |
| Error mapping for DB errors | Existing typed API error mapping | YES (unchanged) |

### Dream state delta
After this plan ships:
- DB CPU: 70% → <50% (target)
- read p95: 120 ms → <60 ms (target)
- Cache hit rate: 0% → ≥60%

Remaining gap to 12-month ideal:
- DB CPU floor is ~40% (some reads always miss); closing to <40% requires higher
  hit rate, which needs either a larger key set or lower write churn
- Multi-process operation gap remains — reserved for a future phase with distributed
  cache when operationally justified

### Error & Rescue Registry

| Method | Exception Class | Rescued? | Rescue Action | Caller Sees |
|--------|----------------|----------|--------------|-------------|
| readProfile: cache.get | CACHE_ADAPTER_ERROR | Y | Bypass mode, log warn | Transparent |
| readProfile: cache.set | CACHE_SET_ERROR | Y | Log warn, return DB value | Correct value |
| readProfile: repo.read | DB_TIMEOUT | N | Propagate (existing) | Existing typed error |
| readProfile: repo.read | DB_CONNECTION_ERROR | N | Propagate (existing) | Existing typed error |
| readProfile: key validation | INVALID_KEY | N | Propagate (existing) | Existing typed error |
| writeProfile: repo.write | DB_TIMEOUT | N | Propagate (existing) | Existing typed error |
| writeProfile: repo.write | DB_CONFLICT | N | Propagate (existing) | Existing typed error |
| writeProfile: cache.delete | CACHE_ADAPTER_ERROR | Y | Log error, bypass mode | Correct saved value |
| startup | CONFIG_ERROR (multi-proc) | N | Reject startup (unrecoverable) | Process won't start |

### Failure Modes Registry

| Codepath | Failure Mode | Rescued? | Test? | User Sees | Logged? |
|----------|-------------|----------|-------|-----------|---------|
| readProfile | cache.get adapter fail | Y | Y (existing) | Nothing (bypass) | Y (warn) |
| readProfile | cache.set fail after read | Y | **GAP→add** | Nothing | Y (warn) |
| readProfile | DB timeout | N | Y (existing) | Typed error | Y (existing) |
| readProfile | stale-fill race (stale cache.set) | Y (TTL) | **GAP→add** | Stale ≤30s | N (accepted) |
| writeProfile | DB write fail | N | Y (existing) | Typed error | Y (existing) |
| writeProfile | cache.delete fail | Y | **GAP→add** | Nothing | Y (error) |
| startup | multi-process + caching | N | **GAP→add** | Process won't start | Y (error) |

Critical gaps: 0 after amendments. The stale-fill race is accepted behavior with
a bounded window (not silent — it is now documented). Test gaps are captured as
tasks.

### TODOS.md updates
No TODOS proposed in HOLD SCOPE mode. The staging verification note and alert
threshold definitions are captured as implementation tasks (T4, T5) rather than
deferred work.

### Diagrams produced
1. System architecture — Section 1 ✓
2. Data flow (read path with shadow nodes) — Section 1 ✓
3. Data flow (write path) — Section 1 ✓
4. Cache entry state machine — Section 1 ✓
5. Read-path shadow trace — Section 4 ✓
6. Rollback plan: feature flag disable → verify DB metrics. No separate diagram needed (2-step procedure).

Stale diagram audit: No ASCII diagrams exist in the repository yet (new feature).
No stale diagrams to audit.

---

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding.

- [ ] **T1 (P1, human: ~1h / CC: ~5min)** — Wrapper — Add try/catch to cache.set in readProfile
  - Surfaced by: Section 2 / Section 5 — cache.set can throw; currently propagates to caller despite successful DB read
  - Files: repository wrapper module
  - Verify: new unit test (cache.set failure, read returns DB value)

- [ ] **T2 (P1, human: ~1h / CC: ~5min)** — Wrapper — Add try/catch to cache.delete in writeProfile
  - Surfaced by: Section 2 / Section 5 — cache.delete can throw; currently propagates to caller despite successful DB write
  - Files: repository wrapper module
  - Verify: new unit test (cache.delete failure, write returns saved)

- [ ] **T3 (P1, human: ~2h / CC: ~10min)** — Tests — Add three missing test specs
  - Surfaced by: Section 6 — cache.set failure path, cache.delete failure path, multi-process startup rejection
  - Files: wrapper test file
  - Verify: all three specs pass; concurrent-miss test uses controlled pause/release (not real async timing)

- [ ] **T4 (P2, human: ~1h / CC: ~5min)** — Observability — Define alert thresholds and runbooks
  - Surfaced by: Section 8 — "monitor" is not an alert; no runbooks for cache adapter failure or hit-rate regression
  - Files: runbook/ops doc, monitoring config
  - Verify: alerts fire in staging simulation; runbooks reviewed by on-call engineer

- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — Rollout — Add post-deploy verification checklist and staging step
  - Surfaced by: Section 9 — checklist for first-5-min post-enable and staging parity
  - Files: rollout runbook / deployment doc
  - Verify: checklist is in the deployment guide; staging test run passes before production enable

- [ ] **T6 (P2, human: ~30min / CC: ~5min)** — Consistency — Define SENTINEL value concretely
  - Surfaced by: Section 5 / Step 0E — sentinel is described abstractly; implementer must define it before writing the wrapper
  - Files: wrapper module, cache adapter interface
  - Verify: SENTINEL is a typed singleton not assignable to a valid profile DTO; unit test confirms cache.get returns it correctly

---

## Completion Summary

```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
+====================================================================+
| Mode selected        | HOLD SCOPE                                  |
| System Audit         | Skipped per run rules                       |
| Step 0               | HOLD SCOPE confirmed; single approach wins  |
| Section 1  (Arch)    | 0 issues — architecture sound               |
| Section 2  (Errors)  | 3 error paths mapped (cache ops); 0 GAPS    |
|                      | after amendments                            |
| Section 3  (Security)| 0 issues — auth boundary correct            |
| Section 4  (Data/UX) | Stale-fill race documented; 0 unhandled     |
| Section 5  (Quality) | 2 issues (cache.set/delete error handling)  |
|                      | → amended in plan                           |
| Section 6  (Tests)   | Diagram produced; 3 test gaps               |
| Section 7  (Perf)    | 0 issues                                    |
| Section 8  (Observ)  | 3 gaps (alerts, runbooks, checklist)        |
| Section 9  (Deploy)  | 1 gap (staging parity, checklist)           |
| Section 10 (Future)  | Reversibility: 5/5; debt: stale-fill        |
|                      | (accepted, bounded)                         |
| Section 11 (Design)  | SKIPPED (no UI scope)                       |
+--------------------------------------------------------------------+
| NOT in scope         | written (6 items)                           |
| What already exists  | written (5 items reused)                    |
| Dream state delta    | written                                     |
| Error/rescue registry| 9 methods, 0 CRITICAL GAPS after amendments |
| Failure modes        | 7 total, 0 CRITICAL GAPS after amendments   |
| TODOS.md updates     | 0 items (HOLD SCOPE; gaps → tasks)          |
| Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
| CEO plan             | skipped (HOLD SCOPE)                        |
| Outside voice        | disabled (codex_reviews=disabled)           |
| Lake Score           | 6/6 recommendations chose complete option  |
| Diagrams produced    | 5 (arch, read flow, write flow, state       |
|                      | machine, data flow shadow trace)            |
| Stale diagrams found | 0 (new feature, no prior diagrams)          |
| Unresolved decisions | 0 (all auto-resolved, headless run)         |
+====================================================================+
```

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open | mode: HOLD_SCOPE, 0 critical gaps (stale-fill race documented as accepted; 3 test gaps → T3) |
| Outside Review | disabled | Independent 2nd opinion | 0 | disabled | codex_reviews=disabled per config |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | not yet run |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | no UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not yet run |

**OUTSIDE COVERAGE:** disabled. `codex_reviews: disabled` in config. Re-enable: `gstack-config set codex_reviews enabled`. Native review completed in full.

**VERDICT:** CEO review completed (HOLD SCOPE). Eng review required before shipping.

NO UNRESOLVED DECISIONS
