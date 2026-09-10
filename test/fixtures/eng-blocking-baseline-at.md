# Plan: Multi-tenant Auth Refactor (reviewed)

Reviewed by `/plan-eng-review` on 2026-09-10, branch `main`, commit `0f0ecb4`.
Source plan: `PLAN.md`. Scope mode: SCOPE_REDUCED (Step 0, decision D4).
Every finding below was walked through interactively; the option letter recorded
next to each one is the user's choice.

## Context

The service needs multi-tenant auth: two new services, `AuthBroker` (validates
tokens against the IDP and owns cached auth state) and `SessionMint` (mints
sessions for validated, active tenants), on top of the existing tenant-keyed
cache adapter. The original plan (PLAN.md:35-36) reached that goal with four new
classes across 12 files, a module-level mutable cache singleton mutated by both
services, a 60-line `validateAndDispatch()` that swallows three error classes,
five sequential IDP calls per validation, and an in-place rewrite of
`legacyAuthFlow()` with no regression test. The review reduced the class count
to two, made the cache boundary explicit and single-writer, surfaced the
swallowed errors as typed failures, parallelized the IDP calls with guards, and
made the legacy cutover reversible and regression-tested.

Outcome for the real user: uncached login drops from five IDP round trips to
one, a revoked or suspended tenant is denied on the very next request, and no
tenant can ever be served another tenant's cached auth state.

## Existing contracts retained (unchanged from PLAN.md:6-16)

The existing cache adapter keys entries by tenant ID, issuer, audience, and
policy version. It evicts expired tokens and invalidates entries on logout,
token revocation, or tenant suspension. Those validity and tenant-key rules are
retained unchanged. The adapter, its invalidation hooks, and their existing
tests remain in use. One change to its surface is approved below (D8, 4A): the
adapter's public operations accept a `TenantContext` value rather than four
loose fields. Existing callers are migrated as part of this work and covered by
the regression suite (T1).

## What already exists

| Sub-problem | Existing code | Plan reuses or rebuilds? |
|---|---|---|
| Tenant-scoped cache keys (tenant, issuer, audience, policy version) | Existing cache adapter (PLAN.md:7-8) | Reused. `TokenStore` and the `AuthCache` facade were rebuilding this; both are dropped (D4). |
| Expiry eviction | Existing adapter (PLAN.md:8) | Reused unchanged. |
| Invalidation on logout / revocation / tenant suspension | Existing adapter hooks (PLAN.md:8-9) | Reused. Minted sessions are written under the tenant key so the same suspension hook evicts them (D6). |
| Existing auth entry point | `legacyAuthFlow()` (PLAN.md:27) | Kept callable behind a per-tenant flag until parity is proven, then deleted (D11). |
| Validate-then-dispatch pipeline | `validateAndDispatch()` (PLAN.md:23) | Split into three functions; behavior preserved, errors surfaced (D7). |

## Step 0: Scope decision (D4, option A)

Complexity check tripped: 12 files, 4 new classes over one backing cache.
Chosen: reduce to two new classes.

- `AuthBroker` and `SessionMint` receive the existing cache adapter by constructor injection. No module-level export of a mutable instance.
- `TokenStore` is dropped; its duty (storing validated tokens by tenant key) is what the adapter already does.
- `AuthCache` facade is dropped; services call the adapter through the injected interface. If an adapter method proves awkward for services during implementation, add the method to the adapter rather than a wrapper class.
- `RequestPolicy` becomes a typed plain object plus a pure `resolvePolicy(ctx, token)` function. No class, no state.
- Expected footprint: 7-8 files instead of 12.

Search check [Layer 1]: module-level singletons in Node share mutable state across every request in a long-lived process and can even double-instantiate under duplicated installs; the standard remedy is explicit constructor injection. Tenant-aware caching guidance is unanimous that every cache entry must encode tenant ownership and that caching layers are part of the security boundary. `Promise.all` is correct when all results are required, but concurrent fan-out to an identity provider needs concurrency control to avoid self-inflicted rate limiting. All three shaped the decisions below.

