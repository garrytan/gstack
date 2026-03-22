# Codebase Audit Checklist

Use this checklist during Phase 3 of the codebase audit. For each item, run the grep pattern against the codebase to find potential issues. Not every match is a real problem — use judgment to filter false positives. Items marked `[QUICK]` are highest-priority and run in quick mode (1-2 per category). Record findings with file path, line number, and severity (critical/high/medium/low).

---

### Security

- `[QUICK]` **Hardcoded secrets** — `password\s*=|secret\s*=|api_key\s*=|API_KEY\s*=|token\s*=.*['"]` — Credentials committed to source code are trivially extractable and often end up in logs or version history.
- **SQL injection via interpolation** — `\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|WHERE)` or f-string/format in SQL context — User input spliced into queries enables arbitrary SQL execution.
- **XSS vectors** — `innerHTML|dangerouslySetInnerHTML|html_safe|raw\(|v-html` — Rendering unsanitized user content in the DOM enables script injection.
- **Missing CSRF protection** — Forms without CSRF tokens, routes missing CSRF middleware — Enables cross-site request forgery on state-changing endpoints.
- **Auth bypass** — Routes or endpoints without auth middleware — Unauthenticated access to protected resources.
- **Path traversal** — `path\.join.*req\.|fs\.\w+.*req\.` — User input in file paths enables reading/writing arbitrary files on the server.
- **SSRF** — User-controlled URLs passed to fetch/request/HTTP client calls — Attackers can reach internal services or cloud metadata endpoints.
- `[QUICK]` **Insecure deserialization** — `eval\(|pickle\.loads|yaml\.load\b|Marshal\.load` — Deserializing untrusted data enables remote code execution.
- **Missing rate limiting** — Public API endpoints without rate limit middleware — Enables brute force, credential stuffing, and resource exhaustion.
- **Overly permissive CORS** — `Access-Control-Allow-Origin.*\*|cors\(\)` without origin whitelist — Allows any origin to make authenticated requests.
- **LLM trust boundaries** — LLM output written to DB or sent to users without validation — Prompt injection can produce malicious content that flows downstream unchecked.
- **Secrets in git** — `.env` files tracked in version control, hardcoded tokens in config files — Secrets in repo history persist even after deletion from HEAD.

### Correctness

- `[QUICK]` **Empty catch blocks** — `catch\s*\([^)]*\)\s*\{\s*\}` or bare `except:` — Swallowed errors hide bugs and make debugging impossible.
- **Unchecked null/undefined** — Missing null checks before property access on nullable values — Causes runtime crashes (TypeError, NullPointerException) in production.
- `[QUICK]` **Race conditions** — Read-check-write without locking, non-atomic status transitions — Concurrent access corrupts state or produces inconsistent results.
- **Off-by-one errors** — `<=` vs `<` in loop bounds, array index calculations — Causes missed items, out-of-bounds access, or infinite loops.
- **Async/await misuse** — Missing `await` on async calls, unhandled promise rejections — Functions return promises instead of values, leading to silent failures.
- **Missing return statements** — Functions that fall through without returning — Callers receive undefined/nil instead of expected values.
- **Type coercion bugs** — Loose equality (`==` in JS), implicit string-to-number — Unexpected truthy/falsy comparisons produce wrong behavior.
- **Incorrect error propagation** — Catching and re-throwing without context — Original error context is lost, making root cause analysis difficult.
- **Stale closures** — React useEffect/useCallback with missing dependency arrays — Component uses stale values, causing subtle UI bugs.
- **Dead code paths** — Unreachable code after return/throw/break — Indicates logic errors or abandoned refactors that confuse readers.

### Reliability

- `[QUICK]` **Missing timeouts** — HTTP requests, DB queries, external service calls without timeout config — Calls hang indefinitely when downstream services are slow or unreachable.
- **Unbounded retries** — Retry loops without max attempts or exponential backoff — Amplifies load on failing services, delays error surfacing.
- `[QUICK]` **Resource leaks** — File handles, DB connections, event listeners not cleaned up — Gradual resource exhaustion leads to crashes under sustained load.
- **Missing graceful shutdown** — No SIGTERM/SIGINT handler, no connection draining — In-flight requests are dropped during deploys, causing user-visible errors.
- **No circuit breakers** — External service calls without circuit breaker pattern — One failing dependency cascades failures across the entire system.
- **Unhandled promise rejections** — Node.js `unhandledRejection` not caught globally — Causes process crash in Node 15+ or silent failures in earlier versions.
- **Missing connection pool limits** — DB pools without max connection config — Connection exhaustion under load causes cascading request failures.
- **No health check endpoint** — Services without `/health` or `/ready` endpoint — Load balancers and orchestrators cannot detect unhealthy instances.

### Architecture

