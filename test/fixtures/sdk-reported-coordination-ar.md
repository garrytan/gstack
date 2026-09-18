# Plan: cache profile summaries in one process

Reviewed by `/plan-ceo-review` on 2026-09-10 · Mode: HOLD SCOPE · Branch: main · Commit a85d341
Plan content below is the original plan with accepted amendments marked **[Amended: Fn]**.
The decision record and review report follow the plan.

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
  **[Amended: F5]** The cached DTO must be identical for every authorized caller
  in the tenant (no viewer-dependent fields). A contract test asserts this; if it
  ever fails, the key must additionally encode the viewer role before shipping.
- The existing LRU adapter supports 1000 entries, a 16 MiB byte cap, and a
  30-second TTL. Recorded hot data fits those limits. Absent records use a
  distinct sentinel with a 10-second TTL; undefined means a cache miss.
- Cache operations are synchronous and atomic in the single JS event loop.
  On any cache failure the existing adapter bypasses the cache until an empty
  cache is reinitialized; repository errors keep the current typed API error
  mapping. The existing per-key
  single-flight wrapper coalesces simultaneous misses and releases on failure.
  **[Amended: F4]** Entering bypass mode emits a structured log line and sets the
  `profile_cache_state` gauge to `bypassed`; an alert fires if it stays there
  over 60 seconds. Reinitialization happens on the next feature-flag transition
  (existing behavior, now documented in the runbook).
- A read already in progress when a write commits may return its earlier DB
  snapshot to that caller. Every read begun after that write completes must
  observe the committed version. TTL expiry is not a substitute for this rule.
  **[Amended: F1]** The mechanism that enforces this is fill invalidation: a
  successful write marks any in-flight fill for the key as invalidated and
  detaches it from the single-flight map, so the late fill never populates the
  cache and later misses start a fresh fill. See the ordering schedule below.
- **[Amended: F3]** Feature-flag cohorts are assigned by a stable hash of the key,
  so the 10% cohort is a subset of the 50% cohort. Any flag transition (percent
  change or on/off) empties the whole cache before the new value takes effect.

## Proposed wrapper integration
Keep the current read-through repository interface and shared adapters. The
original sketch proposed no coordination between a cache fill and a write; the
review found that this violates the read-after-write rule above (F1) and omits
the absent-record sentinel (F2). **[Amended: F1, F2, F3]** These are the complete
read/write ordering rules:

```javascript
// singleFlight entry: { promise, invalidated: boolean } keyed by cache key.
// markInvalidated(key) sets invalidated=true AND removes the entry from the map,
// so a miss arriving afterwards starts a new fill instead of joining a stale one.

async function readProfile(key) {
  if (!flag.enabledFor(key)) return repository.read(key);   // bypass while disabled
  const cached = cache.get(key);                             // undefined = miss
  if (cached === ABSENT) throw new ProfileNotFoundError(key); // existing typed error
  if (cached !== undefined) return cached;
  return singleFlight.run(key, async (entry) => {
    const value = await repository.read(key);   // typed errors propagate; nothing cached
    if (entry.invalidated) {                    // a write committed during this fill
      metrics.inc('profile_cache_fill_discarded_total');
      return value;                             // caller began before the write: allowed
    }
    if (value === null) cache.set(key, ABSENT, { ttlMs: 10_000 });
    else cache.set(key, value);                 // adapter default 30 s TTL, byte/entry caps
    return value;
  });
}

async function writeProfile(key, update) {
  const saved = await repository.write(key, update);  // on throw: no invalidation, cache kept
  if (flag.enabledFor(key)) {
    singleFlight.markInvalidated(key);                // detaches any in-flight fill
    cache.delete(key);
  }
  return saved;
}

flag.onChange(() => {                                 // any transition: percent or on/off
  cache.clear();                                      // adapter: reinitialize empty
  metrics.set('profile_cache_state', flag.enabled ? 'enabled' : 'disabled');
});
```

Assumption recorded (0E): `repository.read` resolves `null` for an absent record.
If it instead throws the existing typed not-found error, catch only that class in
the fill and store `ABSENT`; never catch any other class there.

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, and authorization. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, and concurrent-miss coalescing.
**[Amended: F1, F2, F3, F5]** They also cover the four ordering schedules S1–S4
below with controlled pause/release points on the repository mock, the absent
sentinel (10 s TTL, typed not-found on hit), cache clearing on every flag
transition including 50%→10%→50%, and viewer-invariance of the cached DTO.

