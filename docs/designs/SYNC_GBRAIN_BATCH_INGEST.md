# /sync-gbrain batch ingest migration

**Status:** Implemented on garrytan/dublin-v1 (D1-D8 decisions land in this PR)
**Branch:** garrytan/dublin-v1
**Owner:** Garry Tan
**Triggered by:** /investigate run, 2026-05-09
**Estimated effort:** human ~3 days / CC+gstack ~2 hr
**Files touched:** 4 source + 1 test = 5 total (under estimate)

## Decisions (post-review)

This doc captures the original architecture. Final architecture lands per
the 8 review decisions captured in
`/Users/garrytan/.claude/plans/purrfect-tumbling-quiche.md`:

- **D1** hierarchical staging dir (mkdir -p per slug segment) — kept
- **D2** cut over + delete legacy in same PR (no `--legacy-ingest` flag) — kept
- **D3** scan source-file first, stage only clean — kept
- **D4** ~~three-state OK/DEGRADED/ERR verdict~~ COLLAPSED to OK/ERR per
  Codex finding 7 (gbrain content_hash idempotency makes the third state
  redundant)
- **D5** ~~skip_reason field in state schema~~ DROPPED per Codex finding 7
  (re-runs are cheap; no need for permanent skip-tracking)
- **D6** trust gbrain's content_hash idempotency; drop bookkeeping
  scaffolding (skip_reason, three-state, SIGTERM checkpoint)
- **D7** per-file failure detection via `~/.gbrain/sync-failures.jsonl`
  (byte-offset snapshot + appended-only read)
- **D8** bundle 3 in-scope pre-existing fixes: F6 atomic saveState
  (tmp+rename), F8 isolated-stage benchmark, F9 full-file sha256 hash
  (no more 1MB cap)

## Verified from gbrain source

Three properties verified by reading `~/git/gbrain/src/`:

- **Idempotency** at `core/import-file.ts:242-243, :478` — content_hash
  check, skip if unchanged, overwrite if changed.
- **Frontmatter parity** at `core/import-file.ts:228, 297, 410-422` —
  title/type/tags honored; auto-inference only when frontmatter absent.
- **Path-authoritative slug** at `core/sync.ts:260` (`slugifyPath`),
  enforced at `core/import-file.ts:429`.
- **Per-file failures surface** at `commands/import.ts:308-310`,
  comment at `:28`: "callers can gate state advances" — the
  intentional API for what D7 uses.

## Performance: planned vs measured (post 2026-05-10 perf review)

| Metric | Plan target | Measured | Verdict |
|---|---|---|---|
| Prepare phase on 5135 files | — | <10s | FAST |
| `gbrain import` on 5135 files | — | >10 min | gbrain-side perf issue, filed |
| Loop / hang (original bug) | never | never | FIXED |
| Memory ingest exits null on SIGTERM | no | no — state writes succeed; child gbrain dies with parent | FIXED |
| FILE_TOO_LARGE blocks last_commit | no | no — failed paths excluded via D7 | FIXED |

**Initial perf miss + correction.** The first cold-run measurement
(~12 min) was dominated by 1841 sequential gitleaks subprocess spawns
at ~256ms each — a redundant security gate. The cross-machine
exfiltration boundary is `gstack-brain-sync` (bin/gstack-brain-sync:78-110,
regex-based secret scan on staged diff before `git commit`). Scanning
every source file before ingest into a LOCAL PGLite doesn't change
exposure — the secret already lives on disk in plaintext. We made
per-file gitleaks opt-in via `--scan-secrets`. Default is off. That
cut the prepare phase from ~12 min to under 10 seconds.

The remaining cold-run cost is `gbrain import` itself, which scales
worse than linear on large staging dirs (10s for 501 files; >10 min
for 5031). That's a gbrain-side perf issue, not gstack architecture.
Filed as a TODO; the fix likely lives in gbrain's content_hash check
loop or auto-link reconciliation phase.

## F9 hash migration (one-time cliff)

