# Plan: Multi-tenant Auth Refactor (reviewed)

Reviewed by `/plan-eng-review` on 2026-09-10 against PLAN.md at commit 0d7f121.
Nine decisions (D1-D9) were made interactively; each is recorded inline where it
changes the plan. Original plan text is kept where it still stands and marked
**(revised)** where a decision changed it.

## Context

The auth path is being refactored for multi-tenancy. The original plan introduced
two services (`AuthBroker`, `SessionMint`) sharing a mutable module-level
`AuthCache`, added `TokenStore` and `RequestPolicy` classes, rewrote
`legacyAuthFlow()` in place, and parallelized five IDP calls. Review found the
shape was over-built relative to the existing cache adapter, had a fail-open race
between two cache writers, swallowed errors in the dispatcher, had no rollout or
rollback path, and no regression protection for the flow being rewritten.

The outcome after review: a thinner auth path (two new services, no new cache
layer), a single cache writer with versioned writes so revocation always wins,
a fail-closed dispatcher with typed errors, a per-tenant strangler-fig rollout
with a loud fallback, full unit + integration coverage, and faster logins with
fewer IDP calls.

## Existing contracts retained

The existing cache adapter keys entries by tenant ID, issuer, audience, and
policy version. It evicts expired tokens and invalidates entries on logout,
token revocation, or tenant suspension. Those validity and tenant-key rules are
unchanged. The adapter, its invalidation hooks, and their existing tests remain
in use.

**(revised, D2)** One narrow addition to the adapter: the write path accepts a
policy-version tag and rejects a write whose tag is older than the current
version for that tenant. Existing adapter tests stay green; new tests cover the
rejection.

**(revised, D1)** `AuthCache` and `TokenStore` are not built. The adapter is the
single cache layer and is passed to services by constructor injection.

## Architecture (revised, D1 + D2)

New types: `AuthBroker` (read path) and `SessionMint` (sole write path).
`RequestPolicy` is a pure function over request + tenant config, not a class.
No module-level exports of mutable state; both services receive the adapter,
the IDP client, and the flag reader in their constructors.

```
                     per-tenant flag (D3)
                            │
 request ──> router ────────┼──────────────> legacyAuthFlow()   (unflagged tenants,
                            │                                    flag-store-down fallback D9)
                            └──────────────> validateAndDispatch()   (flattened, D4)
                                                 │
                        ┌────────────────────────┴──────────────────────┐
                        ▼                                               ▼
                   AuthBroker  (READ only)                     SessionMint  (SOLE WRITER)
                        │  get(cacheKeyFor(...))                        │  put(key, entry, policyVersion)
                        ▼                                               ▼
                 ┌──────────────────── existing cache adapter ──────────────────────┐
                 │ keys: tenant|issuer|audience|policyVersion                        │
                 │ rejects put() whose policyVersion < current (D2)                 │
                 │ invalidates on logout / revocation / suspension (unchanged)      │
                 └───────────────────────────────────────────────────────────────────┘
                                                 ▲
                        SessionMint ──> IDP client (static cache + parallel + timeout, D7)
```

### Cache write ownership (D2)

Only `SessionMint` writes. `AuthBroker` reads and, on revocation or suspension
signals, calls the adapter's existing invalidation hooks. Every write carries
the policy version read at validation start via `readPolicyVersion()`. The
adapter rejects a write whose version is stale and the rejection is logged at
warn with tenant ID and key. This makes "revoke racing a mint resurrects the
token" structurally impossible rather than unlikely.

```
 time ──────────────────────────────────────────────────────────────>
 SessionMint:  read pv=7 ─── validate (IDP) ─────────── put(key, e, pv=7) ✗ rejected, logged
 Admin:                      revoke ──> invalidate(key), pv := 8
 AuthBroker:                                             get(key) → miss → deny ✓
```

### Rollout (D3 + D9)

`legacyAuthFlow()` stays callable. A per-tenant flag routes each tenant to the
new flow or legacy. Rollout is tenant by tenant, starting with an internal
tenant. Rollback is a flag flip.

