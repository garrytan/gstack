# Changelog

## 0.5.1 — 2026-03-16

- **You can now use gstack from Codex CLI.** The same skill templates now generate native Codex skill files in `.agents/skills/`, so you get `$gstack-review`, `$gstack-ship`, `$gstack-qa`, and the rest without maintaining a second prompt stack.
- **Claude and Codex stay in sync automatically.** One `.tmpl` template now produces both hosts' `SKILL.md` files, which means new workflow improvements ship to both environments from a single source of truth.
- **Codex setup is one command.** Run `./setup --host codex` to register the generated Codex skills in `~/.agents/skills/`, including the shared browse binary and helper docs.
- **Contributing now covers the dual-host workflow.** The docs, tests, and CI checks all verify both Claude and Codex generation, so it is much harder to accidentally fix one host and break the other.

### For contributors

- Added host-aware generation to `scripts/gen-skill-docs.ts`, including Codex frontmatter, `.agents/skills/` output routing, and shared placeholder resolution.
- Added Codex support to `setup`, `bin/dev-setup`, `bin/dev-teardown`, `browse/src/find-browse.ts`, tests, and `skill-docs.yml`.

## 0.5.0 — 2026-03-16

- **Your site just got a design review.** `/plan-design-review` opens your site and reviews it like a senior product designer — typography, spacing, hierarchy, color, responsive, interactions, and AI slop detection. Get letter grades (A-F) per category, a dual headline "Design Score" + "AI Slop Score", and a structured first impression that doesn't pull punches.
- **It can fix what it finds, too.** `/qa-design-review` runs the same designer's eye audit, then iteratively fixes design issues in your source code with atomic `style(design):` commits and before/after screenshots. CSS-safe by default, with a stricter self-regulation heuristic tuned for styling changes.
- **Know your actual design system.** Both skills extract your live site's fonts, colors, heading scale, and spacing patterns via JS — then offer to save the inferred system as a `DESIGN.md` baseline. Finally know how many fonts you're actually using.
- **AI Slop detection is a headline metric.** Every report opens with two scores: Design Score and AI Slop Score. The AI slop checklist catches the 10 most recognizable AI-generated patterns — the 3-column feature grid, purple gradients, decorative blobs, emoji bullets, generic hero copy.
- **Design regression tracking.** Reports write a `design-baseline.json`. Next run auto-compares: per-category grade deltas, new findings, resolved findings. Watch your design score improve over time.
- **80-item design audit checklist** across 10 categories: visual hierarchy, typography, color/contrast, spacing/layout, interaction states, responsive, motion, content/microcopy, AI slop, and performance-as-design. Distilled from Vercel's 100+ rules, Anthropic's frontend design skill, and 6 other design frameworks.

### For contributors

- Added `{{DESIGN_METHODOLOGY}}` resolver to `gen-skill-docs.ts` — shared design audit methodology injected into both `/plan-design-review` and `/qa-design-review` templates, following the `{{QA_METHODOLOGY}}` pattern.
- Added `~/.gstack-dev/plans/` as a local plans directory for long-range vision docs (not checked in). CLAUDE.md and TODOS.md updated.
- Added `/setup-design-md` to TODOS.md (P2) for interactive DESIGN.md creation from scratch.

## 0.4.5 — 2026-03-16

- **Review findings now actually get fixed, not just listed.** `/review` and `/ship` used to print informational findings (dead code, test gaps, N+1 queries) and then ignore them. Now every finding gets action: obvious mechanical fixes are applied automatically, and genuinely ambiguous issues are batched into a single question instead of 8 separate prompts. You see `[AUTO-FIXED] file:line Problem → what was done` for each auto-fix.
- **You control the line between "just fix it" and "ask me first."** Dead code, stale comments, N+1 queries get auto-fixed. Security issues, race conditions, design decisions get surfaced for your call. The classification lives in one place (`review/checklist.md`) so both `/review` and `/ship` stay in sync.

### Fixed