F9 switched `fileSha256` from a 1MB-capped hash to full-file. Existing state
entries from before this change carry the old 1MB-capped hash. For any file
whose mtime hasn't changed, `fileChangedSinceState` returns false at the
mtime check and the new hash is never computed — so unchanged files behave
identically. For any file whose mtime DOES change after upgrade, the
full-file hash is recomputed and (correctly) treated as changed, then
re-imported. The `gbrain doctor` probe report's `updated_count` may show
inflated numbers on the first run post-upgrade because every touched file
crosses the algorithm boundary. No data loss, but worth knowing.

## Follow-ups (filed as TODOs)

1. **gbrain import perf on large dirs** — investigate why 5031 files
   take >10 min when 501 takes 10s. Likely culprits: N+1 SQL for
   `getPage(slug)` content_hash check, per-page auto-link reconciliation,
   FTS index updates without batching. Lives in gbrain, not gstack.
2. **Optional: source-file changed-detection cache** — even with the
   prepare phase fast, walking 5031 files takes some time. Caching
   the "no changes since last successful import" state at the
   batch level (not per-file) would skip the prepare phase entirely
   on a no-op incremental run.

## Problem

`/sync-gbrain` memory stage takes 35 minutes on a fresh PGLite and exits null,
losing all progress. Subsequent runs redo the same 35 minutes. Observed in
two consecutive runs (gbrain 0.30.0 broken-postgres run: 712s exit-null;
gbrain 0.31.2 PGLite run: 2100s exit-null with 501 pages actually persisted).

## Root cause (from /investigate)

Two compounding bugs in `bin/gstack-memory-ingest.ts`:

1. **Subprocess-per-file architecture.** The ingest loop at line 911 walks
   1,841 files in `~/.gstack/projects/` and spawns two subprocesses per file:
   - `gitleaks detect --no-git --source <path>` — 46ms cold start (`lib/gstack-memory-helpers.ts:157`)
   - `gbrain put <slug>` — 329ms cold start (`bin/gstack-memory-ingest.ts:823`)
   - Per-file floor: 375ms × 1841 = 690s (11.5 min) of pure subprocess startup
     before any actual work happens.

2. **Kill-no-save timeout.** Orchestrator at `bin/gstack-gbrain-sync.ts:442`
   enforces a 35-min timeout. When it fires, `spawnSync` returns
   `result.status === null`, the child gets SIGTERM, and the in-memory
   ingest state never flushes to `~/.gstack/.transcript-ingest-state.json`.
   Next run starts from the same un-progressed state — explains the
   redo-everything pattern.

## Numbers from the field

| Metric | Value | Source |
|---|---|---|
| Files in walkAllSources | 1,841 | `find ~/.gstack/projects -type f \( -name "*.md" -o -name "*.jsonl" \)` |
| `gbrain put` cold start | 329ms | `time (echo "test" \| gbrain put _bench)` |
| `gitleaks detect` cold start | 46ms | `time gitleaks detect --no-git --source <small-file>` |
| Theoretical floor (subprocess only) | 690s / 11.5 min | 375ms × 1841 |
| Observed run time | 2100s / 35 min | matches orchestrator timeout exactly |
| Pages actually persisted | 501 | gbrain sources list page_count |
| PGLite growth during run | 290 → 386 MB | `du -sh ~/.gbrain/brain.pglite` |

## Proposed architecture

Replace the per-file subprocess loop with a **prepare-then-batch** pipeline:

```
walkAllSources(ctx)
  → prepareStage (in-process, fast):
       parse transcripts/artifacts
       build PageRecord with custom YAML frontmatter
       gitleaks scan (single subprocess on staging dir)
       write prepared .md to staging dir
  → gbrain import <staging-dir> --no-embed (single subprocess)
  → flush state file with all successes
  → cleanup staging dir
```

### Why `gbrain import <dir>` is the right batch path

