# Plan: Multi-tenant Auth Refactor (reviewed)

Reviewed by `/plan-eng-review` on 2026-09-10, branch `main`, commit `e51cff2`.
Mode: SCOPE_REDUCED (Step 0 accepted). Source plan: `PLAN.md`.
Caveat: the repository contains only `PLAN.md` and `CLAUDE.md`; no source
was available to read. Every finding below is grounded in plan text
(`PLAN.md:line`) and marked with its confidence. Module paths under `src/`
are placeholders to be mapped onto the real tree at implementation time.

## Context

Auth is being reworked so two services, `AuthBroker` (validates tokens and
dispatches requests) and `SessionMint` (issues sessions), serve multiple
tenants over the existing tenant-keyed cache adapter. The original plan
(`PLAN.md:18-36`) shared one module-level mutable `AuthCache` between both
services, rewrote `legacyAuthFlow()` in place with no regression test,
carried a 60-line `validateAndDispatch()` with three error-swallowing
catches, made five sequential IDP calls per validation, and introduced four
new classes across twelve files. This review keeps the goal (multi-tenant
auth on the existing adapter) and hardens how it gets there: injected
single-writer cache, staged cutover, explicit error results, parallel
validation, and full test coverage including the legacy regression.

## Existing contracts retained (unchanged from source plan)

The existing cache adapter keys entries by tenant ID, issuer, audience, and
policy version. It evicts expired tokens and invalidates entries on logout,
token revocation, or tenant suspension. `AuthCache` retains these validity
and tenant-key rules and is a service-facing facade over that same adapter,
with one backing cache. The adapter, its invalidation hooks, and their
existing tests remain in use unchanged (`PLAN.md:7-13`).

## Step 0: Scope decision (D4, accepted)

Complexity check triggered: 12 files, 4 new classes (`PLAN.md:35-36`).

Decision: **reduce**.
- `TokenStore` is cut. The adapter plus the `AuthCache` facade already own
  storage, eviction, and invalidation; a second storage abstraction had no
  stated job. (Plan-text evidence, confidence 6/10.)
- `RequestPolicy` starts as a module of pure functions
  (`src/auth/request-policy.ts`), promoted to a class only if it grows
  per-tenant state.
- New units: `AuthBroker`, `SessionMint`, `AuthCache` facade, plus the
  policy function module. Target footprint about 8 files.

Logged as decision `0fdd2895` via `gstack-decision-log`. Scope is settled;
later sections do not re-argue it.

## Architecture

### Component and data flow

```
                 request (tenant, token)
                          |
                          v
   +----------------------------------------------+
   |  composition root (one place, app startup)   |
   |  authCache = new AuthCache(existingAdapter)  |
   |  broker    = new AuthBroker(authCache, idp,  |
   |                             policyFns)       |
   |  mint      = new SessionMint(authCache, idp) |
   +----------------------------------------------+
          |  read / invalidate            | write (single writer)
          v                               v
   +-------------+                 +--------------+
   |  AuthBroker |  ---mint req--> |  SessionMint |
   +-------------+                 +--------------+
          \                               /
           \        AuthCache facade     /
            +---------------------------+
            | get(key) / invalidate(key)|
            | putIfVersion(key, entry,  |
            |   expectedPolicyVersion)  |
            +---------------------------+
                          |
                existing cache adapter
          (tenant, issuer, audience, policyVersion)
          eviction + invalidation hooks (unchanged)
```

### Issue 1 [P1] (confidence 8/10) `PLAN.md:19-20`, `:10` — shared global mutable cache (D5, approved: A)

Problem: both services mutate one module-level `AuthCache` and the facade
"does not serialize mutations". A tenant-suspension invalidation that fires
mid-mint can be followed by the mint's write, leaving a suspended tenant
with a live session. Module-level exports also leak state across tests and
double up under hot reload. **[Layer 1]** constructor injection is the
proven answer; the write-ordering problem needs an explicit rule on top.

Remedy (in plan):
1. No module-level export. `AuthCache` is constructed once in the
   composition root and passed to `AuthBroker` and `SessionMint` by
   constructor.
2. Single writer: `SessionMint` is the only component that writes session
   entries. `AuthBroker` reads and calls `invalidate`.
