# Plan: Multi-tenant Auth Refactor (eng-reviewed)

Reviewed by `/plan-eng-review` on 2026-09-10, branch `main`, commit `18d2903`.
Source plan: `PLAN.md`. Mode: SCOPE_REDUCED (Step 0, decision D2).
Every remedy below was approved individually (D1-D14). Nothing was auto-decided.

## Context

The repo's auth path is single-flow (`legacyAuthFlow()`) over a cache adapter that
already keys entries by tenant ID, issuer, audience, and policy version, evicts expired
tokens, and invalidates on logout, token revocation, and tenant suspension. This work
introduces a broker/mint split so tenants can be served by a dedicated broker path
while the adapter and its invalidation hooks stay untouched.

The original draft (PLAN.md) named its own smells but did not resolve them: a global
mutable cache shared by two writers, a 60-line validator that swallows three error
classes, a big-bang rewrite of the live login path with no regression test, five
sequential IDP round trips, and five new units across 12 files. This reviewed plan
resolves each one with a specific, approved remedy.

Goal (stated here because the draft had none): tenant-scoped authentication with the
same user-visible behavior as today, no cross-tenant token reuse, fail-closed error
handling, and login latency bounded by one IDP round trip instead of five.

## Existing contracts retained (unchanged from draft)

The existing cache adapter keys entries by tenant ID, issuer, audience, and policy
version. It evicts expired tokens and invalidates entries on logout, token revocation,
or tenant suspension. The adapter, its invalidation hooks, and their existing tests
remain in use unchanged. `AuthCache` is a service-facing facade over that one adapter,
with one backing cache. The adapter does not serialize mutations; the facade now does
(decision 1A).

## Scope (reduced per D2)

| Unit | Status | Reason |
|------|--------|--------|
| `AuthBroker` | NEW service | Does new work: tenant-routed authentication |
| `SessionMint` | NEW service | Does new work: session issuance |
| `AuthCache` | NEW facade | Single service-facing wrapper over the existing adapter |
| `TokenStore` | CUT (merged into `AuthCache`) | Second wrapper over the same adapter; duplication |
| `RequestPolicy` | CUT as a class; becomes a typed value | Policy version is already a key dimension of the adapter |
| `validateAndDispatch()` | SPLIT into `validateToken()` + `dispatch()` | Decision 5A |
| `legacyAuthFlow()` | KEPT behind a flag until parity | Decision 2A |

Net: 3 new units, roughly 7-8 files (draft: 5 units, 12 files).

## Architecture

### Request flow (ASCII; also lives as a comment atop `auth/AuthBroker` per 4A)

```
 request(tenantId, token)
        │
        ▼
 ┌──────────────────┐   flag OFF   ┌──────────────────┐
 │ auth router      │─────────────▶│ legacyAuthFlow() │──▶ response (unchanged)
 │ (per-tenant flag)│              └──────────────────┘
 └────────┬─────────┘
          │ flag ON
          ▼
 ┌──────────────────┐   TenantKey   ┌──────────────────┐   miss    ┌──────────┐
 │ AuthBroker       │──────────────▶│ AuthCache facade │──────────▶│ IDP      │
 │ .authenticate()  │◀──────────────│ get/put/invalid. │◀──────────│ (∥ calls)│
 └────────┬─────────┘    hit/value  │ per-key ordering │  settled  └──────────┘
          │                         │ + coalescing     │
          │ validateToken() → Result└────────┬─────────┘
          │  Valid | Expired | Revoked |     │ one instance, injected
          │  IssuerMismatch | IdpUnavailable │ from composition root
          ▼                                  ▼
 ┌──────────────────┐             ┌──────────────────┐
 │ dispatch(Result) │             │ SessionMint      │
 │ → route / 401 /  │             │ .mint(TenantKey) │
 │   403 / 503      │             └──────────────────┘
 └──────────────────┘
```

### Invalidation fan-in (ASCII; also a comment atop `auth/AuthCache`)

