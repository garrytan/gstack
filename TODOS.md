# TODOS

## Builder Ethos

### First-time Search Before Building intro

**What:** Add a `generateSearchIntro()` function (like `generateLakeIntro()`) that introduces the Search Before Building principle on first use, with a link to the blog essay.

**Why:** Boil the Lake has an intro flow that links to the essay and marks `.completeness-intro-seen`. Search Before Building should have the same pattern for discoverability.

**Context:** Blocked on a blog post to link to. When the essay exists, add the intro flow with a `.search-intro-seen` marker file. Pattern: `generateLakeIntro()` at gen-skill-docs.ts:176.

**Effort:** S
**Priority:** P2
**Depends on:** Blog post about Search Before Building

## Browse

### Bundle server.ts into compiled binary

**What:** Eliminate `resolveServerScript()` fallback chain entirely — bundle server.ts into the compiled browse binary.

**Why:** The current fallback chain (check adjacent to cli.ts, check global install) is fragile and caused bugs in v0.3.2. A single compiled binary is simpler and more reliable.

**Context:** Bun's `--compile` flag can bundle multiple entry points. The server is currently resolved at runtime via file path lookup. Bundling it removes the resolution step entirely.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Sessions (isolated browser instances)

**What:** Isolated browser instances with separate cookies/storage/history, addressable by name.

**Why:** Enables parallel testing of different user roles, A/B test verification, and clean auth state management.

**Context:** Requires Playwright browser context isolation. Each session gets its own context with independent cookies/localStorage. Prerequisite for video recording (clean context lifecycle) and auth vault.

**Effort:** L
**Priority:** P3

### Video recording

**What:** Record browser interactions as video (start/stop controls).

**Why:** Video evidence in QA reports and PR bodies. Currently deferred because `recreateContext()` destroys page state.

**Context:** Needs sessions for clean context lifecycle. Playwright supports video recording per context. Also needs WebM → GIF conversion for PR embedding.

**Effort:** M
**Priority:** P3
**Depends on:** Sessions

### v20 encryption format support

**What:** AES-256-GCM support for future Chromium cookie DB versions (currently v10).

**Why:** Future Chromium versions may change encryption format. Proactive support prevents breakage.

**Effort:** S
**Priority:** P3

### State persistence

**What:** Save/load cookies + localStorage to JSON files for reproducible test sessions.

**Why:** Enables "resume where I left off" for QA sessions and repeatable auth states.

**Context:** The `saveState()`/`restoreState()` helpers from the handoff feature (browser-manager.ts) already capture cookies + localStorage + sessionStorage + URLs. Adding file I/O on top is ~20 lines.

**Effort:** S
**Priority:** P3
**Depends on:** Sessions

### Auth vault

**What:** Encrypted credential storage, referenced by name. LLM never sees passwords.

**Why:** Security — currently auth credentials flow through the LLM context. Vault keeps secrets out of the AI's view.

**Effort:** L
**Priority:** P3
**Depends on:** Sessions, state persistence

### Iframe support

**What:** `frame <sel>` and `frame main` commands for cross-frame interaction.

**Why:** Many web apps use iframes (embeds, payment forms, ads). Currently invisible to browse.

**Effort:** M
**Priority:** P4

### Semantic locators

**What:** `find role/label/text/placeholder/testid` with attached actions.

**Why:** More resilient element selection than CSS selectors or ref numbers.

**Effort:** M
**Priority:** P4

### Device emulation presets

**What:** `set device "iPhone 16 Pro"` for mobile/tablet testing.

**Why:** Responsive layout testing without manual viewport resizing.

**Effort:** S
**Priority:** P4

### Network mocking/routing

**What:** Intercept, block, and mock network requests.

**Why:** Test error states, loading states, and offline behavior.

**Effort:** M
**Priority:** P4

### Download handling

**What:** Click-to-download with path control.

**Why:** Test file download flows end-to-end.

**Effort:** S
**Priority:** P4

### Content safety

**What:** `--max-output` truncation, `--allowed-domains` filtering.

**Why:** Prevent context window overflow and restrict navigation to safe domains.

**Effort:** S
**Priority:** P4

### Streaming (WebSocket live preview)