The rollout uses the existing runtime feature flag: enable for 10% of keys,
then 50%, then all keys after one healthy hour at each stage. Monitor hit/miss,
eviction, cache bytes, fallback errors, DB CPU, and read p95 without raw IDs.
**[Amended: F6]** "Healthy" at a stage means, for the full hour: API error rate
within the existing SLO, read p95 not above the pre-rollout baseline, hit rate
for enabled keys at or above 40% (10%/50% stages) and 60% (100%), cache state
`enabled` throughout, and `profile_cache_fill_discarded_total` below 1% of fills.
Post-deploy checklist: first 5 minutes confirm state gauge `enabled`, hits
non-zero, fallback errors zero; first hour confirm the stage criteria above.
On error-rate or latency regression, disable the flag immediately; both reads
and writes bypass the cache while disabled, and enabling creates an empty cache.
Cold starts remain within the existing DB capacity. The service owner monitors
the rollout and records the results against the acceptance targets.

## Out of scope
Distributed caching, cross-process coherence, prewarming, changing consistency
semantics, or adding new product surfaces. The repository interface preserves a
future replacement path without introducing a general cache framework now.

---

# CEO Review Decision Record (HOLD SCOPE)

Run constraints: automated session, no human present. System audit, environment
setup, telemetry, codebase exploration, and all shell commands were skipped per
run rules. Every decision point auto-selected the recommended option. Findings
are grounded in the plan text only; file-level claims are marked as assumptions.

## Step 0 outcomes
- **0A Premise:** Real, measured pain (70% DB CPU, p95 120 ms, 900 hot keys). A
  process-local cache is the most direct path; doing nothing leaves the DB as the
  bottleneck. No reframing needed.
- **0B Leverage:** Reuses existing LRU adapter (caps, TTL, sentinel, bypass),
  single-flight wrapper, typed error mapping, runtime flag, contract tests.
  Nothing is rebuilt. Single-flight wrapper needs one small extension (F1).
- **0C Dream state:**
  ```
  CURRENT: every read hits DB      THIS PLAN: read-through LRU in process,     12-MONTH IDEAL: same repository
  70% CPU, p95 120 ms       --->   flag-gated, invariant-preserving      --->  interface, cache backend swappable
                                   (delta: wrapper + tests + metrics)          (distributed only if multi-process)
  ```
  The plan moves toward the ideal; the repository interface stays the seam.
- **0C-bis Alternatives (D1):**
  - A) Plan as sketched, no fill/write coordination. Effort S, Risk High.
    Completeness 4/10: fails the stated read-after-write rule (F1). Rejected.
  - B) Sketch plus fill invalidation via the single-flight entry. Effort S,
    Risk Low. Completeness 9/10. Reuses adapter and wrapper. **Recommended.**
  - C) Versioned DTOs with compare-and-set on fill. Effort M, Risk Med.
    Completeness 10/10 but needs a version field on every read path; more
    surface than the invariant requires. Not selected.
  - Decision: B, because it meets the requirement with the smallest diff and no
    new abstraction (engineered enough, explicit over clever).
- **0F Mode (D2):** HOLD SCOPE, set by the user. Refactor-class change; matches
  the context default. No expansions surfaced anywhere in this review.
- **0D HOLD analysis:** Touches roughly 3 files (wrapper, single-flight, tests)
  plus dashboard/alert config. No complexity smell. Minimum change set equals the
  accepted scope; nothing deferrable without breaking an acceptance target.
- **0E Temporal interrogation:** Two implementation ambiguities resolved now:
  absence signaling (null vs typed throw) recorded as an assumption under the
  sketch; flag cohort hashing must be stable and nested (folded into F3).

## Findings registry
Each finding recorded once. Sections cross-reference by ID.