- **`$B js "const x = await fetch(...); return x.status"` now works.** The `js` command used to wrap everything as an expression — so `const`, semicolons, and multi-line code all broke. It now detects statements and uses a block wrapper, just like `eval` already did.
- **Clicking a dropdown option no longer hangs forever.** If an agent sees `@e3 [option] "Admin"` in a snapshot and runs `click @e3`, gstack now auto-selects that option instead of hanging on an impossible Playwright click. The right thing just happens.
- **When click is the wrong tool, gstack tells you.** Clicking an `<option>` via CSS selector used to time out with a cryptic Playwright error. Now you get: `"Use 'browse select' instead of 'click' for dropdown options."`

### For contributors

- Gate Classification → Severity Classification rename (severity determines presentation order, not whether you see a prompt).
- Fix-First Heuristic section added to `review/checklist.md` — the canonical AUTO-FIX vs ASK classification.
- New validation test: `Fix-First Heuristic exists in checklist and is referenced by review + ship`.
- Extracted `needsBlockWrapper()` and `wrapForEvaluate()` helpers in `read-commands.ts` — shared by both `js` and `eval` commands (DRY).
- Added `getRefRole()` to `BrowserManager` — exposes ARIA role for ref selectors without changing `resolveRef` return type.
- Click handler auto-routes `[role=option]` refs to `selectOption()` via parent `<select>`, with DOM `tagName` check to avoid blocking custom listbox components.
- 6 new tests: multi-line js, semicolons, statement keywords, simple expressions, option auto-routing, CSS option error guidance.

## 0.4.4 — 2026-03-16

- **New releases detected in under an hour, not half a day.** The update check cache was set to 12 hours, which meant you could be stuck on an old version all day while new releases dropped. Now "you're up to date" expires after 60 minutes, so you'll see upgrades within the hour. "Upgrade available" still nags for 12 hours (that's the point).
- **`/gstack-upgrade` always checks for real.** Running `/gstack-upgrade` directly now bypasses the cache and does a fresh check against GitHub. No more "you're already on the latest" when you're not.

### For contributors

- Split `last-update-check` cache TTL: 60 min for `UP_TO_DATE`, 720 min for `UPGRADE_AVAILABLE`.
- Added `--force` flag to `bin/gstack-update-check` (deletes cache file before checking).
- 3 new tests: `--force` busts UP_TO_DATE cache, `--force` busts UPGRADE_AVAILABLE cache, 60-min TTL boundary test with `utimesSync`.

## 0.4.3 — 2026-03-16

- **New `/document-release` skill.** Run it after `/ship` but before merging — it reads every doc file in your project, cross-references the diff, and updates README, ARCHITECTURE, CONTRIBUTING, CHANGELOG, and TODOS to match what you actually shipped. Risky changes get surfaced as questions; everything else is automatic.
- **Every question is now crystal clear, every time.** You used to need 3+ sessions running before gstack would give you full context and plain English explanations. Now every question — even in a single session — tells you the project, branch, and what's happening, explained simply enough to understand mid-context-switch. No more "sorry, explain it to me more simply."
- **Branch name is always correct.** gstack now detects your current branch at runtime instead of relying on the snapshot from when the conversation started. Switch branches mid-session? gstack keeps up.

### For contributors

- Merged ELI16 rules into base AskUserQuestion format — one format instead of two, no `_SESSIONS >= 3` conditional.
- Added `_BRANCH` detection to preamble bash block (`git branch --show-current` with fallback).
- Added regression guard tests for branch detection and simplification rules.

## 0.4.2 — 2026-03-16

