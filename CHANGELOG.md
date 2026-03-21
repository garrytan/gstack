# Changelog

## [0.9.5.0] - 2026-03-21 — CEO Review ↔ Office Hours Chaining

### Added

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
- **Shell injection surface removed.** All skill templates now use `source <(gstack-slug)` instead of `eval $(gstack-slug)`. Same behavior, no `eval`. (Closes #133)
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