```
 logout ─────────┐
 token revoked ──┼──▶ existing adapter hooks ──▶ AuthCache.invalidate(TenantKey)
 tenant suspend ─┘        (unchanged)              │ serialized per key with
                                                   │ in-flight puts (1A)
                                                   ▼
                                             one backing cache
                                       keyed by TenantKey only (3A)
```

### Decisions applied

1. **1A — Inject `AuthCache`; narrow write API with per-key ordering.** No module-level
   export. The composition root constructs one `AuthCache` and passes it to
   `AuthBroker` and `SessionMint` by constructor. The facade exposes `get`, `put`,
   `invalidate`, each keyed by `TenantKey`, and keeps a per-key in-flight map so a
   mint and an invalidate on the same key settle in a defined order.
2. **2A — Strangler seam.** One entry point routes per tenant (config flag) to
   `legacyAuthFlow()` or `AuthBroker`. Rollback is a config flip. Legacy removal is a
   TODO with an explicit exit condition (see TODOS.md updates).
3. **3A — Typed `TenantKey` built only inside `AuthCache`.** Record of
   `{ tenantId, issuer, audience, policyVersion }`; the facade is the only code that
   serializes it. A property test asserts distinct tenants with identical issuer and
   audience never collide.
4. **4A — Diagrams and failure table in the plan and as code comments** in
   `AuthBroker` and `AuthCache`. Diagram maintenance is part of any later change.
5. **8A — Per-key request coalescing** inside `AuthCache`, reusing the 1A in-flight
   map: concurrent misses for one key share one IDP fetch; a failed shared fetch rejects
   every waiter with the typed error.

### Production failure scenarios per new codepath

| Codepath | Realistic failure | Handled by | User sees |
|----------|-------------------|------------|-----------|
| router flag lookup | flag store unreachable | default to legacy path, log | normal login |
| `AuthBroker.authenticate` | IDP unreachable | `IdpUnavailable` result, fail closed | 503 with retry hint |
| `AuthCache.put` vs `invalidate` | interleaved writes on one key | per-key ordering (1A) | revoked stays revoked |
| `AuthCache` key build | caller omits tenant | impossible: only facade builds key (3A) | n/a |
| `AuthCache` miss burst | N concurrent misses, hot tenant | coalescing (8A) | one round trip |
| `validateToken` ∥ IDP calls | 1 of 5 rejects or times out | per-call typed classification (7A) | 401 or 503, never hang |
| `SessionMint.mint` | double submit | idempotent per (TenantKey, claims) | one session |
| tenant suspended mid-request | suspension lands between get and dispatch | invalidate wins; dispatch re-checks | 403 |

## Code quality

- **5A — Split `validateAndDispatch()`.** `validateToken()` returns a typed
  `Result` (`Valid | Expired | Revoked | IssuerMismatch | IdpUnavailable`);
  `dispatch()` switches on it. One error boundary at the entry point logs with tenant
  context and maps to 401/403/503. No catch swallows anything; unknown errors fail
  closed. Callers that relied on silent fallthrough will start seeing 401s, which is the
  intended behavior change.
- **DRY (resolved by D2):** `TokenStore` merged into `AuthCache`; one wrapper over one
  adapter.
- **Consistency (resolved by D2):** the draft listed 4 new classes in one section and
  named a 5th (`AuthBroker`) in another; the scope table above is now the single list.
- **Explicit over clever:** `TenantKey` is a record, not a concatenated string;
  `RequestPolicy` is a typed value passed into `TenantKey.policyVersion`, not a class.

## Performance

- **7A — Parallel IDP calls with per-call classification.** Use `Promise.allSettled`
  (or `Promise.all` with a per-call catch) and map each outcome to a typed `AuthError`
  so a failed introspection reads differently from a failed key fetch. Per-call timeout
  budget so no request hangs. Cache the issuer discovery document and JWKS per issuer
  with TTL and a rotation-triggered refresh; most validations then need 0-1 live calls.
