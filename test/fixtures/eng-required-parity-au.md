# Plan: Multi-tenant Auth Refactor (reviewed)

Reviewed by /plan-eng-review on 2026-09-10, branch `main`, commit `3522c32`.
Source plan: `PLAN.md`. Scope was reduced in Step 0 (decision D2) and every
finding below was accepted individually (D3 through D10). Lake Score: 7/7
decisions chose the complete option.

## Context

The service is moving from a single `legacyAuthFlow()` to a multi-tenant
auth path. The original sketch introduced five new types (AuthBroker,
TokenStore, SessionMint, AuthCache, RequestPolicy) across 12 files, shared
one mutable cache through a module-level export, rewrote the live login path
in place with no regression test, and left token validation as five
sequential IDP calls. This review keeps the goal (tenant-isolated brokering
and session minting over the existing cache adapter) and cuts the shape down
to what that goal needs, then hardens the two places where tenant isolation
can actually break: concurrent cache writes and swallowed errors.

## Step 0: Scope (decision D2, accepted)

**Accepted scope:** three new types and about 7 files.

| Original | Reviewed |
|---|---|
| TokenStore + AuthCache, both wrapping the existing adapter | One `AuthCache` facade. TokenStore is folded in. |
| RequestPolicy class | `requestPolicy(ctx)` pure function returning a policy value. Promote to a class only if per-tenant mutable state appears. |
| AuthBroker, SessionMint services | Kept. |
| 12 files | ~7: composition root, AuthCache, AuthBroker, SessionMint, requestPolicy, validate/dispatch module, flag routing in the entry point, plus tests. |

Plan text inconsistency fixed: the original listed "two new services" and
"four new classes" without AuthBroker in the class list. The real count was
five new types; it is now three.

Search check [Layer 1]: module-level mutable singletons are the documented
Node anti-pattern; composition-root injection is the boring fix. Strangler
fig with a per-tenant flag is the standard way to replace a live auth path.
`Promise.all` is correct when every call must succeed; `allSettled` only
when partial results are useful (they are not here).

TODOS.md does not exist in the repo. Distribution check: no new artifact
type, not applicable.

## Existing contracts retained

The existing cache adapter keys entries by tenant ID, issuer, audience, and
policy version. It evicts expired tokens and invalidates entries on logout,
token revocation, or tenant suspension. `AuthCache` is a service-facing
facade over that same adapter with one backing cache. The adapter, its
invalidation hooks, and their existing tests remain in use unchanged.

New in this plan: `AuthCache` is the only writer (see Architecture 2). The
adapter's validity and tenant-key rules are unchanged; the guard is layered
on top, not inside the adapter.

## Architecture

### Component wiring (decision 1A: constructor injection)

```
composition root (one per process)
  │
  ├── adapter = existingCacheAdapter()          (unchanged)
  ├── cache   = new AuthCache(adapter, tenantStatus)
  ├── idp     = new IdpClient({ timeoutMs })
  ├── broker  = new AuthBroker(cache, idp)
  └── mint    = new SessionMint(cache)
        │
        ▼
  entry point (route handler)
        │  flag.isEnabled(tenantId)?
        ├── false ──▶ legacyAuthFlow(req)                 (retained until parity)
        └── true  ──▶ validate(req, broker) ──▶ dispatch(result, mint)
```

No module-level `AuthCache` export. Tests build a fresh `AuthCache` per case.

### Write path (decision 2A: AuthCache owns all writes, guarded)

```
AuthBroker ──put(key, entry)──┐
                              ▼
                     AuthCache.put()
                       │ 1. tenantStatus.isActive(tenantId)?   no ──▶ drop + AuthError.TenantSuspended
                       │ 2. entry.policyVersion == current?    no ──▶ drop + AuthError.StalePolicy
                       │ 3. adapter.set(key, entry)
                       ▼
SessionMint ──put(key, session)┘

Interleaving that must be safe:
  t0  mint starts for tenant T
  t1  suspension hook wipes T's entries
  t2  mint calls cache.put()  ──▶ step 1 fails ──▶ nothing written
```

The adapter's invalidation hooks still fire on logout, revocation, and
suspension. The guard closes the window between a hook firing and a late
write landing. Locks and queues were considered and rejected as
over-engineering for an in-process cache.

### Rollout (decision 3A: strangler fig, per-tenant flag)

