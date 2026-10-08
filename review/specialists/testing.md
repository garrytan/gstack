# Testing Specialist Review Checklist

Scope: Always-on (every review)
Output: JSON objects, one finding per line. Schema:
{"severity":"CRITICAL|INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"testing","summary":"...","fix":"...","fingerprint":"path:line:testing","specialist":"testing"}
Optional: line, fix, fingerprint, evidence, test_stub.
If no findings: output `NO FINDINGS` and nothing else.

If the caller explicitly asks for an ASCII coverage diagram, first read the
named source and test files directly in a dedicated tool call. Keep that tool
call limited to those two file reads, using either native Read calls or a simple
shell display such as `cat -n src/file && echo ---- && cat -n test/file`. Read
diffs, package files, configs, or other context in separate tool calls. Then
output the diagram before any JSON findings. Use one function root per public or
changed function, put the `[OK]` or `[GAP]` marker on the same branch row as the
tested or missing path, and keep the legend inside the same diagram block:

```text
src/billing.ts
processPayment(amount, currency)
├── valid USD happy path returns success [OK]
└── invalid amount / unsupported currency branches [GAP]
refundPayment(paymentId, reason)
└── refund success and guard branches not imported or untested [GAP]
Legend: [OK] tested [GAP] no test
```

Do not rely on a summary table, prose paragraph, or distant nested marker as the
only coverage evidence. Covered happy-path rows must name the successful, valid,
or concrete tested input path; gap rows must stay under the function that owns
the missing path.

---

## Categories

### Exploratory hypotheses

The parent runs one shared exploratory QA pass before Fix-First, including small diffs
that skip specialists. Supply high-risk changed contracts, adverse scenarios and native
test candidates to that pass; do not launch another explorer, edit product/tests or
commit. A test proposal uses `test_stub` and keeps the caller's approval requirements.
Check real request/queue/storage effects, retries, duplicates and interrupted recovery
where applicable. A diagram or test count is not executed proof. For discoveries promoted
to regressions, require failure for the reproduced bug before repair and green plus
original/adjacent probes afterward; never accept buggy-output goldens or discarded valid
red tests. Unit tests suit logic; real integration/E2E tests protect boundaries mocks hide.

### Missing Negative-Path Tests
- New code paths that handle errors, rejections, or invalid input with NO corresponding test
- Guard clauses and early returns that are untested
- Error branches in try/catch, rescue, or error boundaries with no failure-path test
- Permission/auth checks that are asserted in code but never tested for the "denied" case

### Missing Edge-Case Coverage
- Boundary values: zero, negative, max-int, empty string, empty array, nil/null/undefined
- Single-element collections (off-by-one on loops)
- Unicode and special characters in user-facing inputs
- Concurrent access patterns with no race-condition test

### Negative Assertions
- A new assertion that something is absent (`not.toContain`, `not in`, `assertNotIn`,
  `pytest.raises` on a call that used to succeed) records a behavior removal, not coverage.
  Cite the spec line, plan item or PR text that authorizes the removal; with none, report it
  as a product decision shipped as a test.
- A rename or removal in this diff can empty a standing negative assertion: a test asserting
  the old token is absent now passes forever and guards nothing. For each identifier, flag,
  heading or string the diff renames or deletes, grep the test suite for negative assertions
  naming the old value, including inside tests that assert something else, and report each
  as a coverage gap whose fix names the new value.

### Test Isolation Violations
- Tests sharing mutable state (class variables, global singletons, DB records not cleaned up)
- Order-dependent tests (pass in sequence, fail when randomized)
- Tests that depend on system clock, timezone, or locale
- Tests that make real network calls instead of using stubs/mocks

### Flaky Test Patterns
- Timing-dependent assertions (sleep, setTimeout, waitFor with tight timeouts)
- Assertions on ordering of unordered results (hash keys, Set iteration, async resolution order)
- Tests that depend on external services (APIs, databases) without fallback
- Randomized test data without seed control

### Security Enforcement Tests Missing
- Auth/authz checks in controllers with no test for the "unauthorized" case
- Rate limiting logic with no test proving it actually blocks
- Input sanitization with no test for malicious input
- CSRF/CORS configuration with no integration test

### Coverage Gaps
- New public methods/functions with zero test coverage
- Changed methods where existing tests only cover the old behavior, not the new branch
- Utility functions called from multiple places but tested only indirectly
- A path whose only tests are weak (★ smoke/existence/trivial, or a new test failing the
  authoring gate below) stays a coverage gap at its existing severity; a low-value test
  never closes a gap

### Low-value or implementation-coupled tests
Scope: tests and test-only production seams added or changed in the diff. Findings are
INFORMATIONAL, never CRITICAL, and never an auto-delete: recommend rewrite at the owning
boundary, extend an existing test, or retire with a complete retirement card
(`test, detects, non_test_callers, search_command, stronger_proof, history, unlocks,
validation`). End each finding's `fix` with `Repo-wide sweep: run /test-audit.`

A new or changed test passes the authoring gate only when all four answers exist (read
its `Value: protects=...; fails_when=...; why_new=...; seam=...` header comment when the
diff has one):
1. What observable behavior, invariant or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that? Prefer adding a row to an existing table-driven test or shared fixture over a near-duplicate.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no production caller needs? If yes, test at the real boundary instead.

Patterns:
- assertion-free coverage probes
- self-comparisons and identity copies
- copied fixtures, inventories or export lists
- exact source, import or string greps that are not a declared contract
- private predicate or call-shape tests duplicated at a real boundary
- duplicate invocations of the same contract
- per-caller replays of a shared helper's tests
- tests whose only purpose is keeping a test-only export, global or wrapper alive
- production code whose only callers are tests

Retention bar (never flag): a test that independently enforces a public API, protocol,
config, migration, storage, security, platform, default, prompt-byte, generated-output
(SKILL.md golden), package, release or architecture contract; call order when order is
observable; source inspection when it is the cheapest independent guard; anything
reachable from the package entrypoint (`package.json` exports/main, index re-exports).
Static or slow is not a reason to delete.

Evidence for each finding goes in `evidence` with the fields `detects` (what failure the
test can actually detect), `non_test_callers`, `search_command` and `stronger_proof`.
For the last two patterns, run the caller check for each symbol the diff adds or exports,
only when the symbol matches `^[A-Za-z_][A-Za-z0-9_]*$` (otherwise record "caller check
unavailable: unsupported symbol"), with the symbol quoted, never interpolated unquoted:

```bash
git grep -n -F -w -e '<symbol>' -- . ':!test/' ':!tests/' ':!spec/' ':!**/__tests__/**' ':!**/*.test.*' ':!**/*.spec.*' ':!**/*_test.*' ':!**/test_*.py'
```

Record the command, exclusions and hit count, and mark the evidence "grep-only" (it cannot
see re-exports, dynamic dispatch or generated code). If the search fails, record: caller
check unavailable: <command>. The finding stays INFORMATIONAL and nothing is proposed for
deletion; run the search by hand to complete the evidence. (see
~/.claude/skills/gstack/docs/test-value-bar.md#caller-check-unavailable)

Skip a test carrying `gstack:test-value keep reason="<why>"` (any comment syntax). If any
were skipped, report their count and reasons as one INFORMATIONAL line. Emit no finding
for a test you reviewed and kept.

Rejection vocabulary, when a finding names why a new test fails the gate:
`duplicate_protects`, `needs_seam`, `incomplete_card`, `no_credible_regression`,
`covered_elsewhere`, `implementation_coupled`.

### Regression test without red proof
- The diff adds a test named or commented as a regression, and neither the commit history
  nor the PR body shows it failing before the fix. A regression test that never
  demonstrably failed proves the mock, not the fix. INFORMATIONAL; ask for the
  fails-at-HEAD / passes-after-fix record.
