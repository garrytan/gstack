# Plan: Multi-tenant Auth Refactor (reviewed by /plan-eng-review, 2026-09-10)

Source plan: `PLAN.md` at commit e20d167 on `main`. Review mode: SCOPE_REDUCED.
Every decision below was approved individually (D1 to D11). Nothing here was
auto-decided.

## Context

The auth layer is being refactored for multi-tenant operation. The original
plan added five new components (AuthBroker, SessionMint, AuthCache, TokenStore,
RequestPolicy) over the existing tenant-keyed cache adapter, rewrote
`legacyAuthFlow()` in place, and parallelized five IDP calls. The review found
the plan correct in intent but under-specified where auth plans hurt most:
write ownership of shared cache state, cutover safety, error visibility, and
proof via tests. The reviewed plan keeps the goal (two new services over the
existing adapter) and hardens the path to it.

Repo note: this checkout contains only `PLAN.md` and `CLAUDE.md`. No source,
test framework, or `TODOS.md` exists here, so findings cite plan lines
(`PLAN.md:N`) rather than code lines, and file paths below are module-level
targets to be mapped onto the real tree at implementation time.

## Decisions made in this review

| ID | Question | Decision |
|----|----------|----------|
| D1 | Add gstack routing rules to CLAUDE.md | Yes. Deferred until plan mode exits (see Deferred actions). |
| D2 | Run /office-hours first | No. Standard review. |
| D3 | Step 0 complexity check (12 files, 5 new components) | Reduce to 2 new services: AuthBroker + SessionMint. Existing adapter injected by constructor. AuthCache facade, TokenStore, RequestPolicy cut. |
| D5 | Arch 1: two writers on the shared cache | 1A. Single writer (AuthBroker) plus per-tenant generation check on write. |
| D6 | Arch 2: in-place rewrite of legacyAuthFlow | 2A. Per-tenant feature flag, shadow compare, staged 1% to 100% rollout, legacy kept through bake period. |
| D7 | Code quality 3: validateAndDispatch swallows errors | 3A. Split into validate() and dispatch(); typed errors; one boundary; nothing swallowed. |
| D8 | Tests 4: success/error paths only | 4A. Full edge, race, and isolation set. Regression test for legacyAuthFlow mandated by the regression rule (no question asked). |
| D9 | Perf 5: five sequential IDP calls | 5A. Promise.all with per-call AbortController timeout; cache discovery document and signing keys via the existing adapter. |
| D10 | TODO: post-bake cleanup | Add to TODOS.md (written after plan mode exits). |
| D11 | TODO: TokenStore/RequestPolicy re-evaluation trigger | Add to TODOS.md (written after plan mode exits). |

Lake Score: 5/5 scored recommendations chose the complete option.

## Step 0: Scope challenge (resolved)

**What existing code already solves sub-problems.** The existing cache adapter
already keys by tenant ID, issuer, audience, and policy version, evicts expired
tokens, and invalidates on logout, revocation, and tenant suspension
(`PLAN.md:7-10`). Its tests remain in use (`PLAN.md:12-13`). Every new
component reuses it; nothing rebuilds it.

**Minimum change that achieves the goal.** Two services that take the adapter
as a dependency. The AuthCache facade forwarded calls to the adapter with the
same rules (`PLAN.md:10-12`), so it added a layer without behavior. TokenStore
and RequestPolicy had no stated responsibility anywhere in the plan
(`PLAN.md:35`). The plan also counted 4 new classes while describing 5
(`PLAN.md:19` names AuthBroker separately).

**Complexity check.** Triggered (12 files, 5 new components). Resolved by D3:
scope reduced to 2 new services. Expected file count drops to roughly 7 to 8
(broker, session-mint, idp-client changes, adapter extension, flag router,
tests, docs).

**Search check** [Layer 1 throughout]. Web research (Aside unavailable, WebSearch
fallback) confirmed: dependency injection at a composition root over module-level
singletons is standard and the singleton's known cost is test interference and
un-mockable state; Promise.all fail-fast is the right primitive for login steps
that must all succeed, paired with AbortController timeouts; strangler fig with
per-tenant flags and shadow mode is the standard cutover for legacy auth.
No custom solution is proposed where a built-in exists. No eureka.

