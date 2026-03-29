# Language & Framework Anti-Patterns Reference

Grep-friendly patterns organized by language. Each entry includes a pattern name, regex to search for, brief explanation, and typical severity (critical/high/medium/low).

---

## JavaScript / TypeScript

**Unhandled promise rejection (then without catch)**
Regex: `\.then\s*\(` (check for missing `.catch(`)
Explanation: Promises without error handlers cause silent failures or process crashes (Node 15+).
Severity: high

**Unhandled async errors**
Regex: `async\s+\w+.*\{` (check for missing try/catch around await)
Explanation: Thrown errors in async functions become unhandled promise rejections.
Severity: high

**Event emitter leaks**
Regex: `\.on\(` without corresponding `\.off\(|\.removeListener\(`
Explanation: Listeners accumulate on long-lived emitters, leaking memory and causing duplicate handling.
Severity: medium

**Prototype pollution**
Regex: `Object\.assign\(\{\}|\.\.\.(?:req\.body|req\.query|userInput|params)`
Explanation: Merging untrusted objects can overwrite `__proto__`, polluting all objects in the runtime.
Severity: critical

**Memory leaks in closures**
Regex: `setInterval\(|addEventListener\(` (check if references are cleaned up)
Explanation: Variables captured in long-lived callbacks prevent garbage collection.
Severity: medium

**Missing strict mode in CommonJS**
Regex: `module\.exports` in files without `"use strict"`
Explanation: Non-strict mode allows silent errors, implicit globals, and deprecated features.
Severity: low

**eval with user input**
Regex: `eval\(|new\s+Function\(`
Explanation: Executing user-controlled strings enables arbitrary code execution.
Severity: critical

**Regex ReDoS**
Regex: `new\s+RegExp\(` with user input, or patterns like `(a+)+`, `(a|a)*`
Explanation: Catastrophic backtracking causes CPU exhaustion on crafted input.
Severity: high

**JSON.parse without try/catch**
Regex: `JSON\.parse\(` (check for surrounding try/catch)
Explanation: Malformed JSON throws, crashing the handler if uncaught.
Severity: medium

---

## Python

**Mutable default arguments**
Regex: `def\s+\w+\(.*=\s*\[\]|def\s+\w+\(.*=\s*\{\}`
Explanation: Default mutable objects are shared across calls, causing surprising state accumulation.
Severity: high

**Bare except**
Regex: `except\s*:`
Explanation: Catches KeyboardInterrupt and SystemExit, masking real errors and preventing clean shutdown.
Severity: high

**GIL-bound threading for CPU work**
Regex: `import\s+threading` (in CPU-bound context)
Explanation: Python's GIL prevents true parallelism with threads; use `multiprocessing` or `concurrent.futures.ProcessPoolExecutor`.
Severity: medium

**Unsafe deserialization**
Regex: `pickle\.loads?\(|cPickle\.loads?\(`
Explanation: Deserialization of untrusted data executes arbitrary code; never use on external input.
Severity: critical

**f-string in logging**
Regex: `logger?\.\w+\(f['"]|logging\.\w+\(f['"]`
Explanation: f-strings evaluate eagerly even when log level is disabled. Use `logger.info("msg %s", var)` for lazy interpolation.
Severity: low

**Missing __init__.py**
Regex: (structural check -- directories with .py files but no `__init__.py`)
Explanation: Causes import failures in non-namespace-package setups; inconsistent module resolution.
Severity: low

**Shell injection**
Regex: `os\.system\(|subprocess\.run\(.*shell\s*=\s*True|subprocess\.call\(.*shell\s*=\s*True`
Explanation: Shell=True with user input enables command injection.
Severity: critical

**Global mutable state**
Regex: Module-level `\w+\s*=\s*\[\]|\w+\s*=\s*\{\}` that are mutated later
Explanation: Shared mutable state across requests causes race conditions and data leaks in web servers.
Severity: medium

---

## Ruby / Rails

**N+1 queries**
Regex: `\.each\s+do` accessing associations -- check for missing `.includes(` / `.eager_load(`
Explanation: Each iteration triggers a separate DB query; response time scales linearly with record count.
Severity: high

**Mass assignment bypass**
Regex: `params\.permit!|\.attributes\s*=\s*params`
Explanation: Allows attackers to set any model attribute, including admin flags and foreign keys.
Severity: critical

**Unscoped queries**
Regex: `\.all\b|\.where\(` without tenant/user scope in multi-tenant apps
Explanation: Returns records belonging to other tenants; data leak.
Severity: high

**Unsafe HTML rendering**
Regex: `\.html_safe|raw\s+`
Explanation: Marks string as safe for rendering, bypassing Rails XSS protection.
Severity: critical

**Missing DB indexes on foreign keys**
Regex: `belongs_to\s+:` / `has_many\s+:` -- check migration for matching `add_index`
Explanation: Joins and lookups on unindexed foreign keys cause full table scans.
Severity: medium

**Heavy work in callbacks**
Regex: `after_create|after_save|after_commit` with nested queries or external calls
Explanation: Callbacks run in the request cycle; N+1s and HTTP calls here multiply response time.
Severity: high

**Rescue catching everything**
Regex: `rescue\s*=>\s*\w+\s*$|rescue\s+Exception`
Explanation: Catches SignalException and SystemExit, preventing clean shutdown and masking real errors.
Severity: high

---

## Go

**Discarded errors**
Regex: `\w+,\s*_\s*:=|_\s*=\s*\w+\.\w+\(`
Explanation: Silently ignoring errors leads to nil pointer panics and data corruption downstream.
Severity: high

**Goroutine leaks**
Regex: `go\s+func\(` or `go\s+\w+\(` without cancellation context or done channel
Explanation: Leaked goroutines accumulate, consuming memory and file descriptors until OOM.
Severity: high