- Already shipped in gbrain CLI (verified: `gbrain --help` shows `import <dir> [--no-embed]`).
- Walks dir in-process inside gbrain's own runtime — no subprocess fan-out.
- Honors gbrain's batch-size and embedding-batch tuning.
- gbrain v0.31.2 import did 501 pages + 2906 chunks in 10 seconds during the
  observed run; the slow part was OUR per-file `gbrain put` loop above it.

### What we keep that the current code does right

- **Custom YAML frontmatter injection** (title, type, tags) — preserved by
  writing prepared .md files with frontmatter into the staging dir.
- **Secret scanning** — preserved, but moved to ONE `gitleaks detect --source <staging-dir>`
  call after prepare, before import. Files with findings get redacted or
  excluded; staging dir guarantees gitleaks sees only the prepared content,
  not internal gbrain state.
- **Partial-transcript detection** — preserved in prepare stage; partial
  files still get a `partial: true` field in frontmatter.
- **Unattributed-transcript filtering** — preserved in prepare stage.
- **Per-file mtime + sha256 state tracking** — preserved; the prepare stage
  records what got staged, the import-success result records what landed.
- **Incremental mode** — `fileChangedSinceState` check stays at the top of
  the prepare loop.

## Migration steps

### Step 1: extract `preparePages` from current ingest loop

Take everything in `ingestPass` (lines 899-988 of `bin/gstack-memory-ingest.ts`)
between the walk and the `gbrainPutPage` call. Move into a new function
`preparePages(args, ctx, state) → { staged: PreparedPage[], skipped, failed }`.

Output: list of `{ slug, body, source_path, mtime_ns, sha256, partial }`
where `body` is the full markdown including frontmatter.

### Step 2: add staging dir writer

Pure function: `writeStaged(prepared, stagingDir) → { written, errors }`.
Filename: `${slug}.md`. Idempotent overwrite.

Staging dir lifecycle:
- Created at `~/.gstack/.staging-ingest-${pid}-${ts}/`
- Cleaned in `finally` block, even on SIGTERM
- One staging dir per ingest pass — never reused across runs

### Step 3: single gitleaks pass

Replace per-file `secretScanFile(path)` calls with one call after prepare:
`gitleaks detect --no-git --source <staging-dir> --report-format json --report-path -`.

Parse JSON output, build `Map<slug, findings[]>`. Files with findings get
removed from staging dir before import (or sanitized in place per existing
redaction policy in `lib/gstack-memory-helpers.ts`).

### Step 4: replace `gbrainPutPage` loop with single import call

```typescript
const importResult = spawnSync("gbrain", ["import", stagingDir], {
  stdio: ["ignore", "inherit", "inherit"],
  timeout: 30 * 60 * 1000, // generous; whole batch
});
```

Parse stdout for the `Import complete` line and the `failed` count.

### Step 5: persist state on partial success

If gbrain import reports `imported=N, failed=M`, save state for the N
successful slugs (not all of them). Failures stay un-state'd so they retry
next run, but successes don't redo.

### Step 6: SIGTERM handler in `gstack-memory-ingest.ts`

Wrap `main()` in:
```typescript
let interrupted = false;
const flush = () => {
  if (interrupted) return;
  interrupted = true;
  saveState(state); // best-effort flush of whatever's accumulated
  cleanupStagingDir();
  process.exit(143);
};
process.on("SIGTERM", flush);
process.on("SIGINT", flush);
```

This unblocks the kill-no-save bug independently — even if the batch import
runs over the orchestrator timeout, state from the prepare stage survives.

### Step 7: orchestrator update

In `bin/gstack-gbrain-sync.ts:444`:
- Change `result.status === 0` to `result.status === 0 || (parsedSummary.imported > 0 && parsedSummary.imported >= parsedSummary.skipped + parsedSummary.failed)`.
  Treat partial success (most pages imported) as OK, not ERR.
- Surface `failed_count` and `partial_blockers` in the stage summary so the
  user sees `Memory ... OK 487/501 imported (14 FILE_TOO_LARGE)` instead
  of `ERR exited null`.

### Step 8: handle FILE_TOO_LARGE specifically