| ID | Section | Severity | Evidence (plan text) | Remedy (accepted, auto-decided recommended) | Residual risk | Verification |
|----|---------|----------|----------------------|---------------------------------------------|---------------|--------------|
| F1 | 1, 4 | CRITICAL GAP | "no additional version checks or coordination between a cache fill and a write are proposed" vs "Every read begun after that write completes must observe the committed version" | Fill invalidation: successful write marks and detaches in-flight fill; late fill skips `cache.set`; new misses start fresh fill. Metric `profile_cache_fill_discarded_total`. D3 | Discards a few fills under heavy write bursts; bounded by metric | Schedules S1–S4 with paused repository mock; assert R2 observes v2 and cache never holds v1 after W resolves |
| F2 | 2 | WARNING | Sketch does `cache.set(key, value)` with no absence mapping while contract requires "distinct sentinel with a 10-second TTL" | Map `null` to `ABSENT` with 10 s TTL; hit on `ABSENT` throws existing typed not-found; errors cache nothing. D4 | Assumption on null-vs-throw; recorded | Test: absent read caches sentinel, second read throws typed error without DB call; sentinel expires at 10 s |
| F3 | 4 | CRITICAL GAP | Per-key flag with "writes bypass the cache while disabled"; cohort shrink 50%→10% leaves entries for dropped keys, later writes skip delete, re-expansion serves stale | `cache.clear()` on every flag transition; stable nested hash cohorts. D5 | Each transition causes a cold-start burst; already within DB capacity | Test: cache K at 50%, drop to 10%, write K, raise to 50%, read K returns new version |
| F4 | 8 | WARNING | "bypasses the cache until an empty cache is reinitialized" with no log, metric, or alert; bypass would look like a silent regression to 70% CPU | `profile_cache_state` gauge (disabled/enabled/bypassed), structured log on transition, alert on bypassed > 60 s, fill-discard counter, dashboard panel, runbook entry. D6 | None material | Test: injected adapter fault flips gauge and emits one log line without raw key |
| F5 | 3 | LOW (verify) | "Cached results cannot bypass authorization" is asserted, not tested; a viewer-dependent DTO field would leak across roles in one tenant | Contract test asserting DTO equality across two authorized viewers with different roles; if it fails, key gets viewer role. D7 | None if test passes | Test in existing contract suite |
| F6 | 9 | WARNING | "one healthy hour" undefined; no post-deploy checklist | Stage health criteria and 5-minute/1-hour checklist written into the plan. D8 | Thresholds may need tuning after the 10% stage | Owner records metrics against criteria per stage |

## Section outcomes
1. **Architecture:** 1 issue, F1. Diagram: System architecture (below). Coupling
   added: wrapper to single-flight entry state, justified by the invariant. SPOF:
   the single process, unchanged. 10x load: LRU eviction churn first, then DB;
   100x: single-flight map growth bounded by concurrency. Rollback: flag off in
   seconds, git revert as backstop.
2. **Error and rescue map:** 9 paths mapped, 1 gap (F2). Registry below. No
   catch-all handling proposed; only the typed not-found class may be caught in
   the fill.
3. **Security:** 1 low finding, 0 high (F5). No new endpoints, inputs, secrets,
   or dependencies. Keys already validated; memory bounded by adapter caps; no
   raw IDs in logs. Injection vectors: none new.
4. **Data flow and interaction edge cases:** 2 unhandled found (F1 confirmed by
   schedule, F3). No UI interactions. Diagrams: data flow shadow paths and
   async schedule below.
5. **Code quality:** No new issues. The amended sketch routes misses through the
   existing single-flight wrapper (F1); naming follows existing adapter terms.
   Branch count in `readProfile` is 5; no refactor needed.
6. **Tests:** Diagram below; 4 gaps (F1, F2, F3, F5), all closed by tasks T1–T5.
   Pyramid: unit-heavy, one integration run per stage, no E2E. Flakiness: TTL
   tests must use a fake clock; ordering tests must use explicit deferreds, not
   timers. 2am test: schedule S1. Hostile QA test: S3 (late joiner after
   invalidation). Chaos test: adapter fault mid-fill flips to bypass with reads
   still served from DB.
7. **Performance:** No issues. Residual risk R1: 30 s TTL over 900 keys sets a
   floor of about 30 DB reads/s; the 60% hit target depends on read rate and is
   verified at the 10% stage under F6 criteria. No new connections or indexes.
8. **Observability:** 1 gap (F4). Metrics in scope: hits, misses, evictions,
   bytes, fill discards, state gauge, fallback errors, DB CPU, read p95.
9. **Deployment:** 1 risk (F6). No migrations. Flag-gated; old/new code never
   coexist in one process. Rollback and deployment diagrams below.
10. **Long-term trajectory:** Reversibility 5/5. Debt: 1 item, an ASCII ordering
    diagram in the wrapper source must be maintained (T7). Path dependency: none;
    repository interface remains the seam. A new engineer in 12 months can read
    the invariant and schedule from the plan.
11. **Design and UX:** SKIPPED, justified: no UI, API, or user-visible surface.

## Outside voice
Skipped. `.gstack-section-state-XrV3i5/config.yaml` sets `codex_reviews: disabled`.
Per the documented control, no outside CLI and no native subagent fallback were
run. Outside coverage: **disabled**. The disabled review-log record was not
persisted because shell commands were excluded from this run.