Sources consulted: [Module caching as a singleton](https://www.linkedin.com/pulse/module-caching-nodejs-practical-singleton-jo%C3%A3o-pedro-samarino-usidf), [Singleton, DI, IoC in Node.js](https://medium.com/@moali314/singleton-dependency-injection-ioc-and-service-locator-in-node-js-9a9c7a3326b7), [Tenant-aware caching](https://agnitestudio.com/blog/tenant-aware-caching-saas/), [Multi-tenant OAuth beyond token isolation](https://workos.com/blog/multi-tenant-oauth-beyond-token-isolation), [Token issuer isolation](https://duendesoftware.com/blog/20260520-token-issuer-isolation), [Beware of Promise.all](https://dev.to/jdorn/beware-of-promiseall-3pph), [Promise pool concurrency](https://davidwalsh.name/promise-pool).

## Architecture

### Component boundaries after review

```
                 request (raw)                 IDP (5 endpoints)
                      |                              ^
                      v                              | Promise.all + per-call timeout
  +-----------------------------------+              | single-flight per TenantContext
  |  auth entry (flag per tenant)     |              |
  |   flag off -> legacyAuthFlow()    |     +--------+---------+
  |   flag on  -> AuthBroker pipeline |     |    idpClient     |
  +-----------------+-----------------+     +--------+---------+
                    |                                ^
                    v                                |
  +-----------------------------------------------------------+
  |  AuthBroker  (SINGLE WRITER to the cache)                 |
  |   validate(raw) -> ValidatedToken | throws TokenInvalidError
  |   resolvePolicy(ctx, token) -> Policy | throws PolicyLookupError
  |   dispatch(ctx, policy) -> Result | throws DispatchError   |
  |   tenantStatus(ctx) -> active | suspended                  |
  |   applyMutation(ctx, op)  // atomic per-key adapter op     |
  +-----------------+-------------------------+---------------+
                    | reads + writes           | status reads / mutation requests
                    v                          |
  +----------------------------+     +---------+----------------+
  | existing cache adapter     |<----|  SessionMint (READ-ONLY  |
  |  key = TenantContext       |read |   on the adapter)        |
  |  {tenant, issuer,          |     |  mint(ctx, token):       |
  |   audience, policyVersion} |     |   1. broker.tenantStatus |
  |  evict on expiry           |     |   2. refuse if suspended |
  |  invalidate on logout /    |     |   3. broker.applyMutation|
  |   revoke / suspend         |     |      (register session   |
  +----------------------------+     |       under tenant key)  |
                                     +--------------------------+

  TenantContext is built in exactly ONE function, from the VALIDATED token,
  never from raw request input. The adapter accepts nothing else.
```

### Decisions recorded

**Issue 1 [P1] (confidence 8/10) PLAN.md:19-20, PLAN.md:10. Chosen 1A: single writer.**
Two unconstrained writers to the same tenant key with no serialized mutations produce lost updates that are silent and security-adjacent (a revoked token reappearing until eviction, a fresh session read as expired). `AuthBroker` is the only component that calls the adapter's write or delete operations, and it does so through atomic per-key operations (`getOrSet`, compare-and-swap). If the adapter lacks such an operation, add it to the adapter with its own test; do not emulate it in the service. `SessionMint` reads through the injected adapter and requests writes via `AuthBroker.applyMutation`. Test: two concurrent mutations on one tenant key, deterministic interleaving via a controllable adapter stub, assert final state and no lost update.

**Issue 2 [P2] (confidence 6/10, medium: verify the adapter's hook timing during implementation) PLAN.md:8-9. Chosen 2A: re-check at mint plus register for invalidation.**
Invalidation on tenant suspension is reactive. A mint that reads "valid" then completes after the suspension hook fires creates a live session on a suspended tenant that the hook never saw. `SessionMint.mint` calls `AuthBroker.tenantStatus(ctx)` immediately before minting and throws `TenantSuspendedError` if suspended. Minted sessions are written under the tenant key so the existing suspension hook evicts them. Tests: suspend between validate and mint, assert refusal; suspend after mint, assert the session is evicted; normal path, assert one extra status read and a cache hit.

### Security architecture notes

- `TenantContext` fields come from the validated token's claims (D8). A request header naming a different tenant never influences the cache key.
- Every typed error carries the tenant ID for logging but never the raw token.
- The flag (D11) is evaluated per tenant and read once per request; a flag-service outage falls back to the legacy path (safe default until the legacy path is deleted).

### Production failure scenarios for each new codepath

| Codepath | Realistic failure | Handled by plan? |
|---|---|---|
| `AuthBroker.validate` fan-out | One IDP endpoint hangs | Yes: per-call timeout, `IdpUnavailableError` names the call (D10) |
| `AuthBroker.validate` fan-out | Traffic spike, same tenant, 5N calls | Yes: single-flight per `TenantContext` (D10) |
| `AuthBroker.applyMutation` | Two writers interleave | Yes: single writer + atomic per-key op (D5) |
| `SessionMint.mint` | Tenant suspended mid-flight | Yes: mint-time status check + registration (D6) |
| `TenantContext` builder | Caller passes request-derived tenant | Yes: type accepts only builder output; builder reads token claims (D8) |
| Entry flag | Flag service unreachable | Yes: default to legacy until deletion (D11) |
| `validate` / `resolvePolicy` / `dispatch` | Downstream throws | Yes: typed error union, one boundary handler logs and maps (D7) |

## Code quality

**Issue 3 [P1] (confidence 8/10) PLAN.md:23-24. Chosen 3A: split and surface.**
`validateAndDispatch()` (60 lines, three nested try/catch, each swallowing a different error class) becomes three functions of roughly 15 lines each: `validate`, `resolvePolicy`, `dispatch`. Each returns a value or throws one member of a typed `AuthError` union (`TokenInvalidError`, `PolicyLookupError`, `DispatchError`, plus `TenantSuspendedError` and `IdpUnavailableError` from the sections above). Exactly one catch, at the request boundary, maps each error to a response and logs with tenant ID. Sequence: land the regression suite (T1) first, then this split, then the multi-tenant behavior. Tests: one per error class asserting it is surfaced, not swallowed; one asserting an unknown error is rethrown, not mapped.

**Issue 4 [P2] (confidence 6/10, medium: verify how the adapter exposes its key builder) PLAN.md:7-8, PLAN.md:19-20. Chosen 4A: one `TenantContext`.**
The four-field key is assembled in exactly one function next to the adapter, from the validated token. The adapter's public operations accept `TenantContext` only. Existing callers migrate in this change and are covered by T1. Tests: two tenants with the same issuer and audience share no entry; the builder test asserts fields come from token claims and ignores request input; a policy-version bump produces a distinct key.

DRY sweep beyond issue 4: the five IDP calls share one timeout wrapper and one error-mapping function (not five copies). The flag check lives in one place at the entry point.

Over/under-engineering: after D4 the design has two services, one adapter, one context type, one pure policy resolver, one flag. That is engineered enough for the stated goal; nothing is left that exists only for a hypothetical future.

Existing ASCII diagrams: none found in the repository (no source files present in this fixture). Add the diagrams listed under "Diagrams to embed in code".

## Tests

Test framework detection: no `package.json`, no test files in this repository snapshot. Test file names below follow the `*.test.ts` convention and must be adjusted to the real repository's convention at implementation time. Coverage diagram still applies.

### REGRESSION (CRITICAL, mandatory under the regression rule, no question asked)

PLAN.md:27-28 rewrites `legacyAuthFlow()` with no regression test, and PLAN.md:14-16 explicitly excludes it from planned coverage. This is a modification of existing behavior with no coverage of the changed path. **T1 is a blocking requirement:** before any rewrite, capture the current behavior of `legacyAuthFlow()` and `validateAndDispatch()` as a characterization suite: every accepted token shape, every rejected token shape, every error response, for at least two tenants. The same suite runs against the `AuthBroker` path behind the flag and must produce identical outcomes (parity oracle for D11). The split in issue 3 also modifies existing behavior and is covered by the same suite.

### Coverage diagram

```
CODE PATHS                                                  USER FLOWS
[~] auth entry (flag)                                       [+] Login (new tenant path)
  ├── [GAP] flag on  -> AuthBroker path                       ├── [GAP] [→E2E] login -> validate -> mint -> request OK
  ├── [GAP] flag off -> legacyAuthFlow (parity)               ├── [GAP] [→E2E] two tenants concurrently, isolated
  └── [GAP] flag service unreachable -> legacy default        └── [GAP]        double-submit login: one session, one IDP burst
[~] legacyAuthFlow()  **REGRESSION**                        [+] Revocation / suspension
  └── [GAP] CRITICAL characterization suite (T1)              ├── [GAP] [→E2E] revoke -> next request denied
[~] validateAndDispatch() -> validate/resolvePolicy/dispatch   ├── [GAP] [→E2E] suspend -> next request denied, mint refused
  ├── [GAP] validate: valid / TokenInvalidError               └── [GAP]        suspend tenant A, tenant B unaffected
  ├── [GAP] resolvePolicy: found / PolicyLookupError        [+] Error states the user sees
  ├── [GAP] dispatch: ok / DispatchError                      ├── [GAP]        IDP down: clear "identity provider unavailable"
  └── [GAP] boundary: each error mapped; unknown rethrown     ├── [GAP]        suspended tenant: clear tenant-suspended error
[+] AuthBroker                                                └── [GAP]        invalid token: explicit 401, never a silent pass
  ├── [GAP] 5 IDP calls in parallel, all succeed            [+] Boundary states
  ├── [GAP] one call times out -> IdpUnavailableError         ├── [GAP]        expired cache entry re-validated, not served
  ├── [GAP] one call rejects -> first error, others ignored   └── [GAP]        policy version bump -> old entry not reused
  ├── [GAP] single-flight: N concurrent = 1 fan-out
  ├── [GAP] single-flight entry cleared on failure
  ├── [GAP] applyMutation atomic: concurrent ops, no lost update
  └── [GAP] tenantStatus: active / suspended
[+] SessionMint
  ├── [GAP] mint happy path (status read hits cache)
  ├── [GAP] suspended before mint -> TenantSuspendedError
  ├── [GAP] suspended after mint -> session evicted by hook
  └── [GAP] never calls adapter write/delete (contract test)
[+] TenantContext builder
  ├── [GAP] fields from token claims, request input ignored
  ├── [GAP] two tenants same issuer/audience -> distinct keys
  └── [GAP] policy version bump -> distinct key
[+] resolvePolicy (pure)
  ├── [GAP] known tenant -> policy
  └── [GAP] unknown tenant -> PolicyLookupError

COVERAGE: 0/33 paths tested (0%)  |  Code paths: 0/22 (0%)  |  User flows: 0/11 (0%)
QUALITY: ★★★:0 ★★:0 ★:0  |  GAPS: 33 (5 E2E, 0 eval, 1 CRITICAL regression)
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke check | [→E2E] needs integration test. Coverage is 0% because no code exists yet in this snapshot; every path above is a test requirement for implementation, not a follow-up.

### Test requirements (write alongside the code, not after)

- `legacyAuthFlow.regression.test` (T1, CRITICAL): characterization suite described above; runs against both flag states.
- `errors.test`: one case per `AuthError` member asserting surfaced-not-swallowed; unknown error rethrown at the boundary.
- `authBroker.idp.test`: parallel success; timeout on call k of 5 for each k; rejection on one call; single-flight de-dup under N concurrent callers; single-flight entry cleared after failure.
- `authBroker.interleaving.test`: two concurrent mutations on one key via a controllable adapter stub; final state asserted; no lost update.
- `sessionMint.test`: happy path; suspended-before-mint refusal; suspended-after-mint eviction; contract test that `SessionMint` never invokes adapter write/delete.
- `tenantContext.test`: builder ignores request input; isolation across tenants sharing issuer and audience; policy-version key change.
- `resolvePolicy.test`: pure function, known and unknown tenant.
- `cutover.test`: flag on, flag off, flag service unreachable defaults to legacy.
- `authJourney.e2e.test` (T8, D9 option 5A): two tenants; login, validate (IDP mocked at the network edge), mint, authenticated request, revoke, denied; suspend tenant A, A denied and A's in-flight mint refused, B unaffected; double-submit login produces one session and one IDP fan-out.

QA test plan artifact written to `~/.gstack/projects/gstack-plan-count-v3IR5h/vercel-sandbox-main-eng-review-test-plan-20260910-193446.md` for `/qa` and `/qa-only`.

## Performance

**Issue 6 [P2] (confidence 8/10) PLAN.md:31-32. Chosen 6A: parallel with guards.**
The five IDP calls run under `Promise.all` (all results are required; partial success is not a valid token, so `allSettled` is the wrong tool here). Each call is wrapped in a timeout. Concurrent validations for the same `TenantContext` share one in-flight promise (single-flight map keyed by the context, entry removed on settle, including failure). The first rejection maps to `IdpUnavailableError` naming the failing call. Expected effect: uncached login latency falls from five round trips to one; peak IDP concurrency under a spike is 5 per distinct tenant context, not 5 per request.

No N+1 or memory concerns beyond the single-flight map, which is bounded by the number of distinct in-flight tenant contexts and self-clears.

## Implementation steps (ordered)

1. **T1** Characterization suite for `legacyAuthFlow()` and `validateAndDispatch()`. Green on current code before anything else changes.
2. **T4** `TenantContext` type and builder; adapter accepts `TenantContext`; migrate existing callers; T1 still green.
3. **T2** Split `validateAndDispatch()`; typed `AuthError` union; boundary handler; T1 still green.
4. **T3 + T9** `AuthBroker` and `SessionMint` with injected adapter; single-writer contract; `RequestPolicy` as typed object + `resolvePolicy`; atomic per-key adapter op added if missing.
5. **T5** Mint-time tenant status check; session registration under tenant key.
6. **T6** Parallel IDP validation with timeout, single-flight, typed error.
7. **T7** Per-tenant flag at the entry point; run T1 against both paths; default to legacy on flag outage; dated removal TODO.
8. **T8** Two-tenant E2E journey.
9. **T10** ASCII diagrams in code (below).

## Diagrams to embed in code

- `AuthBroker` module header: the validate → resolvePolicy → dispatch pipeline with the fan-out and single-flight box (the architecture diagram above, trimmed to the broker).
- Cache adapter module header: `TenantContext` → key, and the three invalidation triggers → eviction.
- Entry module: the cutover state machine below.

```
   flag(tenant) = off            flag(tenant) = on            legacy deleted
  +----------------+  enable    +------------------+  100%   +---------------+
  | legacyAuthFlow |----------->| AuthBroker path  |-------->| AuthBroker    |
  |  (default on   |<-----------|  (T1 parity      |         | only          |
  |  flag outage)  |  rollback  |   suite green)   |         |               |
  +----------------+            +------------------+         +---------------+
```

Diagram maintenance is part of every later change to these modules.

## Failure modes

| New codepath | Failure | Test? | Handling? | User sees | Critical gap? |
|---|---|---|---|---|---|
| IDP fan-out | timeout on one call | yes | `IdpUnavailableError` | clear "IDP unavailable" | no |
| IDP fan-out | spike, 5N calls | yes | single-flight | normal latency | no |
| single-flight map | entry not cleared after failure | yes | clear on settle | retry works | no |
| `applyMutation` | lost update | yes | single writer + atomic op | correct state | no |
| `SessionMint.mint` | tenant suspended mid-flight | yes | `TenantSuspendedError` | clear suspended error | no |
| `TenantContext` builder | request-derived tenant | yes | type + builder | correct tenant only | no |
| boundary handler | unknown error class | yes | rethrow, log | 500 with correlation id | no |
| entry flag | flag service down | yes | default legacy | unchanged behavior | no |
| `legacyAuthFlow` rewrite | behavior drift | yes (T1) | parity gate on flag | unchanged behavior | no |

Critical gaps flagged: 0. Before the review, the three swallowed error classes in `validateAndDispatch()` (PLAN.md:23-24) were untested, unhandled, and silent; D7 closes that.

## NOT in scope

- **Deleting `legacyAuthFlow()`**: deferred until the flag is at 100% with the parity suite green; tracked by the dated removal TODO created in T7.
- **Tenant-mismatch observability counter (TODO 2, D12)**: valuable, separable; lands after the refactor stabilizes. Recorded below for TODOS.md.
- **Encrypting cached tokens at rest**: raised by research on distributed token caches; the plan does not change the adapter's storage backend, so this is separate scope for the adapter owner.
- **Per-tenant issuer isolation (separate JWKS per tenant)**: architectural change to the IDP relationship, not this refactor.
- **Distribution**: no new artifact type (binary, package, image) is introduced; no pipeline change needed.

## TODOS.md updates

`TODOS.md` does not exist in this repository and cannot be created while plan mode is active. Create it with the entry below when implementation starts (format per gstack `TODOS-format.md`).

```markdown
# TODOS

## Auth

### Tenant-mismatch cache-read counter (cross-tenant leak detector)

**What:** On every adapter read, compare the tenant ID stored in the entry with the requesting `TenantContext`; on mismatch increment a metric, log at error level with both tenant IDs, and treat the read as a miss.

**Why:** Cache leakage is operationally invisible: latency and error rate look healthy while one tenant sees another's auth state. CI isolation tests (tenantContext.test, authJourney.e2e.test) prove isolation under test traffic only. This is the one runtime signal that fires in production.

**Context:** Decided in /plan-eng-review D12 (2026-09-10) as a follow-up rather than part of the refactor PR to keep that diff right-sized. Implement next to the `TenantContext` builder so the comparison is written once. Store the tenant ID in the entry payload (one extra field). Wire the metric to the existing alerting with a page-level threshold of 1.

**Effort:** S
**Priority:** P2
**Depends on:** `TenantContext` (T4) landed.
```

TODO 1 (feature-flagged cutover) was chosen as "build it now" (D11) and is T7 above, not a TODOS.md entry.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| T1 regression suite | tests/ | — |
| T4 TenantContext + adapter signature | cache adapter, auth/ (callers) | T1 |
| T2 split validateAndDispatch | auth/ (entry pipeline) | T1 |
| T3 + T9 AuthBroker, SessionMint, resolvePolicy | auth/ (new modules), cache adapter (atomic op) | T4 |
| T5 mint-time status check | auth/SessionMint | T3 |
| T6 parallel IDP | auth/AuthBroker, idp client | T3 |
| T7 flag cutover | auth entry, config | T2, T3 |
| T8 E2E | tests/e2e | T5, T6, T7 |
| T10 diagrams | auth/, cache adapter | T3 |

Lanes:
- Lane A: T1 → T4 → T3+T9 → T5 → T6 (sequential, shared auth/ and adapter)
- Lane B: T2 (after T1; touches the entry pipeline only)
- Lane C: T7 (after T2 and T3), then T8, then T10

Execution order: T1 first, alone. Then launch A (from T4) and B (T2) in parallel worktrees. Merge both. Then C sequentially.

Conflict flag: Lanes A and B both touch `auth/`. T2 edits the existing pipeline function, T4/T3 add new modules and change adapter call sites. Keep T2 from touching adapter call sites (leave those to T4) to avoid a merge conflict, or run B after T4.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~15 min)** — tests — Write the characterization/regression suite for `legacyAuthFlow()` and `validateAndDispatch()` before any rewrite (CRITICAL)
  - Surfaced by: Test review, REGRESSION RULE — PLAN.md:27-28 rewrites legacyAuthFlow() with no regression test
  - Files: legacy auth flow module, tests/auth/legacyAuthFlow.regression
  - Verify: suite green on current code; later green on both flag states
- [ ] **T2 (P1, human: ~1 day / CC: ~15 min)** — auth pipeline — Split `validateAndDispatch()` into validate / resolvePolicy / dispatch with a typed `AuthError` union and one boundary handler
  - Surfaced by: Code quality issue 3 (D7, 3A) — PLAN.md:23-24
  - Files: auth pipeline module, auth/errors, tests/auth/errors
  - Verify: one test per error class surfaced; unknown error rethrown; T1 green
- [ ] **T3 (P1, human: ~1.5 days / CC: ~20 min)** — AuthBroker / SessionMint — Constructor-inject the adapter; AuthBroker single writer via atomic per-key ops; SessionMint read-only, requests mutations
  - Surfaced by: Step 0 D4 + Architecture issue 1 (D5, 1A) — PLAN.md:19-20, PLAN.md:10
  - Files: auth/AuthBroker, auth/SessionMint, cache adapter (atomic op), tests/auth/interleaving
  - Verify: interleaving test, SessionMint write-contract test
- [ ] **T4 (P1, human: ~half day / CC: ~10 min)** — cache adapter — `TenantContext` type built once from the validated token; adapter accepts only `TenantContext`
  - Surfaced by: Code quality issue 4 (D8, 4A) — PLAN.md:7-8
  - Files: cache adapter, auth/TenantContext, tests/cache/tenantIsolation
  - Verify: isolation and builder tests; T1 green after caller migration
- [ ] **T5 (P1, human: ~half day / CC: ~10 min)** — SessionMint — Mint-time tenant status check (`TenantSuspendedError`) and session registration under the tenant key
  - Surfaced by: Architecture issue 2 (D6, 2A) — PLAN.md:8-9
  - Files: auth/SessionMint, tests/auth/sessionMint.suspension
  - Verify: suspend-before-mint refused; suspend-after-mint evicted
- [ ] **T6 (P2, human: ~1 day / CC: ~15 min)** — AuthBroker — Parallel IDP validation: `Promise.all` + per-call timeout + single-flight per `TenantContext` + `IdpUnavailableError`
  - Surfaced by: Performance issue 6 (D10, 6A) — PLAN.md:31-32
  - Files: auth/AuthBroker, idp client, tests/auth/idp.parallel
  - Verify: timeout per call k; rejection; N concurrent = one fan-out; entry cleared on failure
- [ ] **T7 (P2, human: ~1 day / CC: ~15 min)** — auth entry — Per-tenant flag selecting legacy vs AuthBroker; T1 runs against both; legacy default on flag outage; dated removal TODO
  - Surfaced by: TODO 1 (D11, build now) — PLAN.md:27-28 big-bang rewrite
  - Files: auth entry module, config/flags, tests/auth/cutover
  - Verify: cutover tests; parity suite green both ways
- [ ] **T8 (P1, human: ~1 day / CC: ~15 min)** — tests/e2e — Two-tenant journey: login → validate → mint → revoke → denied; suspend → denied; IDP mocked at the network edge
  - Surfaced by: Test issue 5 (D9, 5A) — PLAN.md:14-16
  - Files: tests/e2e/authJourney
  - Verify: journey passes; tenant B unaffected by tenant A's revocation and suspension
- [ ] **T9 (P2, human: ~half day / CC: ~10 min)** — scope — Fold `TokenStore` into the adapter; `RequestPolicy` becomes a typed object plus pure `resolvePolicy`
  - Surfaced by: Step 0 complexity check (D4, A) — PLAN.md:35-36
  - Files: auth/RequestPolicy (→ types + resolver), cache adapter
  - Verify: resolvePolicy tests; class count = 2
- [ ] **T10 (P2, human: ~2h / CC: ~5 min)** — docs — ASCII diagrams in AuthBroker, adapter, and entry module headers
  - Surfaced by: Required outputs, Diagrams
  - Files: auth/AuthBroker, cache adapter, auth entry module
  - Verify: diagrams match the shipped code paths
- [ ] **T11 (P3, human: ~half day / CC: ~10 min)** — observability — Tenant-mismatch cache-read counter (TODOS.md follow-up)
  - Surfaced by: TODO 2 (D12, add to TODOS.md)
  - Files: cache adapter, metrics
  - Verify: mismatch increments metric, logs, returns miss

Tasks JSONL: `~/.gstack/projects/gstack-plan-count-v3IR5h/tasks-eng-review-20260910-193708.jsonl` (11 tasks).

## Completion summary

- Step 0: Scope Challenge — scope reduced per recommendation (D4: 4 classes → 2, adapter injected)
- Architecture Review: 2 issues found (both resolved: 1A, 2A)
- Code Quality Review: 2 issues found (both resolved: 3A, 4A)
- Test Review: diagram produced, 33 gaps identified (1 CRITICAL regression, 5 E2E), all folded into test requirements; E2E decision 5A
- Performance Review: 1 issue found (resolved: 6A)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 2 items proposed (1 built now as T7, 1 added for TODOS.md)
- Failure modes: 0 critical gaps flagged (the swallowed-error gap was closed by D7)
- Outside voice: skipped (codex_reviews disabled by config)
- Parallelization: 3 lanes, 2 parallel / 1 sequential
- Lake Score: 6/6 scored recommendations chose the complete option

Retrospective learning: the branch has a single commit (`0f0ecb4 Seed review plan`); no prior review cycle to compare against.

## Suppressed findings (appendix, confidence below the display threshold)

- (confidence 5/10) Audience and issuer for the cache key might currently be derived from request input rather than token claims in existing callers. Cannot quote code in this snapshot. D8's builder makes this moot for new code; check existing callers during T4.
- (confidence 4/10) The cache adapter's stored payload may not be encrypted at rest. Storage backend is not changed by this plan; listed under NOT in scope.
- (confidence 4/10) The five IDP calls may include discovery/JWKS fetches that are cacheable independently of token validity; if so, cache them with a 5-15 minute TTL inside the IDP client. Verify during T6.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review` (plan-review phase) | Independent 2nd opinion | 1 | disabled | outside_status: disabled (codex_reviews=disabled); no outside findings |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (PLAN, SCOPE_REDUCED) | 7 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** provider codex, phase plan-review, completion state disabled (user config `codex_reviews=disabled`), findings none. No native fallback was dispatched because disabled is an intentional opt-out, not a provider failure. Outside coverage for this plan is absent.

**VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