3. Version-checked writes: `AuthCache.putIfVersion(key, entry,
   expectedPolicyVersion)` rejects the write when the entry's policy
   version changed or the key was invalidated since the read. Returns an
   explicit `Rejected` result; `SessionMint` surfaces it as
   `TenantSuspended`/`Stale`, never retries blindly.
4. Unit test forces the interleaving (read → invalidate → write) and
   asserts the write is rejected.

```
   Write protocol (per tenant key)
   SessionMint            AuthCache                 adapter
      |  read(key) ----------> |  get ----------------> |
      |  <-- {entry, v=7} ---- |                        |
      |                        |  <== invalidate(key) ==|  (suspension hook)
      |  putIfVersion(key,     |                        |
      |     entry', expect=7)->|  compare v: gone/!=7   |
      |  <-- Rejected -------- |                        |
      |  => TenantSuspended, no session issued
```

### Issue 2 [P1] (confidence 8/10) `PLAN.md:27-28` — big-bang rewrite of `legacyAuthFlow()` (D6, approved: A)

Problem: the legacy path is replaced in one shot with no rollback other than
a redeploy. Multi-tenant auth means one wrong branch locks out a customer.

Remedy (in plan): strangler-fig cutover.
1. Per-tenant flag `auth.brokerPath` (values: `legacy`, `shadow`, `broker`).
2. `shadow`: run both paths, serve the legacy decision, log any mismatch
   (allow/deny, tenant, policy version, reason code) to a dedicated
   `auth.shadow.mismatch` event.
3. `broker`: serve the new path. Rollback is a flag flip, no deploy.
4. Legacy deletion is a follow-up PR (see TODOS) once mismatches are zero
   across all tenants for the agreed window.

```
   Cutover state machine (per tenant)
   [legacy] --enable shadow--> [shadow] --0 mismatches over window--> [broker]
      ^                          |                                      |
      +------- flag flip --------+------------ flag flip ---------------+
   Exit: all tenants in [broker] for N days  ==> delete legacy + flag (TODO)
```

Production failure scenarios considered:
- New path denies a valid token for one tenant: caught in `shadow` as a
  mismatch before any user is affected; in `broker`, flag flip restores
  legacy in seconds.
- Shadow doubles IDP load: acceptable for the window; metadata cache from
  Issue 5 keeps it to about one extra call per request.

## Code quality

### Issue 3 [P1] (confidence 8/10) `PLAN.md:23-24` — `validateAndDispatch()` swallows three error classes (D7, approved: A)

Problem: 60 lines, three nested try/catch blocks, each swallowing a
different error class. In auth a swallowed error is a silent deny at best
and a silent allow at worst, with no log line to tell a bad token from an
IDP outage.

Remedy (in plan):
1. Split into four small steps: `parseToken`, `validateToken`,
   `resolveTenant`, `dispatch`, each about 10 lines and unit-tested alone.
2. Each step returns a discriminated union:
   `Ok<T> | InvalidToken | TenantSuspended | IdpUnavailable | Unexpected`.
   No nested try/catch; a single try at the step that performs I/O maps the
   thrown error to one of these variants.
3. One boundary at the top (`validateAndDispatch`) maps each variant to a
   response code and a structured log with tenant id and request id.
   `Unexpected` always logs at error level and denies.
4. Callers consume the result type; no exceptions cross the boundary.

```
   validateAndDispatch (pipeline)
   parseToken -> validateToken -> resolveTenant -> dispatch
       |             |               |               |
     InvalidToken  IdpUnavailable  TenantSuspended  Ok
       \_____________|_______________|______________/
                              |
                    boundary: map -> response + log
                    Unexpected => 500 + error log + deny
```

DRY: key construction (tenant, issuer, audience, policyVersion) lives only
in the adapter; `AuthCache` exposes typed keys so neither service rebuilds
them.

## Tests

Test framework: none detectable in this repository (no `package.json`,
config, or test files). Test file names below follow `*.test.ts`; adjust to
the real project convention.

### Coverage diagram (planned code, after approved remedies)

