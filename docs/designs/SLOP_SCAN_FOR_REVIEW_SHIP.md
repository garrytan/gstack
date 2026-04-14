# Design: slop-scan integration in /review and /ship

Status: deferred
Created: 2026-04-09
Depends on: slop-diff script (scripts/slop-diff.ts, already landed)

## Problem

slop-scan findings are only visible if you run `bun run slop:diff` manually. They
should surface automatically during code review and shipping, the same way SQL safety
and trust boundary checks do.

## Integration points

### /review (Step 4, after checklist pass)

Run `bun run slop:diff` after the critical/informational checklist pass. Show new
findings inline with other review output:

```
Pre-Landing Review: 3 issues (1 critical, 2 informational)

AI Slop: +2 new findings, -0 removed
  browse/src/new-feature.ts
    defensive.empty-catch: 2 locations
      line 42: empty catch, boundary=filesystem
      line 87: empty catch, boundary=process
```

Classification: INFORMATIONAL (never blocks merge, just surfaces the pattern).

Fix-First heuristic applies: if the finding is an empty catch around a file op,
auto-fix with `safeUnlink()`. If it's a catch-and-log in extension code, skip
(that's the correct pattern per CLAUDE.md guidelines).

### /ship (Step 3.5, pre-landing review + PR body)

Same integration as /review. Additionally, show a one-line summary in the PR body:

```markdown
## Pre-Landing Review
- 2 issues auto-fixed, 0 needs input
- AI Slop: +0 new / -3 removed ✓
```

### Review Readiness Dashboard

Do NOT add a row. Slop is a diagnostic on the diff, not a review that gets "run"
independently. It shows up inside Eng Review output, not as its own dashboard entry.

## What to auto-fix vs what to skip

Follow CLAUDE.md "Slop-scan" section. Summary:

**Auto-fix (genuine quality improvements):**
- Empty catch around `fs.unlinkSync` → replace with `safeUnlink()`
- Empty catch around `process.kill` → replace with `safeKill()`
- `return await` with no enclosing try → remove `await`
- Untyped catch around URL parsing → add `instanceof TypeError` check

**Skip (correct patterns that slop-scan flags):**
- `.catch(() => {})` on fire-and-forget browser ops (page.close, bringToFront)
- Catch-and-log in Chrome extension code (uncaught errors crash extensions)
- `safeUnlinkQuiet` in shutdown/emergency paths (swallowing all errors is correct)
- Pass-through wrappers that delegate to active session (API stability layer)

## Implementation notes

- `scripts/slop-diff.ts` already handles the heavy lifting (worktree-based base
  comparison, line-number-insensitive fingerprinting, graceful fallback)
- The review/ship skills run bash blocks. Integration is: run the script, parse
  the output, include in the review findings
- If slop-scan is not installed (`npx slop-scan` fails), skip silently
- The script exits 0 always (diagnostic, never gates)

## Effort estimate

| Task | Human | CC+gstack |
|------|-------|-----------|
| Add to review/SKILL.md.tmpl | 2 hours | 10 min |
| Add to ship/SKILL.md.tmpl | 2 hours | 10 min |
| Add to review/checklist.md | 1 hour | 5 min |
| Test with actual PRs | 2 hours | 15 min |
| Regenerate SKILL.md files | — | 1 min |