Flag-store failure: lookup has a short timeout; on timeout or error the router
falls back to `legacyAuthFlow()`, emits a warn-level structured log and a
`auth.flag_fallback` metric, and an integration test stubs the flag store as
down. Legacy removal is tracked in TODOS.md (D8) with the exit condition
"all tenants flagged on, no flips for one full release cycle".

### Security architecture

* Tenant isolation boundary is the cache key. One builder (D5) makes the tenant
  field structurally required.
* Every error class in the dispatcher denies (D4). Unknown errors deny.
* Revocation always wins the race (D2).
* Flag-store outage degrades to the known-good legacy path, never to an
  unvalidated pass (D9).

### Production failure scenarios per new codepath

| Codepath | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|
| `validateAndDispatch()` boundary | Unexpected exception mid-validation | yes (T4/T6) | deny + structured log (D4) | clear 401/403 |
| `AuthBroker` read | Adapter throws / cache backend down | yes (T6) | deny, log, metric | clear 503 |
| `SessionMint` write | Stale policy version after revoke | yes (T2/T6) | write rejected + warn log (D2) | denied on next request |
| `SessionMint` write | Adapter write throws | yes (T6) | deny, no partial state | clear 503 |
| IDP client | One of N calls rejects | yes (T7) | Promise.all rejects, all outcomes logged, deny | clear 503 |
| IDP client | Call hangs | yes (T7) | per-call timeout → deny | clear 503, retry safe |
| IDP static cache | JWKS key rotation, unknown `kid` | yes (T7) | one forced refetch, then deny | brief retry, then works |
| Flag router | Flag store unreachable | yes (T3/T6) | legacy fallback + metric (D9) | nothing, legacy behavior |
| `cacheKeyFor()` | Two tenants collide | yes (T5) | impossible by construction | n/a |

**Critical gaps (no test, no handling, silent): 0.**

## Code quality (revised, D4 + D5)

`validateAndDispatch()` was 60 lines with three nested try/catch blocks, each
swallowing a different error class. It is rewritten as a linear pipeline of
small steps:

```
 parseToken ──> resolveTenant ──> checkPolicy ──> validateWithIdp ──> mintSession ──> dispatch
     │               │                │                 │                  │
  TokenError     TenantError      PolicyError        IdpError          CacheError
     └───────────────┴────────────────┴─────────────────┴──────────────────┘
                                      │
                        single boundary catch:
                        map error → explicit DENY result
                        structured log {tenant, step, errorClass}
                        metric auth.deny{reason}
                        unknown Error → DENY (fail closed)
```

Typed errors: `TokenError`, `TenantError`, `PolicyError`, `IdpError`,
`CacheError`, all extending `AuthError`. Callers that relied on a swallowed
error to continue now receive an explicit deny and are updated in this PR.

DRY: `cacheKeyFor(tenantId, issuer, audience, policyVersion)` and
`readPolicyVersion(tenantId)` live in one shared module used by `AuthBroker`
and `SessionMint`. One test asserts every field is present and ordered and that
two different tenants never produce the same key.

Inline ASCII diagram comments to add at implementation:
* adapter write path: the versioned-write timeline above
* `validateAndDispatch()`: the pipeline diagram above
* router: flag decision tree including the fallback branch
* `SessionMint`: mint pipeline and the sole-writer contract

## Tests (revised, D6 + REGRESSION RULE)

**CRITICAL regression suite (mandatory, IRON RULE).** `legacyAuthFlow()` is
existing behavior being rewritten and the original plan had no regression
coverage. Before any rewrite, write a characterization suite that pins current
behavior: valid token → allow, expired → deny, wrong issuer/audience → deny,
suspended tenant → deny, logout invalidates. The suite runs against both the
legacy path and the new flow (via the flag) for the whole rollout window.

Coverage target: every branch in the diagram below, unit and integration.