**What:** WebSocket-based live preview for pair browsing sessions.

**Why:** Enables real-time collaboration — human watches AI browse.

**Effort:** L
**Priority:** P4

### CDP mode

**What:** Connect to already-running Chrome/Electron apps via Chrome DevTools Protocol.

**Why:** Test production apps, Electron apps, and existing browser sessions without launching new instances.

**Effort:** M
**Priority:** P4

### Linux/Windows cookie decryption

**What:** GNOME Keyring / kwallet / DPAPI support for non-macOS cookie import.

**Why:** Cross-platform cookie import. Currently macOS-only (Keychain).

**Effort:** L
**Priority:** P4

## Ship

### Ship log — persistent record of /ship runs

**What:** Append structured JSON entry to `.gstack/ship-log.json` at end of every /ship run (version, date, branch, PR URL, review findings, Greptile stats, todos completed, test results).

**Why:** /retro has no structured data about shipping velocity. Ship log enables: PRs-per-week trending, review finding rates, Greptile signal over time, test suite growth.

**Context:** /retro already reads greptile-history.md — same pattern. Eval persistence (eval-store.ts) shows the JSON append pattern exists in the codebase. ~15 lines in ship template.

**Effort:** S
**Priority:** P2
**Depends on:** None


### Visual verification with screenshots in PR body

**What:** /ship Step 7.5: screenshot key pages after push, embed in PR body.

**Why:** Visual evidence in PRs. Reviewers see what changed without deploying locally.

**Context:** Part of Phase 3.6. Needs S3 upload for image hosting.

**Effort:** M
**Priority:** P2
**Depends on:** /setup-gstack-upload

## Review

### Inline PR annotations

**What:** /ship and /review post inline review comments at specific file:line locations using `gh api` to create pull request review comments.

**Why:** Line-level annotations are more actionable than top-level comments. The PR thread becomes a line-by-line conversation between Greptile, Claude, and human reviewers.

**Context:** GitHub supports inline review comments via `gh api repos/$REPO/pulls/$PR/reviews`. Pairs naturally with Phase 3.6 visual annotations.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Greptile training feedback export

**What:** Aggregate greptile-history.md into machine-readable JSON summary of false positive patterns, exportable to the Greptile team for model improvement.

**Why:** Closes the feedback loop — Greptile can use FP data to stop making the same mistakes on your codebase.

**Context:** Was a P3 Future Idea. Upgraded to P2 now that greptile-history.md data infrastructure exists. The signal data is already being collected; this just makes it exportable. ~40 lines.

**Effort:** S
**Priority:** P2
**Depends on:** Enough FP data accumulated (10+ entries)

### Visual review with annotated screenshots

**What:** /review Step 4.5: browse PR's preview deploy, annotated screenshots of changed pages, compare against production, check responsive layouts, verify accessibility tree.

**Why:** Visual diff catches layout regressions that code review misses.

**Context:** Part of Phase 3.6. Needs S3 upload for image hosting.

**Effort:** M
**Priority:** P2
**Depends on:** /setup-gstack-upload

## QA

### QA trend tracking

**What:** Compare baseline.json over time, detect regressions across QA runs.

**Why:** Spot quality trends — is the app getting better or worse?

**Context:** QA already writes structured reports. This adds cross-run comparison.

**Effort:** S
**Priority:** P2

### CI/CD QA integration

**What:** `/qa` as GitHub Action step, fail PR if health score drops.

**Why:** Automated quality gate in CI. Catch regressions before merge.

**Effort:** M
**Priority:** P2

### Smart default QA tier

**What:** After a few runs, check index.md for user's usual tier pick, skip the AskUserQuestion.

**Why:** Reduces friction for repeat users.

**Effort:** S
**Priority:** P2

### Accessibility audit mode

**What:** `--a11y` flag for focused accessibility testing.

**Why:** Dedicated accessibility testing beyond the general QA checklist.

**Effort:** S
**Priority:** P3

### CI/CD generation for non-GitHub providers

**What:** Extend CI/CD bootstrap to generate GitLab CI (`.gitlab-ci.yml`), CircleCI (`.circleci/config.yml`), and Bitrise pipelines.

