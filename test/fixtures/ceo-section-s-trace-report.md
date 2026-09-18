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

## CEO Review (HOLD SCOPE)

Mode: **HOLD SCOPE** — the plan's scope is accepted as stated. This review makes it bulletproof: catches failure modes, tests every edge case, ensures observability, maps every error path. No expansion surfaced.

Approach confirmed: thin wrapper around the existing repository, reusing the existing LRU adapter, single-flight coalescing, and feature-flag rollout. Minimal viable and architecturally sound — the right call.

---

## Step 0: Nuclear Scope Challenge

**0A. Premise Challenge**

1. Right problem? Yes. DB CPU at 70% and p95 at 120ms with 900 stable hot keys is a textbook read-cache opportunity. A one-week trace backing the hot-key profile makes this measurement-driven, not speculative.
2. Direct path? Yes. A process-local LRU is the most direct intervention: zero network hops, zero consistency overhead, zero schema change.
3. What if nothing done? DB CPU continues climbing as traffic grows; latency degrades further. Real pain point, evidenced by the trace.

**0B. Existing Code Leverage**

- Existing LRU adapter: fully reused, no new cache library
- Existing single-flight wrapper: reused for concurrent-miss coalescing
- Existing feature flag: reused for staged rollout
- Existing repository contract tests: extended, not replaced
- Existing tenant isolation and key validation: unchanged and inherited

No parallel implementation; no rebuild of existing functionality.

**0C. Dream State Mapping**

```
  CURRENT STATE                  THIS PLAN                  12-MONTH IDEAL
  DB CPU 70%          --->       LRU wraps repository  ---> DB CPU <50%, p95 <60ms
  read p95 120ms                 60%+ cache hits              stable under 10x hot traffic
  all reads hit DB               900 hot keys served          future: multi-process if
  single process OK              from process memory           service scales (separate plan)
```

**0C-bis. Implementation Alternatives**

```
APPROACH A: Thin wrapper (this plan)
  Summary: Add readProfile/writeProfile wrapper around existing repository, reuse LRU adapter.
  Effort:  S
  Risk:    Low
  Pros:    Minimal diff; zero new dependencies; fully reversible via flag
           Inherits existing adapter's eviction, TTL, byte-cap, and bypass logic
  Cons:    Process-local only; no warm restart; cross-process unsupported by design
  Reuses:  existing LRU adapter, single-flight wrapper, feature flag, contract tests

APPROACH B: Decorator/Interceptor pattern
  Summary: Wrap the repository interface with a cache decorator injected at construction.
  Effort:  M
  Risk:    Low
  Pros:    Cleaner separation; easier to swap caching strategies later
  Cons:    More indirection; no material runtime difference for this scope
  Reuses:  same LRU adapter and flag

APPROACH C: Redis sidecar
  Summary: Replace process-local LRU with a Redis-backed cache for future multi-process use.
  Effort:  XL
  Risk:    High
  Pros:    Solves cross-process coherence; supports horizontal scale
  Cons:    New infrastructure dependency; network latency per read; out of stated scope
  Reuses:  nothing from current adapter
```

**RECOMMENDATION:** Approach A. The problem is single-process, the data fits in memory, and approach A is fully reversible with zero new dependencies. Approach B adds abstraction without runtime benefit. Approach C is explicitly out of scope and introduces infrastructure risk.

Auto-decided: Approach A selected (recommended, no human present).

**0D. HOLD SCOPE Analysis**

1. Complexity check: The wrapper touches 1 module (repository), adds 2 functions, and extends 1 test file. Well within the 8-file threshold. No smell.
2. Minimum set: The plan is already minimal. The wrapper, tests, and feature flag are all required for correctness and safe rollout.
3. Stated invariants and acceptance criteria are preserved as the baseline.

**0E. Temporal Interrogation**

```
  HOUR 1 (foundations):    Implementer needs: exact LRU adapter API (get/set/delete
                           return contracts, synchronous guarantees, bypass semantics)
  HOUR 2-3 (core logic):  Ambiguity: post-await guard needed before cache.set (see
                           Section 1 finding). Without it the stale-re-insertion race
                           silently violates the stated ordering invariant.
  HOUR 4-5 (integration): Surprise: feature flag applies per-key to BOTH read and write
                           paths consistently — confirm flag evaluation is idempotent per key.
  HOUR 6+ (polish/tests): Need explicit test for write-during-in-flight-read scenario.
```