**TODOS cross-reference.** No `TODOS.md` in repo. Two TODOs created (D10, D11).

**Completeness check.** The original plan was a shortcut on tests
(`PLAN.md:14-16`) and cutover (`PLAN.md:27-28`). Both upgraded to complete.

**Distribution check.** No new artifact type. Not applicable.

## Architecture (reviewed)

### Components

- **AuthBroker** (new). Owns token validation and is the ONLY writer of
  validated entries to the cache adapter. Exposes `validate()` and
  `dispatch()` (formerly `validateAndDispatch()`).
- **SessionMint** (new). Mints sessions from validated tokens. Reads the
  adapter; triggers the adapter's existing invalidation hooks on logout. Never
  writes token entries.
- **Existing cache adapter** (extended, existing tests untouched). Gains a
  per-tenant generation counter: every invalidation for a tenant (logout,
  revocation, suspension) bumps it; a write carrying a stale generation is
  rejected. Also stores IDP discovery documents and signing keys under the
  existing tenant/issuer key with their own TTL.
- **Flag router** (new, small). Routes each tenant to `legacy`, `new`, or
  `shadow` mode; owns mismatch logging.
- **legacyAuthFlow()** (retained until bake completes). Frozen behavior,
  captured by the regression test.

Both services receive the adapter, the IDP client, and the flag router by
constructor injection at the composition root. No module-level mutable export.

### Request flow

```
 request ──▶ FlagRouter.mode(tenant)
               │
      ┌────────┼─────────────┐
      ▼        ▼             ▼
   legacy    shadow         new
      │        │             │
      │   ┌────┴────┐        │
      │   ▼         ▼        │
      │ legacy    new        │
      │   │         │        │
      │   └──compare──▶ log mismatch (tenant, field, both values)
      │   │ (legacy result is served)
      ▼   ▼                  ▼
  legacyAuthFlow()      AuthBroker.validate()
                              │
                     gen0 = adapter.generation(tenant)
                     hit?  ──yes──▶ cached claims
                       │no
                       ▼
                 Promise.all([ discovery*, keys*, introspect, userinfo, policy ])
                 (* served from adapter cache when fresh; each call has AbortController timeout)
                       │
              ┌────────┴────────┐
              ▼                 ▼
          all ok           any reject / timeout
              │                 │
   adapter.write(key, claims, gen0)      throw IdpError{call, cause}
              │
       ┌──────┴──────┐
       ▼             ▼
  gen0 == current   gen0 stale (invalidated mid-flight)
   stored           write rejected → throw ValidationError{reason: "invalidated"}
              │
              ▼
        AuthBroker.dispatch()  ── single error boundary ──▶ typed result to caller
              │
              ▼
        SessionMint.mint(claims)  (read-only on adapter)
```

### Write ownership and the generation check

```
 tenant T                        adapter[T].generation = g
 ─────────────────────────────────────────────────────────────────
 AuthBroker.validate  read g ──────────────▶ IDP calls (30-300 ms)
 admin suspends T                bump: generation = g+1, evict T entries
 AuthBroker.validate  write(claims, g) ───▶ REJECTED (g != g+1)
                                            caller gets ValidationError
 ─────────────────────────────────────────────────────────────────
 Without the check, the write at the last line lands and T stays
 authenticated until token expiry. That is the race PLAN.md:10
 ("they do not serialize mutations") left open.
```

The generation counter lives with the adapter, so it holds across processes
when the adapter is backed by a shared store. A process-local mutex (option 1B)
would not.

### Rollout state machine (per tenant)

```
  ┌────────┐  enable shadow   ┌────────┐  0 mismatches   ┌─────────────┐
  │ legacy │ ───────────────▶ │ shadow │ ──over window──▶ │ new (1%..)  │
  └────────┘                  └────────┘                  └─────────────┘
       ▲                          │                             │
       │        any mismatch      │            step %            ▼
       └──────────────────────────┘        1 → 10 → 50 → 100 ──▶ bake
       ▲                                                        │
       └──────── flag flip (instant rollback, no deploy) ───────┘
                                                                 │
                                                        bake window clean
                                                                 ▼
                                                   TODO 1: delete legacy + flag
```