**Why:** Not all projects use GitHub Actions. Universal CI/CD bootstrap would make test bootstrap work for everyone.

**Context:** v1 ships with GitHub Actions only. Detection logic already checks for `.gitlab-ci.yml`, `.circleci/`, `bitrise.yml` and skips with an informational note. Each provider needs ~20 lines of template text in `generateTestBootstrap()`.

**Effort:** M
**Priority:** P3
**Depends on:** Test bootstrap (shipped)

### Auto-upgrade weak tests (★) to strong tests (★★★)

**What:** When Step 3.4 coverage audit identifies existing ★-rated tests (smoke/trivial assertions), generate improved versions testing edge cases and error paths.

**Why:** Many codebases have tests that technically exist but don't catch real bugs — `expect(component).toBeDefined()` isn't testing behavior. Upgrading these closes the gap between "has tests" and "has good tests."

**Context:** Requires the quality scoring rubric from the test coverage audit. Modifying existing test files is riskier than creating new ones — needs careful diffing to ensure the upgraded test still passes. Consider creating a companion test file rather than modifying the original.

**Effort:** M
**Priority:** P3
**Depends on:** Test quality scoring (shipped)

## Retro

### Deployment health tracking (retro + browse)

**What:** Screenshot production state, check perf metrics (page load times), count console errors across key pages, track trends over retro window.

**Why:** Retro should include production health alongside code metrics.

**Context:** Requires browse integration. Screenshots + metrics fed into retro output.

**Effort:** L
**Priority:** P3
**Depends on:** Browse sessions

## Infrastructure

### /setup-gstack-upload skill (S3 bucket)

**What:** Configure S3 bucket for image hosting. One-time setup for visual PR annotations.

**Why:** Prerequisite for visual PR annotations in /ship and /review.

**Effort:** M
**Priority:** P2

### gstack-upload helper

**What:** `browse/bin/gstack-upload` — upload file to S3, return public URL.

**Why:** Shared utility for all skills that need to embed images in PRs.

**Effort:** S
**Priority:** P2
**Depends on:** /setup-gstack-upload

### WebM to GIF conversion

**What:** ffmpeg-based WebM → GIF conversion for video evidence in PRs.

**Why:** GitHub PR bodies render GIFs but not WebM. Needed for video recording evidence.

**Effort:** S
**Priority:** P3
**Depends on:** Video recording


### GitHub Actions eval upload

**What:** Run eval suite in CI, upload result JSON as artifact, post summary comment on PR.

**Why:** CI integration catches quality regressions before merge and provides persistent eval records per PR.

**Context:** Requires `ANTHROPIC_API_KEY` in CI secrets. Cost is ~$4/run. Eval persistence system (v0.3.6) writes JSON to `~/.gstack-dev/evals/` — CI would upload as GitHub Actions artifacts and use `eval:compare` to post delta comment.

**Effort:** M
**Priority:** P2
**Depends on:** Eval persistence (shipped in v0.3.6)

### E2E model pinning — SHIPPED

~~**What:** Pin E2E tests to claude-sonnet-4-6 for cost efficiency, add retry:2 for flaky LLM responses.~~

Shipped: Default model changed to Sonnet for structure tests (~30), Opus retained for quality tests (~10). `--retry 2` added. `EVALS_MODEL` env var for override. `test:e2e:fast` tier added. Rate-limit telemetry (first_response_ms, max_inter_turn_ms) and wall_clock_ms tracking added to eval-store.

### Eval web dashboard

**What:** `bun run eval:dashboard` serves local HTML with charts: cost trending, detection rate, pass/fail history.

**Why:** Visual charts better for spotting trends than CLI tools.

**Context:** Reads `~/.gstack-dev/evals/*.json`. ~200 lines HTML + chart.js via Bun HTTP server.

**Effort:** M
**Priority:** P3
**Depends on:** Eval persistence (shipped in v0.3.6)

### CI/CD QA quality gate

**What:** Run `/qa` as a GitHub Action step, fail PR if health score drops below threshold.

**Why:** Automated quality gate catches regressions before merge. Currently QA is manual — CI integration makes it part of the standard workflow.