- **`$B js "await fetch(...)"` now just works.** Any `await` expression in `$B js` or `$B eval` is automatically wrapped in an async context. No more `SyntaxError: await is only valid in async functions`. Single-line eval files return values directly; multi-line files use explicit `return`.
- **Contributor mode now reflects, not just reacts.** Instead of only filing reports when something breaks, contributor mode now prompts periodic reflection: "Rate your gstack experience 0-10. Not a 10? Think about why." Catches quality-of-life issues and friction that passive detection misses. Reports now include a 0-10 rating and "What would make this a 10" to focus on actionable improvements.
- **Skills now respect your branch target.** `/ship`, `/review`, `/qa`, and `/plan-ceo-review` detect which branch your PR actually targets instead of assuming `main`. Stacked branches, Conductor workspaces targeting feature branches, and repos using `master` all just work now.
- **`/retro` works on any default branch.** Repos using `master`, `develop`, or other default branch names are detected automatically — no more empty retros because the branch name was wrong.
- **New `{{BASE_BRANCH_DETECT}}` placeholder** for skill authors — drop it into any template and get 3-step branch detection (PR base → repo default → fallback) for free.
- **3 new E2E smoke tests** validate base branch detection works end-to-end across ship, review, and retro skills.

### For contributors

- Added `hasAwait()` helper with comment-stripping to avoid false positives on `// await` in eval files.
- Smart eval wrapping: single-line → expression `(...)`, multi-line → block `{...}` with explicit `return`.
- 6 new async wrapping unit tests, 40 new contributor mode preamble validation tests.
- Calibration example framed as historical ("used to fail") to avoid implying a live bug post-fix.
- Added "Writing SKILL templates" section to CLAUDE.md — rules for natural language over bash-isms, dynamic branch detection, self-contained code blocks.
- Hardcoded-main regression test scans all `.tmpl` files for git commands with hardcoded `main`.
- QA template cleaned up: removed `REPORT_DIR` shell variable, simplified port detection to prose.
- gstack-upgrade template: explicit cross-step prose for variable references between bash blocks.

## 0.4.1 — 2026-03-16

- **gstack now notices when it screws up.** Turn on contributor mode (`gstack-config set gstack_contributor true`) and gstack automatically writes up what went wrong — what you were doing, what broke, repro steps. Next time something annoys you, the bug report is already written. Fork gstack and fix it yourself.
- **Juggling multiple sessions? gstack keeps up.** When you have 3+ gstack windows open, every question now tells you which project, which branch, and what you were working on. No more staring at a question thinking "wait, which window is this?"
- **Every question now comes with a recommendation.** Instead of dumping options on you and making you think, gstack tells you what it would pick and why. Same clear format across every skill.
- **/review now catches forgotten enum handlers.** Add a new status, tier, or type constant? /review traces it through every switch statement, allowlist, and filter in your codebase — not just the files you changed. Catches the "added the value but forgot to handle it" class of bugs before they ship.

### For contributors

- Renamed `{{UPDATE_CHECK}}` to `{{PREAMBLE}}` across all 11 skill templates — one startup block now handles update check, session tracking, contributor mode, and question formatting.
- DRY'd plan-ceo-review and plan-eng-review question formatting to reference the preamble baseline instead of duplicating rules.
- Added CHANGELOG style guide and vendored symlink awareness docs to CLAUDE.md.

## 0.4.0 — 2026-03-16

### Added
- **QA-only skill** (`/qa-only`) — report-only QA mode that finds and documents bugs without making fixes. Hand off a clean bug report to your team without the agent touching your code.
- **QA fix loop** — `/qa` now runs a find-fix-verify cycle: discover bugs, fix them, commit, re-navigate to confirm the fix took. One command to go from broken to shipped.
- **Plan-to-QA artifact flow** — `/plan-eng-review` writes test-plan artifacts that `/qa` picks up automatically. Your engineering review now feeds directly into QA testing with no manual copy-paste.
- **`{{QA_METHODOLOGY}}` DRY placeholder** — shared QA methodology block injected into both `/qa` and `/qa-only` templates. Keeps both skills in sync when you update testing standards.
- **Eval efficiency metrics** — turns, duration, and cost now displayed across all eval surfaces with natural-language **Takeaway** commentary. See at a glance whether your prompt changes made the agent faster or slower.
- **`generateCommentary()` engine** — interprets comparison deltas so you don't have to: flags regressions, notes improvements, and produces an overall efficiency summary.
- **Eval list columns** — `bun run eval:list` now shows Turns and Duration per run. Spot expensive or slow runs instantly.
- **Eval summary per-test efficiency** — `bun run eval:summary` shows average turns/duration/cost per test across runs. Identify which tests are costing you the most over time.
- **`judgePassed()` unit tests** — extracted and tested the pass/fail judgment logic.
- **3 new E2E tests** — qa-only no-fix guardrail, qa fix loop with commit verification, plan-eng-review test-plan artifact.
- **Browser ref staleness detection** — `resolveRef()` now checks element count to detect stale refs after page mutations. SPA navigation no longer causes 30-second timeouts on missing elements.
- 3 new snapshot tests for ref staleness.

