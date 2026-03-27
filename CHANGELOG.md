# Changelog

## [0.12.8.1] - 2026-03-27 — zsh Glob Compatibility

Skill scripts now work correctly in zsh. Previously, bash code blocks in skill templates used raw glob patterns like `.github/workflows/*.yaml` and `ls ~/.gstack/projects/$SLUG/*-design-*.md` that would throw "no matches found" errors in zsh when no files matched. Fixed 38 instances across 13 templates and 2 resolvers using two approaches: `find`-based alternatives for complex patterns, and `setopt +o nomatch` guards for simple `ls` commands.

### Fixed

- **`.github/workflows/` globs replaced with `find`.** `cat .github/workflows/*deploy*`, `for f in .github/workflows/*.yml`, and `ls .github/workflows/*.yaml` patterns in `/land-and-deploy`, `/setup-deploy`, `/cso`, and the deploy bootstrap resolver now use `find ... -name` instead of raw globs.
- **`~/.gstack/` and `~/.claude/` globs guarded with `setopt`.** Design doc lookups, eval result listings, test plan discovery, and retro history checks across 10 skills now prepend `setopt +o nomatch 2>/dev/null || true` (no-op in bash, disables NOMATCH in zsh).
- **Test framework detection globs guarded.** `ls jest.config.* vitest.config.*` in the testing resolver now has a setopt guard.

## [0.12.8.0] - 2026-03-27 — Codex No Longer Reviews the Wrong Project

When you run gstack in Conductor with multiple workspaces open, Codex could silently review the wrong project. The `codex exec -C` flag resolved the repo root inline via `$(git rev-parse --show-toplevel)`, which evaluates in whatever cwd the background shell inherits. In multi-workspace environments, that cwd might be a different project entirely.

### Fixed

- **Codex exec resolves repo root eagerly.** All 12 `codex exec` commands across `/codex`, `/autoplan`, and 4 resolver functions now resolve `_REPO_ROOT` at the top of each bash block and reference the stored value in `-C`. No more inline evaluation that races with other workspaces.
- **`codex review` also gets cwd protection.** `codex review` doesn't support `-C`, so it now gets `cd "$_REPO_ROOT"` before invocation. Same class of bug, different command.
- **Silent fallback replaced with hard fail.** The `|| pwd` fallback silently used whatever random cwd was available. Now it errors out with a clear message if not in a git repo.

### Removed

- **Dead resolver copies in gen-skill-docs.ts.** Six functions that were moved to `scripts/resolvers/` months ago but never deleted. They had already diverged from the live versions and contained the old vulnerable pattern.

### Added

- **Regression test** that scans all `.tmpl`, resolver `.ts`, and generated `SKILL.md` files for codex commands using inline `$(git rev-parse --show-toplevel)`. Prevents reintroduction.

## [0.12.7.0] - 2026-03-27 — Community PRs + Security Hardening

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

## [0.12.6.0] - 2026-03-27 — Sidebar Knows What Page You're On

The Chrome sidebar agent used to navigate to the wrong page when you asked it to do something. If you'd manually browsed to a site, the sidebar would ignore that and go to whatever Playwright last saw (often Hacker News from the demo). Now it works.

### Fixed

- **Sidebar uses the real tab URL.** The Chrome extension now captures the actual page URL via `chrome.tabs.query()` and sends it to the server. Previously the sidebar agent used Playwright's stale `page.url()`, which didn't update when you navigated manually in headed mode.
- **URL sanitization.** The extension-provided URL is validated (http/https only, control characters stripped, 2048 char limit) before being used in the Claude system prompt. Prevents prompt injection via crafted URLs.
- **Stale sidebar agents killed on reconnect.** Each `/connect-chrome` now kills leftover sidebar-agent processes before starting a new one. Old agents had stale auth tokens and would silently fail, causing the sidebar to freeze.

### Added

- **Pre-flight cleanup for `/connect-chrome`.** Kills stale browse servers and cleans Chromium profile locks before connecting. Prevents "already connected" false positives after crashes.
- **Sidebar agent test suite (36 tests).** Four layers: unit tests for URL sanitization, integration tests for server HTTP endpoints, mock-Claude round-trip tests, and E2E tests with real Claude. All free except layer 4.

## [0.12.5.1] - 2026-03-27 — Eng Review Now Tells You What to Parallelize

`/plan-eng-review` automatically analyzes your plan for parallel execution opportunities. When your plan has independent workstreams, the review outputs a dependency table, parallel lanes, and execution order so you know exactly which tasks to split into separate git worktrees.

### Added

- **Worktree parallelization strategy** in `/plan-eng-review` required outputs. Extracts a structured table of plan steps with module-level dependencies, computes parallel lanes, and flags merge conflict risks. Skips automatically for single-module or single-track plans.

## [0.12.5.0] - 2026-03-26 — Fix Codex Hangs: 30-Minute Waits Are Gone

Three bugs in `/codex` caused 30+ minute hangs with zero output during plan reviews and adversarial checks. All three are fixed.

### Fixed