**Context:** Requires headless browse binary available in CI. The `/qa` skill already produces `baseline.json` with health scores — CI step would compare against the main branch baseline and fail if score drops. Would need `ANTHROPIC_API_KEY` in CI secrets since `/qa` uses Claude.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Cross-platform URL open helper

**What:** `gstack-open-url` helper script — detect platform, use `open` (macOS) or `xdg-open` (Linux).

**Why:** The first-time Completeness Principle intro uses macOS `open` to launch the essay. If gstack ever supports Linux, this silently fails.

**Effort:** S (human: ~30 min / CC: ~2 min)
**Priority:** P4
**Depends on:** Nothing

### CDP-based DOM mutation detection for ref staleness

**What:** Use Chrome DevTools Protocol `DOM.documentUpdated` / MutationObserver events to proactively invalidate stale refs when the DOM changes, without requiring an explicit `snapshot` call.

**Why:** Current ref staleness detection (async count() check) only catches stale refs at action time. CDP mutation detection would proactively warn when refs become stale, preventing the 5-second timeout entirely for SPA re-renders.

**Context:** Parts 1+2 of ref staleness fix (RefEntry metadata + eager validation via count()) are shipped. This is Part 3 — the most ambitious piece. Requires CDP session alongside Playwright, MutationObserver bridge, and careful performance tuning to avoid overhead on every DOM change.

**Effort:** L
**Priority:** P3
**Depends on:** Ref staleness Parts 1+2 (shipped)

## Office Hours / Design

### Design docs → Supabase team store sync

**What:** Add design docs (`*-design-*.md`) to the Supabase sync pipeline alongside test plans, retro snapshots, and QA reports.

**Why:** Cross-team design discovery at scale. Local `~/.gstack/projects/$SLUG/` keyword-grep discovery works for same-machine users now, but Supabase sync makes it work across the whole team. Duplicate ideas surface, everyone sees what's been explored.

**Context:** /office-hours writes design docs to `~/.gstack/projects/$SLUG/`. The team store already syncs test plans, retro snapshots, QA reports. Design docs follow the same pattern — just add a sync adapter.

**Effort:** S
**Priority:** P2
**Depends on:** `garrytan/team-supabase-store` branch landing on main

### /yc-prep skill

**What:** Skill that helps founders prepare their YC application after /office-hours identifies strong signal. Pulls from the design doc, structures answers to YC app questions, runs a mock interview.

**Why:** Closes the loop. /office-hours identifies the founder, /yc-prep helps them apply well. The design doc already contains most of the raw material for a YC application.

**Effort:** M (human: ~2 weeks / CC: ~2 hours)
**Priority:** P2
**Depends on:** office-hours founder discovery engine shipping first

## Design Review

### /plan-design-review + /qa-design-review + /design-consultation — SHIPPED

Shipped as v0.5.0 on main. Includes `/plan-design-review` (report-only design audit), `/qa-design-review` (audit + fix loop), and `/design-consultation` (interactive DESIGN.md creation). `{{DESIGN_METHODOLOGY}}` resolver provides shared 80-item design audit checklist.

### Design outside voices in /plan-eng-review

**What:** Extend the parallel dual-voice pattern (Codex + Claude subagent) to /plan-eng-review's architecture review section.

**Why:** The design beachhead (v0.11.3.0) proves cross-model consensus works for subjective reviews. Architecture reviews have similar subjectivity in tradeoff decisions.

**Context:** Depends on learnings from the design beachhead. If the litmus scorecard format proves useful, adapt it for architecture dimensions (coupling, scaling, reversibility).

**Effort:** S
**Priority:** P3
**Depends on:** Design outside voices shipped (v0.11.3.0)

### Outside voices in /qa visual regression detection

**What:** Add Codex design voice to /qa for detecting visual regressions during bug-fix verification.

**Why:** When fixing bugs, the fix can introduce visual regressions that code-level checks miss. Codex could flag "the fix broke the responsive layout" during re-test.

**Context:** Depends on /qa having design awareness. Currently /qa focuses on functional testing.

**Effort:** M
**Priority:** P3
**Depends on:** Design outside voices shipped (v0.11.3.0)

## Document-Release