(CC+gstack compresses these 6 human hours to ~20-30 minutes of wall time.)

---

## Section 1: Architecture Review

### System Architecture

```
  ┌─────────────────────────────────────────────────────────────┐
  │            profile-summary service (single process)          │
  │                                                             │
  │  ┌──────────────┐  readProfile/writeProfile  ┌───────────┐ │
  │  │   Callers    │ ─────────────────────────► │ Wrapper   │ │
  │  └──────────────┘                            │  (NEW)    │ │
  │                                              └─────┬─────┘ │
  │                                    ┌───────────────┤       │
  │                                    │               │       │
  │                               ┌────▼────┐    ┌────▼────┐  │
  │                               │  LRU    │    │ Repos-  │  │
  │                               │ Cache   │    │  itory  │  │
  │                               │(adapter)│    │(existing│  │
  │                               └─────────┘    └────┬────┘  │
  │                                                   │       │
  │                                             ┌─────▼─────┐ │
  │                                             │ Database  │ │
  │                                             └───────────┘ │
  └─────────────────────────────────────────────────────────────┘
```

Coupling: The wrapper couples callers to the LRU adapter. Before: callers → repository → DB. After: callers → wrapper → (cache OR repository) → DB. The added coupling is justified: the adapter is an internal implementation detail, not a public contract.

Scaling: The LRU is bounded at 1000 entries / 16 MiB. Under 10x load, cache hit rate stays constant (hot keys are stable); DB load drops proportionally. Under 100x load, the 1000-entry limit may not hold all hot keys — but that is explicitly out of scope for this plan and properly left to a future distributed-cache plan.

Single points of failure: The cache is one. It fails open (bypass mode) per the plan.

Rollback posture: Disable the runtime feature flag. Instant bypass — no code change or deploy required.

### Data Flow — All Four Paths

```
READ FLOW:
  KEY ──► cache.get(key)
              │
       ┌──────┴──────────────────────────────┐
       │ hit (cached !== undefined)          │ miss (undefined)
       ▼                                    ▼
  return cached                    single-flight.acquire(key)
                                            │
                                   await repository.read(key)
                                            │
                              ┌─────────────┼────────────────┐
                              │ nil/absent  │ value          │ error
                              ▼             ▼                ▼
                         sentinel       cache.set(key,v)  typed API error
                         (10s TTL)      return value      bypass cache

WRITE FLOW:
  KEY, UPDATE ──► await repository.write(key, update)
                           │
               ┌───────────┼───────────┐
               │ success   │           │ error
               ▼           │           ▼
         cache.delete(key) │    typed API error (cache NOT deleted — preserved)
         return saved      │
                           │
```

### Critical Finding: Stale Re-insertion After Write Invalidation

**CRITICAL GAP** — The plan states: "Every read begun after that write completes must observe the committed version. TTL expiry is not a substitute for this rule." The proposed wrapper violates this invariant.

Race sequence (possible in the JS event loop at await boundaries):

```
  t1: readProfile(key)  → cache miss → single-flight → await DB read (suspends)
  t2: writeProfile(key) → await DB write (suspends)
  t3: DB write completes → cache.delete(key) → writeProfile returns
  t4: DB read (from t1) completes → returns OLD snapshot
  t5: cache.set(key, OLD_VALUE)  ← stale value re-inserted after invalidation!
  t6: next readProfile(key) → cache HIT → returns stale value  ← INVARIANT VIOLATED
```

The plan says "no additional version checks or coordination between a cache fill and a write are proposed," but the stated ordering invariant requires exactly that guard to prevent t5.

Fix: add a synchronous post-await check before cache.set. Because cache.get and cache.set are synchronous (no await), the check+set pair is atomic in the JS event loop — the write's cache.delete cannot interleave between them:

```javascript
async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await repository.read(key);
  // Guard: only cache if no write invalidated this key while we were reading DB.
  // Safe because cache.get and cache.set are synchronous — write's cache.delete
  // cannot interleave between these two lines.
  if (cache.get(key) === undefined) {
    cache.set(key, value);
  }
  return value;
}
```

**Auto-decided (D1):** Add post-await guard to readProfile. Recommended option accepted.

### State Machine: Cache Entry