**Defer in loops**
Regex: Use `files_with_matches` for `defer\s+` then manually inspect for-loop context. Do NOT use multiline grep — `for\s+.*\{[^}]*defer` matches entire files and floods output.
Explanation: Deferred calls accumulate for the function's lifetime, not the loop iteration; resource exhaustion.
Severity: medium

**Race conditions on shared state**
Regex: Global `var\s+\w+\s+map|var\s+\w+\s+\[\]` accessed from multiple goroutines
Explanation: Concurrent map/slice access without mutex causes panics and data corruption.
Severity: critical

**Panic in library code**
Regex: `panic\(`
Explanation: Libraries should return errors, not panic; panics crash the caller's process.
Severity: medium

**Missing context propagation**
Regex: `func\s+\w+\(` without `context\.Context` as first parameter (in server/handler code)
Explanation: Without context, cancellation and timeouts don't propagate; requests hang on client disconnect.
Severity: medium

---

## Rust

**unwrap/expect in library code**
Regex: `\.unwrap\(\)|\.expect\(`
Explanation: Panics in library code crash the calling application; use `?` operator to propagate errors.
Severity: high

**Missing error context**
Regex: `\?\s*;` without `.context(` or `.map_err(` (in functions returning Result)
Explanation: Bare `?` propagates the error without context; debugging requires tracing through call chains.
Severity: medium

**Unsafe without safety comment**
Regex: `unsafe\s*\{` (check for preceding `// SAFETY:` comment)
Explanation: Unsafe blocks require documented invariants to maintain soundness during refactoring.
Severity: medium

**Unnecessary clone**
Regex: `\.clone\(\)` (check if borrowing would suffice)
Explanation: Cloning where a borrow works wastes allocations; especially costly in hot paths.
Severity: low

---

## Swift / iOS

**Retain cycles in closures**
Regex: `\{\s*\[?\s*` in closure context capturing `self` without `[weak self]` or `[unowned self]`
Explanation: Strong self references in closures prevent deallocation; memory grows until OOM.
Severity: high

**Main thread blocking**
Regex: `URLSession.*\.dataTask|FileManager.*\.contents` outside DispatchQueue.global
Explanation: Network or disk I/O on the main thread freezes the UI; causes watchdog kills on iOS.
Severity: high

**Force unwraps**
Regex: `\w+!\.|\w+!\s`
Explanation: Force unwrapping nil crashes the app; use `guard let` or `if let` instead.
Severity: high

**Missing @MainActor**
Regex: UI updates (e.g., `\.text\s*=|\.isHidden\s*=`) in closures without `@MainActor` or `DispatchQueue.main`
Explanation: UI updates from background threads cause visual glitches or crashes.
Severity: high

---

## PHP

**SQL injection via concatenation**
Regex: `\$\w+\s*\.\s*['"].*(?:SELECT|INSERT|UPDATE|DELETE|WHERE)|mysql_query\s*\(`
Explanation: String concatenation in SQL queries enables arbitrary query execution.
Severity: critical

**Command injection**
Regex: `eval\s*\(|exec\s*\(|system\s*\(|passthru\s*\(|shell_exec\s*\(`
Explanation: Executing user-controlled strings enables full server compromise.
Severity: critical

**Missing CSRF protection**
Regex: `<form\s+` without `csrf_token|csrf_field|_token` in the form body
Explanation: State-changing forms without CSRF tokens are vulnerable to cross-site request forgery.
Severity: high

**File inclusion with user input**
Regex: `include\s*\(\s*\$|require\s*\(\s*\$|include_once\s*\(\s*\$`
Explanation: User-controlled file paths in include/require enable remote code execution.
Severity: critical

**Unfiltered output**
Regex: `echo\s+\$_(?:GET|POST|REQUEST|COOKIE)|print\s+\$_`
Explanation: Echoing raw superglobals enables XSS attacks.
Severity: high

---

## General (Framework-Agnostic)

**Secrets in source**
Regex: `(?i)(api_key|apikey|secret_key|password|token|auth_token)\s*[:=]\s*['"][^'"]{8,}`
Explanation: Credentials in source code leak via version control, logs, and error messages.
Severity: critical

**Missing input validation**
Regex: User input (req.body, params, $_POST, etc.) used directly without sanitization or validation
Explanation: Unsanitized input is the root cause of injection, XSS, and path traversal vulnerabilities.
Severity: high

**Overly broad error catching**
Regex: `catch\s*\(.*Exception\)|except\s+Exception|rescue\s+Exception`
Explanation: Catch-all handlers swallow specific errors, hiding bugs and preventing proper recovery.
Severity: medium

**TOCTOU race conditions**
Regex: `File\.exist|file_exists|os\.path\.exists|fs\.existsSync` followed by file operation
Explanation: File state changes between check and use; another process can modify/delete the file.
Severity: medium

**Hardcoded URLs and IPs**
Regex: `https?://(?:localhost|127\.0\.0\.1|10\.\d|192\.168)\b|https?://[a-z]+\.[a-z]+\.\w+/`
Explanation: Environment-specific URLs break across environments; use configuration instead.
Severity: medium

**Missing content-type validation**
Regex: File upload endpoints without content-type or magic byte checks
Explanation: Attackers upload executable files disguised as images; enables server-side code execution.
Severity: high

**Logging sensitive data**
Regex: `(?i)log.*(password|token|secret|credit.?card|ssn|authorization)`
Explanation: Sensitive data in logs is accessible to anyone with log access; violates compliance requirements.
Severity: high

**Missing TLS verification**
Regex: `verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*=>\s*false`
Explanation: Disabling TLS verification enables man-in-the-middle attacks on all traffic through that client.
Severity: critical