### Changed
- QA skill prompt restructured with explicit two-cycle workflow (find → fix → verify).
- `formatComparison()` now shows per-test turns and duration deltas alongside cost.
- `printSummary()` shows turns and duration columns.
- `eval-store.test.ts` fixed pre-existing `_partial` file assertion bug.

### Fixed
- Browser ref staleness — refs collected before page mutation (e.g. SPA navigation) are now detected and re-collected. Eliminates a class of flaky QA failures on dynamic sites.

## 0.3.9 — 2026-03-15

### Added
- **`bin/gstack-config` CLI** — simple get/set/list interface for `~/.gstack/config.yaml`. Used by update-check and upgrade skill for persistent settings (auto_upgrade, update_check).
- **Smart update check** — 12h cache TTL (was 24h), exponential snooze backoff (24h → 48h → 1 week) when user declines upgrades, `update_check: false` config option to disable checks entirely. Snooze resets when a new version is released.
- **Auto-upgrade mode** — set `auto_upgrade: true` in config or `GSTACK_AUTO_UPGRADE=1` env var to skip the upgrade prompt and update automatically.
- **4-option upgrade prompt** — "Yes, upgrade now", "Always keep me up to date", "Not now" (snooze), "Never ask again" (disable).
- **Vendored copy sync** — `/gstack-upgrade` now detects and updates local vendored copies in the current project after upgrading the primary install.
- 25 new tests: 11 for gstack-config CLI, 14 for snooze/config paths in update-check.

### Changed
- README upgrade/troubleshooting sections simplified to reference `/gstack-upgrade` instead of long paste commands.
- Upgrade skill template bumped to v1.1.0 with `Write` tool permission for config editing.
- All SKILL.md preambles updated with new upgrade flow description.

## 0.3.8 — 2026-03-14

### Added
- **TODOS.md as single source of truth** — merged `TODO.md` (roadmap) and `TODOS.md` (near-term) into one file organized by skill/component with P0-P4 priority ordering and a Completed section.
- **`/ship` Step 5.5: TODOS.md management** — auto-detects completed items from the diff, marks them done with version annotations, offers to create/reorganize TODOS.md if missing or unstructured.
- **Cross-skill TODOS awareness** — `/plan-ceo-review`, `/plan-eng-review`, `/retro`, `/review`, and `/qa` now read TODOS.md for project context. `/retro` adds Backlog Health metric (open counts, P0/P1 items, churn).
- **Shared `review/TODOS-format.md`** — canonical TODO item format referenced by `/ship` and `/plan-ceo-review` to prevent format drift (DRY).
- **Greptile 2-tier reply system** — Tier 1 (friendly, inline diff + explanation) for first responses; Tier 2 (firm, full evidence chain + re-rank request) when Greptile re-flags after a prior reply.
- **Greptile reply templates** — structured templates in `greptile-triage.md` for fixes (inline diff), already-fixed (what was done), and false positives (evidence + suggested re-rank). Replaces vague one-line replies.
- **Greptile escalation detection** — explicit algorithm to detect prior GStack replies on comment threads and auto-escalate to Tier 2.
- **Greptile severity re-ranking** — replies now include `**Suggested re-rank:**` when Greptile miscategorizes issue severity.
- Static validation tests for `TODOS-format.md` references across skills.