### Auto-invoke /document-release from /ship — SHIPPED

Shipped in v0.8.3. Step 8.5 added to `/ship` — after creating the PR, `/ship` automatically reads `document-release/SKILL.md` and executes the doc update workflow. Zero-friction doc updates.

### `{{DOC_VOICE}}` shared resolver

**What:** Create a placeholder resolver in gen-skill-docs.ts encoding the gstack voice guide (friendly, user-forward, lead with benefits). Inject into /ship Step 5, /document-release Step 5, and reference from CLAUDE.md.

**Why:** DRY — voice rules currently live inline in 3 places (CLAUDE.md CHANGELOG style section, /ship Step 5, /document-release Step 5). When the voice evolves, all three drift.

**Context:** Same pattern as `{{QA_METHODOLOGY}}` — shared block injected into multiple templates to prevent drift. ~20 lines in gen-skill-docs.ts.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Ship Confidence Dashboard

### Smart review relevance detection — PARTIALLY SHIPPED

~~**What:** Auto-detect which of the 4 reviews are relevant based on branch changes (skip Design Review if no CSS/view changes, skip Code Review if plan-only).~~

`bin/gstack-diff-scope` shipped — categorizes diff into SCOPE_FRONTEND, SCOPE_BACKEND, SCOPE_PROMPTS, SCOPE_TESTS, SCOPE_DOCS, SCOPE_CONFIG. Used by design-review-lite to skip when no frontend files changed. Dashboard integration for conditional row display is a follow-up.

**Remaining:** Dashboard conditional row display (hide "Design Review: NOT YET RUN" when SCOPE_FRONTEND=false). Extend to Eng Review (skip for docs-only) and CEO Review (skip for config-only).

**Effort:** S
**Priority:** P3
**Depends on:** gstack-diff-scope (shipped)


## Codex

### Codex→Claude reverse buddy check skill

**What:** A Codex-native skill (`.agents/skills/gstack-claude/SKILL.md`) that runs `claude -p` to get an independent second opinion from Claude — the reverse of what `/codex` does today from Claude Code.

**Why:** Codex users deserve the same cross-model challenge that Claude users get via `/codex`. Currently the flow is one-way (Claude→Codex). Codex users have no way to get a Claude second opinion.

**Context:** The `/codex` skill template (`codex/SKILL.md.tmpl`) shows the pattern — it wraps `codex exec` with JSONL parsing, timeout handling, and structured output. The reverse skill would wrap `claude -p` with similar infrastructure. Would be generated into `.agents/skills/gstack-claude/` by `gen-skill-docs --host codex`.

**Effort:** M (human: ~2 weeks / CC: ~30 min)
**Priority:** P1
**Depends on:** None

## Completeness

### Completeness metrics dashboard

**What:** Track how often Claude chooses the complete option vs shortcut across gstack sessions. Aggregate into a dashboard showing completeness trend over time.

**Why:** Without measurement, we can't know if the Completeness Principle is working. Could surface patterns (e.g., certain skills still bias toward shortcuts).

**Context:** Would require logging choices (e.g., append to a JSONL file when AskUserQuestion resolves), parsing them, and displaying trends. Similar pattern to eval persistence.

**Effort:** M (human) / S (CC)
**Priority:** P3
**Depends on:** Boil the Lake shipped (v0.6.1)

## Safety & Observability

### On-demand hook skills (/careful, /freeze, /guard) — SHIPPED

~~**What:** Three new skills that use Claude Code's session-scoped PreToolUse hooks to add safety guardrails on demand.~~

Shipped as `/careful`, `/freeze`, `/guard`, and `/unfreeze` in v0.6.5. Includes hook fire-rate telemetry (pattern name only, no command content) and inline skill activation telemetry.

### Skill usage telemetry — SHIPPED

~~**What:** Track which skills get invoked, how often, from which repo.~~

Shipped in v0.6.5. TemplateContext in gen-skill-docs.ts bakes skill name into preamble telemetry line. Analytics CLI (`bun run analytics`) for querying. /retro integration shows skills-used-this-week.

### /investigate scoped debugging enhancements (gated on telemetry)