## NOT in scope
- Distributed or cross-process cache: unsupported configuration, startup rejects it.
- Prewarming: cold starts fit existing DB capacity.
- Versioned DTO compare-and-set (Approach C): more surface than the invariant needs.
- General cache framework: interface seam already preserves replacement.
- Always-invalidate-on-write while flag disabled: would change a stated contract; clear-on-transition (F3) meets the invariant without that.

## What already exists
- LRU adapter with entry/byte caps, TTL, absent sentinel, bypass-on-fault: reused.
- Per-key single-flight wrapper: reused, extended with `markInvalidated` (F1).
- Typed repository error mapping: reused unchanged.
- Runtime per-key feature flag: reused, gains an `onChange` hook consumer (F3).
- Repository contract tests: reused, gain one viewer-invariance case (F5).

## Dream state delta
After this plan the service reads hot summaries from process memory behind the
unchanged repository interface, with the read-after-write rule enforced and
observable. The remaining gap to the 12-month ideal is only a swappable backend
if the service ever goes multi-process; nothing in this plan blocks that.

## Error and rescue registry (Section 2)
| Method / codepath | What can go wrong | Exception class | Rescued? | Rescue action | User sees |
|-------------------|-------------------|-----------------|----------|---------------|-----------|
| readProfile: cache.get | adapter internal fault | adapter-internal error | Y (adapter) | bypass, gauge=bypassed, log, alert (F4) | nothing; latency rises |
| readProfile: repository.read | DB timeout / pool exhausted | existing typed repository errors | Y (existing mapping) | propagate typed error; single-flight releases; nothing cached | existing error response |
| readProfile: repository.read | record absent | null or existing typed not-found | Y | cache ABSENT 10 s; hit throws typed not-found (F2) | existing not-found response |
| readProfile: cache.set | value over byte cap / eviction | adapter reject | Y (adapter) | skip store, eviction metric | nothing |
| readProfile: fill invalidated | write committed mid-fill | not an error | Y | skip set, discard metric (F1) | fresh value on next read |
| writeProfile: repository.write | write fails | existing typed repository errors | Y (existing) | no invalidation; cache preserved | existing error response |
| writeProfile: cache.delete | adapter fault | adapter-internal error | Y (adapter) | bypass, gauge, log (F4) | nothing |
| flag.onChange: cache.clear | adapter fault | adapter-internal error | Y (adapter) | bypass, gauge, log (F4) | nothing |
| startup | multi-process with cache on | existing configuration error | Y (existing) | process refuses to start | operator sees startup failure |

No catch-all handlers. 0 unrescued gaps after F2 and F4.

## Failure modes registry
| Codepath | Failure mode | Rescued? | Test? | User sees? | Logged? |
|----------|--------------|----------|-------|------------|---------|
| fill vs write | late fill stores pre-write snapshot | Y (F1) | Y S1–S3 | fresh data | metric |
| flag cohort | stale entry after 50→10→50 | Y (F3) | Y | fresh data | log on clear |
| absent record | null cached for 30 s or never cached | Y (F2) | Y | not-found | no |
| adapter fault | silent bypass, CPU regresses | Y (F4) | Y | nothing | log+alert |
| DB error on fill | error cached or fill stuck | Y (existing release) | Y existing | typed error | existing |
| failed write | cache wrongly invalidated | Y | Y existing | consistent | no |
| viewer-dependent DTO | cross-role field leak | Y (F5 test) | Y | correct fields | n/a |
| eviction churn at 10x | hit rate drops | Y (adapter) | Y limits | latency | metric |

CRITICAL GAPS remaining: 0 (F1 and F3 closed by accepted remedies).

## TODOS.md updates
0 items proposed. Every evidenced gap is remedied inside the accepted scope; no
deferred correctness or operability gap remains. No expansions surfaced (HOLD).

## Scope expansion decisions
Not applicable (HOLD SCOPE): 0 proposed, 0 accepted, 0 deferred.

## Diagrams

### 1. System architecture
```
  request ──▶ authn/authz ──▶ readProfile / writeProfile (wrapper)
                                  │            │
                     flag.enabledFor(key)      │ singleFlight.markInvalidated + cache.delete
                                  │            ▼
                    cache.get ◀── LRU adapter (1000 entries / 16 MiB / 30 s, ABSENT 10 s)
                                  │      ▲
                             miss ▼      │ set (only if fill not invalidated)
                    singleFlight[key] ── repository.read/write ──▶ DB (single writer process)
  flag.onChange ──▶ cache.clear + state gauge      metrics/logs ──▶ dashboard + alerts
```