### Fixed
- **`.gitignore` append failures silently swallowed** — `ensureStateDir()` bare `catch {}` replaced with ENOENT-only silence; non-ENOENT errors (EACCES, ENOSPC) logged to `.gstack/browse-server.log`.

### Changed
- `TODO.md` deleted — all items merged into `TODOS.md`.
- `/ship` Step 3.75 and `/review` Step 5 now reference reply templates and escalation detection from `greptile-triage.md`.
- `/ship` Step 6 commit ordering includes TODOS.md in the final commit alongside VERSION + CHANGELOG.
- `/ship` Step 8 PR body includes TODOS section.

## 0.3.7 — 2026-03-14

### Added
- **Screenshot element/region clipping** — `screenshot` command now supports element crop via CSS selector or @ref (`screenshot "#hero" out.png`, `screenshot @e3 out.png`), region clip (`screenshot --clip x,y,w,h out.png`), and viewport-only mode (`screenshot --viewport out.png`). Uses Playwright's native `locator.screenshot()` and `page.screenshot({ clip })`. Full page remains the default.
- 10 new tests covering all screenshot modes (viewport, CSS, @ref, clip) and error paths (unknown flag, mutual exclusion, invalid coords, path validation, nonexistent selector).

## 0.3.6 — 2026-03-14

### Added
- **E2E observability** — heartbeat file (`~/.gstack-dev/e2e-live.json`), per-run log directory (`~/.gstack-dev/e2e-runs/{runId}/`), progress.log, per-test NDJSON transcripts, persistent failure transcripts. All I/O non-fatal.
- **`bun run eval:watch`** — live terminal dashboard reads heartbeat + partial eval file every 1s. Shows completed tests, current test with turn/tool info, stale detection (>10min), `--tail` for progress.log.
- **Incremental eval saves** — `savePartial()` writes `_partial-e2e.json` after each test completes. Crash-resilient: partial results survive killed runs. Never cleaned up.
- **Machine-readable diagnostics** — `exit_reason`, `timeout_at_turn`, `last_tool_call` fields in eval JSON. Enables `jq` queries for automated fix loops.
- **API connectivity pre-check** — E2E suite throws immediately on ConnectionRefused before burning test budget.
- **`is_error` detection** — `claude -p` can return `subtype: "success"` with `is_error: true` on API failures. Now correctly classified as `error_api`.
- **Stream-json NDJSON parser** — `parseNDJSON()` pure function for real-time E2E progress from `claude -p --output-format stream-json --verbose`.
- **Eval persistence** — results saved to `~/.gstack-dev/evals/` with auto-comparison against previous run.
- **Eval CLI tools** — `eval:list`, `eval:compare`, `eval:summary` for inspecting eval history.
- **All 9 skills converted to `.tmpl` templates** — plan-ceo-review, plan-eng-review, retro, review, ship now use `{{UPDATE_CHECK}}` placeholder. Single source of truth for update check preamble.
- **3-tier eval suite** — Tier 1: static validation (free), Tier 2: E2E via `claude -p` (~$3.85/run), Tier 3: LLM-as-judge (~$0.15/run). Gated by `EVALS=1`.
- **Planted-bug outcome testing** — eval fixtures with known bugs, LLM judge scores detection.
- 15 observability unit tests covering heartbeat schema, progress.log format, NDJSON naming, savePartial, finalize, watcher rendering, stale detection, non-fatal I/O.
- E2E tests for plan-ceo-review, plan-eng-review, retro skills.
- Update-check exit code regression tests.
- `test/helpers/skill-parser.ts` — `getRemoteSlug()` for git remote detection.

### Fixed
- **Browse binary discovery broken for agents** — replaced `find-browse` indirection with explicit `browse/dist/browse` path in SKILL.md setup blocks.
- **Update check exit code 1 misleading agents** — added `|| true` to prevent non-zero exit when no update available.
- **browse/SKILL.md missing setup block** — added `{{BROWSE_SETUP}}` placeholder.
- **plan-ceo-review timeout** — init git repo in test dir, skip codebase exploration, bump timeout to 420s.
- Planted-bug eval reliability — simplified prompts, lowered detection baselines, resilient to max_turns flakes.