**What:** Six enhancements to /investigate auto-freeze, contingent on telemetry showing the freeze hook actually fires in real debugging sessions.

**Why:** /investigate v0.7.1 auto-freezes edits to the module being debugged. If telemetry shows the hook fires often, these enhancements make the experience smarter. If it never fires, the problem wasn't real and these aren't worth building.

**Context:** All items are prose additions to `investigate/SKILL.md.tmpl`. No new scripts.

**Items:**
1. Stack trace auto-detection for freeze directory (parse deepest app frame)
2. Freeze boundary widening (ask to widen instead of hard-block when hitting boundary)
3. Post-fix auto-unfreeze + full test suite run
4. Debug instrumentation cleanup (tag with DEBUG-TEMP, remove before commit)
5. Debug session persistence (~/.gstack/investigate-sessions/ — save investigation for reuse)
6. Investigation timeline in debug report (hypothesis log with timing)

**Effort:** M (all 6 combined)
**Priority:** P3
**Depends on:** Telemetry data showing freeze hook fires in real /investigate sessions

## Completed

### Deploy pipeline (v0.9.8.0)
- /land-and-deploy — merge PR, wait for CI/deploy, canary verification
- /canary — post-deploy monitoring loop with anomaly detection
- /benchmark — performance regression detection with Core Web Vitals
- /setup-deploy — one-time deploy platform configuration
- /review Performance & Bundle Impact pass
- E2E model pinning (Sonnet default, Opus for quality tests)
- E2E timing telemetry (first_response_ms, max_inter_turn_ms, wall_clock_ms)
- test:e2e:fast tier, --retry 2 on all E2E scripts
**Completed:** v0.9.8.0

### Phase 1: Foundations (v0.2.0)
- Rename to gstack
- Restructure to monorepo layout
- Setup script for skill symlinks
- Snapshot command with ref-based element selection
- Snapshot tests
**Completed:** v0.2.0

### Phase 2: Enhanced Browser (v0.2.0)
- Annotated screenshots, snapshot diffing, dialog handling, file upload
- Cursor-interactive elements, element state checks
- CircularBuffer, async buffer flush, health check
- Playwright error wrapping, useragent fix
- 148 integration tests
**Completed:** v0.2.0

### Phase 3: QA Testing Agent (v0.3.0)
- /qa SKILL.md with 6-phase workflow, 3 modes (full/quick/regression)
- Issue taxonomy, severity classification, exploration checklist
- Report template, health score rubric, framework detection
- wait/console/cookie-import commands, find-browse binary
**Completed:** v0.3.0

### Phase 3.5: Browser Cookie Import (v0.3.x)
- cookie-import-browser command (Chromium cookie DB decryption)
- Cookie picker web UI, /setup-browser-cookies skill
- 18 unit tests, browser registry (Comet, Chrome, Arc, Brave, Edge)
**Completed:** v0.3.1

### E2E test cost tracking
- Track cumulative API spend, warn if over threshold
**Completed:** v0.3.6

### Auto-upgrade mode + smart update check
- Config CLI (`bin/gstack-config`), auto-upgrade via `~/.gstack/config.yaml`, 12h cache TTL, exponential snooze backoff (24h→48h→1wk), "never ask again" option, vendored copy sync on upgrade
**Completed:** v0.3.8

## Browse-Mobile (Appium Driver for Mobile QA)

### Investigate xcrun simctl + XCTest as alternative to Appium

**What:** During the Phase 1 spike, benchmark Appium vs. native Apple tooling (xcrun simctl for lifecycle, XCTest/xctestctl for element inspection + interaction, xcrun simctl io screenshot for captures) on cold start latency, element tree reliability, and setup friction.

**Why:** Outside voice in eng review challenged the Appium choice — it's a heavyweight Java-dependent server designed for CI, not interactive dev tools. For an iOS-only Phase 1, native tooling may be faster (no JVM boot), more reliable (direct XCTest element tree vs Appium's XML translation), and zero Java dependency. Cross-platform Appium benefit is irrelevant when Android Phase 2 would use adb + UIAutomator directly anyway.

**Context:** The design doc chose Appium for cross-platform maturity. But the eng review decided on a separate binary (not shared CLI), meaning each platform already gets its own driver. If native xcrun/XCTest is significantly better for iOS, Appium adds cost without value until a unified cross-platform abstraction is needed.

