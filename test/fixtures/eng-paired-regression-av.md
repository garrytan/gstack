# Plan: Multi-tenant Auth Refactor (reviewed)

## Tests

Test framework: none detectable in this review fixture (no `package.json`,
no test files). The target repo is JavaScript or TypeScript (the plan uses
`Promise.all`). File names below follow `test/<area>/<unit>.test.ts`; match the
real repo's runner and naming when implementing.

**REGRESSION RULE (mandatory, no decision required):** `legacyAuthFlow()` is
existing behavior being modified with no covering test (PLAN.md:14-16, 27-28).
A regression test is a CRITICAL requirement of this plan: record
`legacyAuthFlow()` outputs on a fixture set covering each tenant shape, valid
and invalid tokens, and each invalidation reason, before any rewrite begins.
A parity test then runs the same fixtures through `AuthBroker` and asserts
identical results. Both live until the legacy path is deleted.

**Decision: D6 = 4A (full coverage).**

### Tests to add (every GAP above)

| File | Kind | Asserts |
|------|------|---------|
| `test/auth/legacyAuthFlow.regression.test.ts` | unit, CRITICAL | recorded fixture outputs unchanged |
| `test/auth/parity.test.ts` | integration, CRITICAL | legacy and AuthBroker agree on every fixture |

## Implementation Tasks

- [ ] **T4 (P1, human: ~1 day / CC: ~15 min)** — tests — CRITICAL regression fixtures for legacyAuthFlow() and parity test against AuthBroker
  - Surfaced by: Test review REGRESSION RULE, PLAN.md:14-16,27-28
  - Files: `test/auth/legacyAuthFlow.regression.test.ts`, `test/auth/parity.test.ts`
  - Verify: both suites green before and after the rewrite