### Security architecture

Tenant isolation rests on the adapter's existing key (tenant ID, issuer,
audience, policy version). The facade removal means no new code path can bypass
that key. The generation check closes the revoke/suspend window. The typed error
boundary guarantees a rejected validation is never mistaken for success. Tenant
isolation is verified end to end (test list below).

## Code quality (reviewed)

`validateAndDispatch()` (`PLAN.md:23-24`) becomes:

- `validate(token, tenant): Promise<Claims>` throws `ValidationError`,
  `IdpError`, or `PolicyError`. No try/catch inside except to wrap the raw
  IDP client failure into `IdpError{call, cause}`.
- `dispatch(result)` is the single error boundary. It maps each typed error to
  an explicit outcome (HTTP status and user-facing message) and logs with
  tenant, call, and reason. Unknown errors propagate; they are never swallowed.

DRY: the five IDP calls share one `timedCall(name, fn, timeoutMs)` helper that
attaches the AbortController and wraps failures into `IdpError`. Discovery and
key lookups share one `cachedOrFetch(key, ttl, fn)` helper over the adapter.

## Tests (reviewed)

Test framework: none detectable in this checkout (no `package.json`, no test
files). Diagram produced; test file names below follow the module names and
must be adjusted to the real tree's conventions.

### Coverage diagram (state after this plan lands)