When gbrain reports FILE_TOO_LARGE, log to a new
`~/.gstack/.ingest-skip-list.json` so the next prepare stage skips that file
entirely. Avoids re-staging a file that will always fail. User can review
the skip list with a new `gstack-memory-ingest --skip-list` flag.

## Test plan

1. **Unit (free, runs in `bun test`):**
   - `preparePages` against fixture corpus of 50 files: assert YAML correct,
     partial detection works, unattributed filtered.
   - `writeStaged` overwrite idempotency.
   - SIGTERM handler flush behavior using a child-process test harness.

2. **Integration (free, runs in `bun test`):**
   - End-to-end: prepare → gitleaks → gbrain import on a temp PGLite,
     assert page_count matches imported count.
   - Partial-success path: inject a deliberate FILE_TOO_LARGE; assert
     successes still state'd, failure logged to skip list.
   - State preservation across SIGTERM: spawn ingest, kill at midpoint,
     restart, assert resumed state.

3. **Benchmark gate (periodic, paid):**
   - Cold run on 1841-file fixture: assert under 8 min.
   - Incremental run (no changes): assert under 60 sec.
   - Test fixture: copy of `~/.gstack/projects/` snapshot for repeatable timing.

## Rollback strategy

- New `--legacy-ingest` flag on `gstack-memory-ingest` keeps the old
  per-file path callable for one release cycle.
- If batch path regresses on a real corpus, set
  `gstack-config set memory_ingest_path legacy` to revert without redeploy.
- Remove flag + legacy path one minor version after confirming batch is stable.

## Risks & open questions for plan-eng-review

1. **gbrain import idempotency on overlapping slugs.** If a previous run
   wrote slug X to PGLite with old content, does `gbrain import` of
   updated-X overwrite or duplicate? Need to test before relying on it.

2. **Frontmatter injection inside `gbrain import` parser.** Current code
   knows how to inject title/type/tags into existing frontmatter blocks
   (line 794-821). Does `gbrain import` honor those fields the same way
   `gbrain put` does? Verify in unit test.

3. **Staging dir disk pressure.** 1841 files × avg ~50KB = ~92MB of
   staging .md content. Acceptable on dev machines but worth knowing.
   Alternative: stream prepared content to a tar piped to import (if gbrain
   supports it) — likely not, ignore for V1.

4. **Cross-worktree concurrency.** `~/.gstack/.staging-ingest-${pid}-${ts}/`
   is pid-namespaced so two concurrent /sync-gbrain runs don't collide.
   But the orchestrator already holds a lock at `~/.gstack/.sync-gbrain.lock`
   so this is belt-and-suspenders. Keep it.

5. **The "memory ingest exited null" message.** After this change, the
   orchestrator might still see status=null on real OOM kills or SIGKILL.
   Should the verdict block be more honest? E.g.,
   `ERR memory: killed by signal SIGTERM at 35:00 (timeout)`.

6. **Should we deprecate `gbrain put` for memory entirely?** The legacy
   path exists for V1.5's `put_file` migration plan. With batch import
   working, do we still need single-page put as a fallback for ad-hoc
   ingestion? Probably yes (for `~/.gstack/.transcript-ingest-state.json`
   updates triggered outside the orchestrator), but worth confirming.

## What this isn't

- Not a gbrain CLI change. All work is in gstack.
- Not a CLAUDE.md voice/UX change.
- Not a new user-facing feature. CHANGELOG entry will read: "Memory ingest
  is ~10× faster on cold runs and survives interruption."

## Acceptance criteria

- Cold `/sync-gbrain` on 1841 files completes in under 8 minutes.
- Incremental `/sync-gbrain` (no file changes) completes in under 60 seconds.
- SIGTERM mid-run flushes state; next run resumes without redoing
  successfully-imported files.
- FILE_TOO_LARGE failures don't block sync.last_commit advancement.
- All existing test fixtures (transcripts, learnings, design-docs, ceo-plans)
  ingest correctly with full frontmatter.
- No regression on partial-transcript or unattributed-transcript handling.