- **8A — Coalescing** (above) bounds refills to one per key per expiry.
- Observability (D13, built in this PR): per-tenant IDP latency histogram, cache hit
  ratio, coalesced-miss count, 401/503 rates, tagged by path (`legacy|broker`), emitted
  at the `AuthCache` facade and `validateToken()` boundary using the project's existing
  metrics client. Cap tenant-tag cardinality.

## Tests

Test framework: none detectable in this fixture repo (only `PLAN.md` is committed).
The plan's `Promise.all` reference implies a Node/TypeScript runner; confirm the real
repo's runner and naming convention before creating files. Paths below use
`tests/auth/*.test.ts` as the convention to match.

### CRITICAL — regression (mandatory, REGRESSION RULE)

`legacyAuthFlow()` is live behavior being changed with no covering test (PLAN.md:27-28).
Before any rewrite: `tests/auth/legacyAuthFlow.characterization.test.ts` records current
outputs (including quirks) for valid, expired, revoked, issuer-mismatch, IDP-unavailable,
and tenant-suspended inputs. This suite runs against the legacy path now and moves to
`AuthBroker` when the flag is removed (TODO 1).

### Coverage diagram (after 6A every GAP below becomes a named test)

```
CODE PATHS                                                USER FLOWS
[+] auth/AuthBroker                                       [+] Login, flag ON (new path)
  ├── authenticate(req, tenantKey)                          ├── [GAP→E2E] valid token → session issued
  │   ├── [PLANNED ★★] success — PLAN.md:14                 ├── [GAP→E2E] expired → 401 + re-auth prompt
  │   ├── [PLANNED ★★] error   — PLAN.md:14                 ├── [GAP]     revoked mid-session → 401 next request
  │   ├── [GAP] IDP unreachable → IdpUnavailable            └── [GAP]     tenant suspended mid-request → 403
  │   ├── [GAP] cache hit / cache miss (both branches)
  │   └── [GAP] concurrent mint + revoke, same key         [+] Login, flag OFF (legacy path)
  └── flag router (legacy | broker)                         ├── [REGRESSION][CRITICAL] characterization suite
      ├── [GAP] flag on  → AuthBroker                       └── [GAP→E2E] parity: same input, same result
      └── [GAP] flag off → legacyAuthFlow
[+] auth/SessionMint                                      [+] Error states
  └── mint(tenantKey, claims)                               ├── [GAP] IDP 5xx → 503, never a silent pass
      ├── [PLANNED ★★] success/error — PLAN.md:14           ├── [GAP] IDP timeout → bounded wait, then 503
      └── [GAP] double-submit mint is idempotent            └── [GAP] 1-of-5 IDP call fails → typed error
[+] auth/AuthCache (facade over existing adapter)
  ├── [GAP] TenantKey isolation property test (3A)
  ├── [GAP] per-key write ordering, mint vs invalidate (1A)
  ├── [GAP] coalesced miss: N waiters, 1 fetch; failed fetch rejects all (8A)
  ├── [GAP] logout/revoke/suspend invalidation via facade
  └── [EXISTING ★★★] adapter eviction/invalidation — PLAN.md:12-13
[+] auth/validate.ts
  ├── validateToken(): [GAP] Valid/Expired/Revoked/IssuerMismatch/IdpUnavailable (5)
  ├── validateToken(): [GAP] ∥ IDP calls all-ok / one-rejects / all-reject
  ├── validateToken(): [GAP] JWKS cache hit / stale after rotation → refresh
  └── dispatch():      [GAP] each Result variant → route + status

COVERAGE (draft): 4/33 paths (12%) | Code: 4/23 | User flows: 0/10
QUALITY: ★★★:1 ★★:3 | GAPS: 29 (3 E2E, 0 eval, 1 REGRESSION)
TARGET (this plan): 33/33
```

### Tests to write (6A)

