# Fix #1671: `/office-hours` always reports SESSION_COUNT: 0

**Status:** SHIPPED
**Branch:** fix-1671-profile-migration
**Date:** 2026-05-23
**Issue:** https://github.com/garrytan/gstack/issues/1671
**Original PR that introduced the bug:** garrytan/gstack#1039 / commit `0a803f9` / v1.0.0.0 / 2026-04-18

## The problem

`/office-hours` reports `SESSION_COUNT: 0` and `TIER: introduction` on every invocation, even for users who have run the skill many times. The `welcome_back` tier (`bin/gstack-developer-profile:165-169`) that exists to skip the closing pitch for returning users is unreachable. Live ~5 weeks on every fresh-`$HOME` user since v1.0.0.0.

## Root cause

The v1.0.0.0 migration moved the read path to `~/.gstack/developer-profile.json` but left the writer in `office-hours/SKILL.md.tmpl` writing to the legacy `~/.gstack/builder-profile.jsonl`. The `ensure_profile` stub created on first read has `sessions: []`; subsequent writes go to a file the reader never re-reads. Reader and writer disagree on storage.

Full root-cause analysis (including RC2/RC3 follow-ups): https://github.com/garrytan/gstack/issues/1671

## The fix

Make the writer use the same file the reader does.

### Changes

1. **`bin/gstack-developer-profile`** — add `--log-session '<json>'` subcommand:
   - Validates required fields (`date`, `mode`), silent-skip on invalid input (matches `bin/gstack-timeline-log:22-26`).
   - Reads existing `developer-profile.json` via `bun -e`.
   - Appends entry to `sessions[]`. Updates `signals_accumulated` (per-signal-string increment, same as `do_migrate:67-69`), unions `resources_shown` and `topics`.
   - Atomic mktemp+mv write (matches existing pattern at line 54).
   - Calls `gstack-brain-enqueue "developer-profile.json"` after write, mirroring `bin/gstack-timeline-log:40`.

2. **`bin/gstack-developer-profile:do_read`** — filter `mode:"resources"` entries when picking LAST_PROJECT / LAST_ASSIGNMENT / LAST_DESIGN_TITLE / CROSS_PROJECT / DESIGN_*. The Phase 6 resources auto-append happens after the real session in the same /office-hours invocation; without the filter, that resources entry clobbers real-session state for the user's next session. Latent bug that was masked by the broken writer; activated by the fix.

3. **`office-hours/SKILL.md.tmpl`** — swap writers at lines 490 and 893:
   - From: `echo '{...}' >> "$GSTACK_STATE_ROOT/builder-profile.jsonl"`
   - To: `~/.claude/skills/gstack/bin/gstack-developer-profile --log-session '{...}' 2>/dev/null || true`
   - Run `bun run gen:skill-docs` to regenerate `office-hours/SKILL.md`.

### What's NOT in the fix (intentionally)

- **No new binary.** The owner binary for `developer-profile.json` is `gstack-developer-profile`; the writer belongs there as a subcommand. `--log-session` joins the binary's existing `--migrate` / `--derive` write-side subcommand boundary, not the `gstack-*-log` event-writer family. Verb name still matches `gstack-*-log`.
- **No mkdir-locks.** Concurrent /office-hours calls have a read-modify-write race on `developer-profile.json`. The codebase accepts the same race in `gstack-config` (r-m-w on YAML, no lock). Not introduced by this fix; out of scope.
- **No schema bump.** Schema stays at `schema_version: 1`. The fix doesn't change the schema, just makes the writer use it.
- **No auto-reconcile for affected users.** Existing users with stranded `builder-profile.jsonl` entries don't get their past history auto-merged into `developer-profile.json`. On their next /office-hours run, the first new session lands in `welcome_back`; past data stays in the legacy file (still readable by other tools during deprecation). Most affected users have only a handful of stranded sessions so the loss is mostly aesthetic. Dropped the one-release-only reconcile pathway as net noise — Garry's "right-sized diff" voice.
- **No autoplan timeline rollup (RC2).** Separate concern, separate PR.
- **No project-scope opt-in (RC3).** Separate concern, separate PR.
- **No gbrain glob change.** The office-hours manifest still globs `~/.gstack/builder-profile.jsonl` for context; once new writes stop landing there, the snapshot goes cold. Update in a follow-up if it becomes a UX issue.

### Tests (all gate-tier, free, deterministic)

1. **Regression test** in `test/gstack-developer-profile.test.ts`:
   - Fresh `$HOME`.
   - Run /office-hours preamble: gstack-developer-profile creates empty stub.
   - Call `--log-session` with a startup-mode JSON.
   - Run `--read` again. Assert `SESSION_COUNT: 1`, `TIER: welcome_back`.
   - Fails on current main (subcommand doesn't exist). Passes with fix.

2. **`do_read` mode filter test:** after recording a startup session followed by a resources entry, `--read` returns LAST_PROJECT / LAST_ASSIGNMENT / LAST_DESIGN_TITLE from the real session, not from the resources entry. RESOURCES_SHOWN still aggregates correctly.

3. **Validation + aggregation tests:** `--log-session` silently skips invalid JSON / missing required fields, injects `ts` if missing, preserves user-set `ts`, correctly aggregates signals/resources/topics across multiple sessions.

4. **Static-grep invariant** in `test/static-no-legacy-writes.test.ts` (new): walks every skill dir, asserts no production code path writes to `builder-profile.jsonl` except allowlisted readers (`gstack-developer-profile`, `gstack-memory-ingest.ts`, `gstack-artifacts-init`, doc files). Prevents future writers from regressing onto the legacy file.

### Acceptance criteria

- Second `/office-hours` invocation on a fresh `$HOME` returns `TIER: welcome_back`.
- `bun test` passes on the touched files in isolation.
- `bun run gen:skill-docs` produces clean diff matching the `.tmpl` edits.

### Rollout

- One commit. PATCH version bump per CHANGELOG style guide.
- CHANGELOG entry written by `/ship`. User-facing voice: lead with what users experience now that they didn't before (welcome_back tier kicks in on second visit).

## Follow-up TODOs

- Deprecate `builder-profile.jsonl` entirely (writer + shim + memory-ingest type) after one release.
- Fix RC2 (autoplan inlines sub-skills, bypassing their timeline-log preambles).
- Add `GSTACK_PROFILE_SCOPE` opt-in for power users with multiple agent identities (RC3).
- /plan-tune doesn't currently call `--derive`, so `inferred`/`gap` can drift (pre-existing, unrelated to #1671).
- `mode:"resources"` entries inflate SESSION_COUNT under the existing tier aggregator (pre-existing, unrelated to #1671 root cause).
