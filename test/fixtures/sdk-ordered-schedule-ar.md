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
Keep the current read-through repository interface and shared adapters.

> **Amended by CEO review (D3, D4, D5).** The original sketch below is retained
> for the record. It stated that no coordination between a cache fill and a
> write was proposed; the review found that this violates the retained
> read-after-write contract (finding F1). The accepted replacement sketch
> follows it. See "Plan amendments" for the full list.

Original sketch (superseded):

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

Accepted sketch (D3 fill token + per-call flag capture, D4 invalidate on every
write outcome, D5 explicit sentinel mapping):

```javascript
// Ordering rule: a fill may land only if no write to the same key committed
// while the DB read was in flight. See the schedule diagram in the review.
async function readProfile(key) {
  if (!flag.enabledFor(key)) return repository.read(key);   // decided once per call
  const cached = cache.get(key);
  if (cached !== undefined) return cached === ABSENT ? null : cached;
  return singleFlight.run(key, async (token) => {           // token issued per in-flight miss
    const value = await repository.read(key);
    if (token.isCurrent()) {                                  // false if a write committed meanwhile
      if (value === null) cache.set(key, ABSENT, { ttlMs: 10_000 });
      else cache.set(key, value);                              // default 30 s TTL
    } else metrics.increment('profile_cache.fill_skipped_stale');
    return value;
  });
}

async function writeProfile(key, update) {
  try {
    return await repository.write(key, update);
  } finally {
    if (flag.enabledFor(key)) {                               // same predicate as the read path
      singleFlight.invalidateTokens(key);                     // in-flight fills for key become stale
      cache.delete(key);                                      // runs on success AND failure (F2)
    }
  }
}
```

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, and authorization. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write invalidation (amended from "preservation", D4),
concurrent-miss coalescing, and the additional tests listed under
"Plan amendments".
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

## Plan amendments (accepted in CEO review, 2026-09-10)
Each amendment maps to one finding in the Findings register below. Original
requirements are unchanged; every amendment repairs an implementation gap
against a retained contract or adds required operability.

1. **A1 (F1 / D3)** Fill token in the existing single-flight registry. A write
   commit invalidates the token of any in-flight miss for that key, so a late
   fill with a pre-write snapshot is skipped and counted. The feature-flag
   decision is captured once per call, so a call that started in bypass never
   fills the cache. The ordering rule and schedule diagram go in a code comment
   next to the guard.
2. **A2 (F2 / D4)** Invalidate the key and its fill tokens on every write
   outcome, including thrown errors, because an ack-lost write may have
   committed. The planned "failed-write preservation" test becomes
   "failed-write invalidation".
3. **A3 (F3 / D5)** The wrapper owns the absent-record mapping: repository
   `null` is stored as the ABSENT sentinel with a 10 s TTL and returned to the
   caller as `null`. `undefined` is never stored.
4. **A4 (F4 / D6)** Deploy rule: the flag is off during any deploy and is
   enabled only after the new process is the sole instance. The service owner
   confirms the deploy strategy has no old/new overlap and records it in the
   runbook. Startup rejection stays as the configuration guard.
5. **A5 (F5 / D7)** Day-1 observability: a bypass-state gauge, a
   `fill_skipped_stale` counter, and three alerts (bypass active over 5 min,
   hit ratio under 60% for 15 min after full rollout, DB CPU over 50% for
   15 min). Runbook entry: bypass active means inspect fallback-error logs,
   then toggle the flag off and on to reinitialize.
6. **A6 (F6 / D8)** One shared, deterministic key-enablement predicate for the
   read and write paths, with a test that a write to an enabled key invalidates
   and a write to a disabled key touches no cache state.
7. **Stated assumption S1.** Repository reads and writes hit the same primary
   with read-after-write visibility. If a read replica is in the path, the
   cache would extend replica lag to 30 s and S1 must be revisited before the
   10% stage.

## CEO Review — HOLD SCOPE — 2026-09-10

Reviewer: Claude (Fable 5.1) via `/plan-ceo-review`. Mode fixed by the user:
HOLD SCOPE. No expansions surfaced. Run constraints honored: system audit,
environment setup, telemetry, codebase exploration, and all git/gh commands
skipped; no shell was available, so review-log, decision-log, task JSONL, and
dashboard commands were not executed (see Process notes).