```
CODE PATHS                                              USER FLOWS
[+] src/auth/auth-cache.ts                              [+] Login (tenant A, tenant B side by side)
  ├── get()                                               ├── [GAP] [→E2E] A logs in, B logs in, no cross read
  │   └── [GAP] hit / miss / expired                      ├── [GAP] [→E2E] Double-submit login → one session
  ├── invalidate()                                        └── [GAP] [→E2E] IDP timeout → clear retry message
  │   └── [GAP] logout / revoke / suspend (hook wiring)  [+] Logout
  └── putIfVersion()                                      └── [GAP] [→E2E] A logs out, B unaffected
      ├── [GAP] version matches → stored                 [+] Suspension / revocation
      ├── [GAP] version differs → Rejected                ├── [GAP] [→E2E] suspend A → next request denied
      └── [GAP] key invalidated since read → Rejected     ├── [GAP] [→E2E] revoke token → next request denied
[+] src/auth/session-mint.ts                              └── [GAP] [→E2E] suspend during mint → no session
  ├── mint()
  │   ├── [GAP] happy path                               [+] Cutover
  │   ├── [GAP] Rejected → TenantSuspended                ├── [GAP] flag=legacy serves legacy path
  │   └── [GAP] IDP failure → IdpUnavailable              ├── [GAP] flag=shadow logs mismatch, serves legacy
[+] src/auth/auth-broker.ts                               └── [GAP] flag=broker serves new path
  ├── parseToken()      [GAP] valid / malformed / empty
  ├── validateToken()   [GAP] ok / expired / bad sig     [+] Error states
  │   ├── [GAP] Promise.all one-fails → fail fast         ├── [GAP] IDP 500 → clear error, logged w/ tenant+req id
  │   ├── [GAP] per-call timeout → IdpUnavailable         ├── [GAP] malformed JWKS → deny, logged, no crash
  │   └── [GAP] metadata cache hit / miss / TTL expiry    └── [GAP] Unexpected → 500, error log, deny
  ├── resolveTenant()   [GAP] known / suspended / unknown
  ├── dispatch()        [GAP] ok / downstream error
  └── validateAndDispatch() boundary
      └── [GAP] every variant → response + log
[+] src/auth/request-policy.ts (pure fns)
  └── [GAP] each policy fn: allow / deny / edge inputs
[~] src/auth/legacy-auth-flow.ts (kept behind flag)
  └── [GAP] [CRITICAL REGRESSION] recorded corpus: legacy vs broker parity
[=] existing cache adapter                              (★★★ TESTED — existing suite, unchanged)

COVERAGE: 1/34 paths tested (3%)  |  Code paths: 1/22  |  User flows: 0/12
QUALITY: ★★★:1  |  GAPS: 33 (10 E2E, 1 CRITICAL regression, 0 eval)
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke | [→E2E] integration test | [+] new | [~] modified | [=] unchanged

### Issue 4 [P1] (confidence 9/10) `PLAN.md:14-16` — no end-to-end coverage of the auth flows (D8, approved: A)

Remedy (in plan): `test/e2e/multi-tenant-auth.e2e.test.ts` with a two-tenant
fixture and a fake IDP server.
- Login/logout/revoke/suspend/expired for tenant A while tenant B stays
  logged in; assert B never sees A's session and no cross-tenant cache read.
- Fake IDP injects timeout, 500, malformed JWKS; assert the user-visible
  error is explicit and the log carries tenant id and request id.
- Interleaving test: trigger suspension between read and write inside
  `SessionMint.mint()`; assert `putIfVersion` rejects and no session exists.
- Cutover tests: each flag value routes as specified; shadow mismatch event
  is emitted on a deliberately divergent case and absent on the happy path.

### CRITICAL regression test (mandatory under the regression rule, no question asked)

`legacyAuthFlow()` is existing behavior being replaced (`PLAN.md:27-28`) and
the source plan explicitly omitted a regression test (`PLAN.md:14-16`).
Add `test/auth/legacy-parity.regression.test.ts`:
- Record a corpus of real-shaped requests (valid, expired, revoked,
  suspended tenant, wrong audience, wrong issuer, malformed) with the
  legacy decision for each.
- Run the corpus through the new `AuthBroker` path and assert identical
  allow/deny and reason code for every entry.
- This test is also the shadow-mode oracle; it stays after legacy deletion,
  re-pointed at the recorded decisions.

### Unit tests (one file per module, every branch in the diagram)

- `auth-cache.test.ts`: get hit/miss/expired; invalidate per hook;
  putIfVersion stored/rejected-version/rejected-invalidated.
- `session-mint.test.ts`: happy, Rejected → TenantSuspended, IDP failure.
- `auth-broker.test.ts`: each step's variants; boundary mapping for every
  variant including `Unexpected`; Promise.all fail-fast; per-call timeout;
  metadata cache hit/miss/TTL expiry.
- `request-policy.test.ts`: every policy function, allow/deny/boundary
  inputs, null/empty tenant.

QA test plan artifact (for `/qa` and `/qa-only`):
`~/.gstack/projects/gstack-plan-count-kpTDIg/vercel-sandbox-main-eng-review-test-plan-20260910-211647.md`

## Performance

### Issue 5 [P2] (confidence 8/10) `PLAN.md:31-32` — five sequential IDP calls per validation (D9, approved: A)

Remedy (in plan):
1. `Promise.all` over the independent calls **[Layer 1, standard library]**.
   Fail-fast is correct: any failed check means the token is invalid, so
   partial results have no value (`Promise.allSettled` not appropriate).
2. Every IDP call wrapped with `AbortSignal.timeout(ms)`; a timeout maps to
   `IdpUnavailable`, never a hung login.
3. Per-issuer metadata cache (discovery document, JWKS) with TTL and
   key-rotation handling (on unknown `kid`, refresh once, then fail).
   Steady-state validation makes one IDP call instead of five.
4. Tests: one-fails fail-fast, timeout path, cache hit/miss/expiry, unknown
   kid refresh.

```
   before: IDP1 -> IDP2 -> IDP3 -> IDP4 -> IDP5      (5 RTT)
   after:  [discovery, JWKS from cache] + Promise.all([introspect, ...])  (~1 RTT)
           each call: AbortSignal.timeout -> IdpUnavailable