### Changed
- **Template system expanded** — `{{UPDATE_CHECK}}` and `{{BROWSE_SETUP}}` placeholders in `gen-skill-docs.ts`. All browse-using skills generate from single source of truth.
- Enriched 14 command descriptions with specific arg formats, valid values, error behavior, and return types.
- Setup block checks workspace-local path first (for development), falls back to global install.
- LLM eval judge upgraded from Haiku to Sonnet 4.6.
- `generateHelpText()` auto-generated from COMMAND_DESCRIPTIONS (replaces hand-maintained help text).

## 0.3.3 — 2026-03-13

### Added
- **SKILL.md template system** — `.tmpl` files with `{{COMMAND_REFERENCE}}` and `{{SNAPSHOT_FLAGS}}` placeholders, auto-generated from source code at build time. Structurally prevents command drift between docs and code.
- **Command registry** (`browse/src/commands.ts`) — single source of truth for all browse commands with categories and enriched descriptions. Zero side effects, safe to import from build scripts and tests.
- **Snapshot flags metadata** (`SNAPSHOT_FLAGS` array in `browse/src/snapshot.ts`) — metadata-driven parser replaces hand-coded switch/case. Adding a flag in one place updates the parser, docs, and tests.
- **Tier 1 static validation** — 43 tests: parses `$B` commands from SKILL.md code blocks, validates against command registry and snapshot flag metadata
- **Tier 2 E2E tests** via Agent SDK — spawns real Claude sessions, runs skills, scans for browse errors. Gated by `SKILL_E2E=1` env var (~$0.50/run)
- **Tier 3 LLM-as-judge evals** — Haiku scores generated docs on clarity/completeness/actionability (threshold ≥4/5), plus regression test vs hand-maintained baseline. Gated by `ANTHROPIC_API_KEY`
- **`bun run skill:check`** — health dashboard showing all skills, command counts, validation status, template freshness
- **`bun run dev:skill`** — watch mode that regenerates and validates SKILL.md on every template or source file change
- **CI workflow** (`.github/workflows/skill-docs.yml`) — runs `gen:skill-docs` on push/PR, fails if generated output differs from committed files
- `bun run gen:skill-docs` script for manual regeneration
- `bun run test:eval` for LLM-as-judge evals
- `test/helpers/skill-parser.ts` — extracts and validates `$B` commands from Markdown
- `test/helpers/session-runner.ts` — Agent SDK wrapper with error pattern scanning and transcript saving
- **ARCHITECTURE.md** — design decisions document covering daemon model, security, ref system, logging, crash recovery
- **Conductor integration** (`conductor.json`) — lifecycle hooks for workspace setup/teardown
- **`.env` propagation** — `bin/dev-setup` copies `.env` from main worktree into Conductor workspaces automatically
- `.env.example` template for API key configuration

### Changed
- Build now runs `gen:skill-docs` before compiling binaries
- `parseSnapshotArgs` is metadata-driven (iterates `SNAPSHOT_FLAGS` instead of switch/case)
- `server.ts` imports command sets from `commands.ts` instead of declaring inline
- SKILL.md and browse/SKILL.md are now generated files (edit the `.tmpl` instead)

## 0.3.2 — 2026-03-13

### Fixed
- Cookie import picker now returns JSON instead of HTML — `jsonResponse()` referenced `url` out of scope, crashing every API call
- `help` command routed correctly (was unreachable due to META_COMMANDS dispatch ordering)
- Stale servers from global install no longer shadow local changes — removed legacy `~/.claude/skills/gstack` fallback from `resolveServerScript()`
- Crash log path references updated from `/tmp/` to `.gstack/`