### Step 0 outcomes
- **0A Premise.** Right problem. The pain is measured (70% DB CPU, p95 120 ms,
  900 hot keys), and a local read-through cache is the most direct path to the
  three acceptance targets. Doing nothing leaves the DB near saturation.
- **0B Existing leverage.** The plan reuses the LRU adapter, single-flight
  wrapper, runtime flag, and contract tests. Nothing is rebuilt. The fill token
  (A1) is added to the existing single-flight registry rather than a new map.
- **0C Dream state.**
  ```
  CURRENT: 1 process, no cache    THIS PLAN: local LRU behind the       12-MONTH IDEAL: same repo interface,
  DB CPU 70%, p95 120 ms   --->   repo interface, flagged rollout  ---> coherent cache if multi-process arrives
  ```
  Moves toward the ideal: the interface boundary is the future swap point.
- **0C-bis Alternatives (D1).** A) Wrapper at the repository layer (as
  planned). Effort S, risk Low, completeness 10/10. B) Handler-level response
  memoization. Effort S, risk Med, completeness 6/10: bypasses the repository
  contract tests and duplicates invalidation. C) DB-side materialized summary
  or query cache. Effort XL, risk Med, completeness 9/10 but is a schema change
  the scope excludes. **Chosen: A** (reuse ladder rung 1, smallest correct diff).
- **0F Mode (D2).** HOLD SCOPE, set by the user. Kind-not-coverage decision.
- **0D Complexity.** Two files touched (wrapper, tests) plus metrics and
  runbook. No new classes. Minimum change set equals the accepted sketch.
- **0E Temporal interrogation.** Hour 1: where the sentinel mapping lives
  (F3). Hour 2-3: the fill/write ordering (F1) and write-failure semantics
  (F2). Hour 4-5: the deploy overlap window (F4) and predicate sharing (F6).
  Hour 6+: alerts and runbook (F5). All resolved below. Human ~6 h, CC ~45 min.

### Decision register (all auto-chosen: recommended option, no human present)
| ID | Decision | Chosen | Completeness |
|----|----------|--------|--------------|
| D1 | Implementation approach | A: repository-layer wrapper | A 10, B 6, C 9 |
| D2 | Review mode | HOLD SCOPE (user-set) | kind, not coverage |
| D3 | F1 remedy | A: fill token + per-call flag capture + ordering test | A 10, B 4 (global counter, starves fills), C 2 (accept stale, violates contract) |
| D4 | F2 remedy | A: invalidate on every write outcome | A 10, B 5 (keep preservation) |
| D5 | F3 remedy | A: wrapper maps null to ABSENT with 10 s TTL | A 10, B 6 (rely on adapter) |
| D6 | F4 remedy | A: flag off during deploys, sole-instance rule | A 10, B 5 (document only) |
| D7 | F5 remedy | A: gauge, counter, 3 alerts, runbook entry | A 10, B 6 (dashboards only) |
| D8 | F6 remedy | A: shared predicate + tests | A 10, B 7 (code review only) |

### Findings register
Severity: CRITICAL GAP / WARNING. Each finding is recorded once; sections
cross-reference by ID.

| ID | Sev | Finding and evidence | Accepted remedy | Residual risk | Verification |
|----|-----|----------------------|-----------------|---------------|--------------|
| F1 | CRITICAL GAP | Original sketch fills the cache after `await repository.read` with no coordination. Schedule: read misses, write commits and deletes (no-op), read resolves and stores the pre-write snapshot. A later read hits the stale value for up to 30 s, violating the retained contract "every read begun after that write completes must observe the committed version". The plan text explicitly proposed no such check. Flag flip mid-read has the same shape. | A1 | A skipped fill costs one extra DB read for that key. | Ordering test with controlled pause/release for both completion orders; flag-flip test; `fill_skipped_stale` counter observed in test. |
| F2 | WARNING | `writeProfile` deletes only on success. A write that commits but whose ack is lost or times out leaves the old value cached up to 30 s. "Failed-write preservation" would lock this in. | A2 | A failed pre-commit write evicts a good entry: one extra miss. | Test: write rejects after commit stub, next read hits DB. |
| F3 | WARNING | `cache.set(key, value)` has no TTL argument and does not map `null`. Storing `undefined` or `null` either defeats negative caching silently or caches nothing. Contract needs a 10 s sentinel. | A3 | None material. | Test: second read of an absent key within 10 s makes no DB call; create then read returns the record. |
| F4 | WARNING | Startup rejects a multi-process configuration, but a rolling deploy creates a transient two-process window that no configuration check sees. Old process caches, new process writes: coherence breaks. | A4 | Relies on an operational rule; the runbook is the control. | Owner records deploy strategy; rollout checklist gates enabling on sole-instance confirmation. |
| F5 | WARNING | Adapter bypass after a cache failure is silent to operators: the plan lists metrics to monitor but no alert, no bypass gauge, no reinit procedure. Hit rate can drop to zero and DB CPU return to 70% with no page. | A5 | Alert tuning may need one iteration. | Alerts exist before the 10% stage; bypass gauge flips in the adapter-failure test. |
| F6 | WARNING | Percentage rollout is per key. If the write path evaluates enablement differently from the read path, writes to enabled keys never invalidate. | A6 | None material. | Predicate unit test plus write-then-read test across enabled and disabled keys. |