```
CODE PATHS                                                   USER FLOWS
[~] legacyAuthFlow()  (flag-routed, kept)                    [+] Login / token validation
  ├── [CRITICAL] regression: valid token → allow               ├── [→E2E] Login on flagged tenant → new flow
  ├── [CRITICAL] regression: expired → deny                    ├── [→E2E] Login on unflagged tenant → legacy
  ├── [CRITICAL] regression: wrong audience/issuer → deny      ├── [→E2E] Flag flipped mid-session → no lockout
  └── [CRITICAL] regression: suspended tenant → deny           └── [→E2E] Flag store down → legacy + metric (D9)
[+] validateAndDispatch()  (flattened, D4)                   [+] Revocation / logout
  ├── happy path → dispatch                                    ├── [→E2E] Revoke → next request denied
  ├── TokenError → deny + log                                  ├── [→E2E] Revoke racing mint → stale write rejected (D2)
  ├── TenantError → deny + log                                 └──        Tenant suspended → all tokens denied
  ├── PolicyError → deny + log
  ├── IdpError → deny + log                                  [+] Tenant isolation
  ├── CacheError → deny + log                                  ├── [→E2E] Tenant A token never validates for B
  └── unknown Error → deny + log (fail closed)                 └──        Same issuer/audience, different tenant → miss
[+] AuthBroker (read path)
  ├── cache hit → allow                                      [+] Error states
  ├── cache miss → IDP validate                                ├── IDP timeout → clear 503, not 401
  └── adapter throws → deny                                    ├── IDP 5xx → clear 503, retry safe
[+] SessionMint (sole writer, D2)                              └── Partial IDP failure → deny, all outcomes logged
  ├── mint → write with policy version
  ├── stale version → write rejected + logged
  └── adapter write throws → deny, no partial state
[+] cacheKeyFor() / readPolicyVersion()  (D5)
  ├── all four fields required and ordered
  └── two tenants never collide
[+] IDP client (D7)
  ├── static responses served from cache within TTL
  ├── unknown kid → one forced JWKS refetch
  ├── all parallel calls succeed
  ├── one rejects → aggregate error, no hang
  └── per-call timeout fires

TARGET: 34/34 paths tested (100%)  |  Code paths: 22/22  |  User flows: 12/12
GAPS BEFORE REVIEW: 27 (7 E2E, 4 CRITICAL regression)  |  GAPS AFTER PLAN: 0
```

Test harness: a fake adapter with an injectable write delay (for the D2 race
test) and an IDP stub that can fail, hang, or rotate keys per call. Integration
flows run against those fakes; no live IDP in CI.

## Performance (revised, D7)

Token validation issued 5 sequential IDP calls. Revised:

1. Static IDP responses (OIDC discovery document, JWKS) are cached with a TTL in
   the existing adapter; unknown `kid` triggers one forced refetch.
   Assumption: two of the five calls are these static fetches. If none are,
   step 2 still applies.
2. Remaining calls run with `Promise.all`, each wrapped in a per-call timeout.
   Any rejection denies the request; all outcomes are logged so a partial
   failure is diagnosable.
3. Expected result: login latency drops from 5 round trips to 1, IDP request
   volume drops by up to 40 percent, and a hung IDP call cannot hang a login.

## Scope (revised, D1)

Complexity check triggered on the original plan (12 files, 4 new classes plus
`AuthBroker`). Reduced to: 2 new service types, 1 shared helper module, 1 typed
error module, 1 narrow adapter change, 1 router change, the rewritten
dispatcher, and tests. Roughly 8 source files plus tests.

## What already exists

| Sub-problem | Existing code | Plan now |
|---|---|---|
| Tenant-scoped cache keying, expiry, invalidation | cache adapter + hooks + tests | reused unchanged, one write-path addition (D2) |
| Current auth behavior | `legacyAuthFlow()` | kept as flag fallback and regression oracle (D3) |
| Service-facing cache facade | none needed; adapter API suffices | `AuthCache` dropped (D1) |
| Token storage | adapter already stores tokens | `TokenStore` dropped (D1) |
| Request policy evaluation | none; was a proposed class | pure function (D1) |

## NOT in scope

* **Deleting `legacyAuthFlow()` and the per-tenant flag** — tracked in
  TODOS.md (D8); happens after 100 percent rollout plus one release of bake.
* **Adding an `AuthCache` facade** — only if a future consumer needs a narrower
  API than the adapter; not justified today (D1).
* **Rewriting the cache adapter itself** — one write-path addition only (D2);
  its keying and invalidation rules are unchanged.