```
  [DISABLED]  ──(flag enable)──►  [EMPTY]
      ▲                               │
      │ (flag disable)          (first read for key)
      │                               │
      │                               ▼
      │                          [MISS/BYPASS]
      │                               │
      │                         (DB read completes)
      │                               │
      │                               ▼
      │                          [CACHED]  ◄──── (subsequent reads)
      │                               │
      │                         (write or eviction or TTL)
      │                               │
      │                               ▼
      │                          [INVALIDATED]
      │                               │
      │                         (next read: miss → DB)
      │                               ▼
      │                          [CACHED again]
      │
      └────── (cache failure → BYPASS until reinitialized)
```

Invalid transitions prevented: write to absent key cannot create cache entry (write only deletes); sentinel entries expire on 10s TTL, not promoted to normal entries.

### Security Architecture

Auth boundary: authentication and authorization happen before repository access. The wrapper sits inside that boundary. Keys encode tenant ID and profile ID — the wrapper cannot be used to bypass authorization. No new attack surface.

---

## Section 2: Error & Rescue Map

| METHOD/CODEPATH | WHAT CAN GO WRONG | EXCEPTION CLASS |
|---|---|---|
| readProfile | cache.get throws | CacheAdapterError |
| readProfile | repository.read rejects | typed DBError |
| readProfile | cache.set throws | CacheAdapterError |
| writeProfile | repository.write rejects | typed DBError |
| writeProfile | cache.delete throws | CacheAdapterError |

| EXCEPTION CLASS | RESCUED? | RESCUE ACTION | USER SEES |
|---|---|---|---|
| CacheAdapterError (any op) | Y | Adapter enters bypass mode; all subsequent ops go to DB until cache is reinitialized | Transparent — no degraded response |
| typed DBError (read) | Y | Existing typed error mapping; bypass unchanged | Existing error response |
| typed DBError (write) | Y | Existing typed error mapping; cache NOT deleted (failed-write preservation) | Existing error response |

No catch-all handlers. No silent swallows. All cache failures are non-blocking by design (bypass mode). Repository error handling is unchanged.

**Section 2 result: 5 paths mapped, 0 CRITICAL GAPS.**

---

## Section 3: Security & Threat Model

| THREAT | LIKELIHOOD | IMPACT | MITIGATED? |
|---|---|---|---|
| Cross-tenant cache access | Low | High | YES — keys encode authenticated tenant ID; no ambiguity |
| Cache poisoning via key manipulation | Low | High | YES — keys derived from validated inputs; wrapper doesn't accept raw user input |
| PII leakage in logs | Low | High | YES — plan explicitly excludes raw IDs from monitoring |
| Stale data serving sensitive fields | Med | Med | PARTIAL — stale re-insertion gap (Section 1) closes with T1 fix |
| New attack surface (endpoints) | N/A | N/A | NO new endpoints introduced |

No new secrets, no new dependencies, no injection vectors. The stale-data risk from the re-insertion gap is mitigated by T1.

**Section 3 result: 0 new attack vectors. 1 stale-data risk closed by T1.**

---

## Section 4: Data Flow & Interaction Edge Cases

```
READ DATA FLOW:
  KEY ──► VALIDATE (auth layer, pre-wrapper) ──► CACHE LOOKUP
    │                                                  │
    ▼                                           ┌──────┴──────┐
  [nil?]  undefined = cache miss               HIT           MISS
  [empty?] key cannot be empty (validated)      │             │
  [wrong?] upstream validated                  return      await DB
                                               cached       read
                                                          │
                                                     ┌────┴────┐
                                                  value      absent
                                                     │          │
                                                post-await   sentinel
                                                guard check  (10s TTL)
                                                     │
                                                cache.set
                                                (if key still absent)
```

**Async ordering edge cases:**

| SCENARIO | HANDLED? | HOW |
|---|---|---|
| Concurrent reads for same key (miss) | YES | Single-flight coalesces |
| Write during in-flight read (same key) | GAP → FIXED by T1 | Post-await guard prevents stale re-insertion |
| Write after read completes (normal ordering) | YES | cache.delete removes stale value before next read |
| Multiple writes to same key in sequence | YES | Each write deletes; final state is post-last-write TTL miss |
| Adapter failure during read | YES | Bypass mode; read goes to DB |
| Adapter failure during write delete | YES | Bypass mode; subsequent reads miss to DB |
| Feature flag disabled mid-request | YES | Both read and write bypass; no partial state |