### Section outcomes
1. **Architecture.** F1 (CRITICAL GAP, remedied A1), assumption S1. Coupling
   added: wrapper to flag and to LRU, justified by the flagged rollout. Single
   point of failure is the one process, unchanged. 10x load: hot set exceeds
   1000 entries and hit rate falls to baseline behavior; caught by the A5 hit
   ratio alert. Rollback: flag off, seconds. Diagrams in "Diagrams".
2. **Error and rescue map.** F2 (remedied A2). Registry below. No catch-all
   handlers introduced; repository errors keep typed mapping. 0 open gaps.
3. **Security and threat model.** No issues found. No new endpoint, input, or
   dependency. Keys carry tenant and profile ID; authorization precedes the
   repository; values are immutable DTOs; keys and values are never logged.
   Threats assessed: cross-tenant read via key collision (Low/High, mitigated
   by unambiguous key encoding and existing tenant-isolation tests); cache
   poisoning (Low/High, writes are authorized and go through the repository);
   eviction flooding by probing absent IDs (Med/Low, bounded by 10 s TTL and
   LRU, each miss costs no more than today).
4. **Data flow and interaction edge cases.** F1 schedule, F3 shadow paths.
   No user-visible interaction; interaction table not applicable. Shadow paths
   diagrammed in "Diagrams". 8 edge cases mapped, 0 unhandled after remedies.
5. **Code quality.** No independent issues. Sketch fits the existing
   read-through pattern; no duplication of adapter logic; names describe
   behavior. Cross-references F1, F3.
6. **Tests.** Diagram in "Diagrams". 6 gaps, all covered by the accepted
   remedies' verification column. Flakiness: TTL tests use a fake clock;
   ordering tests use explicit deferred promises, never timers. 2 am test: the
   two-order schedule test. Hostile QA: write during a coalesced miss with
   three waiting readers. Chaos: adapter throws on `set` mid-fill and bypass
   gauge flips. Pyramid: unit-heavy, one integration test per rollout stage.
7. **Performance.** No issues found. Memory bounded at 16 MiB; no new
   connections; single-flight prevents stampede; cold start equals today's
   load. Headroom of 1000 entries over 900 hot keys is thin but is future
   capacity, not a HOLD SCOPE gap; the A5 hit-ratio alert makes it visible.
8. **Observability.** F5 (remedied A5). Existing metrics list retained.
   Debuggability: `fill_skipped_stale` and the bypass gauge reconstruct the
   two silent failure classes from metrics alone.
9. **Deployment and rollout.** F4, F6 (remedied A4, A6). No migration.
   Rollout stages retained. Post-deploy checks: first 5 min hit ratio rising,
   bypass gauge false, error rate flat; first hour DB CPU trend and p95.
10. **Long-term trajectory.** No independent issues. Reversibility 5/5 (flag
    plus one wrapper). Debt: the ordering comment (A1) is the only
    documentation added and is required. Interface preserves the future
    multi-process swap.
11. **Design and UX.** SKIPPED, justified: the plan states no UI, API, or
    product surface change and none was found.

### Outside voice
Codex review skipped (codex_reviews disabled in the isolated config).
Outside coverage: provider codex, phase plan-review, status disabled. No native
fallback dispatched, as the disabled branch requires. Re-enable:
`gstack-config set codex_reviews enabled`. The guarded review-log record for the
disabled status could not be written (no shell in this run).