* **IDP-side rate-limit negotiation or client-credential changes** — the
  static cache (D7) reduces load; anything beyond that is separate work.
* **Multi-region cache consistency** — out of scope for this refactor; the
  versioned write (D2) is single-backing-cache correct as the plan states.
* **New artifact distribution** — no new binary, package, or image; N/A.

## TODOS.md updates (apply at implementation start; plan mode forbade the edit)

```markdown
# TODOS

## Auth

### Remove legacyAuthFlow() and the per-tenant new-flow flag

**What:** Delete legacyAuthFlow(), the per-tenant new-flow flag, the flag-store
fallback path, and the legacy branch of the regression suite.

**Why:** Two auth code paths double the test and review cost of every future
auth change and keep a fallback alive that no longer has anything to fall back
from.

**Context:** /plan-eng-review D3 (2026-09-10) chose a strangler-fig rollout:
legacyAuthFlow() stays callable behind a per-tenant flag while the new
AuthBroker + SessionMint flow rolls out tenant by tenant. D9 added a
flag-store-down fallback to legacy. The regression suite pins legacy behavior
and runs against both paths during rollout. Start in the router and the
regression suite; the flag reader and fallback metric go with them.

**Effort:** S
**Priority:** P2
**Depends on:** All tenants flagged on to the new flow with no flag flips for
one full release cycle.
```

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| S1 Regression suite for `legacyAuthFlow()` | tests/auth/legacy | — |
| S2 Shared helpers + typed errors | auth/shared | — |
| S3 Adapter versioned-write rejection | cache adapter module | S2 (policy version helper) |
| S4 IDP client: static cache, parallel, timeout | auth/idp | — |
| S5 `AuthBroker` + `SessionMint` | auth/services | S2, S3, S4 |
| S6 Flattened dispatcher + flag router + fallback | auth/dispatch | S2, S5 |
| S7 Integration flows | tests/auth/integration | S5, S6 |

Lanes:
* Lane A: S1 (independent)
* Lane B: S2 → S3 → S5 → S6 (sequential, shared auth/ services and adapter)
* Lane C: S4 (independent)
* Lane D: S7 (after B and C merge)

Execution order: launch A, B, C in parallel worktrees. Merge A first (it is
pure tests and gates the rewrite). Merge C, then B. Then D.