- **Plan files now visible to Codex sandbox.** Codex runs sandboxed to the repo root and couldn't see plan files at `~/.claude/plans/`. It would waste 10+ tool calls searching before giving up. Now the plan content is embedded directly in the prompt, and referenced source files are listed so Codex reads them immediately.
- **Streaming output actually streams.** Python's stdout buffering meant zero output visible until the process exited. Added `PYTHONUNBUFFERED=1`, `python3 -u`, and `flush=True` on every print call across all three Codex modes.
- **Sane reasoning effort defaults.** Replaced hardcoded `xhigh` (23x more tokens, known 50+ min hangs per OpenAI issues #8545, #8402, #6931) with per-mode defaults: `high` for review and challenge, `medium` for consult. Users can override with `--xhigh` flag when they want maximum reasoning.
- **`--xhigh` override works in all modes.** The override reminder was missing from challenge and consult mode instructions. Found by adversarial review.

## [0.12.4.0] - 2026-03-26 — Full Commit Coverage in /ship

When you ship a branch with 12 commits spanning performance work, dead code removal, and test infra, the PR should mention all three. It wasn't. The CHANGELOG and PR summary biased toward whatever happened most recently, silently dropping earlier work.

### Fixed

- **/ship Step 5 (CHANGELOG):** Now forces explicit commit enumeration before writing. You list every commit, group by theme, write the entry, then cross-check that every commit maps to a bullet. No more recency bias.
- **/ship Step 8 (PR body):** Changed from "bullet points from CHANGELOG" to explicit commit-by-commit coverage. Groups commits into logical sections. Excludes the VERSION/CHANGELOG metadata commit (bookkeeping, not a change). Every substantive commit must appear somewhere.

## [0.12.3.0] - 2026-03-26 — Voice Directive: Every Skill Sounds Like a Builder

Every gstack skill now has a voice. Not a personality, not a persona, but a consistent set of instructions that make Claude sound like someone who shipped code today and cares whether the thing works for real users. Direct, concrete, sharp. Names the file, the function, the command. Connects technical work to what the user actually experiences.

Two tiers: lightweight skills get a trimmed version (tone + writing rules). Full skills get the complete directive with context-dependent tone (YC partner energy for strategy, senior eng for code review, blog-post clarity for debugging), concreteness standards, humor calibration, and user-outcome guidance.

### Added

- **Voice directive in all 25 skills.** Generated from `preamble.ts`, injected via the template resolver. Tier 1 skills get a 4-line version. Tier 2+ skills get the full directive.
- **Context-dependent tone.** Match the context: YC partner for `/plan-ceo-review`, senior eng for `/review`, best-technical-blog-post for `/investigate`.
- **Concreteness standard.** "Show the exact command. Use real numbers. Point at the exact line." Not aspirational... enforced.
- **User outcome connection.** "This matters because your user will see a 3-second spinner." Make the user's user real.
- **LLM eval test.** Judge scores directness, concreteness, anti-corporate tone, AI vocabulary avoidance, and user outcome connection. All dimensions must score 4/5+.

## [0.12.2.0] - 2026-03-26 — Deploy with Confidence: First-Run Dry Run

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

## [0.12.1.0] - 2026-03-26 — Smarter Browsing: Network Idle, State Persistence, Iframes

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

## [0.12.0.0] - 2026-03-26 — Headed Mode + Sidebar Agent

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
- **`/ship` no longer tells you to "run /review first."** Ship runs its own pre-landing review in Step 3.5 — asking you to run the same review separately was redundant. The gate is removed; ship just does it.
- **`/land-and-deploy` now checks all 8 review types.** Previously missed `review`, `adversarial-review`, and `codex-plan-review` — if you only ran `/review` (not `/plan-eng-review`), land-and-deploy wouldn't see it.
- **Dashboard Outside Voice row now works.** Was showing "0 runs" even after outside voices ran in `/plan-ceo-review` or `/plan-eng-review`. Now correctly maps to `codex-plan-review` entries.
- **`/codex review` now tracks staleness.** Added the `commit` field to codex review log entries so the dashboard can detect when a codex review is outdated.
- **`/autoplan` no longer hardcodes "clean" status.** Review log entries from autoplan used to always record `status:"clean"` even when issues were found. Now uses proper placeholder tokens that Claude substitutes with real values.

## [0.11.20.0] - 2026-03-26

### Added

- **GitLab support for `/retro` and `/ship`.** You can now run `/ship` on GitLab repos — it creates merge requests via `glab mr create` instead of `gh pr create`. `/retro` detects default branches on both platforms. All 11 skills using `BASE_BRANCH_DETECT` automatically get GitHub, GitLab, and git-native fallback detection.
- **GitHub Enterprise and self-hosted GitLab detection.** If the remote URL doesn't match `github.com` or `gitlab`, gstack checks `gh auth status` / `glab auth status` to detect authenticated platforms — no manual config needed.
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

- **One decision per question — everywhere.** Every skill now presents decisions one at a time, each with its own focused question, recommendation, and options. No more wall-of-text questions that bundle unrelated choices together. This was already enforced in the three plan-review skills; now it's a universal rule across all 23+ skills.

## [0.11.18.0] - 2026-03-24 — Ship With Teeth

`/ship` and `/review` now actually enforce the quality gates they've been talking about. Coverage audit becomes a real gate (not just a diagram), plan completion gets verified against the diff, and verification steps from your plan run automatically.

### Added

- **Test coverage gate in /ship.** AI-assessed coverage below 60% is a hard stop. 60-79% gets a prompt. 80%+ passes. Thresholds are configurable per-project via `## Test Coverage` in CLAUDE.md.
- **Coverage warning in /review.** Low coverage is now flagged prominently before you reach the /ship gate, so you can write tests early.
- **Plan completion audit.** /ship reads your plan file, extracts every actionable item, cross-references against the diff, and shows you a DONE/NOT DONE/PARTIAL/CHANGED checklist. Missing items are a shipping blocker (with override).
- **Plan-aware scope drift detection.** /review's scope drift check now reads the plan file too — not just TODOS.md and PR description.
- **Auto-verification via /qa-only.** /ship reads your plan's verification section and runs /qa-only inline to test it — if a dev server is running on localhost. No server, no problem — it skips gracefully.
- **Shared plan file discovery.** Conversation context first, content-based grep fallback second. Used by plan completion, plan review reports, and verification.
- **Ship metrics logging.** Coverage %, plan completion ratio, and verification results are logged to review JSONL for /retro to track trends.
- **Plan completion in /retro.** Weekly retros now show plan completion rates across shipped branches.

## [0.11.17.0] - 2026-03-24 — Cleaner Skill Descriptions + Proactive Opt-Out

### Changed

- **Skill descriptions are now clean and readable.** Removed the ugly "MANUAL TRIGGER ONLY" prefix from every skill description that was wasting 58 characters and causing build errors for Codex integration.
- **You can now opt out of proactive skill suggestions.** The first time you run any gstack skill, you'll be asked whether you want gstack to suggest skills during your workflow. If you prefer to invoke skills manually, just say no — it's saved as a global setting. You can change your mind anytime with `gstack-config set proactive true/false`.

### Fixed

- **Telemetry source tagging no longer crashes.** Fixed duration guards and source field validation in the telemetry logger so it handles edge cases cleanly instead of erroring.

## [0.11.16.1] - 2026-03-24 — Installation ID Privacy Fix

### Fixed

- **Installation IDs are now random UUIDs instead of hostname hashes.** The old `SHA-256(hostname+username)` approach meant anyone who knew your machine identity could compute your installation ID. Now uses a random UUID stored in `~/.gstack/installation-id` — not derivable from any public input, rotatable by deleting the file.
- **RLS verification script handles edge cases.** `verify-rls.sh` now correctly treats INSERT success as expected (kept for old client compat), handles 409 conflicts and 204 no-ops.

## [0.11.16.0] - 2026-03-24 — Smarter CI + Telemetry Security

### Changed

- **CI runs only gate tests by default — periodic tests run weekly.** Every E2E test is now classified as `gate` (blocks PRs) or `periodic` (weekly cron + on-demand). Gate tests cover functional correctness and safety guardrails. Periodic tests cover expensive Opus quality benchmarks, non-deterministic routing tests, and tests requiring external services (Codex, Gemini). CI feedback is faster and cheaper while quality benchmarks still run weekly.
- **Global touchfiles are now granular.** Previously, changing `gen-skill-docs.ts` triggered all 56 E2E tests. Now only the ~27 tests that actually depend on it run. Same for `llm-judge.ts`, `test-server.ts`, `worktree.ts`, and the Codex/Gemini session runners. The truly global list is down to 3 files (session-runner, eval-store, touchfiles.ts itself).
- **New `test:gate` and `test:periodic` scripts** replace `test:e2e:fast`. Use `EVALS_TIER=gate` or `EVALS_TIER=periodic` to filter tests by tier.
- **Telemetry sync uses `GSTACK_SUPABASE_URL` instead of `GSTACK_TELEMETRY_ENDPOINT`.** Edge functions need the base URL, not the REST API path. The old variable is removed from `config.sh`.
- **Cursor advancement is now safe.** The sync script checks the edge function's `inserted` count before advancing — if zero events were inserted, the cursor holds and retries next run.

### Fixed

- **Telemetry RLS policies tightened.** Row-level security policies on all telemetry tables now deny direct access via the anon key. All reads and writes go through validated edge functions with schema checks, event type allowlists, and field length limits.
- **Community dashboard is faster and server-cached.** Dashboard stats are now served from a single edge function with 1-hour server-side caching, replacing multiple direct queries.

### For contributors

- `E2E_TIERS` map in `test/helpers/touchfiles.ts` classifies every test — a free validation test ensures it stays in sync with `E2E_TOUCHFILES`
- `EVALS_FAST` / `FAST_EXCLUDED_TESTS` removed in favor of `EVALS_TIER`
- `allow_failure` removed from CI matrix (gate tests should be reliable)
- New `.github/workflows/evals-periodic.yml` runs periodic tests Monday 6 AM UTC
- New migration: `supabase/migrations/002_tighten_rls.sql`
- New smoke test: `supabase/verify-rls.sh` (9 checks: 5 reads + 4 writes)
- Extended `test/telemetry.test.ts` with field name verification
- Untracked `browse/dist/` binaries from git (arm64-only, rebuilt by `./setup`)

## [0.11.15.0] - 2026-03-24 — E2E Test Coverage for Plan Reviews & Codex

### Added

- **E2E tests verify plan review reports appear at the bottom of plans.** The `/plan-eng-review` review report is now tested end-to-end — if it stops writing `## GSTACK REVIEW REPORT` to the plan file, the test catches it.
- **E2E tests verify Codex is offered in every plan skill.** Four new lightweight tests confirm that `/office-hours`, `/plan-ceo-review`, `/plan-design-review`, and `/plan-eng-review` all check for Codex availability, prompt the user, and handle the fallback when Codex is unavailable.

### For contributors

- New E2E tests in `test/skill-e2e-plan.test.ts`: `plan-review-report`, `codex-offered-eng-review`, `codex-offered-ceo-review`, `codex-offered-office-hours`, `codex-offered-design-review`
- Updated touchfile mappings and selection count assertions
- Added `touchfiles` to the documented global touchfile list in CLAUDE.md

## [0.11.14.0] - 2026-03-24 — Windows Browse Fix

### Fixed

- **Browse engine now works on Windows.** Three compounding bugs blocked all Windows `/browse` users: the server process died when the CLI exited (Bun's `unref()` doesn't truly detach on Windows), the health check never ran because `process.kill(pid, 0)` is broken in Bun binaries on Windows, and Chromium's sandbox failed when spawned through the Bun→Node process chain. All three are now fixed. Credits to @fqueiro (PR #191) for identifying the `detached: true` approach.
- **Health check runs first on all platforms.** `ensureServer()` now tries an HTTP health check before falling back to PID-based detection — more reliable on every OS, not just Windows.
- **Startup errors are logged to disk.** When the server fails to start, errors are written to `~/.gstack/browse-startup-error.log` so Windows users (who lose stderr due to process detachment) can debug.
- **Chromium sandbox disabled on Windows.** Chromium's sandbox requires elevated privileges when spawned through the Bun→Node chain — now disabled on Windows only.

### For contributors

- New tests for `isServerHealthy()` and startup error logging in `browse/test/config.test.ts`

## [0.11.13.0] - 2026-03-24 — Worktree Isolation + Infrastructure Elegance

### Added

- **E2E tests now run in git worktrees.** Gemini and Codex tests no longer pollute your working tree. Each test suite gets an isolated worktree, and useful changes the AI agent makes are automatically harvested as patches you can cherry-pick. Run `git apply ~/.gstack-dev/harvests/<id>/gemini.patch` to grab improvements.
- **Harvest deduplication.** If a test keeps producing the same improvement across runs, it's detected via SHA-256 hash and skipped — no duplicate patches piling up.
- **`describeWithWorktree()` helper.** Any E2E test can now opt into worktree isolation with a one-line wrapper. Future tests that need real repo context (git history, real diff) can use this instead of tmpdirs.

### Changed

- **Gen-skill-docs is now a modular resolver pipeline.** The monolithic 1700-line generator is split into 8 focused resolver modules (browse, preamble, design, review, testing, utility, constants, codex-helpers). Adding a new placeholder resolver is now a single file instead of editing a megafunction.
- **Eval results are project-scoped.** Results now live in `~/.gstack/projects/$SLUG/evals/` instead of the global `~/.gstack-dev/evals/`. Multi-project users no longer get eval results mixed together.

### For contributors

- WorktreeManager (`lib/worktree.ts`) is a reusable platform module — future skills like `/batch` can import it directly.
- 12 new unit tests for WorktreeManager covering lifecycle, harvest, dedup, and error handling.
- `GLOBAL_TOUCHFILES` updated so worktree infrastructure changes trigger all E2E tests.

## [0.11.12.0] - 2026-03-24 — Triple-Voice Autoplan

Every `/autoplan` phase now gets two independent second opinions — one from Codex (OpenAI's frontier model) and one from a fresh Claude subagent. Three AI reviewers looking at your plan from different angles, each phase building on the last.

### Added

- **Dual voices in every autoplan phase.** CEO review, Design review, and Eng review each run both a Codex challenge and an independent Claude subagent simultaneously. You get a consensus table showing where the models agree and disagree — disagreements surface as taste decisions at the final gate.
- **Phase-cascading context.** Codex gets prior-phase findings as context (CEO concerns inform Design review, CEO+Design inform Eng). Claude subagent stays truly independent for genuine cross-model validation.
- **Structured consensus tables.** CEO phase scores 6 strategic dimensions, Design uses the litmus scorecard, Eng scores 6 architecture dimensions. CONFIRMED/DISAGREE for each.
- **Cross-phase synthesis.** Phase 4 gate highlights themes that appeared independently in multiple phases — high-confidence signals when different reviewers catch the same issue.
- **Sequential enforcement.** STOP markers between phases + pre-phase checklists prevent autoplan from accidentally parallelizing CEO/Design/Eng (each phase depends on the previous).
- **Phase-transition summaries.** Brief status at each phase boundary so you can track progress without waiting for the full pipeline.
- **Degradation matrix.** When Codex or the Claude subagent fails, autoplan gracefully degrades with clear labels (`[codex-only]`, `[subagent-only]`, `[single-reviewer mode]`).

## [0.11.11.0] - 2026-03-23 — Community Wave 3

10 community PRs merged — bug fixes, platform support, and workflow improvements.

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

## [0.11.10.0] - 2026-03-23 — CI Evals on Ubicloud

### Added

- **E2E evals now run in CI on every PR.** 12 parallel GitHub Actions runners on Ubicloud spin up per PR, each running one test suite. Docker image pre-bakes bun, node, Claude CLI, and deps so setup is near-instant. Results posted as a PR comment with pass/fail + cost breakdown.
- **3x faster eval runs.** All E2E tests run concurrently within files via `testConcurrentIfSelected`. Wall clock drops from ~18min to ~6min — limited by the slowest individual test, not sequential sum.
- **Docker CI image** (`Dockerfile.ci`) with pre-installed toolchain. Rebuilds automatically when Dockerfile or package.json changes, cached by content hash in GHCR.

### Fixed

- **Routing tests now work in CI.** Skills are installed at top-level `.claude/skills/` instead of nested under `.claude/skills/gstack/` — project-level skill discovery doesn't recurse into subdirectories.

### For contributors

- `EVALS_CONCURRENCY=40` in CI for maximum parallelism (local default stays at 15)
- Ubicloud runners at ~$0.006/run (10x cheaper than GitHub standard runners)
- `workflow_dispatch` trigger for manual re-runs

## [0.11.9.0] - 2026-03-23 — Codex Skill Loading Fix

### Fixed

- **Codex no longer rejects gstack skills with "invalid SKILL.md".** Existing installs had oversized description fields (>1024 chars) that Codex silently rejected. The build now errors if any Codex description exceeds 1024 chars, setup always regenerates `.agents/` to prevent stale files, and a one-time migration auto-cleans oversized descriptions on existing installs.
- **`package.json` version now stays in sync with `VERSION`.** Was 6 minor versions behind. A new CI test catches future drift.

### Added

- **Codex E2E tests now assert no skill loading errors.** The exact "Skipped loading skill(s)" error that prompted this fix is now a regression test — `stderr` is captured and checked.
- **Codex troubleshooting entry in README.** Manual fix instructions for users who hit the loading error before the auto-migration runs.

### For contributors

- `test/gen-skill-docs.test.ts` validates all `.agents/` descriptions stay within 1024 chars
- `gstack-update-check` includes a one-time migration that deletes oversized Codex SKILL.md files
- P1 TODO added: Codex→Claude reverse buddy check skill

## [0.11.8.0] - 2026-03-23 — zsh Compatibility Fix

### Fixed

- **gstack skills now work in zsh without errors.** Every skill preamble used a `.pending-*` glob pattern that triggered zsh's "no matches found" error on every invocation (the common case where no pending telemetry files exist). Replaced shell glob with `find` to avoid zsh's NOMATCH behavior entirely. Thanks to @hnshah for the initial report and fix in PR #332. Fixes #313.

### Added

- **Regression test for zsh glob safety.** New test verifies all generated SKILL.md files use `find` instead of bare shell globs for `.pending-*` pattern matching.

## [0.11.7.0] - 2026-03-23 — /review → /ship Handoff Fix

### Fixed

- **`/review` now satisfies the ship readiness gate.** Previously, running `/review` before `/ship` always showed "NOT CLEARED" because `/review` didn't log its result and `/ship` only looked for `/plan-eng-review`. Now `/review` persists its outcome to the review log, and all dashboards recognize both `/review` (diff-scoped) and `/plan-eng-review` (plan-stage) as valid Eng Review sources.
- **Ship abort prompt now mentions both review options.** When Eng Review is missing, `/ship` suggests "run `/review` or `/plan-eng-review`" instead of only mentioning `/plan-eng-review`.

### For contributors

- Based on PR #338 by @malikrohail. DRY improvement per eng review: updated the shared `REVIEW_DASHBOARD` resolver instead of creating a duplicate ship-only resolver.
- 4 new validation tests covering review-log persistence, dashboard propagation, and abort text.

## [0.11.6.0] - 2026-03-23 — Infrastructure-First Security Audit

### Added

- **`/cso` v2 — start where the breaches actually happen.** The security audit now begins with your infrastructure attack surface (leaked secrets in git history, dependency CVEs, CI/CD pipeline misconfigurations, unverified webhooks, Dockerfile security) before touching application code. 15 phases covering secrets archaeology, supply chain, CI/CD, LLM/AI security, skill supply chain, OWASP Top 10, STRIDE, and active verification.
- **Two audit modes.** `--daily` runs a zero-noise scan with an 8/10 confidence gate (only reports findings it's highly confident about). `--comprehensive` does a deep monthly scan with a 2/10 bar (surfaces everything worth investigating).
- **Active verification.** Every finding gets independently verified by a subagent before reporting — no more grep-and-guess. Variant analysis: when one vulnerability is confirmed, the entire codebase is searched for the same pattern.
- **Trend tracking.** Findings are fingerprinted and tracked across audit runs. You can see what's new, what's fixed, and what's been ignored.
- **Diff-scoped auditing.** `--diff` mode scopes the audit to changes on your branch vs the base branch — perfect for pre-merge security checks.
- **3 E2E tests** with planted vulnerabilities (hardcoded API keys, tracked `.env` files, unsigned webhooks, unpinned GitHub Actions, rootless Dockerfiles). All verified passing.

### Changed

- **Stack detection before scanning.** v1 ran Ruby/Java/PHP/C# patterns on every project without checking the stack. v2 detects your framework first and prioritizes relevant checks.
- **Proper tool usage.** v1 used raw `grep` in Bash; v2 uses Claude Code's native `Grep` tool for reliable results without truncation.

## [0.11.5.2] - 2026-03-22 — Outside Voice

### Added

- **Plan reviews now offer an independent second opinion.** After all review sections complete in `/plan-ceo-review` or `/plan-eng-review`, you can get a "brutally honest outside voice" from a different AI model (Codex CLI, or a fresh Claude subagent if Codex isn't installed). It reads your plan, finds what the review missed — logical gaps, unstated assumptions, feasibility risks — and presents findings verbatim. Optional, recommended, never blocks shipping.
- **Cross-model tension detection.** When the outside voice disagrees with the review findings, the disagreements are surfaced automatically and offered as TODOs so nothing gets lost.
- **Outside Voice in the Review Readiness Dashboard.** `/ship` now shows whether an outside voice ran on the plan, alongside the existing CEO/Eng/Design/Adversarial review rows.

### Changed

- **`/plan-eng-review` Codex integration upgraded.** The old hardcoded Step 0.5 is replaced with a richer resolver that adds Claude subagent fallback, review log persistence, dashboard visibility, and higher reasoning effort (`xhigh`).

## [0.11.5.1] - 2026-03-23 — Inline Office Hours

### Changed

- **No more "open another window" for /office-hours.** When `/plan-ceo-review` or `/plan-eng-review` offer to run `/office-hours` first, it now runs inline in the same conversation. The review picks up right where it left off after the design doc is ready. Same for mid-session detection when you're still figuring out what to build.
- **Handoff note infrastructure removed.** The handoff notes that bridged the old "go to another window" flow are no longer written. Existing notes from prior sessions are still read for backward compatibility.

## [0.11.5.0] - 2026-03-23 — Bash Compatibility Fix

### Fixed

- **`gstack-review-read` and `gstack-review-log` no longer crash under bash.** These scripts used `source <(gstack-slug)` which silently fails to set variables under bash with `set -euo pipefail`, causing `SLUG: unbound variable` errors. Replaced with `eval "$(gstack-slug)"` which works correctly in both bash and zsh.
- **All SKILL.md templates updated.** Every template that instructed agents to run `source <(gstack-slug)` now uses `eval "$(gstack-slug)"` for cross-shell compatibility. Regenerated all SKILL.md files from templates.
- **Regression tests added.** New tests verify `eval "$(gstack-slug)"` works under bash strict mode, and guard against `source <(.*gstack-slug` patterns reappearing in templates or bin scripts.

## [0.11.4.0] - 2026-03-22 — Codex in Office Hours

### Added

- **Your brainstorming now gets a second opinion.** After premise challenge in `/office-hours`, you can opt in to a Codex cold read — a completely independent AI that hasn't seen the conversation reviews your problem, answers, and premises. It steelmans your idea, identifies the most revealing thing you said, challenges one premise, and proposes a 48-hour prototype. Two different AI models seeing different things catches blind spots neither would find alone.
- **Cross-Model Perspective in design docs.** When you use the second opinion, the design doc automatically includes a `## Cross-Model Perspective` section capturing what Codex said — so the independent view is preserved for downstream reviews.
- **New founder signal: defended premise with reasoning.** When Codex challenges one of your premises and you keep it with articulated reasoning (not just dismissal), that's tracked as a positive signal of conviction.

## [0.11.3.0] - 2026-03-23 — Design Outside Voices

### Added

- **Every design review now gets a second opinion.** `/plan-design-review`, `/design-review`, and `/design-consultation` dispatch both Codex (OpenAI) and a fresh Claude subagent in parallel to independently evaluate your design — then synthesize findings with a litmus scorecard showing where they agree and disagree. Cross-model agreement = high confidence; disagreement = investigate.
- **OpenAI's design hard rules baked in.** 7 hard rejection criteria, 7 litmus checks, and a landing-page vs app-UI classifier from OpenAI's "Designing Delightful Frontends" framework — merged with gstack's existing 10-item AI slop blacklist. Your design gets evaluated against the same rules OpenAI recommends for their own models.
- **Codex design voice in every PR.** The lightweight design review that runs in `/ship` and `/review` now includes a Codex design check when frontend files change — automatic, no opt-in needed.
- **Outside voices in /office-hours brainstorming.** After wireframe sketches, you can now get Codex + Claude subagent design perspectives on your approaches before committing to a direction.
- **AI slop blacklist extracted as shared constant.** The 10 anti-patterns (purple gradients, 3-column icon grids, centered everything, etc.) are now defined once and shared across all design skills. Easier to maintain, impossible to drift.

## [0.11.2.0] - 2026-03-22 — Codex Just Works

### Fixed

- **Codex no longer shows "exceeds maximum length of 1024 characters" on startup.** Skill descriptions compressed from ~1,200 words to ~280 words — well under the limit. Every skill now has a test enforcing the cap.
- **No more duplicate skill discovery.** Codex used to find both source SKILL.md files and generated Codex skills, showing every skill twice. Setup now creates a minimal runtime root at `~/.codex/skills/gstack` with only the assets Codex needs — no source files exposed.
- **Old direct installs auto-migrate.** If you previously cloned gstack into `~/.codex/skills/gstack`, setup detects this and moves it to `~/.gstack/repos/gstack` so skills aren't discovered from the source checkout.
- **Sidecar directory no longer linked as a skill.** The `.agents/skills/gstack` runtime asset directory was incorrectly symlinked alongside real skills — now skipped.

### Added

- **Repo-local Codex installs.** Clone gstack into `.agents/skills/gstack` inside any repo and run `./setup --host codex` — skills install next to the checkout, no global `~/.codex/` needed. Generated preambles auto-detect whether to use repo-local or global paths at runtime.
- **Kiro CLI support.** `./setup --host kiro` installs skills for the Kiro agent platform, rewriting paths and symlinking runtime assets. Auto-detected by `--host auto` if `kiro-cli` is installed.
- **`.agents/` is now gitignored.** Generated Codex skill files are no longer committed — they're created at setup time from templates. Removes 14,000+ lines of generated output from the repo.

### Changed

- **`GSTACK_DIR` renamed to `SOURCE_GSTACK_DIR` / `INSTALL_GSTACK_DIR`** throughout the setup script for clarity about which path points to the source repo vs the install location.
- **CI validates Codex generation succeeds** instead of checking committed file freshness (since `.agents/` is no longer committed).

## [0.11.1.1] - 2026-03-22 — Plan Files Always Show Review Status

### Added

- **Every plan file now shows review status.** When you exit plan mode, the plan file automatically gets a `GSTACK REVIEW REPORT` section — even if you haven't run any formal reviews yet. Previously, this section only appeared after running `/plan-eng-review`, `/plan-ceo-review`, `/plan-design-review`, or `/codex review`. Now you always know where you stand: which reviews have run, which haven't, and what to do next.

## [0.11.1.0] - 2026-03-22 — Global Retro: Cross-Project AI Coding Retrospective

### Added

- **`/retro global` — see everything you shipped across every project in one report.** Scans your Claude Code, Codex CLI, and Gemini CLI sessions, traces each back to its git repo, deduplicates by remote, then runs a full retro across all of them. Global shipping streak, context-switching metrics, per-project breakdowns with personal contributions, and cross-tool usage patterns. Run `/retro global 14d` for a two-week view.
- **Per-project personal contributions in global retro.** Each project in the global retro now shows YOUR commits, LOC, key work, commit type mix, and biggest ship — separate from team totals. Solo projects say "Solo project — all commits are yours." Team projects you didn't touch show session count only.
- **`gstack-global-discover` — the engine behind global retro.** Standalone discovery script that finds all AI coding sessions on your machine, resolves working directories to git repos, normalizes SSH/HTTPS remotes for dedup, and outputs structured JSON. Compiled binary ships with gstack — no `bun` runtime needed.

### Fixed

- **Discovery script reads only the first few KB of session files** instead of loading entire multi-MB JSONL transcripts into memory. Prevents OOM on machines with extensive coding history.
- **Claude Code session counts are now accurate.** Previously counted all JSONL files in a project directory; now only counts files modified within the time window.
- **Week windows (`1w`, `2w`) are now midnight-aligned** like day windows, so `/retro global 1w` and `/retro global 7d` produce consistent results.

## [0.11.0.0] - 2026-03-22 — /cso: Zero-Noise Security Audits

### Added

- **`/cso` — your Chief Security Officer.** Full codebase security audit: OWASP Top 10, STRIDE threat modeling, attack surface mapping, data classification, and dependency scanning. Each finding includes severity, confidence score, a concrete exploit scenario, and remediation options. Not a linter — a threat model.
- **Zero-noise false positive filtering.** 17 hard exclusions and 9 precedents adapted from Anthropic's security review methodology. DOS isn't a finding. Test files aren't attack surface. React is XSS-safe by default. Every finding must score 8/10+ confidence to make the report. The result: 3 real findings, not 3 real + 12 theoretical.
- **Independent finding verification.** Each candidate finding is verified by a fresh sub-agent that only sees the finding and the false positive rules — no anchoring bias from the initial scan. Findings that fail independent verification are silently dropped.
- **`browse storage` now redacts secrets automatically.** Tokens, JWTs, API keys, GitHub PATs, and Bearer tokens are detected by both key name and value prefix. You see `[REDACTED — 42 chars]` instead of the secret.
- **Azure metadata endpoint blocked.** SSRF protection for `browse goto` now covers all three major cloud providers (AWS, GCP, Azure).

### Fixed

- **`gstack-slug` hardened against shell injection.** Output sanitized to alphanumeric, dot, dash, and underscore only. All remaining `eval $(gstack-slug)` callers migrated to `source <(...)`.
- **DNS rebinding protection.** `browse goto` now resolves hostnames to IPs and checks against the metadata blocklist — prevents attacks where a domain initially resolves to a safe IP, then switches to a cloud metadata endpoint.
- **Concurrent server start race fixed.** An exclusive lockfile prevents two CLI invocations from both killing the old server and starting new ones simultaneously, which could leave orphaned Chromium processes.
- **Smarter storage redaction.** Key matching now uses underscore-aware boundaries (won't false-positive on `keyboardShortcuts` or `monkeyPatch`). Value detection expanded to cover AWS, Stripe, Anthropic, Google, Sendgrid, and Supabase key prefixes.
- **CI workflow YAML lint error fixed.**

### For contributors

- **Community PR triage process documented** in CONTRIBUTING.md.
- **Storage redaction test coverage.** Four new tests for key-based and value-based detection.

## [0.10.2.0] - 2026-03-22 — Autoplan Depth Fix

### Fixed

- **`/autoplan` now produces full-depth reviews instead of compressing everything to one-liners.** When autoplan said "auto-decide," it meant "decide FOR the user using principles" — but the agent interpreted it as "skip the analysis entirely." Now autoplan explicitly defines the contract: auto-decide replaces your judgment, not the analysis. Every review section still gets read, diagrammed, and evaluated. You get the same depth as running each review manually.
- **Execution checklists for CEO and Eng phases.** Each phase now enumerates exactly what must be produced — premise challenges, architecture diagrams, test coverage maps, failure registries, artifacts on disk. No more "follow that file at full depth" without saying what "full depth" means.
- **Pre-gate verification catches skipped outputs.** Before presenting the final approval gate, autoplan now checks a concrete checklist of required outputs. Missing items get produced before the gate opens (max 2 retries, then warns).
- **Test review can never be skipped.** The Eng review's test diagram section — the highest-value output — is explicitly marked NEVER SKIP OR COMPRESS with instructions to read actual diffs, map every codepath to coverage, and write the test plan artifact.

## [0.10.1.0] - 2026-03-22 — Test Coverage Catalog

### Added

- **Test coverage audit now works everywhere — plan, ship, and review.** The codepath tracing methodology (ASCII diagrams, quality scoring, gap detection) is shared across `/plan-eng-review`, `/ship`, and `/review` via a single `{{TEST_COVERAGE_AUDIT}}` resolver. Plan mode adds missing tests to your plan before you write code. Ship mode auto-generates tests for gaps. Review mode finds untested paths during pre-landing review. One methodology, three contexts, zero copy-paste.
- **`/review` Step 4.75 — test coverage diagram.** Before landing code, `/review` now traces every changed codepath and produces an ASCII coverage map showing what's tested (★★★/★★/★) and what's not (GAP). Gaps become INFORMATIONAL findings that follow the Fix-First flow — you can generate the missing tests right there.
- **E2E test recommendations built in.** The coverage audit knows when to recommend E2E tests (common user flows, tricky integrations where unit tests can't cover it) vs unit tests, and flags LLM prompt changes that need eval coverage. No more guessing whether something needs an integration test.
- **Regression detection iron rule.** When a code change modifies existing behavior, gstack always writes a regression test — no asking, no skipping. If you changed it, you test it.
- **`/ship` failure triage.** When tests fail during ship, the coverage audit classifies each failure and recommends next steps instead of just dumping the error output.
- **Test framework auto-detection.** Reads your CLAUDE.md for test commands first, then auto-detects from project files (package.json, Gemfile, pyproject.toml, etc.). Works with any framework.

### Fixed

- **gstack no longer crashes in repos without an `origin` remote.** The `gstack-repo-mode` helper now gracefully handles missing remotes, bare repos, and empty git output — defaulting to `unknown` mode instead of crashing the preamble.
- **`REPO_MODE` defaults correctly when the helper emits nothing.** Previously an empty response from `gstack-repo-mode` left `REPO_MODE` unset, causing downstream template errors.

## [0.10.0.0] - 2026-03-22 — Autoplan

### Added

- **`/autoplan` — one command, fully reviewed plan.** Hand it a rough plan and it runs the full CEO → design → eng review pipeline automatically. Reads the actual review skill files from disk (same depth, same rigor as running each review manually) and makes intermediate decisions using 6 encoded principles: completeness, boil lakes, pragmatic, DRY, explicit over clever, bias toward action. Taste decisions (close approaches, borderline scope, codex disagreements) surface at a final approval gate. You approve, override, interrogate, or revise. Saves a restore point so you can re-run from scratch. Writes review logs compatible with `/ship`'s dashboard.

## [0.9.8.0] - 2026-03-21 — Deploy Pipeline + E2E Performance

### Added

- **`/land-and-deploy` — merge, deploy, and verify in one command.** Takes over where `/ship` left off. Merges the PR, waits for CI and deploy workflows, then runs canary verification on your production URL. Auto-detects your deploy platform (Fly.io, Render, Vercel, Netlify, Heroku, GitHub Actions). Offers revert at every failure point. One command from "PR approved" to "verified in production."
- **`/canary` — post-deploy monitoring loop.** Watches your live app for console errors, performance regressions, and page failures using the browse daemon. Takes periodic screenshots, compares against pre-deploy baselines, and alerts on anomalies. Run `/canary https://myapp.com --duration 10m` after any deploy.
- **`/benchmark` — performance regression detection.** Establishes baselines for page load times, Core Web Vitals, and resource sizes. Compares before/after on every PR. Tracks performance trends over time. Catches the bundle size regressions that code review misses.
- **`/setup-deploy` — one-time deploy configuration.** Detects your deploy platform, production URL, health check endpoints, and deploy status commands. Writes the config to CLAUDE.md so all future `/land-and-deploy` runs are fully automatic.
- **`/review` now includes Performance & Bundle Impact analysis.** The informational review pass checks for heavy dependencies, missing lazy loading, synchronous script tags, and bundle size regressions. Catches moment.js-instead-of-date-fns before it ships.

### Changed

- **E2E tests now run 3-5x faster.** Structure tests default to Sonnet (5x faster, 5x cheaper). Quality tests (planted-bug detection, design quality, strategic review) stay on Opus. Full suite dropped from 50-80 minutes to ~15-25 minutes.
- **`--retry 2` on all E2E tests.** Flaky tests get a second chance without masking real failures.
- **`test:e2e:fast` tier.** Excludes the 8 slowest Opus quality tests for quick feedback (~5-7 minutes). Run `bun run test:e2e:fast` for rapid iteration.
- **E2E timing telemetry.** Every test now records `first_response_ms`, `max_inter_turn_ms`, and `model` used. Wall-clock timing shows whether parallelism is actually working.

### Fixed

- **`plan-design-review-plan-mode` no longer races.** Each test gets its own isolated tmpdir — no more concurrent tests polluting each other's working directory.
- **`ship-local-workflow` no longer wastes 6 of 15 turns.** Ship workflow steps are inlined in the test prompt instead of having the agent read the 700+ line SKILL.md at runtime.
- **`design-consultation-core` no longer fails on synonym sections.** "Colors" matches "Color", "Type System" matches "Typography" — fuzzy synonym-based matching with all 7 sections still required.

## [0.9.7.0] - 2026-03-21 — Plan File Review Report

### Added

- **Every plan file now shows which reviews have run.** After any review skill finishes (`/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/codex review`), a markdown table is appended to the plan file itself — showing each review's trigger command, purpose, run count, status, and findings summary. Anyone reading the plan can see review status at a glance without checking conversation history.
- **Review logs now capture richer data.** CEO reviews log scope proposal counts (proposed/accepted/deferred), eng reviews log total issues found, design reviews log before→after scores, and codex reviews log how many findings were fixed. The plan file report uses these fields directly — no more guessing from partial metadata.

## [0.9.6.0] - 2026-03-21 — Auto-Scaled Adversarial Review

### Changed

- **Review thoroughness now scales automatically with diff size.** Small diffs (<50 lines) skip adversarial review entirely — no wasted time on typo fixes. Medium diffs (50–199 lines) get a cross-model adversarial challenge from Codex (or a Claude adversarial subagent if Codex isn't installed). Large diffs (200+ lines) get all four passes: Claude structured, Codex structured review with pass/fail gate, Claude adversarial subagent, and Codex adversarial challenge. No configuration needed — it just works.
- **Claude now has an adversarial mode.** A fresh Claude subagent with no checklist bias reviews your code like an attacker — finding edge cases, race conditions, security holes, and silent data corruption that the structured review might miss. Findings are classified as FIXABLE (auto-fixed) or INVESTIGATE (your call).
- **Review dashboard shows "Adversarial" instead of "Codex Review."** The dashboard row reflects the new multi-model reality — it tracks whichever adversarial passes actually ran, not just Codex.

## [0.9.5.0] - 2026-03-21 — Builder Ethos

### Added

- **ETHOS.md — gstack's builder philosophy in one document.** Four principles: The Golden Age (AI compression ratios), Boil the Lake (completeness is cheap), Search Before Building (three layers of knowledge), and Build for Yourself. This is the philosophical source of truth that every workflow skill references.
- **Every workflow skill now searches before recommending.** Before suggesting infrastructure patterns, concurrency approaches, or framework-specific solutions, gstack checks if the runtime has a built-in and whether the pattern is current best practice. Three layers of knowledge — tried-and-true (Layer 1), new-and-popular (Layer 2), and first-principles (Layer 3) — with the most valuable insights prized above all.
- **Eureka moments.** When first-principles reasoning reveals that conventional wisdom is wrong, gstack names it, celebrates it, and logs it. Your weekly `/retro` now surfaces these insights so you can see where your projects zigged while others zagged.
- **`/office-hours` adds Landscape Awareness phase.** After understanding your problem through questioning but before challenging premises, gstack searches for what the world thinks — then runs a three-layer synthesis to find where conventional wisdom might be wrong for your specific case.
- **`/plan-eng-review` adds search check.** Step 0 now verifies architectural patterns against current best practices and flags custom solutions where built-ins exist.
- **`/investigate` searches on hypothesis failure.** When your first debugging hypothesis is wrong, gstack searches for the exact error message and known framework issues before guessing again.
- **`/design-consultation` three-layer synthesis.** Competitive research now uses the structured Layer 1/2/3 framework to find where your product should deliberately break from category norms.
- **CEO review saves context when handing off to `/office-hours`.** When `/plan-ceo-review` suggests running `/office-hours` first, it now saves a handoff note with your system audit findings and any discussion so far. When you come back and re-invoke `/plan-ceo-review`, it picks up that context automatically — no more starting from scratch.

## [0.9.4.1] - 2026-03-20

### Changed

- **`/retro` no longer nags about PR size.** The retro still reports PR size distribution (Small/Medium/Large/XL) as neutral data, but no longer flags XL PRs as problems or recommends splitting them. AI reviews don't fatigue — the unit of work is the feature, not the diff.

## [0.9.4.0] - 2026-03-20 — Codex Reviews On By Default

### Changed

- **Codex code reviews now run automatically in `/ship` and `/review`.** No more "want a second opinion?" prompt every time — Codex reviews both your code (with a pass/fail gate) and runs an adversarial challenge by default. First-time users get a one-time opt-in prompt; after that, it's hands-free. Configure with `gstack-config set codex_reviews enabled|disabled`.
- **All Codex operations use maximum reasoning power.** Review, adversarial, and consult modes all use `xhigh` reasoning effort — when an AI is reviewing your code, you want it thinking as hard as possible.
- **Codex review errors can't corrupt the dashboard.** Auth failures, timeouts, and empty responses are now detected before logging results, so the Review Readiness Dashboard never shows a false "passed" entry. Adversarial stderr is captured separately.
- **Codex review log includes commit hash.** Staleness detection now works correctly for Codex reviews, matching the same commit-tracking behavior as eng/CEO/design reviews.

### Fixed

- **Codex-for-Codex recursion prevented.** When gstack runs inside Codex CLI (`.agents/skills/`), the Codex review step is completely stripped — no accidental infinite loops.

## [0.9.3.0] - 2026-03-20 — Windows Support

### Fixed

- **gstack now works on Windows 11.** Setup no longer hangs when verifying Playwright, and the browse server automatically falls back to Node.js to work around a Bun pipe-handling bug on Windows ([bun#4253](https://github.com/oven-sh/bun/issues/4253)). Just make sure Node.js is installed alongside Bun. macOS and Linux are completely unaffected.
- **Path handling works on Windows.** All hardcoded `/tmp` paths and Unix-style path separators now use platform-aware equivalents via a new `platform.ts` module. Path traversal protection works correctly with Windows backslash separators.

### Added

- **Bun API polyfill for Node.js.** When the browse server runs under Node.js on Windows, a compatibility layer provides `Bun.serve()`, `Bun.spawn()`, `Bun.spawnSync()`, and `Bun.sleep()` equivalents. Fully tested.
- **Node server build script.** `browse/scripts/build-node-server.sh` transpiles the server for Node.js, stubs `bun:sqlite`, and injects the polyfill — all automated during `bun run build`.

## [0.9.2.0] - 2026-03-20 — Gemini CLI E2E Tests

### Added

- **Gemini CLI is now tested end-to-end.** Two E2E tests verify that gstack skills work when invoked by Google's Gemini CLI (`gemini -p`). The `gemini-discover-skill` test confirms skill discovery from `.agents/skills/`, and `gemini-review-findings` runs a full code review via gstack-review. Both parse Gemini's stream-json NDJSON output and track token usage.
- **Gemini JSONL parser with 10 unit tests.** `parseGeminiJSONL` handles all Gemini event types (init, message, tool_use, tool_result, result) with defensive parsing for malformed input. The parser is a pure function, independently testable without spawning the CLI.
- **`bun run test:gemini`** and **`bun run test:gemini:all`** scripts for running Gemini E2E tests independently. Gemini tests are also included in `test:evals` and `test:e2e` aggregate scripts.

## [0.9.1.0] - 2026-03-20 — Adversarial Spec Review + Skill Chaining

### Added

- **Your design docs now get stress-tested before you see them.** When you run `/office-hours`, an independent AI reviewer checks your design doc for completeness, consistency, clarity, scope creep, and feasibility — up to 3 rounds. You get a quality score (1-10) and a summary of what was caught and fixed. The doc you approve has already survived adversarial review.
- **Visual wireframes during brainstorming.** For UI ideas, `/office-hours` now generates a rough HTML wireframe using your project's design system (from DESIGN.md) and screenshots it. You see what you're designing while you're still thinking, not after you've coded it.
- **Skills help each other now.** `/plan-ceo-review` and `/plan-eng-review` detect when you'd benefit from running `/office-hours` first and offer it — one-tap to switch, one-tap to decline. If you seem lost during a CEO review, it'll gently suggest brainstorming first.
- **Spec review metrics.** Every adversarial review logs iterations, issues found/fixed, and quality score to `~/.gstack/analytics/spec-review.jsonl`. Over time, you can see if your design docs are getting better.

## [0.9.0.1] - 2026-03-19

### Changed

- **Telemetry opt-in now defaults to community mode.** First-time prompt asks "Help gstack get better!" (community mode with stable device ID for trend tracking). If you decline, you get a second chance with anonymous mode (no unique ID, just a counter). Respects your choice either way.

### Fixed

- **Review logs and telemetry now persist during plan mode.** When you ran `/plan-ceo-review`, `/plan-eng-review`, or `/plan-design-review` in plan mode, the review result wasn't saved to disk — so the dashboard showed stale or missing entries even though you just completed a review. Same issue affected telemetry logging at the end of every skill. Both now work reliably in plan mode.

## [0.9.0] - 2026-03-19 — Works on Codex, Gemini CLI, and Cursor

**gstack now works on any AI agent that supports the open SKILL.md standard.** Install once, use from Claude Code, OpenAI Codex CLI, Google Gemini CLI, or Cursor. All 21 skills are available in `.agents/skills/` -- just run `./setup --host codex` or `./setup --host auto` and your agent discovers them automatically.

- **One install, four agents.** Claude Code reads from `.claude/skills/`, everything else reads from `.agents/skills/`. Same skills, same prompts, adapted for each host. Hook-based safety skills (careful, freeze, guard) get inline safety advisory prose instead of hooks -- they work everywhere.
- **Auto-detection.** `./setup --host auto` detects which agents you have installed and sets up both. Already have Claude Code? It still works exactly the same.
- **Codex-adapted output.** Frontmatter is stripped to just name + description (Codex doesn't need allowed-tools or hooks). Paths are rewritten from `~/.claude/` to `~/.codex/`. The `/codex` skill itself is excluded from Codex output -- it's a Claude wrapper around `codex exec`, which would be self-referential.
- **CI checks both hosts.** The freshness check now validates Claude and Codex output independently. Stale Codex docs break the build just like stale Claude docs.

## [0.8.6] - 2026-03-19

### Added

- **You can now see how you use gstack.** Run `gstack-analytics` to see a personal usage dashboard — which skills you use most, how long they take, your success rate. All data stays local on your machine.
- **Opt-in community telemetry.** On first run, gstack asks if you want to share anonymous usage data (skill names, duration, crash info — never code or file paths). Choose "yes" and you're part of the community pulse. Change anytime with `gstack-config set telemetry off`.
- **Community health dashboard.** Run `gstack-community-dashboard` to see what the gstack community is building — most popular skills, crash clusters, version distribution. All powered by Supabase.
- **Install base tracking via update check.** When telemetry is enabled, gstack fires a parallel ping to Supabase during update checks — giving us an install-base count without adding any latency. Respects your telemetry setting (default off). GitHub remains the primary version source.
- **Crash clustering.** Errors are automatically grouped by type and version in the Supabase backend, so the most impactful bugs surface first.
- **Upgrade funnel tracking.** We can now see how many people see upgrade prompts vs actually upgrade — helps us ship better releases.
- **/retro now shows your gstack usage.** Weekly retrospectives include skill usage stats (which skills you used, how often, success rate) alongside your commit history.
- **Session-specific pending markers.** If a skill crashes mid-run, the next invocation correctly finalizes only that session — no more race conditions between concurrent gstack sessions.

## [0.8.5] - 2026-03-19

### Fixed

- **`/retro` now counts full calendar days.** Running a retro late at night no longer silently misses commits from earlier in the day. Git treats bare dates like `--since="2026-03-11"` as "11pm on March 11" if you run it at 11pm — now we pass `--since="2026-03-11T00:00:00"` so it always starts from midnight. Compare mode windows get the same fix.
- **Review log no longer breaks on branch names with `/`.** Branch names like `garrytan/design-system` caused review log writes to fail because Claude Code runs multi-line bash blocks as separate shell invocations, losing variables between commands. New `gstack-review-log` and `gstack-review-read` atomic helpers encapsulate the entire operation in a single command.
- **All skill templates are now platform-agnostic.** Removed Rails-specific patterns (`bin/test-lane`, `RAILS_ENV`, `.includes()`, `rescue StandardError`, etc.) from `/ship`, `/review`, `/plan-ceo-review`, and `/plan-eng-review`. The review checklist now shows examples for Rails, Node, Python, and Django side-by-side.
- **`/ship` reads CLAUDE.md to discover test commands** instead of hardcoding `bin/test-lane` and `npm run test`. If no test commands are found, it asks the user and persists the answer to CLAUDE.md.

### Added

- **Platform-agnostic design principle** codified in CLAUDE.md — skills must read project config, never hardcode framework commands.
- **`## Testing` section** in CLAUDE.md for `/ship` test command discovery.

## [0.8.4] - 2026-03-19

### Added

- **`/ship` now automatically syncs your docs.** After creating the PR, `/ship` runs `/document-release` as Step 8.5 — README, ARCHITECTURE, CONTRIBUTING, and CLAUDE.md all stay current without an extra command. No more stale docs after shipping.
- **Six new skills in the docs.** README, docs/skills.md, and BROWSER.md now cover `/codex` (multi-AI second opinion), `/careful` (destructive command warnings), `/freeze` (directory-scoped edit lock), `/guard` (full safety mode), `/unfreeze`, and `/gstack-upgrade`. The sprint skill table keeps its 15 specialists; a new "Power tools" section covers the rest.
- **Browse handoff documented everywhere.** BROWSER.md command table, docs/skills.md deep-dive, and README "What's new" all explain `$B handoff` and `$B resume` for CAPTCHA/MFA/auth walls.
- **Proactive suggestions know about all skills.** Root SKILL.md.tmpl now suggests `/codex`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, and `/gstack-upgrade` at the right workflow stages.

## [0.8.3] - 2026-03-19

### Added

- **Plan reviews now guide you to the next step.** After running `/plan-ceo-review`, `/plan-eng-review`, or `/plan-design-review`, you get a recommendation for what to run next — eng review is always suggested as the required shipping gate, design review is suggested when UI changes are detected, and CEO review is softly mentioned for big product changes. No more remembering the workflow yourself.
- **Reviews know when they're stale.** Each review now records the commit it was run at. The dashboard compares that against your current HEAD and tells you exactly how many commits have elapsed — "eng review may be stale — 13 commits since review" instead of guessing.
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
- **Auto-handoff hint after 3 consecutive failures.** If the browse tool fails 3 times in a row, it suggests using `handoff` — so you don't waste time watching the AI retry a CAPTCHA.
- **15 new tests for the handoff feature.** Unit tests for state save/restore, failure tracking, edge cases, plus integration tests for the full headless-to-headed flow with cookie and tab preservation.

### Changed

- `recreateContext()` refactored to use shared `saveState()`/`restoreState()` helpers — same behavior, less code, ready for future state persistence features.
- `browser.close()` now has a 5-second timeout to prevent hangs when closing headed browsers on macOS.

## [0.8.1] - 2026-03-19

### Fixed

- **`/qa` no longer refuses to use the browser on backend-only changes.** Previously, if your branch only changed prompt templates, config files, or service logic, `/qa` would analyze the diff, conclude "no UI to test," and suggest running evals instead. Now it always opens the browser -- falling back to a Quick mode smoke test (homepage + top 5 navigation targets) when no specific pages are identified from the diff.

## [0.8.0] - 2026-03-19 — Multi-AI Second Opinion

**`/codex` — get an independent second opinion from a completely different AI.**

Three modes. `/codex review` runs OpenAI's Codex CLI against your diff and gives a pass/fail gate — if Codex finds critical issues (`[P1]`), it fails. `/codex challenge` goes adversarial: it tries to find ways your code will fail in production, thinking like an attacker and a chaos engineer. `/codex <anything>` opens a conversation with Codex about your codebase, with session continuity so follow-ups remember context.

When both `/review` (Claude) and `/codex review` have run, you get a cross-model analysis showing which findings overlap and which are unique to each AI — building intuition for when to trust which system.

**Integrated everywhere.** After `/review` finishes, it offers a Codex second opinion. During `/ship`, you can run Codex review as an optional gate before pushing. In `/plan-eng-review`, Codex can independently critique your plan before the engineering review begins. All Codex results show up in the Review Readiness Dashboard.

**Also in this release:** Proactive skill suggestions — gstack now notices what stage of development you're in and suggests the right skill. Don't like it? Say "stop suggesting" and it remembers across sessions.

## [0.7.4] - 2026-03-18

### Changed

- **`/qa` and `/design-review` now ask what to do with uncommitted changes** instead of refusing to start. When your working tree is dirty, you get an interactive prompt with three options: commit your changes, stash them, or abort. No more cryptic "ERROR: Working tree is dirty" followed by a wall of text.

## [0.7.3] - 2026-03-18

### Added

- **Safety guardrails you can turn on with one command.** Say "be careful" or "safety mode" and `/careful` will warn you before any destructive command — `rm -rf`, `DROP TABLE`, force-push, `kubectl delete`, and more. You can override every warning. Common build artifact cleanups (`rm -rf node_modules`, `dist`, `.next`) are whitelisted.
- **Lock edits to one folder with `/freeze`.** Debugging something and don't want Claude to "fix" unrelated code? `/freeze` blocks all file edits outside a directory you choose. Hard block, not just a warning. Run `/unfreeze` to remove the restriction without ending your session.
- **`/guard` activates both at once.** One command for maximum safety when touching prod or live systems — destructive command warnings plus directory-scoped edit restrictions.
- **`/debug` now auto-freezes edits to the module being debugged.** After forming a root cause hypothesis, `/debug` locks edits to the narrowest affected directory. No more accidental "fixes" to unrelated code during debugging.
- **You can now see which skills you use and how often.** Every skill invocation is logged locally to `~/.gstack/analytics/skill-usage.jsonl`. Run `bun run analytics` to see your top skills, per-repo breakdown, and how often safety hooks actually catch something. Data stays on your machine.
- **Weekly retros now include skill usage.** `/retro` shows which skills you used during the retro window alongside your usual commit analysis and metrics.

## [0.7.2] - 2026-03-18

### Fixed

- `/retro` date ranges now align to midnight instead of the current time. Running `/retro` at 9pm no longer silently drops the morning of the start date — you get full calendar days.
- `/retro` timestamps now use your local timezone instead of hardcoded Pacific time. Users outside the US-West coast get correct local hours in histograms, session detection, and streak tracking.

## [0.7.1] - 2026-03-19

### Added

- **gstack now suggests skills at natural moments.** You don't need to know slash commands — just talk about what you're doing. Brainstorming an idea? gstack suggests `/office-hours`. Something's broken? It suggests `/debug`. Ready to deploy? It suggests `/ship`. Every workflow skill now has proactive triggers that fire when the moment is right.
- **Lifecycle map.** gstack's root skill description now includes a developer workflow guide mapping 12 stages (brainstorm → plan → review → code → debug → test → ship → docs → retro) to the right skill. Claude sees this in every session.
- **Opt-out with natural language.** If proactive suggestions feel too aggressive, just say "stop suggesting things" — gstack remembers across sessions. Say "be proactive again" to re-enable.
- **11 journey-stage E2E tests.** Each test simulates a real moment in the developer lifecycle with realistic project context (plan.md, error logs, git history, code) and verifies the right skill fires from natural language alone. 11/11 pass.
- **Trigger phrase validation.** Static tests verify every workflow skill has "Use when" and "Proactively suggest" phrases — catches regressions for free.

### Fixed

- `/debug` and `/office-hours` were completely invisible to natural language — no trigger phrases at all. Now both have full reactive + proactive triggers.

## [0.7.0] - 2026-03-18 — YC Office Hours

**`/office-hours` — sit down with a YC partner before you write a line of code.**

Two modes. If you're building a startup, you get six forcing questions distilled from how YC evaluates products: demand reality, status quo, desperate specificity, narrowest wedge, observation & surprise, and future-fit. If you're hacking on a side project, learning to code, or at a hackathon, you get an enthusiastic brainstorming partner who helps you find the coolest version of your idea.

Both modes write a design doc that feeds directly into `/plan-ceo-review` and `/plan-eng-review`. After the session, the skill reflects back what it noticed about how you think — specific observations, not generic praise.

**`/debug` — find the root cause, not the symptom.**

When something is broken and you don't know why, `/debug` is your systematic debugger. It follows the Iron Law: no fixes without root cause investigation first. Traces data flow, matches against known bug patterns (race conditions, nil propagation, stale cache, config drift), and tests hypotheses one at a time. If 3 fixes fail, it stops and questions the architecture instead of thrashing.

## [0.6.4.1] - 2026-03-18

### Added

- **Skills now discoverable via natural language.** All 12 skills that were missing explicit trigger phrases now have them — say "deploy this" and Claude finds `/ship`, say "check my diff" and it finds `/review`. Following Anthropic's best practice: "the description field is not a summary — it's when to trigger."

## [0.6.4.0] - 2026-03-17

### Added

- **`/plan-design-review` is now interactive — rates 0-10, fixes the plan.** Instead of producing a report with letter grades, the designer now works like CEO and Eng review: rates each design dimension 0-10, explains what a 10 looks like, then edits the plan to get there. One AskUserQuestion per design choice. The output is a better plan, not a document about the plan.
- **CEO review now calls in the designer.** When `/plan-ceo-review` detects UI scope in a plan, it activates a Design & UX section (Section 11) covering information architecture, interaction state coverage, AI slop risk, and responsive intention. For deep design work, it recommends `/plan-design-review`.
- **14 of 15 skills now have full test coverage (E2E + LLM-judge + validation).** Added LLM-judge quality evals for 10 skills that were missing them: ship, retro, qa-only, plan-ceo-review, plan-eng-review, plan-design-review, design-review, design-consultation, document-release, gstack-upgrade. Added real E2E test for gstack-upgrade (was a `.todo`). Added design-consultation to command validation.
- **Bisect commit style.** CLAUDE.md now requires every commit to be a single logical change — renames separate from rewrites, test infrastructure separate from test implementations.

### Changed

- `/qa-design-review` renamed to `/design-review` — the "qa-" prefix was confusing now that `/plan-design-review` is plan-mode. Updated across all 22 files.

## [0.6.3.0] - 2026-03-17

### Added

- **Every PR touching frontend code now gets a design review automatically.** `/review` and `/ship` apply a 20-item design checklist against changed CSS, HTML, JSX, and view files. Catches AI slop patterns (purple gradients, 3-column icon grids, generic hero copy), typography issues (body text < 16px, blacklisted fonts), accessibility gaps (`outline: none`), and `!important` abuse. Mechanical CSS fixes are auto-applied; design judgment calls ask you first.
- **`gstack-diff-scope` categorizes what changed in your branch.** Run `source <(gstack-diff-scope main)` and get `SCOPE_FRONTEND=true/false`, `SCOPE_BACKEND`, `SCOPE_PROMPTS`, `SCOPE_TESTS`, `SCOPE_DOCS`, `SCOPE_CONFIG`. Design review uses it to skip silently on backend-only PRs. Ship pre-flight uses it to recommend design review when frontend files are touched.
- **Design review shows up in the Review Readiness Dashboard.** The dashboard now distinguishes between "LITE" (code-level, runs automatically in /review and /ship) and "FULL" (visual audit via /plan-design-review with browse binary). Both show up as Design Review entries.
- **E2E eval for design review detection.** Planted CSS/HTML fixtures with 7 known anti-patterns (Papyrus font, 14px body text, `outline: none`, `!important`, purple gradient, generic hero copy, 3-column feature grid). The eval verifies `/review` catches at least 4 of 7.

## [0.6.2.0] - 2026-03-17

### Added

- **Plan reviews now think like the best in the world.** `/plan-ceo-review` applies 14 cognitive patterns from Bezos (one-way doors, Day 1 proxy skepticism), Grove (paranoid scanning), Munger (inversion), Horowitz (wartime awareness), Chesky/Graham (founder mode), and Altman (leverage obsession). `/plan-eng-review` applies 15 patterns from Larson (team state diagnosis), McKinley (boring by default), Brooks (essential vs accidental complexity), Beck (make the change easy), Majors (own your code in production), and Google SRE (error budgets). `/plan-design-review` applies 12 patterns from Rams (subtraction default), Norman (time-horizon design), Zhuo (principled taste), Gebbia (design for trust, storyboard the journey), and Ive (care is visible).
- **Latent space activation, not checklists.** The cognitive patterns name-drop frameworks and people so the LLM draws on its deep knowledge of how they actually think. The instruction is "internalize these, don't enumerate them" — making each review a genuine perspective shift, not a longer checklist.

## [0.6.1.0] - 2026-03-17

### Added

- **E2E and LLM-judge tests now only run what you changed.** Each test declares which source files it depends on. When you run `bun run test:e2e`, it checks your diff and skips tests whose dependencies weren't touched. A branch that only changes `/retro` now runs 2 tests instead of 31. Use `bun run test:e2e:all` to force everything.
- **`bun run eval:select` previews which tests would run.** See exactly which tests your diff triggers before spending API credits. Supports `--json` for scripting and `--base <branch>` to override the base branch.
- **Completeness guardrail catches forgotten test entries.** A free unit test validates that every `testName` in the E2E and LLM-judge test files has a corresponding entry in the TOUCHFILES map. New tests without entries fail `bun test` immediately — no silent always-run degradation.

### Changed

- `test:evals` and `test:e2e` now auto-select based on diff (was: all-or-nothing)
- New `test:evals:all` and `test:e2e:all` scripts for explicit full runs

## 0.6.1 — 2026-03-17 — Boil the Lake

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

## 0.6.0.1 — 2026-03-17

- **`/gstack-upgrade` now catches stale vendored copies automatically.** If your global gstack is up to date but the vendored copy in your project is behind, `/gstack-upgrade` detects the mismatch and syncs it. No more manually asking "did we vendor it?" — it just tells you and offers to update.
- **Upgrade sync is safer.** If `./setup` fails while syncing a vendored copy, gstack restores the previous version from backup instead of leaving a broken install.

### For contributors

- Standalone usage section in `gstack-upgrade/SKILL.md.tmpl` now references Steps 2 and 4.5 (DRY) instead of duplicating detection/sync bash blocks. Added one new version-comparison bash block.
- Update check fallback in standalone mode now matches the preamble pattern (global path → local path → `|| true`).

## 0.6.0 — 2026-03-17

- **100% test coverage is the key to great vibe coding.** gstack now bootstraps test frameworks from scratch when your project doesn't have one. Detects your runtime, researches the best framework, asks you to pick, installs it, writes 3-5 real tests for your actual code, sets up CI/CD (GitHub Actions), creates TESTING.md, and adds test culture instructions to CLAUDE.md. Every Claude Code session after that writes tests naturally.
- **Every bug fix now gets a regression test.** When `/qa` fixes a bug and verifies it, Phase 8e.5 automatically generates a regression test that catches the exact scenario that broke. Tests include full attribution tracing back to the QA report. Auto-incrementing filenames prevent collisions across sessions.
- **Ship with confidence — coverage audit shows what's tested and what's not.** `/ship` Step 3.4 builds a code path map from your diff, searches for corresponding tests, and produces an ASCII coverage diagram with quality stars (★★★ = edge cases + errors, ★★ = happy path, ★ = smoke test). Gaps get tests auto-generated. PR body shows "Tests: 42 → 47 (+5 new)".
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

## 0.5.4 — 2026-03-17

- **Engineering review is always the full review now.** `/plan-eng-review` no longer asks you to choose between "big change" and "small change" modes. Every plan gets the full interactive walkthrough (architecture, code quality, tests, performance). Scope reduction is only suggested when the complexity check actually triggers — not as a standing menu option.
- **Ship stops asking about reviews once you've answered.** When `/ship` asks about missing reviews and you say "ship anyway" or "not relevant," that decision is saved for the branch. No more getting re-asked every time you re-run `/ship` after a pre-landing fix.

### For contributors

- Removed SMALL_CHANGE / BIG_CHANGE / SCOPE_REDUCTION menu from `plan-eng-review/SKILL.md.tmpl`. Scope reduction is now proactive (triggered by complexity check) rather than a menu item.
- Added review gate override persistence to `ship/SKILL.md.tmpl` — writes `ship-review-override` entries to `$BRANCH-reviews.jsonl` so subsequent `/ship` runs skip the gate.
- Updated 2 E2E test prompts to match new flow.

## 0.5.3 — 2026-03-17

- **You're always in control — even when dreaming big.** `/plan-ceo-review` now presents every scope expansion as an individual decision you opt into. EXPANSION mode recommends enthusiastically, but you say yes or no to each idea. No more "the agent went wild and added 5 features I didn't ask for."
- **New mode: SELECTIVE EXPANSION.** Hold your current scope as the baseline, but see what else is possible. The agent surfaces expansion opportunities one by one with neutral recommendations — you cherry-pick the ones worth doing. Perfect for iterating on existing features where you want rigor but also want to be tempted by adjacent improvements.
- **Your CEO review visions are saved, not lost.** Expansion ideas, cherry-pick decisions, and 10x visions are now persisted to `~/.gstack/projects/{repo}/ceo-plans/` as structured design documents. Stale plans get archived automatically. If a vision is exceptional, you can promote it to `docs/designs/` in your repo for the team.

- **Smarter ship gates.** `/ship` no longer nags you about CEO and Design reviews when they're not relevant. Eng Review is the only required gate (and you can disable even that with `gstack-config set skip_eng_review true`). CEO Review is recommended for big product changes; Design Review for UI work. The dashboard still shows all three — it just won't block you for the optional ones.

### For contributors

- Added SELECTIVE EXPANSION mode to `plan-ceo-review/SKILL.md.tmpl` with cherry-pick ceremony, neutral recommendation posture, and HOLD SCOPE baseline.
- Rewrote EXPANSION mode's Step 0D to include opt-in ceremony — distill vision into discrete proposals, present each as AskUserQuestion.
- Added CEO plan persistence (0D-POST step): structured markdown with YAML frontmatter (`status: ACTIVE/ARCHIVED/PROMOTED`), scope decisions table, archival flow.
- Added `docs/designs` promotion step after Review Log.
- Mode Quick Reference table expanded to 4 columns.
- Review Readiness Dashboard: Eng Review required (overridable via `skip_eng_review` config), CEO/Design optional with agent judgment.
- New tests: CEO review mode validation (4 modes, persistence, promotion), SELECTIVE EXPANSION E2E test.

## 0.5.2 — 2026-03-17

- **Your design consultant now takes creative risks.** `/design-consultation` doesn't just propose a safe, coherent system — it explicitly breaks down SAFE CHOICES (category baseline) vs. RISKS (where your product stands out). You pick which rules to break. Every risk comes with a rationale for why it works and what it costs.
- **See the landscape before you choose.** When you opt into research, the agent browses real sites in your space with screenshots and accessibility tree analysis — not just web search results. You see what's out there before making design decisions.
- **Preview pages that look like your product.** The preview page now renders realistic product mockups — dashboards with sidebar nav and data tables, marketing pages with hero sections, settings pages with forms — not just font swatches and color palettes.

## 0.5.1 — 2026-03-17
- **Know where you stand before you ship.** Every `/plan-ceo-review`, `/plan-eng-review`, and `/plan-design-review` now logs its result to a review tracker. At the end of each review, you see a **Review Readiness Dashboard** showing which reviews are done, when they ran, and whether they're clean — with a clear CLEARED TO SHIP or NOT READY verdict.
- **`/ship` checks your reviews before creating the PR.** Pre-flight now reads the dashboard and asks if you want to continue when reviews are missing. Informational only — it won't block you, but you'll know what you skipped.
- **One less thing to copy-paste.** The SLUG computation (that opaque sed pipeline for computing `owner-repo` from git remote) is now a shared `bin/gstack-slug` helper. All 14 inline copies across templates replaced with `source <(gstack-slug)`. If the format ever changes, fix it once.
- **Screenshots are now visible during QA and browse sessions.** When gstack takes screenshots, they now show up as clickable image elements in your output — no more invisible `/tmp/browse-screenshot.png` paths you can't see. Works in `/qa`, `/qa-only`, `/plan-design-review`, `/qa-design-review`, `/browse`, and `/gstack`.

### For contributors

- Added `{{REVIEW_DASHBOARD}}` resolver to `gen-skill-docs.ts` — shared dashboard reader injected into 4 templates (3 review skills + ship).
- Added `bin/gstack-slug` helper (5-line bash) with unit tests. Outputs `SLUG=` and `BRANCH=` lines, sanitizes `/` to `-`.
- New TODOs: smart review relevance detection (P3), `/merge` skill for review-gated PR merge (P2).

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