## NOT in scope
- Distributed or cross-process cache: plan non-goal, deferred by the user.
- Prewarming: plan non-goal; cold start is within DB capacity.
- Consistency-semantics changes: plan non-goal; F1 repairs to the existing rule.
- Capacity growth beyond 1000 entries: hypothetical, not an evidenced gap.
- Read-replica handling: recorded as assumption S1, not built.

## What already exists
| Existing piece | Reused? |
|----------------|---------|
| LRU adapter (1000 / 16 MiB / 30 s, sentinel 10 s, bypass on failure) | Yes, unchanged |
| Per-key single-flight wrapper | Yes, extended with fill tokens (A1) |
| Runtime feature flag with per-key percentage | Yes, predicate shared (A6) |
| Repository contract tests | Yes, unchanged |
| Typed API error mapping | Yes, unchanged |
| Metrics pipeline | Yes, new series added (A5) |

## Dream state delta
This plan lands the cache behind the repository interface, which is the seam a
future coherent or distributed cache would replace. It adds no framework and no
consistency change, so the 12-month ideal remains reachable without unwinding
anything shipped here.

## Error & Rescue Registry
| Method | What can go wrong | Error class | Rescued | Action | Caller sees |
|--------|-------------------|-------------|---------|--------|-------------|
| readProfile | adapter `get`/`set` throws | adapter CacheError | Y | adapter bypass, gauge on, log with key hash | correct data, slower |
| readProfile | `repository.read` throws | existing typed repo errors | Y | single-flight releases, no fill | existing typed API error |
| readProfile | write committed during read | none (logic) | Y (A1) | skip fill, counter | own snapshot; later reads fresh |
| readProfile | oversize value | adapter reject | Y | counted no-op set | correct data, no cache |
| writeProfile | `repository.write` throws before commit | existing typed repo errors | Y (A2) | invalidate anyway | existing typed API error |
| writeProfile | ack lost after commit | timeout error | Y (A2) | invalidate anyway | existing timeout error |
| writeProfile | `cache.delete` throws | adapter CacheError | Y | adapter bypass, gauge on | write succeeded |
| startup | multi-process config with cache on | existing config error | Y | process refuses to start, logged | deploy fails loudly |
| flag lookup | flag service unavailable | existing flag error | Y | existing default: disabled (bypass) | slower, correct |

## Failure Modes Registry
| Codepath | Failure mode | Rescued | Test | Caller sees | Logged |
|----------|--------------|---------|------|-------------|--------|
| read fill | stale fill after write (F1) | Y (A1) | Y | fresh on next read | counter |
| read | adapter failure | Y | Y | transparent | log + gauge |
| read | DB error | Y | Y | typed error | existing |
| read | absent record | Y (A3) | Y | null | no |
| write | failed after commit (F2) | Y (A2) | Y | typed error | existing |
| write | predicate mismatch (F6) | Y (A6) | Y | fresh | n/a |
| rollout | deploy overlap (F4) | Y (A4) | checklist | none | runbook |
| ops | silent bypass (F5) | Y (A5) | Y | none | alert |

0 rows with Rescued=N and Test=N and silent. 0 CRITICAL GAPS remaining
(1 found, F1, remedied).

## TODOS.md updates
0 items proposed. Every evidenced gap was repaired in scope; remaining
candidates (capacity headroom, replica handling) are hypothetical or
assumptions, which HOLD SCOPE does not surface as TODOs.

