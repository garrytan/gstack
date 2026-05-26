---
paths:
  - "**/*.ts"
  - "**/*.js"
  - "browse/src/error-handling.ts"
  - "slop-scan.config.json"
---

# Slop-scan: AI code quality, not AI code hiding

We use [slop-scan](https://github.com/benvinegar/slop-scan) to catch patterns where
AI-generated code is genuinely worse than what a human would write. We are NOT trying
to pass as human code. We are AI-coded and proud of it. The goal is code quality.

```bash
npx slop-scan scan .          # human-readable report
npx slop-scan scan . --json   # machine-readable for diffing
```

Config: `slop-scan.config.json` at repo root (currently excludes `**/vendor/**`).

## What to fix (genuine quality improvements)

- **Empty catches around file ops** — use `safeUnlink()` (ignores ENOENT, rethrows
  EPERM/EIO). A swallowed EPERM in cleanup means silent data loss.
- **Empty catches around process kills** — use `safeKill()` (ignores ESRCH, rethrows
  EPERM). A swallowed EPERM means you think you killed something you didn't.
- **Redundant `return await`** — remove when there's no enclosing try block. Saves a
  microtask, signals intent.
- **Typed exception catches** — `catch (err) { if (!(err instanceof TypeError)) throw err }`
  is genuinely better than `catch {}` when the try block does URL parsing or DOM work.
  You know what error you expect, so say so.

## What NOT to fix (linter gaming, not quality)

- **String-matching on error messages** — `err.message.includes('closed')` is brittle.
  Playwright/Chrome can change wording anytime. If a fire-and-forget operation can fail
  for ANY reason and you don't care, `catch {}` is the correct pattern.
- **Adding comments to exempt pass-through wrappers** — "alias for active session" above
  a method just to trip slop-scan's exemption rule is noise, not documentation.
- **Converting extension catch-and-log to selective rethrow** — Chrome extensions crash
  entirely on uncaught errors. If the catch logs and continues, that IS the right pattern
  for extension code. Don't make it throw.
- **Tightening best-effort cleanup paths** — shutdown, emergency cleanup, and disconnect
  code should use `safeUnlinkQuiet()` (swallows ALL errors). A cleanup path that throws
  on EPERM means the rest of cleanup doesn't run. That's worse.

## Utilities in `browse/src/error-handling.ts`

| Function | Use when | Behavior |
|----------|----------|----------|
| `safeUnlink(path)` | Normal file deletion | Ignores ENOENT, rethrows others |
| `safeUnlinkQuiet(path)` | Shutdown/emergency cleanup | Swallows all errors |
| `safeKill(pid, signal)` | Sending signals | Ignores ESRCH, rethrows others |
| `isProcessAlive(pid)` | Boolean process checks | Returns true/false, never throws |

## Score tracking

Baseline (2026-04-09, before cleanup): 100 findings, 432.8 score, 2.38 score/file.
After cleanup: 90 findings, 358.1 score, 1.96 score/file.

Don't chase the number. Fix patterns that represent actual code quality problems.
Accept findings where the "sloppy" pattern is the correct engineering choice.