| File | Asserts |
|------|---------|
| `tests/auth/legacyAuthFlow.characterization.test.ts` | CRITICAL: current behavior per input class, quirks included |
| `tests/auth/authBroker.test.ts` | success; each `Result` variant; cache hit vs miss; IDP unreachable → `IdpUnavailable` |
| `tests/auth/authRouter.test.ts` | flag on → broker; flag off → legacy; flag store down → legacy + log |
| `tests/auth/sessionMint.test.ts` | success/error; double submit yields one session |
| `tests/auth/authCache.property.test.ts` | property: distinct tenants, same issuer+audience, never collide; suspension invalidates only that tenant |
| `tests/auth/authCache.concurrency.test.ts` | mint then invalidate on one key settles in order; N concurrent misses → 1 fetch; failed fetch rejects all waiters |
| `tests/auth/authCache.invalidation.test.ts` | logout/revoke/suspend hooks reach the facade and clear the right key |
| `tests/auth/validateToken.test.ts` | 5 Result variants; ∥ IDP all-ok / one-rejects / all-reject; per-call timeout; JWKS cache hit and rotation refresh |
| `tests/auth/dispatch.test.ts` | each Result → route or 401/403/503; nothing swallowed |
| `tests/auth/e2e/login.e2e.test.ts` [→E2E] | valid login → authed request → logout → 401 (stubbed IDP) |
| `tests/auth/e2e/expired.e2e.test.ts` [→E2E] | expired → 401 → re-auth → works |
| `tests/auth/e2e/parity.e2e.test.ts` [→E2E] | same inputs through legacy and broker produce identical outcomes |

### QA test plan artifact

Written for `/qa` and `/qa-only` at
`~/.gstack/projects/gstack-plan-count-4WfoHa/vercel-sandbox-main-eng-review-test-plan-20260910-181559.md`.

## What already exists

| Sub-problem | Existing code | Plan's use |
|-------------|---------------|------------|
| Tenant/issuer/audience/policy keying | cache adapter | Reused via `AuthCache`; `TenantKey` formalizes it |
| Expiry eviction | cache adapter | Reused unchanged |
| Invalidation on logout/revoke/suspend | adapter hooks + tests | Reused unchanged; facade routes through them |
| Login behavior | `legacyAuthFlow()` | Kept behind flag; characterized; removed later |
| Token storage | cache adapter | Draft rebuilt it as `TokenStore`; now cut |
| Policy versioning | adapter key dimension | Draft rebuilt it as `RequestPolicy` class; now a typed value |
| Metrics emission | project metrics client (assumed) | Reuse; do not add a client |

## NOT in scope

- **Removing `legacyAuthFlow()` and the flag** — TODO 1; needs parity data first.
- **Load-testing the miss storm / IDP rate limits** — TODO 3; separate harness.
- **Changing the cache adapter or its invalidation hooks** — retained contract.
- **New IDP client library** — reuse the existing one; only call shape changes (7A).
- **`TokenStore` and `RequestPolicy` classes** — cut in D2, not deferred.
- **Distribution/CI changes** — no new artifact type is introduced.

## TODOS.md updates (create `TODOS.md` at implementation; file does not exist yet)

```markdown
# TODOS

## Auth

### Remove legacyAuthFlow() and the routing flag
**What:** Delete legacyAuthFlow, the per-tenant flag, and the router branch; point the characterization suite at AuthBroker.
**Why:** Finish the strangler; one login path, no dual-path drift, no flag config to audit.
**Context:** Added by /plan-eng-review 2026-09-10 (decision 2A/D12). Exit condition: parity E2E green in staging and all tenants on the broker path for two release cycles. Start at auth router.
**Effort:** S  **Priority:** P2  **Depends on:** 2A shipped; parity.e2e green; all tenants flagged on.

### Load-test cache-miss storm and IDP rate-limit behavior
**What:** k6/artillery scenario against a stubbed, call-counting IDP; assert outbound calls per key per expiry == 1 and p99 login within budget.
**Why:** Decision 8A (coalescing) rests on a medium-confidence bet about hot-tenant concurrency; this measures it before production does.
**Context:** Added by /plan-eng-review 2026-09-10 (D14). Run before the first production policy-version bump. Read counts from the metrics added in this PR.
**Effort:** M  **Priority:** P2  **Depends on:** 7A, 8A, metrics (D13) merged.
```