## Diagrams
System architecture:
```
  Caller (authn/authz done)
        │
        ▼
  ProfileRepository facade ── readProfile / writeProfile (NEW wrapper)
        ├──▶ FeatureFlag (existing, per-key %, one predicate)        [A6]
        ├──▶ SingleFlight (existing) + fill tokens                    [A1]
        ├──▶ LRU adapter (existing: 1000 / 16 MiB / 30 s, ABSENT 10 s)[A3]
        └──▶ repository.read / write ──▶ primary DB (assumption S1)
  Metrics: hit, miss, evict, bytes, fallback, bypass gauge, fill_skipped_stale [A5]
```
Dependency before / after:
```
  BEFORE: Caller ─▶ Repository ─▶ DB
  AFTER:  Caller ─▶ Wrapper ─▶ {Flag, SingleFlight, LRU} and Repository ─▶ DB
```
Read data flow with shadow paths:
```
  key ─▶ flag? ─no─▶ repository.read ─▶ return
         │yes
         ▼
  cache.get ─hit─▶ ABSENT? ─▶ null | value
         │miss
         ▼
  singleFlight(token) ─▶ repository.read ─▶ token current? ─yes─▶ set (null→ABSENT 10 s) ─▶ return
                              │ throws                │ no
                              ▼                        ▼
                     release, typed error       skip set, count, return
  nil key:   rejected by existing validation upstream, never reaches wrapper
  empty:     repository null → ABSENT sentinel → caller null
  error:     no fill, single-flight released, typed API error
```
Async schedule for F1 (columns: read R1, write W1, cache[key]):
```
  t1 R1 get→miss, token τ1        |                                  | —
  t2 R1 await read (snapshot v1)  |                                  | —
  t3                              | W1 await write → v2 committed    | —
  t4                              | W1 invalidate τ1, delete (no-op) | —      W1 completes
  t5 R1 read resolves v1          |                                  | —
  t6 SKETCH: set v1               |                                  | v1     R2 after t4 → v1  ✗
  t6 A1: τ1 stale → skip          |                                  | —      R2 after t4 → DB v2 ✓
  Alternate order: R1 sets v1 before W1 commits; W1's delete removes it ✓
  Single-thread atomicity does not prevent this interleaving; the token does.
```
Cache entry state machine:
```
  EMPTY ──miss, DB value, token ok──▶ FRESH(v, 30 s) ──TTL | evict | write──▶ EMPTY
  EMPTY ──miss, DB null,  token ok──▶ NEG(ABSENT, 10 s) ──TTL | evict | write──▶ EMPTY
  EMPTY ──miss, token stale──▶ EMPTY
  Impossible: FRESH(v_old) after a completed write. Prevented by delete-after-commit
  plus token invalidation (A1, A2).
```
Cache instance states:
```
  DISABLED ──flag on──▶ ENABLED(empty) ──adapter error──▶ BYPASS(gauge=1)
  ENABLED ──flag off──▶ DISABLED        BYPASS ──flag off, flag on──▶ ENABLED(empty)
```
Error flow:
```
  adapter error ─▶ bypass + gauge + log ─▶ alert if >5 min ─▶ runbook: toggle flag
  repo error    ─▶ existing typed mapping ─▶ caller; write path still invalidates
```
Deployment sequence:
```
  1 merge wrapper (flag off) ─▶ 2 deploy, confirm sole instance ─▶ 3 verify alerts live
  ─▶ 4 flag 10% (1 h healthy) ─▶ 5 flag 50% (1 h) ─▶ 6 flag 100% ─▶ 7 record targets
```
Rollback flowchart:
```
  regression seen? ─yes─▶ flag off (seconds) ─▶ reads/writes bypass ─▶ investigate
        │no                                     └─ re-enable creates empty cache
        ▼
  continue stage
```
Test diagram:
```
  NEW UX FLOWS: none
  NEW DATA FLOWS: read-through fill; write invalidate; negative cache
  NEW CODEPATHS: hit; miss+fill; miss+stale-token skip; write ok+delete;
                 write fail+delete; adapter error→bypass; flag off bypass;
                 shared predicate; startup rejection
  NEW ASYNC WORK: none (single-flight existing)
  NEW INTEGRATIONS: none
  NEW ERROR PATHS: see Error & Rescue Registry
```

## Stale Diagram Audit
Not performed: codebase exploration was skipped by run rules, so existing
diagrams in touched files were not inspected. The implementer must check the
repository and single-flight files for existing ASCII comments and update them
alongside A1.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~3h / CC: ~20min)** — repository wrapper — Add fill tokens to single-flight, capture flag once per call, write ordering comment
  - Surfaced by: Section 1 / Section 4 — F1 stale fill after concurrent write
  - Files: profile repository wrapper, single-flight wrapper, wrapper tests
  - Verify: two-order pause/release test and flag-flip test pass; `fill_skipped_stale` increments
- [ ] **T2 (P1, human: ~1h / CC: ~5min)** — repository wrapper — Invalidate key and tokens in `finally` on every write outcome
  - Surfaced by: Section 2 — F2 ack-lost write leaves stale entry
  - Files: profile repository wrapper, wrapper tests
  - Verify: failed-write invalidation test; next read hits DB