**No UI edge cases** — backend-only change.

**Section 4 result: 1 edge case mapped (stale re-insertion), covered by T1 fix.**

---

## Section 5: Code Quality Review

The proposed code is 10 lines across 2 functions. Review:

- Organization: wrapper is a thin shell around existing repository — correct pattern; fits existing structure.
- DRY: no repetition. Single-flight and LRU are reused, not rebuilt.
- Naming: `readProfile`, `writeProfile`, `key`, `value`, `saved`, `cached` — all intention-revealing.
- Error handling: relies on adapter bypass semantics; no catch-all.
- Cyclomatic complexity: each function has 1-2 branches. Well within limit.
- Over-engineering: none. No unnecessary abstractions.
- Under-engineering: the missing post-await guard (addressed in T1) is the sole fragility.

**Section 5 result: 0 issues beyond the T1 finding from Section 1.**

---

## Section 6: Test Review

### Test Diagram

```
NEW DATA FLOWS:
  - Read path: cache hit (all TTL states)
  - Read path: cache miss → DB → cache.set
  - Read path: cache miss → DB → post-await guard blocks stale re-insertion (T2: MISSING)
  - Write path: success → cache.delete
  - Write path: failure → cache NOT deleted (preserved)
  - Concurrent reads: single-flight coalescing
  - Adapter failure: bypass mode on any op

NEW CODEPATHS:
  - cache.get → hit branch
  - cache.get → miss branch → DB → cache.set
  - cache.get → miss branch → DB → post-await guard (key no longer absent → skip set)
  - cache.delete on write success
  - cache.delete skipped on write failure
  - adapter bypass on cache error

NEW BACKGROUND JOBS / ASYNC WORK:
  - None

NEW INTEGRATIONS / EXTERNAL CALLS:
  - None (existing DB calls, no new integrations)

NEW ERROR/RESCUE PATHS:
  - CacheAdapterError → bypass mode (Section 2)
```

### Coverage Gap

The plan lists these test cases: hit/miss, eviction/byte limits, TTL, adapter-failure fallback, successful-write invalidation, failed-write preservation, concurrent-miss coalescing.

**Missing:** write-during-in-flight-read. This is the specific interleaving that produces the stale re-insertion (Section 1). Without it, the post-await guard added by T1 is untested.

Test spec header:
```javascript
describe('readProfile — write-during-in-flight-read', () => {
  it('does not cache the stale value when a write invalidates the key during a DB read', async () => {
    // Arrange: pause the DB read mid-flight using a controlled promise
    // Act: start readProfile → suspend at DB read → run writeProfile → complete DB read
    // Assert: cache.get(key) returns undefined after both settle
    //         next readProfile goes to DB (not stale cache hit)
  });
});
```

**Auto-decided (D2):** Add test spec for write-during-in-flight-read. Recommended option accepted.

### Test Ambition Check

- "Ship at 2am on a Friday" test: the write-during-in-flight-read test (T2) is that test — it catches the silent stale-read failure.
- "Hostile QA" test: force adapter failure mid-sequence; verify bypass, then re-enable and verify empty cache.
- Chaos test: cycle the feature flag rapidly under concurrent read/write load; assert no stale reads escape.

**Section 6 result: 1 gap (write-during-in-flight-read test). Addressed by T2.**

---

## Section 7: Performance Review

| DIMENSION | ASSESSMENT |
|---|---|
| N+1 queries | None introduced. Cache reduces DB calls, not adds. |
| Memory | 16 MiB cap is explicit; 900 hot key DTOs are small; bounded. |
| DB indexes | No new queries; existing indexes unchanged. |
| Caching opportunities | This plan IS the caching. All hot reads covered. |
| Slow paths | Cold start: 900 cache misses on restart. Spread over time by single-flight coalescing and rolling traffic. Plan claims within existing DB capacity — reasonable given 900 reads over 30s TTL window. |
| Connection pool | No new connections. Cache eliminates DB round-trips. |

Cold-start analysis: 900 hot keys × average read latency ≈ 900 DB reads over the first ~30 seconds of traffic. Current DB handles ~N reads/s at 70% CPU. If N >> 30, cold start is within capacity. Plan states this explicitly — the service owner should verify against the current read rate during rollout monitoring.