- **Circular dependencies** — Mutual imports between modules — Causes initialization order bugs, import errors, and tight coupling.
- **God modules** — Single files >500 LOC with multiple responsibilities — Hard to test, hard to change, high defect density.
- `[QUICK]` **Missing separation of concerns** — Business logic in controllers/routes, DB queries in views — Violates layering, makes logic untestable and unreusable.
- **Inconsistent patterns** — Same thing done different ways in different parts of the codebase — Increases cognitive load and bug surface; pick one way and standardize.
- **Config scattered** — Config values hardcoded across files instead of centralized — Config changes require multi-file edits and are easy to miss.
- **Missing dependency injection** — Hard-coded dependencies that prevent testing — Forces integration tests where unit tests would suffice.
- **Inappropriate coupling** — UI code importing from server internals or vice versa — Breaks deployment independence and creates fragile cross-boundary dependencies.
- **Missing abstraction layers** — Direct DB access from route handlers — Business rules are coupled to storage implementation, blocking future changes.
- **Monolith signals** — Everything in one package/module when it should be split — Slows builds, blocks independent deployment, and creates merge conflicts.
- **Missing error boundaries** — No top-level error handling in UI components — One component crash takes down the entire page.

### Tests

- `[QUICK]` **Critical paths without tests** — Auth, payment, data mutation with no test coverage — Highest-risk code paths that break silently without regression tests.
- **Tests that don't assert** — `expect(x).toBeDefined()` or tests with no assertions — Tests pass but verify nothing meaningful; false confidence.
- **Flaky test patterns** — Timing dependencies (`setTimeout` in tests), shared mutable state — Tests fail intermittently, eroding trust and blocking CI.
- **Missing integration tests** — Only unit tests, no end-to-end or integration tests — Units pass in isolation but fail when composed.
- **Mock-heavy tests** — Tests that mock everything and test nothing real — Verify mock behavior, not production behavior; miss real bugs.
- **Missing error path tests** — Only happy-path tested, no error/edge cases — Error handling code ships untested and often breaks in production.
- **Test doubles diverging from real behavior** — Mocks that don't match real API signatures or return types — Tests pass with stale mocks while production breaks.
- **Missing boundary value tests** — No tests for empty input, max values, edge cases — Off-by-one and boundary bugs slip through.
- **Test setup duplication** — Same setup code repeated across many test files — Maintenance burden grows; setup changes require shotgun edits.
- **No test for recently changed code** — Files modified in last 90 days without corresponding tests — Recent changes are highest risk for regressions.

### Tech Debt

- `[QUICK]` **TODO/FIXME/HACK markers** — `TODO|FIXME|HACK|XXX|WORKAROUND` — Accumulated deferred work that may represent known bugs or incomplete features.
- **Dead code** — Unused functions, unreachable branches, commented-out code blocks — Confuses readers, creates false grep matches, and rots over time.
- **Duplicated logic** — Same logic implemented in multiple places (DRY violations) — Bug fixes applied to one copy but not the other; inconsistent behavior.
- **Outdated dependencies** — `package.json`/`Gemfile`/`requirements.txt` with known vulnerable versions — Security vulnerabilities and missing bug fixes.
- **Deprecated API usage** — Using deprecated methods, libraries, or patterns — Will break on upgrade; technical cliff ahead.
- **Inconsistent naming** — Mixed camelCase/snake_case, inconsistent file naming conventions — Increases cognitive load and causes import errors.
- **Magic numbers/strings** — Hardcoded values without named constants — Intent is unclear; same value repeated in multiple places drifts.
- **Missing documentation** — Public APIs without doc comments, complex logic without explanation — Slows onboarding and increases misuse of internal APIs.
- **Overly complex functions** — Cyclomatic complexity >10, deeply nested conditionals — Hard to test, hard to reason about, high defect density.
- **Legacy patterns** — jQuery in a React app, callbacks in an async/await codebase — Mixed paradigms increase complexity without adding value.

### Performance

- `[QUICK]` **N+1 query patterns** — DB queries inside loops, missing eager loading/joins — Multiplies DB round trips; 1 query becomes N, killing response time.
- **Missing indexes** — Queries on unindexed columns (inferred from WHERE/ORDER BY patterns) — Full table scans on every query; performance degrades with data growth.
- **Unbounded operations** — `SELECT *` without LIMIT, loading entire collections into memory — Works in dev, OOMs in production with real data volumes.
- **Sync I/O in async context** — Blocking file reads in async handlers, synchronous crypto — Blocks the event loop / thread pool, killing concurrency.
- **Missing pagination** — List endpoints returning all records without limit/offset — Response times and memory usage grow linearly with data.
- **Large payload without streaming** — Reading entire files into memory, large JSON responses — Memory spikes cause GC pauses or OOM crashes under load.
- **Missing caching** — Repeated expensive computations without memoization or cache layer — Redundant work on every request; easy wins left on the table.
- **Expensive operations in hot paths** — Complex regex, JSON parse/stringify in tight loops or request handlers — Adds latency to every request; move to init time or cache results.