Conflict flags: Lanes B and C both live under auth/; keep S4 confined to
auth/idp and its own test file to avoid merge conflicts with auth/services.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~15min)** — tests/auth/legacy — Write the CRITICAL characterization suite for `legacyAuthFlow()` before any rewrite; run it against legacy and new flow
  - Surfaced by: Test review — REGRESSION RULE, PLAN.md:27-28 and :14-16
  - Files: tests/auth/legacy/*, router flag stub
  - Verify: suite green on legacy path before S5/S6 land; green on both paths after
- [ ] **T2 (P1, human: ~1.5 days / CC: ~25min)** — cache adapter + auth/services — Single writer: only `SessionMint` writes; writes carry policy version; adapter rejects stale writes with warn log
  - Surfaced by: Architecture — D2, PLAN.md:10, 19-20
  - Files: cache adapter write path, auth/services/SessionMint, auth/services/AuthBroker
  - Verify: unit test for stale-write rejection; integration test "revoke racing mint → denied"
- [ ] **T3 (P1, human: ~1.25 days / CC: ~23min)** — auth/dispatch — Per-tenant flag router with legacy fallback on flag-store failure, timeout, warn log, `auth.flag_fallback` metric
  - Surfaced by: Architecture — D3 + D9, PLAN.md:27-28
  - Files: auth/dispatch/router, flag reader interface
  - Verify: integration tests for flagged, unflagged, mid-session flip, flag store down
- [ ] **T4 (P1, human: ~1 day / CC: ~20min)** — auth/dispatch — Flatten `validateAndDispatch()` into a linear pipeline with typed errors and one fail-closed boundary
  - Surfaced by: Code quality — D4, PLAN.md:23-24
  - Files: auth/dispatch/validateAndDispatch, auth/shared/errors
  - Verify: one unit test per error class plus unknown-error → deny; no catch without a deny
- [ ] **T5 (P2, human: ~2h / CC: ~5min)** — auth/shared — `cacheKeyFor()` and `readPolicyVersion()` helpers used by both services, with ordering and no-collision tests
  - Surfaced by: Code quality — D5, PLAN.md:7-8
  - Files: auth/shared/cacheKey, tests
  - Verify: unit tests; grep shows no other key construction in auth/
- [ ] **T6 (P1, human: ~2 days / CC: ~30min)** — tests/auth/integration — Integration flows: revocation race, tenant isolation, flag routing, IDP partial failure, flag store down, adapter failures
  - Surfaced by: Test review — D6 coverage diagram, 7 [→E2E] flows
  - Files: tests/auth/integration/*, fake adapter with write delay, IDP stub
  - Verify: all 12 user flows in the diagram green
- [ ] **T7 (P2, human: ~1 day / CC: ~20min)** — auth/idp — TTL-cache static IDP responses, `Promise.all` with per-call timeout for the rest, forced JWKS refetch on unknown kid
  - Surfaced by: Performance — D7, PLAN.md:31-32
  - Files: auth/idp/client, tests
  - Verify: unit tests for cache hit, rotation refetch, one-rejects, timeout; latency measurement 5 RTT → 1 RTT
- [ ] **T8 (P2, human: ~0.5 day / CC: ~10min)** — auth/services — Drop `AuthCache` and `TokenStore`; `RequestPolicy` as pure function; constructor injection for adapter, IDP client, flag reader
  - Surfaced by: Step 0 — D1, PLAN.md:19-20, 35-36
  - Files: auth/services/*, auth/shared/requestPolicy
  - Verify: no module-level mutable exports in auth/ (grep); services unit-testable with fakes
- [ ] **T9 (P3, human: ~5min / CC: ~1min)** — TODOS.md — Add the legacy-removal TODO with its exit condition
  - Surfaced by: TODOS.md updates — D8
  - Files: TODOS.md
  - Verify: entry present in the format above

## Completion summary

- Step 0: Scope Challenge — scope reduced per recommendation (D1: 4-5 new classes → 2 services + helpers)
- Architecture Review: 2 issues found (D2 cache write race, D3 rollout); 1 follow-on failure mode (D9)
- Code Quality Review: 2 issues found (D4 swallowed errors, D5 key builder DRY)
- Test Review: diagram produced, 27 gaps identified (4 CRITICAL regression, 7 E2E); all added to plan (D6)
- Performance Review: 1 issue found (D7)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 1 item proposed to user (D8, accepted)
- Failure modes: 0 critical gaps flagged
- Outside voice: skipped (codex_reviews disabled)
- Parallelization: 4 lanes, 3 parallel / 1 sequential follow-on
- Lake Score: 7/7 coverage-scored recommendations chose the complete option (D1, D8 were kind-only)

Setup prompts deferred this run (not approvals): CLAUDE.md routing rules (plan
mode forbids the edit and commit), /office-hours design-doc offer (explicit
review request), cross-project learnings toggle (learnings store empty).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review` | Independent 2nd opinion | 1 | disabled | skipped (codex_reviews=disabled) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (PLAN) | 32 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

### Suppressed findings (confidence below 7, appendix only)

- (confidence: 5/10) PLAN.md:19 vs :35 — `AuthBroker` is a new service but is missing from the "4 new classes" list; the real count was 5. Informational; resolved by D1.
- (confidence: 5/10) PLAN.md:31-32 — the five IDP calls are not named; the D7 static-cache step assumes two are OIDC discovery and JWKS. Verify at implementation.
- (confidence: 4/10) PLAN.md:35 — `RequestPolicy` contents are undefined; treated as a pure function (D1). Revisit if it needs state.

**OUTSIDE COVERAGE:** provider codex, phase plan-review, status disabled by config (`codex_reviews=disabled`), no findings; no native fallback was dispatched because disabled is an intentional opt-out, not a provider failure.

**VERDICT:** ENG CLEARED — ready to implement (1 clean plan-eng-review run within 7 days, 0 unresolved, 0 critical gaps). Outside review disabled by config; CEO, Design, DX reviews not run and not required.

NO UNRESOLVED DECISIONS