### 2. Data flow with shadow paths
```
  key ──▶ flag check ──▶ cache.get ──▶ singleFlight ──▶ repository.read ──▶ cache.set ──▶ DTO
   │          │             │              │                 │                 │
  nil/invalid │         undefined=miss   join or start     null → ABSENT     invalidated → skip
  rejected    │         ABSENT → 404     (never join a     typed error →      over cap → skip
  upstream    │         hit → return      detached fill)   release, no set    adapter fault → bypass
  (existing)  disabled → DB direct
```

### 3. State machines
```
  cache:  disabled ──flag on──▶ enabled(empty) ──▶ serving ──adapter fault──▶ bypassed
             ▲                       ▲                │                          │
             └──flag off (clear)─────┴── any flag transition (clear) ◀──────────┘
  entry:  miss ──start fill──▶ filling ──resolve──▶ cached | ABSENT ──TTL/evict/delete──▶ miss
                                 │ write resolves
                                 ▼
                             invalidated (detached) ──resolve──▶ discarded (no set)
  Invalid transitions prevented: cached→cached without delete on write (F1 marks + deletes);
  new miss joining an invalidated fill (detach removes it from the map).
```

### 4. Async ordering schedule (Section 4, F1)
```
  t | R1 (began before W)        | W (write v2)                      | R2 (began after W)      | cache | singleFlight
  1 | get → undefined            |                                   |                         | -     | -
  2 | start fill E1; await read  |                                   |                         | -     | E1
  3 |                            | await repository.write → commit   |                         | -     | E1
  4 |                            | resolve; mark E1 invalid; detach; |                         | -     | -
    |                            | cache.delete                      |                         |       |
  5 |                            |                                   | get → undefined; fill E2| -     | E2
  6 | read resolves v1           |                                   |                         | -     | E2
  7 | E1.invalidated → no set;   |                                   |                         | -     | E2
    | return v1 (allowed)        |                                   |                         |       |
  8 |                            |                                   | read resolves v2; set   | v2    | -
  S1 = above. S2: R1 resolves before W resolves → set v1 at t3, W deletes at t4, R2 misses → v2.
  S3: R3 arrives at t5 → must start E2, never join E1 (detach is the mechanism).
  S4: W rejects → no mark, no delete; cached value preserved.
  Without the remedy, line 7 stores v1 and R2 reads v1: violates the invariant.
```

### 5. Error flow
```
  repository.read throws ──▶ singleFlight releases ──▶ nothing cached ──▶ typed error to caller
  adapter throws (get/set/delete/clear) ──▶ adapter enters bypass ──▶ gauge=bypassed, log, alert
                                         ──▶ reads go to DB ──▶ reinit on next flag transition
```

### 6. Deployment sequence
```
  deploy code (flag off, no cache) ──▶ smoke: state gauge=disabled, reads OK
  ──▶ flag 10% ──▶ 5-min checks ──▶ 1 healthy hour (F6) ──▶ flag 50% ──▶ same ──▶ flag 100% ──▶ same
  each transition: cache.clear, cold fills within DB capacity
```

### 7. Rollback flowchart
```
  regression seen? ──yes──▶ flag off (seconds) ──▶ cache cleared, reads/writes bypass ──▶ verify p95/errors
        │                                                                         │
        no                                                              still bad? ──▶ git revert + redeploy
        ▼
  continue stage
```

### Stale diagram audit
Codebase exploration was skipped in this run, so existing ASCII diagrams in the
touched files could not be enumerated. T7 adds the ordering diagram to the
wrapper source and requires checking any existing adapter or wrapper diagrams at
implementation time.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~3h / CC: ~20min)** — wrapper + single-flight — Add fill invalidation: `markInvalidated(key)` sets flag and detaches entry; fill skips `cache.set` when invalidated; increment discard metric
  - Surfaced by: Section 1 / Section 4 — F1
  - Files: repository cache wrapper, single-flight wrapper, wrapper tests
  - Verify: schedules S1–S4 with deferred repository mock; assert R2 sees v2 and cache never holds v1 after W resolves
- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — wrapper — Map absent record to `ABSENT` with 10 s TTL; hit on `ABSENT` throws existing typed not-found; errors cache nothing
  - Surfaced by: Section 2 — F2
  - Files: repository cache wrapper, wrapper tests
  - Verify: absent read caches sentinel; second read throws without DB call; sentinel expires at 10 s under fake clock