**Section 7 result: 0 issues. Cold start assertion is a monitoring checkpoint, not a plan gap.**

---

## Section 8: Observability & Debuggability Review

**Metrics specified in plan:** hit/miss rate, eviction rate, cache bytes, fallback errors, DB CPU, read p95. This is complete for the acceptance criteria.

**Gap: alert thresholds not specified.**

The plan says "monitor" but doesn't define when the service owner should be paged vs. just watching. For a staged rollout with an active owner, manual monitoring is acceptable. But for ongoing operation post-100% rollout, the missing thresholds become an operational gap.

Suggested thresholds (P3 TODO, not blocking ship):
- Page if: hit rate < 40% sustained for 5 minutes (cache not working)
- Page if: fallback error rate > 1% (adapter instability)
- Warn if: cache bytes > 14 MiB (near 16 MiB cap, possible eviction pressure)

**Logging:** secrets and raw IDs excluded per plan. Structured log lines at bypass entry/exit and eviction spikes would aid post-incident debugging. Not required for ship.

**Debuggability at 3 weeks post-ship:** With hit/miss, eviction, and fallback error metrics, you can reconstruct most incident scenarios. The stale-read scenario (before T1 fix) would have been invisible — this is why T1 is P1.

**Runbook for fallback errors:** Disable the feature flag → service reverts to direct DB → investigate adapter state → re-enable creates empty cache.

**Auto-decided (D3):** Alert thresholds as P3 TODO. Non-blocking.

**Section 8 result: 1 minor gap (alert thresholds). Addressed as P3 TODO (T3).**

---

## Section 9: Deployment & Rollout Review

| CHECK | STATUS |
|---|---|
| DB migration | None required. |
| Feature flag | YES — existing runtime flag; staged rollout 10% → 50% → 100% |
| Rollout order | Flag enable is the deploy; no schema changes, no migration sequencing needed. |
| Rollback plan | Disable flag → instant bypass → empty cache on re-enable. Full rollback < 1 minute. |
| Deploy-time risk window | Flag-gated; old and new behavior coexist cleanly. 10% of keys test the wrapper while 90% go direct. |
| Environment parity | Staging test assumed; plan says "existing DB capacity" — verify staging has representative load. |
| Post-deploy verification | Hit rate, fallback errors, DB CPU at each stage; one healthy hour before advancing. |
| Smoke tests | Existing contract tests; new wrapper tests (T1+T2) must pass before flag enable. |