**Effort:** S (spike comparison during Phase 1 proof-of-concept)
**Priority:** P1
**Depends on:** Phase 1 spike start

### Document/automate app build prerequisite

**What:** The QA flow assumes the Expo app is already built and running on the simulator. Document this as a prerequisite, or automate: detect if Metro bundler is running (check port 8081), offer to start `expo start`, or require a pre-built .app path.

**Why:** Outside voice flagged this as a Phase 1 blocker: the plan jumps to Appium automation without specifying who builds and serves the JS bundle. A developer running `/qa` for the first time will hit "app not found" with no guidance.

**Context:** For Expo: `expo start` must be running, or `npx expo run:ios` must have been run to build a .app. For bare RN: Metro bundler + built .app. Detection: check `lsof -i :8081` for Metro, check `xcrun simctl listapps booted` for installed app.

**Effort:** S
**Priority:** P1
**Depends on:** browse-mobile server.ts implementation

### Screenshot disk-full error handling

**What:** When screenshot save fails (disk full, permission error), return an actionable error to Claude instead of silently failing. Check `fs.writeFile` result and return `{ error: "disk_full", message: "Screenshot save failed — disk may be full" }`.

**Why:** Coverage diagram identified this as the only critical gap: a failure mode with no test, no error handling, and silent user impact.

**Context:** Applies to both browse-mobile and potentially browse/ (same pattern). Simple `try/catch` on the write with an informative error response.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Revyl command table validation test

**What:** Add a gen-skill-docs test that parses the Revyl command mapping table from generated SKILL.md files and validates command flags against a known-good reference list (e.g., `revyl device swipe` requires `--direction` + `--x/--y` or `--target`; `revyl device type` requires `--target` + `--text`).

**Why:** The Revyl command table has been wrong 3 times now (--output→--out, swipe missing --x/--y, type missing --target). Each time it was caught by live testing, not automated checks. A validation test in `bun test` would catch drift immediately.

**Context:** Pattern: existing `gen-skill-docs.test.ts` already validates generated SKILL.md content. This adds a focused check for Revyl CLI command syntax. The reference list is a simple map of command→required flags. Does NOT require `revyl` CLI installed — just validates the template output against known-correct syntax.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Revyl auth in headless/CI environments

**What:** Handle `revyl auth login` failing in environments without a browser (SSH sessions, CI runners, headless servers). Detect headless environment and offer `revyl auth token <TOKEN>` as alternative.

**Why:** `revyl auth login` opens a browser for OAuth. If no browser is available, the user gets stuck with no guidance. This blocks mobile QA in CI/CD and remote dev environments.

**Context:** The QA template now auto-runs `revyl auth login` when auth is needed, with an AskUserQuestion fallback. But the fallback could be smarter: detect `$DISPLAY` (Linux) or `$SSH_CONNECTION` to preemptively offer the token-based auth path instead of trying browser auth first.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Revyl mobile QA E2E test

**What:** E2E test that runs `/qa` against a test Expo app using Revyl cloud device, verifying the full flow: detect → init → build → upload → test → report.

**Why:** The Revyl QA path (added in the dual-backend update) has no automated testing. A gen-skill-docs quality check catches template regressions but can't verify the actual QA flow works end-to-end with Revyl's CLI and device provisioning.

**Context:** All other skill paths have E2E tests via `claude -p`. The Revyl mobile path is the only untested flow. Requires a Revyl account, costs per device session, and an Expo test app fixture. Pattern: existing E2E tests in `test/skill-e2e-*.test.ts`.

**Effort:** M
**Priority:** P2
**Depends on:** Revyl test account setup, CI Revyl auth

### /browse skill Revyl integration (dev loop mode)

**What:** Add Revyl dev loop mode to `/browse` skill for interactive mobile development with hot reload on cloud devices.

**Why:** The `/qa` skill now supports Revyl in static mode (Release build). `/browse` needs the complementary dev loop mode for hot-reload interactive development. The initial mobile QA report proved that dev loop works once tunnel DNS stabilizes — it just needs proper tunnel verification and retry logic.