TODO 2 (observability) was chosen as "build now" (D13) and is in scope above.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| T5 characterization suite | tests/auth/ (legacy) | — |
| T2 AuthCache facade (1A, 3A, 8A) | auth/cache/ | — |
| T3 validate/dispatch split (5A) | auth/validate/ | — |
| T1 composition root + services | auth/broker/, auth/mint/, app bootstrap | T2 |
| T4 flag-routed seam (2A) | auth/router/ | T1, T5 |
| T7 ∥ IDP calls + JWKS cache (7A) | auth/idp/ | T3 |
| T8 metrics (D13) | auth/cache/, auth/validate/ | T2, T3 |
| T9 diagrams as comments (4A) | auth/broker/, auth/cache/ | T1, T2 |
| T6 full test suite (6A) | tests/auth/ | T1-T4, T7 |

- **Lane A:** T2 → T1 → T4 (sequential, shared auth/cache → broker → router)
- **Lane B:** T3 → T7 (sequential, shared auth/validate → auth/idp)
- **Lane C:** T5 (independent)
- **Execution:** launch A, B, C in parallel worktrees. Merge all three. Then T8 + T9
  (touch both lanes' modules). Then T6.
- **Conflict flag:** T8 touches auth/cache/ (Lane A) and auth/validate/ (Lane B).
  Run it only after both lanes merge.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~20 min)** — auth/broker, auth/mint, bootstrap — Inject one `AuthCache` from the composition root; delete the module-level export
  - Surfaced by: Architecture — Issue 1 (PLAN.md:19-20), decision 1A
  - Files: auth/broker/AuthBroker.ts, auth/mint/SessionMint.ts, app/bootstrap.ts
  - Verify: `tests/auth/authBroker.test.ts` constructs services with a fake cache; no `import { authCache }` anywhere
- [ ] **T2 (P1, human: ~1 day / CC: ~30 min)** — auth/cache — `AuthCache` facade: `TenantKey` record built only here, per-key write ordering, per-key request coalescing
  - Surfaced by: Architecture — Issues 1, 3 (PLAN.md:10-12, 19-20); Performance — Issue 8; decisions 1A, 3A, 8A
  - Files: auth/cache/AuthCache.ts, auth/cache/TenantKey.ts
  - Verify: `authCache.property.test.ts`, `authCache.concurrency.test.ts` green
- [ ] **T3 (P1, human: ~1 day / CC: ~20 min)** — auth/validate — Split `validateAndDispatch()` into `validateToken()` returning typed `Result` and `dispatch()`; single fail-closed error boundary
  - Surfaced by: Code Quality — Issue 5 (PLAN.md:23-24), decision 5A
  - Files: auth/validate/validateToken.ts, auth/validate/dispatch.ts, auth/errors.ts
  - Verify: `validateToken.test.ts`, `dispatch.test.ts`; grep shows zero empty catch blocks
- [ ] **T4 (P1, human: ~1 day / CC: ~20 min)** — auth/router — Per-tenant flag routes to `legacyAuthFlow()` or `AuthBroker`; flag-store failure defaults to legacy
  - Surfaced by: Architecture — Issue 2 (PLAN.md:27-28), decision 2A
  - Files: auth/router/authRouter.ts, config/flags
  - Verify: `authRouter.test.ts`; flipping the flag in staging switches paths without deploy
- [ ] **T5 (P1, human: ~4 hrs / CC: ~15 min)** — tests/auth — CRITICAL regression: characterization suite for `legacyAuthFlow()` current behavior
  - Surfaced by: Tests — REGRESSION RULE (PLAN.md:27-28)
  - Files: tests/auth/legacyAuthFlow.characterization.test.ts
  - Verify: suite green against unmodified legacy before any other task merges