**"10% of keys" flag semantics:** The rollout applies consistently to both read and write paths for a given key. This is the only correct interpretation — partial application would create inconsistency (reads cache, writes don't invalidate). Recommend confirming flag implementation applies to both paths per key in the same call.

**Section 9 result: 0 risks. Flag semantics worth verifying in implementation.**

---

## Section 10: Long-Term Trajectory Review

| DIMENSION | ASSESSMENT |
|---|---|
| Technical debt | Minimal. Thin wrapper, no new abstraction layer. |
| Path dependency | None. Plan explicitly preserves future replacement path ("without introducing a general cache framework now"). |
| Knowledge concentration | Plan is self-contained and clear. A new engineer reading it in 12 months will understand the problem, the invariant, and the fix. |
| Reversibility | **5/5** — feature flag disable reverts instantly to baseline. One-hour rollback, zero data risk. |
| Ecosystem fit | Standard read-through LRU pattern in JS. No unusual choices. |
| The 1-year question | Reads cleanly. Acceptance targets, invariants, and out-of-scope items are all explicit. |

Future trajectory: if the service scales to multiple processes, this plan's design makes that upgrade path clear — the "Out of scope" section names distributed caching and cross-process coherence as the next tier. The current interface can be replaced without changing callers.

**Section 10 result: Reversibility 5/5, 0 debt items.**

---

## Section 11: Design & UX Review

**SKIPPED** — no UI scope detected. This is a backend-only change with no user-visible interactions, screens, or state changes.

---

## Outside Voice

Codex review skipped (codex_reviews disabled). Re-enable: `gstack-config set codex_reviews enabled`.

---

## Required Outputs

### NOT in scope (considered and deferred)

| Item | Rationale |
|---|---|
| Distributed caching | Out of stated scope; single-process design is the constraint |
| Cross-process coherence | Explicitly excluded; multi-process startup is rejected by design |
| Cache prewarming | Not needed; hot keys warm within first TTL window via normal traffic |
| Changing consistency semantics | No requirement; existing read-through model is sufficient |
| New product surfaces (API, UI, schema) | Backend-only change; no new surfaces planned |
| General cache framework | Would over-engineer; specific adapter is the right size for this problem |
| Alert threshold automation | P3 TODO; manual monitoring sufficient during rollout and initial operation |

### What already exists

| Component | Status |
|---|---|
| LRU adapter (1000 entries, 16 MiB, 30s TTL) | Reused unchanged |
| Single-flight miss coalescing | Reused unchanged |
| Runtime feature flag | Reused for staged rollout |
| Repository contract tests (tenant isolation, key validation, absence, DB failures, authorization) | Extended with wrapper tests |
| Tenant ID + profile ID key encoding | Unchanged; wrapper inherits this property |
| Typed API error mapping | Unchanged; wrapper preserves these error responses |

### Dream state delta

```
  CURRENT STATE              THIS PLAN DELTA           12-MONTH IDEAL
  DB CPU 70%        --->     DB CPU < 50%        --->  Stable at < 50% under 10x traffic growth
  read p95 120ms             read p95 < 60ms            read p95 < 60ms sustained
  all 900 hot reads          60%+ hot reads served       full hot-key coverage; optional
  hit DB directly            from process memory          distributed cache if multi-process
                                                          needed (separate plan)
```

This plan closes the gap from current state to 12-month ideal for the single-process constraint. The distributed-cache path is preserved, not foreclosed.

### Error & Rescue Registry

| METHOD | FAILURE | EXCEPTION | RESCUED? | RESCUE ACTION | USER SEES |
|---|---|---|---|---|---|
| readProfile | cache.get throws | CacheAdapterError | YES | Adapter enters bypass; DB read proceeds | Transparent |
| readProfile | DB read rejects | typed DBError | YES | Existing typed error mapping | Existing error response |
| readProfile | cache.set throws | CacheAdapterError | YES | Adapter enters bypass; read returns DB value | Transparent |
| writeProfile | DB write rejects | typed DBError | YES | Existing typed error mapping; cache NOT deleted | Existing error response |
| writeProfile | cache.delete throws | CacheAdapterError | YES | Adapter enters bypass; subsequent reads go to DB | Transparent |

### Failure Modes Registry

| CODEPATH | FAILURE MODE | RESCUED? | TEST? | USER SEES | LOGGED? |
|---|---|---|---|---|---|
| readProfile | Cache adapter failure | YES | YES (adapter-failure fallback) | Nothing (transparent) | YES (bypass entry) |
| readProfile | DB read error | YES | YES (existing contract tests) | Existing error response | YES (existing) |
| readProfile | Stale re-insertion after write | NO (gap) → FIXED T1 | NO (gap) → ADDED T2 | Silent stale read | Not without T1+T2 |
| writeProfile | DB write error | YES | YES (failed-write preservation) | Existing error response | YES (existing) |
| writeProfile | Cache delete failure | YES | YES (adapter-failure fallback) | Nothing (transparent) | YES (bypass entry) |
| Feature flag disable | All cache ops bypassed | N/A | YES (existing flag tests) | Nothing (transparent) | YES (flag events) |

**CRITICAL GAP before T1+T2:** Stale re-insertion after write is RESCUED=N, TEST=N, USER SEES=Silent. T1 and T2 close this gap.

### Diagrams Summary

Architecture, data flow, state machine, and error flow produced in sections above. Deployment sequence and rollback are feature-flag based and described in Section 9 prose (no sequence diagram needed — disable flag = rollback, one step).

### Stale Diagram Audit

No existing ASCII diagrams found in the plan or referenced files. This plan introduces 4 new diagrams (system architecture, read flow, state machine, cross-reference in Section 4). All current and consistent with the proposed implementation.

---

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code; checkbox as you ship.

- [ ] **T1 (P1, human: ~30min / CC: ~5min)** — readProfile wrapper — Add post-await guard to prevent stale re-insertion after write invalidation
  - Surfaced by: Section 1 (Architecture) — stale re-insertion race; write's cache.delete can execute between the DB read's await and cache.set, allowing an old snapshot back into cache
  - Files: repository wrapper module (readProfile function)
  - Verify: T2 test passes; run existing contract tests; confirm cache.get returns undefined for a key that was written while its read was in-flight
  - Change: after `await repository.read(key)`, replace unconditional `cache.set(key, value)` with `if (cache.get(key) === undefined) { cache.set(key, value); }`

- [ ] **T2 (P2, human: ~1h / CC: ~10min)** — wrapper tests — Add test for write-during-in-flight-read scenario
  - Surfaced by: Section 6 (Tests) — the post-await guard (T1) is untested without a controlled interleaving test
  - Files: wrapper test file
  - Verify: test fails without T1 fix; passes with it; is deterministic (no timing dependency — use controlled promise resolution)
  - Test: pause readProfile at the DB read using a deferred promise; run writeProfile to completion; resolve DB read; assert cache.get(key) === undefined after both settle

- [ ] **T3 (P3, human: ~30min / CC: ~5min)** — observability — Define alert thresholds for ongoing cache operation post-rollout
  - Surfaced by: Section 8 (Observability) — monitoring metrics are specified but alert thresholds are not; fine during active-owner rollout, operational gap post-stabilization
  - Files: alerting config / runbook
  - Thresholds: hit rate < 40% sustained 5 min → page; fallback error rate > 1% → page; cache bytes > 14 MiB → warn

_No new tasks from Sections 3, 5, 7, 9, 10, 11._

---

## Completion Summary

```
+====================================================================+
|             MEGA PLAN REVIEW — COMPLETION SUMMARY                  |
+====================================================================+
| Mode selected        | HOLD SCOPE                                  |
| System Audit         | SKIPPED (per run configuration)             |
| Step 0               | HOLD SCOPE confirmed; Approach A selected   |
| Section 1  (Arch)    | 1 CRITICAL GAP (stale re-insertion) → T1   |
| Section 2  (Errors)  | 5 error paths mapped, 0 GAPS               |
| Section 3  (Security)| 0 issues found, 0 High severity            |
| Section 4  (Data/UX) | 1 edge case mapped (stale re-insertion)     |
| Section 5  (Quality) | 0 issues found                             |
| Section 6  (Tests)   | Diagram produced, 1 gap (T2)               |
| Section 7  (Perf)    | 0 issues found                             |
| Section 8  (Observ)  | 1 minor gap (alert thresholds → T3)        |
| Section 9  (Deploy)  | 0 risks flagged                            |
| Section 10 (Future)  | Reversibility: 5/5, debt items: 0         |
| Section 11 (Design)  | SKIPPED (no UI scope)                      |
+--------------------------------------------------------------------+
| NOT in scope         | written (7 items)                           |
| What already exists  | written (6 components)                      |
| Dream state delta    | written                                     |
| Error/rescue registry| 5 methods, 0 CRITICAL GAPS (post-T1)       |
| Failure modes        | 6 total, 1 CRITICAL GAP (closed by T1+T2)  |
| TODOS.md updates     | 1 item (T3, P3, alert thresholds)          |
| Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)        |
| CEO plan             | skipped (HOLD SCOPE)                        |
| Outside voice        | DISABLED (codex_reviews=disabled)           |
| Lake Score           | 3/3 recommendations chose complete option  |
| Diagrams produced    | 4 (architecture, read flow, state machine,  |
|                      |    data flow with shadow paths)             |
| Stale diagrams found | 0                                           |
| Unresolved decisions | 0 (D1, D2, D3 all auto-decided)            |
+====================================================================+
```

**Auto-decided decisions (no human present):**
- D1: Add post-await guard (stale re-insertion fix) → recommended option accepted → T1
- D2: Add write-during-in-flight-read test → recommended option accepted → T2
- D3: Alert thresholds as P3 TODO → recommended option accepted → T3

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open | mode: HOLD_SCOPE, 1 critical gap (stale re-insertion → T1+T2) |
| Outside Review | disabled | Independent 2nd opinion | 0 | DISABLED | codex_reviews=disabled per config |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** codex_reviews=disabled; outside review step skipped per isolated config. Re-enable: `gstack-config set codex_reviews enabled`.

**VERDICT:** CEO Review complete — 1 critical gap found and addressed (T1: post-await guard; T2: interleaving test). Eng review required before shipping.

NO UNRESOLVED DECISIONS