```

## Failure modes

| New codepath | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|
| `AuthCache.putIfVersion` | suspension between read and write | interleaving unit + E2E | Rejected → TenantSuspended | explicit deny |
| `SessionMint.mint` | IDP timeout mid-mint | unit + fake IDP E2E | IdpUnavailable | clear retry message |
| `AuthBroker.validateToken` | one of N calls fails | unit (fail-fast) | Promise.all rejects → InvalidToken/IdpUnavailable | explicit deny |
| `AuthBroker.validateToken` | hung IDP endpoint | unit (timeout) | AbortSignal.timeout | retry message, not a spinner |
| metadata cache | stale JWKS after key rotation | unit (unknown kid) | refresh once, then fail | brief deny, self-heals |
| `validateAndDispatch` boundary | unknown exception | unit (Unexpected) | 500 + error log + deny | generic error, logged |
| shadow mode | paths disagree | cutover test | mismatch event, legacy served | nothing (by design) |
| flag `broker` | new path wrong for a tenant | regression corpus | flag flip rollback | recovers in seconds |

Critical gaps in the source plan (no test, no handling, silent): swallowed
errors in `validateAndDispatch` and write-after-invalidate on the shared
cache. Both are closed by approved remedies (Issues 1 and 3). Open critical
gaps after review: 0.

## What already exists

- Existing cache adapter: tenant/issuer/audience/policy-version keying,
  eviction, invalidation hooks, and tests. Reused unchanged; `AuthCache` is
  a thin facade. `TokenStore` would have rebuilt this and is cut.
- `legacyAuthFlow()`: retained behind the per-tenant flag as the shadow
  oracle and regression baseline until deletion.
- `validateAndDispatch()`: exists; refactored, not rewritten from scratch.
- `Promise.all`, `AbortSignal.timeout`: platform built-ins, no dependency.

## NOT in scope

- `TokenStore` class: cut; storage is the adapter's job (D4).
- `RequestPolicy` as a class: deferred until it holds state (D4).
- Deleting `legacyAuthFlow()` and the cutover flag: follow-up PR after the
  shadow window (TODO below).
- Replacing or re-keying the existing cache adapter: out of scope; its
  contracts are retained by design.
- Adapter-level mutation serialization (locks): not needed once single
  writer + version-checked writes are in place.
- New distribution artifacts: none introduced; no pipeline work needed.

## Diagrams to embed in code

- `src/auth/auth-cache.ts`: the write-protocol sequence (Issue 1).
- `src/auth/auth-broker.ts`: the validateAndDispatch pipeline (Issue 3).
- `src/auth/cutover.ts` (flag routing): the cutover state machine (Issue 2).
- `test/e2e/multi-tenant-auth.e2e.test.ts`: two-tenant fixture layout.
Update these diagrams in the same commit as any change to the code they
describe.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| S1 AuthCache facade + putIfVersion + tests | src/auth/auth-cache, test/auth | — |
| S2 validateAndDispatch split + typed results + request-policy fns | src/auth/auth-broker, src/auth/request-policy, test/auth | — |
| S3 Promise.all + timeout + metadata cache | src/auth/auth-broker (validateToken), test/auth | S2 |
| S4 SessionMint on injected cache | src/auth/session-mint, test/auth | S1 |
| S5 Cutover flag + shadow compare + regression corpus | src/auth/cutover, src/auth/legacy-auth-flow, test/auth | S2, S4 |
| S6 Two-tenant E2E + fake IDP | test/e2e | S1–S5 |

Lanes:
- Lane A: S1 → S4 (sequential, shared cache contract)
- Lane B: S2 → S3 (sequential, both in auth-broker)
- Lane C: S5 (after A and B merge)
- Lane D: S6 (after C)

Execution: launch A and B in parallel worktrees; merge both; then C; then D.
Conflict flag: A and B both add tests under `test/auth/` in different files;
keep file names distinct to avoid merge noise.

## TODOS.md updates

TODOS.md does not exist; create it after plan mode exits with this entry
(approved D10):

- **What:** Delete `legacyAuthFlow()`, the `auth.brokerPath` flag, and the
  shadow-compare harness.
- **Why:** Two auth paths double surface area and drift risk; the flag is
  scaffolding with a planned exit.
- **Pros:** One path to reason about; smaller codebase.
- **Cons:** Must not happen before the mismatch window closes.
- **Context:** Issue 2 keeps legacy behind a per-tenant flag with shadow
  logging. Exit criteria: all tenants on `broker`, zero
  `auth.shadow.mismatch` events over the agreed window. Start in the
  composition root (remove flag routing), delete legacy and shadow harness,
  keep `legacy-parity.regression.test.ts` pointed at recorded decisions.
- **Depends on / blocked by:** this PR merged; shadow window elapsed.

## Post-plan-mode actions (approved, not plan-file edits)

- D1: append gstack skill routing rules to `CLAUDE.md` and commit
  (`chore: add gstack skill routing rules to CLAUDE.md`).
- D10: create `TODOS.md` with the entry above.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~20 min)** — AuthCache — Inject cache by constructor; single writer; add `putIfVersion` with rejection on version change or invalidation; interleaving unit test
  - Surfaced by: Architecture — Issue 1, `PLAN.md:19-20`, `:10`
  - Files: src/auth/auth-cache.ts, composition root, test/auth/auth-cache.test.ts
  - Verify: interleaving test rejects write after invalidate; no module-level `export const authCache`
- [ ] **T2 (P1, human: ~3 days / CC: ~30 min)** — Cutover — Per-tenant `auth.brokerPath` flag (legacy/shadow/broker); shadow mismatch event; legacy retained
  - Surfaced by: Architecture — Issue 2, `PLAN.md:27-28`
  - Files: src/auth/cutover.ts, src/auth/legacy-auth-flow.ts, test/auth/cutover.test.ts
  - Verify: each flag value routes correctly; mismatch event fires on divergent case only
- [ ] **T3 (P1, human: ~1 day / CC: ~20 min)** — AuthBroker — Split `validateAndDispatch` into parse/validate/resolveTenant/dispatch returning a discriminated union; single boundary with tenant+request-id logging; `Unexpected` denies
  - Surfaced by: Code Quality — Issue 3, `PLAN.md:23-24`
  - Files: src/auth/auth-broker.ts, src/auth/request-policy.ts, test/auth/auth-broker.test.ts, test/auth/request-policy.test.ts
  - Verify: no nested try/catch; every variant has a boundary test; grep shows no empty catch
- [ ] **T4 (P1, human: ~1 day / CC: ~15 min)** — Regression — CRITICAL: recorded-corpus parity test legacy vs broker
  - Surfaced by: Tests — regression rule, `PLAN.md:14-16`, `:27-28`
  - Files: test/auth/legacy-parity.regression.test.ts, test/fixtures/auth-corpus.json
  - Verify: 100% decision + reason-code parity across the corpus
- [ ] **T5 (P1, human: ~2 days / CC: ~30 min)** — E2E — Two-tenant suite with fake IDP: login/logout/revoke/suspend/expired, cross-tenant isolation, IDP timeout/500/malformed JWKS, suspend-during-mint
  - Surfaced by: Tests — Issue 4, `PLAN.md:14-16`
  - Files: test/e2e/multi-tenant-auth.e2e.test.ts, test/support/fake-idp.ts
  - Verify: suite green; isolation assertions present for every flow
- [ ] **T6 (P2, human: ~1 day / CC: ~15 min)** — AuthBroker — `Promise.all` over IDP calls, `AbortSignal.timeout` per call, per-issuer discovery/JWKS cache with TTL and unknown-kid refresh
  - Surfaced by: Performance — Issue 5, `PLAN.md:31-32`
  - Files: src/auth/auth-broker.ts, src/auth/idp-metadata-cache.ts, test/auth/auth-broker.test.ts
  - Verify: fail-fast, timeout, cache hit/miss/expiry, unknown-kid tests pass; steady-state call count is 1
- [ ] **T7 (P2, human: ~2h / CC: ~5 min)** — Scope — Remove `TokenStore` from the design; implement `RequestPolicy` as pure functions
  - Surfaced by: Step 0 — D4, `PLAN.md:35-36`
  - Files: src/auth/request-policy.ts (no TokenStore file)
  - Verify: no `TokenStore` symbol; request-policy has no class or module state
- [ ] **T8 (P3, follow-up)** — Cleanup — Delete legacy path, flag, and shadow harness after the mismatch window
  - Surfaced by: TODOS — D10
  - Files: src/auth/cutover.ts, src/auth/legacy-auth-flow.ts, composition root
  - Verify: parity regression test still green against recorded decisions

## Suppressed findings (appendix)

- [P3] (confidence 4/10) `PLAN.md:35` — `TokenStore` may have an undisclosed
  job (e.g. refresh-token persistence). Unverifiable without source; if so,
  reopen D4 for that one responsibility.
- [P3] (confidence 4/10) `PLAN.md:36` — `RequestPolicy` may need per-tenant
  state from day one. Unverifiable; promotion path documented in D4.

## Completion summary

- Step 0: Scope Challenge — scope reduced per recommendation (TokenStore cut, RequestPolicy as functions)
- Architecture Review: 2 issues found (both resolved: A)
- Code Quality Review: 1 issue found (resolved: A)
- Test Review: diagram produced, 33 gaps identified (1 CRITICAL regression, 10 E2E); all added to plan
- Performance Review: 1 issue found (resolved: A)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 1 item proposed to user (accepted)
- Failure modes: 2 critical gaps flagged in source plan, 0 open after remedies
- Outside voice: skipped (codex_reviews disabled)
- Parallelization: 4 lanes, 2 parallel / 2 sequential
- Lake Score: 5/5 recommendations chose complete option
- Unresolved decisions: 0

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review` (host: claude, phase: plan-review) | Independent 2nd opinion | 1 | disabled | skipped by config (`codex_reviews=disabled`) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (SCOPE_REDUCED) | 5 issues, 0 critical gaps open, 33 test gaps added to plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** provider codex, phase plan-review, status disabled (user opt-out via `codex_reviews=disabled`), no findings; no native fallback dispatched because disabled is terminal. Missing outside coverage is recorded, not counted as clean.
- **VERDICT:** ENG CLEARED — ready to implement. Re-enable outside voice with `gstack-config set codex_reviews enabled` if a second model's read is wanted before build.

NO UNRESOLVED DECISIONS