**Context:** The /qa skill's Revyl detection infrastructure (auth check, app-id resolution, YAML validation) can be reused. Dev loop adds: Metro + Cloudflare tunnel startup, tunnel health polling, deep link handling, and the "Open in X?" iOS dialog workaround. Tunnel race condition (30s DNS propagation) is the main reliability risk.

**Effort:** M
**Priority:** P2
**Depends on:** This branch landing (Revyl detection infrastructure in gen-skill-docs.ts)

### Revyl dev loop: reuse existing Metro instead of starting a new one — PARTIALLY FIXED

**What:** ~~When the QA skill tries the dev loop path and Metro is already running on port 8081, detect and reuse it instead of starting a second Metro process.~~

**Shipped (partial):** The QA template now detects existing Metro on :8081 via `lsof` and kills it before `revyl dev start`, avoiding the 65s timeout. This is the "kill and restart" approach.

**Remaining:** A smarter approach would reuse the existing Metro instead of killing it — tell Revyl which port to connect to. This avoids the Metro restart overhead but requires understanding Revyl's port configuration options.

**Effort:** S
**Priority:** P3
**Depends on:** Understanding Revyl's `--port` or tunnel config options

### Android Revyl support

**What:** Extend Revyl mobile QA path to support Android devices (`--platform android`), including APK build pipeline, ADB-based app installation, and Android-specific system dialog handling.

**Why:** The current Revyl mobile QA only supports iOS. Revyl itself supports Android. Many mobile apps target both platforms and need cross-platform QA.

**Context:** Android differences: APK build instead of .app (`npx expo run:android` or EAS), different system dialogs (no "Open in X?" confirmation), different accessibility tree format. The Revyl command API is the same (`revyl device start --platform android`). browse-mobile (Appium) is also iOS-only — this TODO covers both backends.

**Effort:** M
**Priority:** P3
**Depends on:** This branch landing (Revyl iOS support)

## Garry-Wiggum

### Parallel sub-agent architecture (v0.2.0)

**What:** Run QA and Design Review on separate worktrees via `claude -p`, with branch naming (`gw-qa-iter-N`, `gw-dr-iter-N`), merge strategy (QA merges first, then DR on top), and conflict resolution.

**Why:** Sequential execution means each iteration takes ~2x as long as it could. Parallel execution would halve iteration time and allow QA and DR to run without blocking each other.

**Context:** v0.1.0 uses sequential execution (QA first, DR second) to avoid merge conflicts. Parallel requires worktree isolation (`git worktree add`), a merge strategy when both agents modify the same files, and careful branch management. The Agent tool with `isolation: "worktree"` may provide the right primitive.

**Effort:** L
**Priority:** P2
**Depends on:** garry-wiggum v0.1.0 landing

### Diff-aware iteration (v0.2.0)

**What:** Only re-test pages/components touched by the previous iteration's fixes, rather than running full QA and design review on every iteration.

**Why:** Later iterations often have only 1-2 remaining issues in specific files. Re-running full QA across all pages wastes time and risks introducing new issues in unrelated areas.

**Context:** Requires tracking which files were modified in each iteration (available from git diff), mapping files to pages/routes (needs route-to-file mapping or heuristic), and passing a "scope" parameter to QA and design review skills. The QA skill would need a `--files` or `--pages` flag to limit its scope.

**Effort:** M
**Priority:** P2
**Depends on:** garry-wiggum v0.1.0 landing

### Garry-Wiggum E2E test

**What:** Full E2E test (`test/skill-e2e-garry-wiggum.test.ts`) that validates the iterative loop works end-to-end, including state file creation, convergence detection, and promise tag output.

**Why:** v0.1.0 ships with only static validation (skill frontmatter + structure checks via `bun test`). A full E2E test would validate the integration with QA and design review skills and the Ralph Loop contract.

**Context:** Requires a test app with planted bugs, Ralph Loop plugin integration, and verification that the state file is correctly updated across iterations. Could use a mock Ralph Loop or a single-pass test (--max 1) as a simpler starting point.

**Effort:** M
**Priority:** P2
**Depends on:** garry-wiggum v0.1.0 landing