### Added
- **Diff-aware QA mode** — `/qa` on a feature branch auto-analyzes `git diff`, identifies affected pages/routes, detects the running app on localhost, and tests only what changed. No URL needed.
- **Project-local browse state** — state file, logs, and all server state now live in `.gstack/` inside the project root (detected via `git rev-parse --show-toplevel`). No more `/tmp` state files.
- **Shared config module** (`browse/src/config.ts`) — centralizes path resolution for CLI and server, eliminates duplicated port/state logic
- **Random port selection** — server picks a random port 10000-60000 instead of scanning 9400-9409. No more CONDUCTOR_PORT magic offset. No more port collisions across workspaces.
- **Binary version tracking** — state file includes `binaryVersion` SHA; CLI auto-restarts the server when the binary is rebuilt
- **Legacy /tmp cleanup** — CLI scans for and removes old `/tmp/browse-server*.json` files, verifying PID ownership before sending signals
- **Greptile integration** — `/review` and `/ship` fetch and triage Greptile bot comments; `/retro` tracks Greptile batting average across weeks
- **Local dev mode** — `bin/dev-setup` symlinks skills from the repo for in-place development; `bin/dev-teardown` restores global install
- `help` command — agents can self-discover all commands and snapshot flags
- Version-aware `find-browse` with META signal protocol — detects stale binaries and prompts agents to update
- `browse/dist/find-browse` compiled binary with git SHA comparison against origin/main (4hr cached)
- `.version` file written at build time for binary version tracking
- Route-level tests for cookie picker (13 tests) and find-browse version check (10 tests)
- Config resolution tests (14 tests) covering git root detection, BROWSE_STATE_FILE override, ensureStateDir, readVersionHash, resolveServerScript, and version mismatch detection
- Browser interaction guidance in CLAUDE.md — prevents Claude from using mcp\_\_claude-in-chrome\_\_\* tools
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

## 0.3.1 — 2026-03-12

### Phase 3.5: Browser cookie import

- `cookie-import-browser` command — decrypt and import cookies from real Chromium browsers (Comet, Chrome, Arc, Brave, Edge)
- Interactive cookie picker web UI served from the browse server (dark theme, two-panel layout, domain search, import/remove)
- Direct CLI import with `--domain` flag for non-interactive use
- `/setup-browser-cookies` skill for Claude Code integration
- macOS Keychain access with async 10s timeout (no event loop blocking)
- Per-browser AES key caching (one Keychain prompt per browser per session)
- DB lock fallback: copies locked cookie DB to /tmp for safe reads
- 18 unit tests with encrypted cookie fixtures

## 0.3.0 — 2026-03-12

### Phase 3: /qa skill — systematic QA testing

- New `/qa` skill with 6-phase workflow (Initialize, Authenticate, Orient, Explore, Document, Wrap up)
- Three modes: full (systematic, 5-10 issues), quick (30-second smoke test), regression (compare against baseline)
- Issue taxonomy: 7 categories, 4 severity levels, per-page exploration checklist
- Structured report template with health score (0-100, weighted across 7 categories)
- Framework detection guidance for Next.js, Rails, WordPress, and SPAs
- `browse/bin/find-browse` — DRY binary discovery using `git rev-parse --show-toplevel`

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
- Playwright error wrapping — actionable messages for AI agents
- Context recreation preserves cookies/storage/URLs (useragent fix)
- SKILL.md rewritten as QA-oriented playbook with 10 workflow patterns
- 166 integration tests (was ~63)

## 0.0.2 — 2026-03-12

- Fix project-local `/browse` installs — compiled binary now resolves `server.ts` from its own directory instead of assuming a global install exists
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

## 0.0.1 — 2026-03-11

Initial release.

- Five skills: `/plan-ceo-review`, `/plan-eng-review`, `/review`, `/ship`, `/browse`
- Headless browser CLI with 40+ commands, ref-based interaction, persistent Chromium daemon
- One-command install as Claude Code skills (submodule or global clone)
- `setup` script for binary compilation and skill symlinking