- [ ] **T6 (P1, human: ~3 days / CC: ~1 hr)** — tests/auth — Close all 29 coverage gaps: unit, property, concurrency, and 3 E2E flows against a stubbed IDP
  - Surfaced by: Tests — Issue 6 (PLAN.md:14-16), decision 6A
  - Files: tests/auth/*.test.ts, tests/auth/e2e/*.e2e.test.ts (table above)
  - Verify: coverage report shows every diagram branch exercised; E2E suite green
- [ ] **T7 (P2, human: ~1 day / CC: ~20 min)** — auth/idp — Parallel IDP calls with per-call typed classification, per-call timeout, issuer discovery + JWKS cache with TTL and rotation refresh
  - Surfaced by: Performance — Issue 7 (PLAN.md:31-32), decision 7A
  - Files: auth/idp/idpClient.ts, auth/idp/jwksCache.ts
  - Verify: `validateToken.test.ts` ∥ cases; p50 login latency ≈ 1 IDP round trip in staging
- [ ] **T8 (P2, human: ~3 hrs / CC: ~10 min)** — auth/cache, auth/validate — Per-tenant metrics: IDP latency, hit ratio, coalesced misses, 401/503 rates, tagged by path
  - Surfaced by: TODO 2 chosen "build now" (D13)
  - Files: auth/cache/AuthCache.ts, auth/validate/validateToken.ts, using existing metrics client
  - Verify: metrics visible in staging dashboard per tenant and path; cardinality cap enforced
- [ ] **T9 (P2, human: ~1 hr / CC: ~5 min)** — auth/broker, auth/cache — Embed the request-flow and invalidation ASCII diagrams as file-header comments
  - Surfaced by: Architecture — Issue 4, decision 4A
  - Files: auth/broker/AuthBroker.ts, auth/cache/AuthCache.ts
  - Verify: diagrams match the plan; reviewed on any later change to those files
- [ ] **T10 (P3, human: ~10 min / CC: ~1 min)** — TODOS.md — Create file with the two entries above
  - Surfaced by: TODOS.md updates (D12, D14)
  - Files: TODOS.md
  - Verify: entries follow the gstack TODOS format

## Suppressed findings

None. Every finding scored 6/10 or higher. Issue 8 (miss storm) was reported at 6/10
with the medium-confidence caveat and accepted with a load-test TODO to measure it.

## Completion summary

- Step 0: Scope Challenge — scope reduced per recommendation (5 units/12 files → 3 units/~7-8 files)
- Architecture Review: 4 issues found, 4 resolved (all complete option)
- Code Quality Review: 1 issue found, 1 resolved (2 more resolved by Step 0)
- Test Review: diagram produced, 29 gaps identified (1 CRITICAL regression), all added to plan
- Performance Review: 2 issues found, 2 resolved
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 3 items proposed (2 added, 1 built now)
- Failure modes: 3 critical gaps flagged in the draft (unordered two-writer cache, swallowed auth errors, hand-built tenant keys); 0 remain after approved remedies
- Outside voice: skipped (codex_reviews disabled; no native fallback by design)
- Parallelization: 3 lanes, 3 parallel then 2 sequential steps
- Lake Score: 8/8 recommendations chose the complete option

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review` | Independent 2nd opinion | 1 | disabled | skipped (codex_reviews disabled) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (PLAN) | 8 issues + 29 test gaps, 0 critical gaps remaining, mode SCOPE_REDUCED |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** provider codex, phase plan-review, outside_status disabled (user config `codex_reviews=disabled`); no outside findings; no native subagent fallback was dispatched because disabled is an opt-out, not a provider failure.

**VERDICT:** ENG CLEARED — ready to implement. CEO and Design reviews not run (backend-only auth refactor; neither is required).

NO UNRESOLVED DECISIONS