```
CODE PATHS                                                   USER FLOWS
[+] auth/broker  AuthBroker.validate()                       [+] Sign-in
  ├── [GAP] cache hit, no IDP calls                            ├── [GAP] [→E2E] new path, per tenant
  ├── [GAP] 5/5 IDP calls succeed, write accepted              ├── [GAP] [→E2E] legacy path unchanged
  ├── [GAP] 4/5 succeed, 1 rejects → IdpError names the call   ├── [GAP] [→E2E] shadow: legacy served, mismatch logged
  ├── [GAP] 1 call exceeds timeout → IdpError{timeout}         └── [GAP]        double submit → one session
  └── [GAP] stale generation → write rejected, ValidationError
[+] auth/broker  AuthBroker.dispatch() boundary              [+] Revocation and suspension
  ├── [GAP] ValidationError → 401 + logged                     ├── [GAP] [→E2E] suspend mid-validation → rejected
  ├── [GAP] IdpError → 503 + logged                            ├── [GAP] [→E2E] revoke then retry → rejected
  ├── [GAP] PolicyError → 403 + logged                         └── [GAP]        logout then reuse cookie → rejected
  └── [GAP] unknown error propagates (not swallowed)
[+] auth/session-mint  SessionMint.mint()                    [+] Isolation
  ├── [GAP] claims present → session                           └── [GAP] [→E2E] tenant A token on tenant B route → rejected
  ├── [GAP] claims missing → ValidationError
  └── [GAP] never writes token entries (spy asserts 0 writes) [+] Error states the user sees
[+] auth/cache-adapter (extended)                              ├── [GAP] IDP slow → clear auth error, no hang
  ├── [★★★ TESTED] eviction + invalidation (existing tests)    └── [GAP] session expired → redirect to login
  ├── [GAP] generation bumps on logout/revoke/suspend
  ├── [GAP] write with stale generation rejected
  └── [GAP] discovery/keys TTL expiry and issuer-change invalidation
[+] auth/legacy-flow  legacyAuthFlow()
  └── [GAP] CRITICAL REGRESSION: current inputs → claims/errors captured
[+] config/flags  FlagRouter
  ├── [GAP] legacy / new / shadow routing per tenant
  ├── [GAP] shadow mismatch logged with both values
  └── [GAP] flag flip mid-traffic takes effect without restart

COVERAGE: 1/30 paths tested (3%)  |  Code paths: 1/20 (5%)  |  User flows: 0/10 (0%)
QUALITY: ★★★:1 ★★:0 ★:0  |  GAPS: 29 (7 E2E, 0 eval)  |  REGRESSION: 1 (CRITICAL)
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke
[→E2E] = integration test | all 29 gaps are required by this plan (D8: 4A).

### CRITICAL: regression test for legacyAuthFlow() (regression rule, mandatory)

What broke: `PLAN.md:27-28` rewrites existing behavior and `PLAN.md:15-16`
explicitly excludes it from coverage. Before any rewrite:

- `tests/auth/legacy-flow.regression.test` records, for a fixture set of
  tenants and tokens, the exact claims returned and the exact error for each
  failure case (expired, wrong audience, wrong issuer, suspended tenant,
  revoked token, malformed token).
- The same fixture set is the shadow comparator's assertion set and stays as
  the permanent behavioral spec after legacy is deleted.

### Required tests (one per GAP above)

Unit (`tests/auth/broker.test`): cache hit; 5/5 success; 4/5 with one reject;
timeout on one call; stale generation rejection; each typed error at the
boundary; unknown error propagates; `timedCall` and `cachedOrFetch` helpers.

Unit (`tests/auth/session-mint.test`): mint from claims; missing claims; zero
adapter writes (spy).

Unit (`tests/auth/cache-adapter.generation.test`): generation bump per
invalidation type; stale write rejected; discovery/keys TTL; issuer change
invalidates cached keys. Existing adapter tests remain untouched.

Unit (`tests/config/flags.test`): routing per mode; mismatch logging; live flip.

E2E (`tests/e2e/auth.e2e`): sign-in on new, legacy, and shadow paths; suspend
mid-validation; revoke then retry; logout then reuse; tenant A token on tenant
B route; double submit; IDP slow UX; session expiry UX.

## Performance (reviewed)

- Five IDP calls run under `Promise.all` (fail-fast is correct: all must
  succeed for a login). Each call has its own AbortController timeout; a
  timeout is an `IdpError{call, timeout: true}`, never a hang.
- Discovery document and signing keys are cached through the existing adapter
  under the tenant/issuer key with their own TTL, so a typical cache miss makes
  2 to 3 network calls instead of 5.
- Memory: cached discovery/keys are small and bounded per tenant/issuer.
- No N+1: one adapter read per request on the hot path, one write on miss.

## Failure modes (new codepaths)

| Codepath | Realistic production failure | Test | Handling | User sees |
|----------|------------------------------|------|----------|-----------|
| validate(): IDP call timeout | IDP endpoint hangs | yes | AbortController → IdpError | clear 503 auth error |
| validate(): 1 of 5 rejects | IDP 500 on introspection | yes | fail-fast IdpError names call | clear 503 auth error |
| validate(): write after suspension | admin suspends mid-flight | yes | generation check rejects write | 401, tenant stays locked out |
| dispatch(): unknown error | bug in new code | yes | propagates, logged | 500, visible in logs |
| SessionMint: stale claims | token evicted between validate and mint | yes | ValidationError | 401 with message |
| adapter: cached keys after IDP key rotation | JWKS rotated early | yes | TTL + issuer-change invalidation; signature failure triggers refetch | brief 401 then recovery |
| FlagRouter: shadow path throws | new path bug | yes | legacy result served, mismatch logged | nothing; logged |
| FlagRouter: flag store unreachable | config service down | yes | default to legacy | nothing |

Critical gaps after this plan: 0. The original plan had 2 (silent re-cache
after suspension; swallowed errors in `validateAndDispatch`), both closed by
D5 and D7.

## What already exists

- **Cache adapter with tenant/issuer/audience/policy key, eviction, and
  invalidation hooks** (`PLAN.md:7-10`). Reused as-is plus a generation counter
  and two new cacheable entry types. The original AuthCache facade would have
  rebuilt its interface with no new behavior; removed.
- **Existing adapter tests** (`PLAN.md:13`). Retained unchanged; the generation
  tests are additive.
- **legacyAuthFlow()** (`PLAN.md:27`). Retained as the rollback path and the
  behavioral oracle for shadow compare until bake completes.

## NOT in scope

- **AuthCache facade**: forwarded calls with the adapter's own rules; no
  behavior. Cut by D3.
- **TokenStore, RequestPolicy**: no stated responsibility anywhere in the plan.
  Cut by D3; re-evaluation trigger recorded (TODO 2).
- **Deleting legacyAuthFlow() and the rollout flag**: happens after 100%
  rollout plus bake window (TODO 1), not in this change.
- **Cross-process locking of cache writes**: replaced by the generation check,
  which is cheaper and holds across instances.
- **A dependency-injection container library**: constructor injection at the
  composition root is enough for two services; a container is premature.
- **Distribution/CI changes**: no new artifact type.

## Diagrams to embed in code comments

- `auth/broker`: the request flow diagram above (validate → Promise.all →
  generation-checked write → dispatch boundary).
- `auth/cache-adapter`: the write-ownership and generation-check timeline.
- `config/flags`: the per-tenant rollout state machine.
- `tests/auth/legacy-flow.regression.test`: a short diagram of fixture tenants
  and which failure each token exercises, since the fixture matrix is non-obvious.

No existing ASCII diagrams were found in this checkout to check for staleness.

## TODOs (approved; written to TODOS.md after plan mode exits)

1. **Remove legacyAuthFlow(), the rollout flag, and the shadow-compare
   harness after bake.** Why: prevents permanent dual-path debt on the auth hot
   path. Pros: one path, fewer branches, smaller flag config. Cons: waits on
   bake data; removes instant rollback. Context: cutover lands via T3; the T5
   regression test stays as the permanent spec. Depends on: T3 at 100% for all
   tenants and zero shadow mismatches over the bake window.
2. **Re-introduce TokenStore and/or RequestPolicy only when a named
   responsibility the adapter cannot cover appears.** Why: preserves the
   author's intent without speculative abstraction. Pros: explicit trigger.
   Cons: a real need surfaces as a mid-implementation revision. Context:
   `PLAN.md:35` named both with no responsibility; D3 cut them. Depends on: T1
   landed; a concrete gap found during T2 or T7.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| T1 reduce to 2 services, inject adapter | auth/broker, auth/session-mint | — |
| T2 generation check | auth/cache-adapter | — |
| T4 split validate/dispatch, typed errors | auth/broker | T1 |
| T5 legacy regression test | auth/legacy-flow (read), tests/auth | — |
| T3 flag + shadow + rollout | config/flags, auth/legacy-flow, auth/broker (routing seam) | T1, T5 |
| T7 Promise.all + timeouts + cached discovery/keys | auth/broker, auth/idp-client, auth/cache-adapter | T2, T4 |
| T6 full test set | tests/auth, tests/e2e | T2, T3, T4, T7 |
| T8 diagrams | auth/broker, auth/cache-adapter, config/flags | T3, T7 |

Lanes:
- Lane A: T1 → T4 → T7 (sequential, shared auth/broker)
- Lane B: T2 (independent, auth/cache-adapter)
- Lane C: T5 → T3 (sequential, shared auth/legacy-flow and config/flags)
- Lane D: T6 → T8 (after A, B, C merge)

Execution order: launch A, B, C in parallel worktrees. Merge B before A
reaches T7 (T7 needs the generation API). Merge A and C, then run D.

Conflict flags: Lanes A and C both touch auth/broker (T3 adds the routing
seam; T4 reshapes the function). Keep the routing seam to a single call site
in C and rebase C onto A before merging. Lanes A and B both touch
auth/cache-adapter at T7; T7 only consumes the API T2 adds, so merge B first.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~20 min)** — auth services — Reduce to AuthBroker + SessionMint; inject the existing adapter by constructor; drop AuthCache, TokenStore, RequestPolicy
  - Surfaced by: Step 0 scope challenge (D3) — `PLAN.md:19-20`, `PLAN.md:35`
  - Files: auth/broker, auth/session-mint, composition root
  - Verify: no module-level cache export; both services constructible with a fake adapter in tests
- [ ] **T2 (P1, human: ~1 day / CC: ~30 min)** — cache adapter — Single writer plus per-tenant generation check; invalidation bumps generation
  - Surfaced by: Architecture issue 1 (D5) — `PLAN.md:19-20`, `PLAN.md:10`
  - Files: auth/cache-adapter, auth/broker, auth/session-mint
  - Verify: `tests/auth/cache-adapter.generation.test` (stale write rejected); existing adapter tests still green
- [ ] **T3 (P1, human: ~3 days / CC: ~45 min)** — rollout — Per-tenant flag, shadow compare with mismatch logging, staged rollout; legacy kept through bake
  - Surfaced by: Architecture issue 2 (D6) — `PLAN.md:27-28`
  - Files: config/flags, auth/legacy-flow, auth/broker
  - Verify: `tests/config/flags.test`; E2E shadow run shows legacy served and mismatch logged
- [ ] **T4 (P1, human: ~1 day / CC: ~20 min)** — validateAndDispatch — Split into validate() and dispatch(); typed errors; one boundary; nothing swallowed
  - Surfaced by: Code quality issue 3 (D7) — `PLAN.md:23-24`
  - Files: auth/broker
  - Verify: boundary tests for each typed error; unknown error propagates
- [ ] **T5 (P1, human: ~1 day / CC: ~20 min)** — tests — CRITICAL regression test capturing legacyAuthFlow() behavior before any rewrite
  - Surfaced by: Test review REGRESSION RULE — `PLAN.md:27-28`, `PLAN.md:15-16`
  - Files: tests/auth/legacy-flow.regression.test
  - Verify: test passes against unmodified legacy; same fixtures drive shadow compare
- [ ] **T6 (P1, human: ~2 days / CC: ~40 min)** — tests — Full edge, race, isolation, and E2E set (all 29 gaps in the coverage diagram)
  - Surfaced by: Test issue 4 (D8) — `PLAN.md:14-16`
  - Files: tests/auth, tests/e2e
  - Verify: coverage diagram shows 30/30; E2E suite green
- [ ] **T7 (P2, human: ~1 day / CC: ~20 min)** — token validation — Promise.all with per-call AbortController timeout; cache discovery and signing keys via the adapter
  - Surfaced by: Performance issue 5 (D9) — `PLAN.md:31-32`
  - Files: auth/broker, auth/idp-client, auth/cache-adapter
  - Verify: timeout test produces IdpError, not a hang; cache-miss path makes at most 3 network calls with warm discovery/keys
- [ ] **T8 (P2, human: ~2h / CC: ~5 min)** — docs — Embed the three ASCII diagrams in code comments
  - Surfaced by: Required outputs, Diagrams
  - Files: auth/broker, auth/cache-adapter, config/flags
  - Verify: diagrams match the shipped flow; reviewed in PR

## Deferred actions (blocked by plan mode, run right after exit)

- D1: append the gstack skill-routing section to `CLAUDE.md` and commit it.
- D10, D11: create `TODOS.md` with the two approved TODOs.

## Suppressed findings (appendix)

- [P3] (confidence: 5/10) `PLAN.md:7` — if two issuers for one tenant share an
  audience and policy version, the key still differs by issuer, so no collision;
  unverified without adapter source. Medium confidence, verify this is actually
  an issue.
- [P3] (confidence: 4/10) `PLAN.md:19-20` — SessionMint may need to persist
  session records (not tokens); if so they belong in a separate keyspace, not
  the token cache. Unverified; suppressed.

## Completion summary

- Step 0: Scope Challenge — scope reduced per recommendation (5 new components → 2)
- Architecture Review: 2 issues found (both resolved: 1A, 2A)
- Code Quality Review: 1 issue found (resolved: 3A)
- Test Review: diagram produced, 29 gaps identified plus 1 CRITICAL regression; all added to plan (4A)
- Performance Review: 1 issue found (resolved: 5A)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 2 items proposed to user, 2 accepted (write deferred to post plan mode)
- Failure modes: 0 critical gaps remaining (2 in original plan, closed)
- Outside voice: skipped (codex_reviews disabled)
- Parallelization: 4 lanes, 3 parallel / 1 sequential after merge
- Lake Score: 5/5 recommendations chose complete option

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review` | Independent 2nd opinion | 1 | disabled | skipped (codex_reviews disabled) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (PLAN, SCOPE_REDUCED) | 6 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** provider codex, phase plan-review, outside_status disabled (user config `codex_reviews=disabled`), no findings; no native fallback dispatched because disabled is an opt-out, not a failure. Re-enable: `gstack-config set codex_reviews enabled`.
- **VERDICT:** ENG CLEARED — ready to implement. Outside coverage disabled by config; no cross-model comparison available.

NO UNRESOLVED DECISIONS