- [ ] **T3 (P1, human: ~1h / CC: ~10min)** — flag integration — `cache.clear()` on every flag transition; stable nested hash cohorts
  - Surfaced by: Section 4 — F3
  - Files: wrapper flag hook, flag cohort helper, tests
  - Verify: 50%→10%→50% sequence returns fresh value; 10% cohort is a subset of 50% cohort
- [ ] **T4 (P1, human: ~2h / CC: ~15min)** — observability — State gauge, transition log, bypass alert (>60 s), fill-discard counter, dashboard panel, runbook entry
  - Surfaced by: Section 8 — F4
  - Files: wrapper metrics, alert config, dashboard config, runbook doc
  - Verify: injected adapter fault flips gauge and emits one log line with no raw key; alert rule test fires at 61 s
- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — contract tests — Assert cached DTO equality across two authorized viewers with different roles
  - Surfaced by: Section 3 — F5
  - Files: repository contract tests
  - Verify: test passes; if it fails, stop and encode viewer role in the key before rollout
- [ ] **T6 (P2, human: ~30min / CC: ~5min)** — rollout doc — Record stage health criteria and 5-minute/1-hour checklist (already written into the plan) in the runbook
  - Surfaced by: Section 9 — F6
  - Files: runbook doc
  - Verify: owner signs each stage against the criteria
- [ ] **T7 (P3, human: ~20min / CC: ~3min)** — wrapper source — Add the ordering schedule as an ASCII comment; audit any existing adapter/wrapper diagrams
  - Surfaced by: Section 10 — debt item; Stale diagram audit
  - Files: repository cache wrapper
  - Verify: diagram matches T1 behavior at code review

_No new tasks from Section 5, Section 7, Section 11._

Tasks JSONL artifact: not written (shell commands excluded from this run; `jq` path unavailable).

## Completion Summary
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | HOLD SCOPE (user-specified)                 |
  | System Audit         | SKIPPED per run rules (no shell/codebase)   |
  | Step 0               | Approach B (fill invalidation); 2 ambiguities resolved |
  | Section 1  (Arch)    | 1 issue found (F1)                          |
  | Section 2  (Errors)  | 9 error paths mapped, 1 GAP (F2), 0 open    |
  | Section 3  (Security)| 1 issue found (F5), 0 High severity         |
  | Section 4  (Data/UX) | 8 edge cases mapped, 2 unhandled (F1, F3), 0 open |
  | Section 5  (Quality) | 0 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 4 gaps (closed by T1–T5)  |
  | Section 7  (Perf)    | 0 issues found, 1 residual risk (R1)        |
  | Section 8  (Observ)  | 1 gap found (F4)                            |
  | Section 9  (Deploy)  | 1 risk flagged (F6)                         |
  | Section 10 (Future)  | Reversibility: 5/5, debt items: 1 (T7)      |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 9 methods, 0 CRITICAL GAPS                  |
  | Failure modes        | 8 total, 0 CRITICAL GAPS (2 found, 2 closed)|
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 0 proposed, 0 accepted (HOLD)               |
  | CEO plan             | skipped (HOLD)                              |
  | Outside voice        | codex: disabled (config), no fallback run   |
  | Lake Score           | 6/6 recommendations chose complete option   |
  | Diagrams produced    | 7 (architecture, data flow, state machine,  |
  |                      | async schedule, error flow, deploy, rollback)|
  | Stale diagrams found | 0 enumerated (audit deferred to T7)         |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```

Decisions auto-selected (recommended option, no human present): D1 approach B;
D2 mode HOLD SCOPE (user-specified); D3 F1 remedy; D4 F2 remedy; D5 F3 remedy;
D6 F4 remedy; D7 F5 remedy; D8 F6 remedy; D9 next step: run `/plan-eng-review`.
Review log, decision log, learnings log, telemetry, and handoff cleanup were not
run (shell excluded). No durable learnings this session beyond the plan record.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | mode: HOLD_SCOPE, 0 critical gaps open (6 findings, 6 remedied) |
| Outside Review | codex via `/plan-ceo-review` | Independent 2nd opinion | 0 | disabled | none (codex_reviews disabled) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** provider codex, phase plan-review, disabled by `codex_reviews: disabled`; no native fallback run; no findings.

**VERDICT:** CEO CLEARED — eng review required

NO UNRESOLVED DECISIONS
