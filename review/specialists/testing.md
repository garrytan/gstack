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