1. Ship both paths. Flag default off for every tenant.
2. Enable for one internal tenant. Watch parity suite and error rates.
3. Widen by tenant cohort. Flip back per tenant on any divergence.
4. At 100% with parity green for one release, execute TODO 1 (delete
   `legacyAuthFlow()`, the flag branch, and the parity suite's legacy leg).

### Production failure scenarios per new codepath

| Codepath | Realistic failure | Plan accounts for it |
|---|---|---|
| Composition root | Two roots constructed (e.g. test and app) → two caches | Root is the only constructor call site; tests use the root's factory. |
| AuthCache.put() guard | tenantStatus lookup slow or down | Guard fails closed (deny write) and raises `AuthError.TenantStatusUnavailable`; test covers it. |
| Flag routing | Flag store unreachable | Default to legacy path; log; test covers it. |
| validate() parallel IDP | One call hangs | AbortSignal timeout, siblings aborted (6A). |

## Code quality (decision 4A)

`validateAndDispatch()` (60 lines, three nested try/catch blocks, each
swallowing a different error class) is split:

```
validate(req, broker): Promise<Validated>
  │  throws typed errors, never swallows
  ├── AuthError.IdpUnreachable   (network / timeout)
  ├── AuthError.BadSignature     (JWKS mismatch)
  ├── AuthError.UnknownTenant
  ├── AuthError.TenantSuspended
  └── AuthError.Expired

dispatch(validated, mint): Promise<Response>
  └── mint.mint(validated) ──▶ cache.put()

boundary (route handler)
  try { dispatch(await validate(req, broker), mint) }
  catch (e) { log(e); return mapAuthError(e) }   // one catch, one map table
```

`mapAuthError` is a single table from error class to response code and
user-facing message. Every class is a distinct, testable outcome. Callers
that depended on silent failure must be audited when the split lands.

DRY: TokenStore was a second wrapper over the same adapter as AuthCache; it
is gone (D2). Inline ASCII diagram comments go in `AuthCache` (write-path
guard), the composition root (wiring), and the validate/dispatch module
(error map).

## Tests

Test framework: none detected in this fixture repo (no `package.json`, zero
test files). File names below assume TypeScript with `*.test.ts`; adjust to
the real project's convention.

### Coverage diagram

```
CODE PATHS                                                   USER FLOWS
[+] composition-root.ts                                      [+] Login (flag off)
  └── build()                                                  └── [GAP][CRITICAL][→E2E] identical to pre-refactor — legacyAuthFlow.regression.test.ts
      └── [GAP] single AuthCache instance, no module export   [+] Login (flag on)
[+] auth-cache.ts                                              ├── [GAP][→E2E] happy path end to end
  └── put()                                                    ├── [GAP]       double-submit → one session
      ├── [GAP] active tenant, current policy → written        ├── [GAP]       token expires between validate and dispatch
      ├── [GAP] suspended tenant → dropped, TenantSuspended    └── [GAP]       flag store unreachable → legacy path
      ├── [GAP] stale policy version → dropped, StalePolicy  [+] Parity (flag on vs off)
      ├── [GAP] tenantStatus unavailable → fail closed          └── [GAP][→E2E] table: happy + each AuthError + suspended/revoked/expired
      └── [GAP] suspend-during-mint interleaving             [+] Tenant admin
[+] validate.ts                                                ├── [GAP][→E2E] suspend tenant → in-flight mint refused
  └── validate()                                               └── [GAP][→E2E] revoke token → next request rejected
      ├── [GAP] all 5 IDP calls succeed                      [+] Error states
      ├── [GAP] one call rejects → siblings aborted            ├── [GAP] each AuthError → specific code + message + log line
      ├── [GAP] one call times out → IdpUnreachable            └── [GAP] IDP slow → bounded failure, retryable message
      └── [GAP] each AuthError subclass raised
[+] dispatch.ts / boundary
  └── mapAuthError()
      └── [GAP] every AuthError class → distinct response
[+] request-policy.ts
  └── requestPolicy()  [GAP] pure: same ctx → same policy, unknown tenant → default-deny
[+] legacyAuthFlow (retained, existing tests) [★★ TESTED by existing adapter tests only]

COVERAGE: 0/22 new paths tested (0%)  |  Code paths: 0/13  |  User flows: 0/9
QUALITY: existing adapter tests ★★  |  GAPS: 22 (7 E2E, 1 CRITICAL regression, 0 eval)
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke | [→E2E] needs integration test

### Required tests (all written alongside the feature code)

**CRITICAL (regression rule, mandatory, no decision needed):**
`legacyAuthFlow.regression.test.ts`. Pin current behavior of
`legacyAuthFlow()` before any change: valid token → session shape and
lifetime; expired, bad signature, unknown tenant → the exact current
response codes and bodies; logout and revocation clear the cache. This is
the oracle for the parity suite and the guard for the flag-off path. What
breaks without it: the rewrite changes existing behavior for every tenant
still on the legacy path with nothing to catch it.

**Decision 5A, parity suite:** `auth-parity.test.ts`. One fixture table,
each row run through both paths (flag off, flag on), assert identical
outcome. Rows: valid token; each `AuthError` class; tenant suspended,
revoked, expired; policy version bumped. Exit criterion for TODO 1.

**Decision 1A:** `composition-root.test.ts`. Two services from one root
share one `AuthCache`; two roots do not. Grep test: no module exports an
`AuthCache` instance.

**Decision 2A:** `auth-cache.test.ts`. Five `put()` branches above,
including the suspend-during-mint interleaving (start mint, fire suspension
hook, complete mint, assert no entry) and tenantStatus unavailable → deny.

**Decision 4A:** `validate.test.ts`, `dispatch.test.ts`. One test per
`AuthError` subclass raised by `validate()`; one per row of `mapAuthError`;
assert a log line is emitted for each; assert nothing is swallowed (a
non-AuthError propagates).

**Decision 6A:** in `validate.test.ts` with a fake IDP: all succeed;
one rejects → others receive abort; one hangs past timeout →
`IdpUnreachable` within the bound; latency of the happy path ≈ max, not
sum (assert call overlap via fake timestamps).

**User flows [→E2E]:** `auth.e2e.test.ts`: login flag on → authenticated
request → logout; double-submit; suspend tenant during login; revoke then
retry; flag store unreachable → legacy path.

QA test plan artifact written to
`~/.gstack/projects/gstack-plan-count-tTVLFw/vercel-sandbox-main-eng-review-test-plan-20260910-210603.md`.

## Performance (decision 6A)

Token validation's five independent IDP calls run in parallel:

```
validate()
  signal = AbortSignal.timeout(timeoutMs)  (one per call, plus a shared controller)
  Promise.all([discovery, jwks, introspect, userinfo, tenantLookup].map(c => c(signal)))
    │ first rejection ──▶ controller.abort() ──▶ siblings cancelled
    │ timeout          ──▶ AuthError.IdpUnreachable
    ▼
  latency: max(call) instead of sum(call)
```

`Promise.all` is the right semantics: validation is all-or-nothing.
Per-issuer caching of discovery and JWKS is TODO 2, deliberately out of this
PR. If the IDP client does not accept an `AbortSignal`, wrap it rather than
skipping the timeout.

## NOT in scope

- **TokenStore as a separate class.** Second wrapper over the same adapter; folded into AuthCache (D2). Revisit only if a non-cache backing store is actually needed.
- **RequestPolicy as a class.** No described state; a pure function. Promote when per-tenant mutable policy state appears.
- **Deleting `legacyAuthFlow()` and the flag.** Follow-up TODO 1, gated on parity at 100%.
- **Per-issuer discovery/JWKS caching.** Follow-up TODO 2; independent of tenant correctness and would blur the parity comparison.
- **Locks or a write queue for AuthCache.** Write-time guard chosen instead (2A); a queue is over-engineering for an in-process cache.
- **Changes to the existing cache adapter or its invalidation hooks.** Retained unchanged by the plan's own contract.
- **Distribution / packaging.** No new artifact type.

## What already exists

- **Existing cache adapter** (tenant/issuer/audience/policy-version keys, expiry eviction, invalidation on logout/revocation/suspension, with tests): reused unchanged behind `AuthCache`. The original plan rebuilt a second wrapper (TokenStore) over it; removed.
- **`legacyAuthFlow()`**: retained as the flag-off path and as the parity oracle instead of being rewritten in place.
- **Existing adapter tests**: still run; they do not cover the new writer or the guard, hence the new `auth-cache.test.ts`.
- **IDP client**: reused; gains an `AbortSignal` parameter or a thin wrapper.

## TODOS (approved D9, D10; create TODOS.md at implementation time)

### TODO 1: Remove the per-tenant auth flag and delete legacyAuthFlow()
- **What:** Delete `legacyAuthFlow()`, the flag branch in the entry point, and the parity suite's legacy leg.
- **Why:** Two live auth paths are a maintenance and audit burden once the new path is proven.
- **Pros:** Single code path, smaller test matrix. **Cons:** Needs a real signal before it is safe.
- **Context:** Start at the composition root / entry-point flag routing. The parity suite from decision 5A is the gate.
- **Depends on:** Flag at 100% for all tenants; parity suite green for one full release.

### TODO 2: Cache per-issuer IDP discovery and JWKS
- **What:** Issuer-keyed cache for the discovery document and JWKS with TTL and refresh on unknown `kid`.
- **Why:** Two of five IDP calls per login are static per issuer; cuts latency and IDP quota.
- **Pros:** Lower p50, fewer rate-limit hits. **Cons:** A second cache with its own staleness rules; key rotation must trigger refresh.
- **Context:** Lives in the IDP client, not AuthCache. Key on issuer URL.
- **Depends on:** Decision 6A (parallel calls) landing first as the baseline.

## Failure modes

| New codepath | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|
| AuthCache.put() | Suspension hook races a mint | auth-cache interleaving | guard drops write | clear "account suspended" |
| AuthCache.put() | tenantStatus lookup down | auth-cache unavailable case | fail closed, TenantStatusUnavailable | clear retryable error |
| validate() | One IDP call hangs | validate timeout case | AbortSignal timeout | bounded, retryable error |
| validate() | One IDP call rejects, siblings leak | validate abort case | controller.abort() | specific error |
| dispatch/boundary | Unknown error class | validate non-AuthError case | propagates, logged | 500 with log line (not silent) |
| Flag routing | Flag store unreachable | e2e flag-unreachable | default to legacy | unchanged legacy behavior |
| Composition root | Second root built | composition-root test | test fails | n/a |
| legacyAuthFlow (flag off) | Behavior drift from rewrite | CRITICAL regression test | n/a (no code change on this path) | identical to today |

Critical gaps (no test, no handling, silent): **0** after the accepted
remedies. Before review there were two: the suspend-during-mint race and
the swallowed error classes.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| S1 Composition root + AuthCache (fold TokenStore, guarded put) | auth/cache, app bootstrap | — |
| S2 validate()/dispatch() split, AuthError classes, parallel IDP calls | auth/validate, auth/idp-client | — |
| S3 AuthBroker + SessionMint + requestPolicy | auth/services | S1 (cache API), S2 (AuthError types) |
| S4 Flag routing + regression test + parity suite + e2e | entry point, test/ | S1, S2, S3 |

Lane A: S1 (independent). Lane B: S2 (independent). Lane C: S3 → S4
(sequential, waits on A and B).

Execution order: launch A and B in parallel worktrees. Merge both. Then C.

Conflict flags: A and B both touch the shared `AuthError` type if it is
placed under auth/cache; put `AuthError` in its own module in S2 and have S1
import it, or agree the file name up front.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~3h / CC: ~10min)** — composition root — Build one AuthCache in a composition root and constructor-inject it into AuthBroker and SessionMint; delete the module-level export
  - Surfaced by: Architecture issue 1 (D3) — PLAN.md:19-20 "global mutable AuthCache instance via module-level export"
  - Files: composition-root.ts, auth-broker.ts, session-mint.ts, composition-root.test.ts
  - Verify: composition-root.test.ts; grep confirms no exported AuthCache instance
- [ ] **T2 (P1, human: ~4h / CC: ~15min)** — AuthCache — Route all writes through AuthCache.put() with tenant-status and policy-version guard; fail closed on status lookup failure
  - Surfaced by: Architecture issue 2 (D4) — PLAN.md:10 "they do not serialize mutations"
  - Files: auth-cache.ts, auth-cache.test.ts
  - Verify: auth-cache.test.ts including suspend-during-mint interleaving
- [ ] **T3 (P1, human: ~1 day / CC: ~20min)** — entry point — Per-tenant feature flag routes to the new path; legacyAuthFlow() retained; flag store failure defaults to legacy
  - Surfaced by: Architecture issue 3 (D5) — PLAN.md:27-28 "rewritten as part of this work"
  - Files: entry-point route handler, flags config, auth.e2e.test.ts
  - Verify: e2e flag on/off and flag-unreachable cases
- [ ] **T4 (P1, human: ~3h / CC: ~10min)** — legacyAuthFlow — CRITICAL regression test pinning current legacyAuthFlow() behavior before any change
  - Surfaced by: Test review, mandatory regression rule — PLAN.md:27-28 "no regression test for the prior behavior is planned"
  - Files: legacyAuthFlow.regression.test.ts
  - Verify: test passes against unmodified legacyAuthFlow() first
- [ ] **T5 (P1, human: ~4h / CC: ~15min)** — validate/dispatch — Split validateAndDispatch() into validate() + dispatch(), typed AuthError subclasses, one boundary catch with a mapAuthError table and a log line per class; audit callers that relied on silent failure
  - Surfaced by: Code quality issue 4 (D6) — PLAN.md:23-24 "each catch swallows a different error class"
  - Files: validate.ts, dispatch.ts, auth-error.ts, validate.test.ts, dispatch.test.ts
  - Verify: one test per AuthError class; non-AuthError propagates
- [ ] **T6 (P2, human: ~1 day / CC: ~20min)** — tests — Table-driven parity suite running each fixture row through flag-off and flag-on paths
  - Surfaced by: Test issue 5 (D7) — PLAN.md:14-16 "does not exercise legacyAuthFlow() or assert compatibility"
  - Files: auth-parity.test.ts
  - Verify: suite green for every row; becomes the exit criterion for TODO 1
- [ ] **T7 (P2, human: ~3h / CC: ~10min)** — IDP client — Parallelize the five IDP calls with Promise.all, per-call AbortSignal timeout, abort siblings on first failure, map to AuthError.IdpUnreachable
  - Surfaced by: Performance issue 6 (D8) — PLAN.md:31-32 "5 sequential API calls to the IDP"
  - Files: validate.ts, idp-client.ts, validate.test.ts
  - Verify: fake-IDP tests for hang, single rejection, and call overlap
- [ ] **T8 (P2, human: ~2h / CC: ~10min)** — scope — Fold TokenStore into AuthCache; implement requestPolicy() as a pure function with default-deny for unknown tenant
  - Surfaced by: Step 0 scope challenge (D2) — PLAN.md:35-36 "4 new classes (TokenStore, SessionMint, AuthCache, RequestPolicy)"
  - Files: auth-cache.ts, request-policy.ts, request-policy.test.ts
  - Verify: no TokenStore symbol remains; requestPolicy tests
- [ ] **T9 (P3, human: ~2h / CC: ~10min)** — cleanup — TODO 1: remove flag and delete legacyAuthFlow() after parity at 100%
  - Surfaced by: TODO 1 (D9)
  - Files: entry point, legacyAuthFlow module, auth-parity.test.ts
  - Verify: parity suite green for one release before starting
- [ ] **T10 (P3, human: ~4h / CC: ~15min)** — IDP client — TODO 2: per-issuer discovery + JWKS cache with kid-miss refresh
  - Surfaced by: TODO 2 (D10)
  - Files: idp-client.ts, idp-client.test.ts
  - Verify: second login for same issuer makes 3 network calls, not 5

## Completion summary

- Step 0: Scope Challenge — scope reduced per recommendation (5 types / 12 files → 3 types / ~7 files)
- Architecture Review: 3 issues found (all resolved: 1A, 2A, 3A)
- Code Quality Review: 1 issue found (resolved: 4A)
- Test Review: diagram produced, 22 gaps identified; 1 CRITICAL regression test added under the mandatory rule; parity suite accepted (5A)
- Performance Review: 1 issue found (resolved: 6A)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 2 items proposed to user, 2 accepted (file to be created at implementation)
- Failure modes: 0 critical gaps flagged after remedies (2 before)
- Outside voice: skipped (codex_reviews disabled; recorded as outside_status disabled)
- Parallelization: 3 lanes, 2 parallel / 1 sequential
- Lake Score: 7/7 recommendations chose complete option

## Suppressed findings (confidence below 7, appendix only)

- (4/10) TokenStore may have been intended for a future non-cache backing store; the plan does not say so, so it was folded. Re-split if that requirement surfaces.
- (4/10) RequestPolicy may need per-tenant mutable state; nothing in the plan describes it. Pure function until proven otherwise.
- (3/10) The five IDP calls may not all be independent (e.g. introspection may need the discovery document's endpoint). If so, two-stage: discovery + JWKS first, then the remaining three in parallel. Verify against the IDP client before T7.
- (4/10) Callers of validateAndDispatch() may depend on the silent-failure behavior; no call sites were available in this fixture to check. Audit is folded into T5.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review` (plan-review phase) | Independent 2nd opinion | 1 | disabled | outside_status: disabled (codex_reviews=disabled); no outside coverage |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (PLAN) | 7 issues, 0 critical gaps, 7/7 resolved, scope reduced |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** provider codex, phase plan-review, disabled by config (`codex_reviews=disabled`); no findings. Native review only. Re-enable with `gstack-config set codex_reviews enabled`.

**VERDICT:** ENG CLEARED — ready to implement (scope reduced, 7 findings resolved, regression test mandatory). No outside coverage.

NO UNRESOLVED DECISIONS