- [ ] **T3 (P1, human: ~1h / CC: ~5min)** — repository wrapper — Map null to ABSENT with 10 s TTL, never store undefined
  - Surfaced by: Step 0E / Section 4 — F3 sentinel mapping unspecified
  - Files: profile repository wrapper, wrapper tests
  - Verify: absent key second read makes no DB call within 10 s; create then read returns record
- [ ] **T4 (P1, human: ~1h / CC: ~5min)** — feature flag — Share one deterministic enablement predicate across read and write paths
  - Surfaced by: Section 9 — F6 predicate mismatch
  - Files: profile repository wrapper, flag helper, wrapper tests
  - Verify: write to enabled key invalidates; write to disabled key touches no cache state
- [ ] **T5 (P1 before first flag enable, human: ~3h / CC: ~20min)** — observability — Bypass gauge, stale-fill counter, three alerts, runbook entry
  - Surfaced by: Section 8 — F5 silent bypass
  - Files: metrics module, alert definitions, runbook
  - Verify: adapter-failure test flips gauge; alerts render in staging
- [ ] **T6 (P1 before first flag enable, human: ~1h / CC: ~5min)** — rollout — Record deploy strategy, gate flag enable on sole-instance confirmation
  - Surfaced by: Section 9 — F4 deploy overlap window
  - Files: runbook, rollout checklist
  - Verify: checklist item signed off by service owner before the 10% stage

_No new tasks from Section 3 (Security), Section 5 (Code quality), Section 7
(Performance), Section 10 (Trajectory), Section 11 (Design, skipped)._

Task JSONL artifact: not written (no shell available in this run; see Process notes).

## Completion Summary
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | HOLD SCOPE (user-set)                       |
  | System Audit         | skipped by run rules                        |
  | Step 0               | approach A (repo-layer wrapper); 8 decisions|
  | Section 1  (Arch)    | 1 issue found (F1)                          |
  | Section 2  (Errors)  | 9 error paths mapped, 1 GAP (F2) remedied   |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 8 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 0 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 6 gaps (all remedied)     |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 1 gap found (F5)                            |
  | Section 9  (Deploy)  | 2 risks flagged (F4, F6)                    |
  | Section 10 (Future)  | Reversibility: 5/5, debt items: 0           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 9 methods/paths, 0 CRITICAL GAPS open       |
  | Failure modes        | 8 total, 0 CRITICAL GAPS open (1 remedied)  |
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 0 proposed, 0 accepted (HOLD)               |
  | CEO plan             | skipped (HOLD)                              |
  | Outside voice        | codex, disabled                             |
  | Lake Score           | 7/7 recommendations chose complete option   |
  | Diagrams produced    | 10 (arch, deps, data flow, schedule, 2 state|
  |                      |  machines, error, deploy, rollback, test)   |
  | Stale diagrams found | not audited (exploration skipped)           |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```

### Unresolved decisions
None. All eight decision points were auto-chosen to the recommended option per
the run rules; none was destructive or irreversible.

### Process notes
- Skipped by run rules: preamble, system audit, design-doc and handoff checks,
  landscape search, prior learnings, brain context, telemetry, git commands.
- Not executed because no shell tool was available: `gstack-review-log`
  (plan-ceo-review and the disabled codex record), `gstack-decision-log`,
  tasks JSONL write, `gstack-review-read`, handoff cleanup, learnings log.
  The GSTACK REVIEW REPORT below therefore reflects this run only; prior review
  rows show no runs because the log could not be read.
- No durable learnings this session beyond the plan content itself.
- Next review: `/plan-eng-review` is the required shipping gate and has not
  run. Design review not applicable (no UI scope).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | mode: HOLD_SCOPE, 0 critical gaps open (1 found, remedied), 6 findings, 6 tasks |
| Outside Review | codex via `/plan-ceo-review` outside voice | Independent 2nd opinion | 0 | disabled | none (codex_reviews disabled) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** provider codex, phase plan-review, status disabled by config; no native fallback dispatched; no outside findings. Review-log record not persisted (no shell).
- **VERDICT:** CEO CLEARED — eng review required

NO UNRESOLVED DECISIONS
