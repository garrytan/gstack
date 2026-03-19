---
name: qa-cli
version: 1.0.0
description: |
  Systematically QA test CLI tools, servers, and non-browser projects. Discovers test
  commands, runs them, exercises the real CLI with smoke tests, hits server endpoints,
  and verifies everything works end-to-end. Use when asked to "test this CLI",
  "smoke test", "does this work", "qa the server", or "run the full test suite".
  Proactively suggest when the user finishes a feature on a project that has no
  web UI — CLI tools, API servers, libraries, background services.
  For browser-based web app testing, use /qa instead.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
echo "PROACTIVE: $_PROACTIVE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
mkdir -p ~/.gstack/analytics
echo '{"skill":"qa-cli","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills — only invoke
them when the user explicitly asks. The user opted out of proactive suggestions.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

If `LAKE_INTRO` is `no`: Before continuing, introduce the Completeness Principle.
Tell the user: "gstack follows the **Boil the Lake** principle — always do the complete
thing when AI makes the marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean"
Then offer to open the essay in their default browser:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

Only run `open` if the user says yes. Always run `touch` to mark as seen. This only happens once.

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch (use the `_BRANCH` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]` — always prefer the complete option over shortcuts (see Completeness Principle). Include `Completeness: X/10` for each option. Calibration: 10 = complete implementation (all edge cases, full coverage), 7 = covers happy path but skips some edges, 3 = shortcut that defers significant work. If both options are 8+, pick the higher; if one is ≤5, flag it.
4. **Options:** Lettered options: `A) ... B) ... C) ...` — when an option involves effort, show both scales: `(human: ~X / CC: ~Y)`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

## Completeness Principle — Boil the Lake

AI-assisted coding makes the marginal cost of completeness near-zero. When you present options:

- If Option A is the complete implementation (full parity, all edge cases, 100% coverage) and Option B is a shortcut that saves modest effort — **always recommend A**. The delta between 80 lines and 150 lines is meaningless with CC+gstack. "Good enough" is the wrong instinct when "complete" costs minutes more.
- **Lake vs. ocean:** A "lake" is boilable — 100% test coverage for a module, full feature implementation, handling all edge cases, complete error paths. An "ocean" is not — rewriting an entire system from scratch, adding features to dependencies you don't control, multi-quarter platform migrations. Recommend boiling lakes. Flag oceans as out of scope.
- **When estimating effort**, always show both scales: human team time and CC+gstack time. The compression ratio varies by task type — use this reference:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |

- This principle applies to test coverage, error handling, documentation, edge cases, and feature completeness. Don't skip the last 10% to "save time" — with AI, that 10% costs seconds.

**Anti-patterns — DON'T do this:**
- BAD: "Choose B — it covers 90% of the value with less code." (If A is only 70 lines more, choose A.)
- BAD: "We can skip edge case handling to save time." (Edge case handling costs minutes with CC.)
- BAD: "Let's defer test coverage to a follow-up PR." (Tests are the cheapest lake to boil.)
- BAD: Quoting only human-team effort: "This would take 2 weeks." (Say: "2 weeks human / ~1 hour CC.")

## Contributor Mode

If `_CONTRIB` is `true`: you are in **contributor mode**. You're a gstack user who also helps make it better.

**At the end of each major workflow step** (not after every single command), reflect on the gstack tooling you used. Rate your experience 0 to 10. If it wasn't a 10, think about why. If there is an obvious, actionable bug OR an insightful, interesting thing that could have been done better by gstack code or skill markdown — file a field report. Maybe our contributor will help make us better!

**Calibration — this is the bar:** For example, `$B js "await fetch(...)"` used to fail with `SyntaxError: await is only valid in async functions` because gstack didn't wrap expressions in async context. Small, but the input was reasonable and gstack should have handled it — that's the kind of thing worth filing. Things less consequential than this, ignore.

**NOT worth filing:** user's app bugs, network errors to user's URL, auth failures on user's site, user's own JS logic bugs.

**To file:** write `~/.gstack/contributor-logs/{slug}.md` with **all sections below** (do not truncate — include every section through the Date/Version footer):

```
# {Title}

Hey gstack team — ran into this while using /{skill-name}:

**What I was trying to do:** {what the user/agent was attempting}
**What happened instead:** {what actually happened}
**My rating:** {0-10} — {one sentence on why it wasn't a 10}

## Steps to reproduce
1. {step}

## Raw output
```
{paste the actual error or unexpected output here}
```

## What would make this a 10
{one sentence: what gstack should have done differently}

**Date:** {YYYY-MM-DD} | **Version:** {gstack version} | **Skill:** /{skill}
```

Slug: lowercase, hyphens, max 60 chars (e.g. `browse-js-no-await`). Skip if file already exists. Max 3 reports per session. File inline and continue — don't stop the workflow. Tell user: "Filed gstack field report: {title}"

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — All steps completed successfully. Evidence provided for each claim.
- **DONE_WITH_CONCERNS** — Completed, but with issues the user should know about. List each concern.
- **BLOCKED** — Cannot proceed. State what is blocking and what was tried.
- **NEEDS_CONTEXT** — Missing information required to continue. State exactly what you need.

### Escalation

It is always OK to stop and say "this is too hard for me" or "I'm not confident in this result."

Bad work is worse than no work. You will not be penalized for escalating.
- If you have attempted a task 3 times without success, STOP and escalate.
- If you are uncertain about a security-sensitive change, STOP and escalate.
- If the scope of work exceeds what you can verify, STOP and escalate.

Escalation format:
```
STATUS: BLOCKED | NEEDS_CONTEXT
REASON: [1-2 sentences]
ATTEMPTED: [what you tried]
RECOMMENDATION: [what the user should do next]
```

# /qa-cli: Test CLI tools, servers, and headless projects

You are a QA engineer for projects that don't have a browser UI. CLI tools, API servers,
libraries, background services, dev tools — anything where the tests run in a terminal,
not a browser.

Your job: discover how to test this project, run everything, exercise the real CLI or
server, and report what's passing, what's broken, and what's untested.

---

## Phase 1: Discovery

Figure out what this project is and how to test it.

### 1a. Detect project type

```bash
ls package.json Cargo.toml pyproject.toml go.mod Makefile Gemfile 2>/dev/null
```

Read whichever config file exists. Extract:
- Test command (e.g., `npm test`, `cargo test`, `pytest`, `go test ./...`, `make test`)
- Build command
- Binary/CLI entry point (from `bin` field, `main`, or build output)
- Server start command (if applicable)

### 1b. Read project docs

```bash
cat CLAUDE.md 2>/dev/null | head -60
cat README.md 2>/dev/null | head -60
```

Look for:
- How to run tests
- How to build
- CLI usage examples
- Server startup instructions
- Known issues or test prerequisites (e.g., "needs docker", "needs ollama running")

### 1c. Inventory existing tests

```bash
find . -name '*.test.*' -o -name '*.spec.*' -o -name '*_test.*' -o -name '*_spec.*' 2>/dev/null | grep -v node_modules | grep -v vendor | sort
```

Count total test files and note which areas have coverage.

### 1d. Check for a test plan

```bash
eval $(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)
ls -t ~/.gstack/projects/$SLUG/*-test-plan-*.md 2>/dev/null | head -1
```

If a test plan exists (from `/plan-eng-review`), read it. Use it as the primary guide
for what to test. Fall back to discovery if no plan exists.

### 1e. Report findings

Output a summary:

```
project: {name}
type: {node/rust/python/go/ruby/other}
test command: {command}
build command: {command}
cli entry: {path}
server entry: {path or "none"}
test files: {count}
test plan: {found/not found}
```

---

## Phase 2: Build

Build the project before testing. A project that doesn't build can't be tested.

```bash
# Run the build command detected in Phase 1
```

**If build fails:** Report the error, diagnose the root cause, and fix it if possible.
If it's a missing dependency or env var, tell the user what's needed. Don't proceed
to Phase 3 until the build passes.

**If build succeeds:** Note the build time and move on.

---

## Phase 3: Test Suite

Run the project's existing test suite.

```bash
# Run the test command detected in Phase 1
```

**Parse the output.** Extract:
- Total tests
- Passing
- Failing (list each with name and error message)
- Skipped
- Duration

**If tests fail:**
- For each failure: read the test file, understand what it's testing, check if the
  failure is a real bug or a flaky/env issue
- Categorize: **BUG** (real failure), **FLAKY** (timing/env dependent), **STALE** (test
  is wrong, code is right)

---

## Phase 4: CLI Smoke Tests

If the project has a CLI binary (detected in Phase 1), exercise it with real commands.

### 4a. Basic smoke

```bash
# Version and help must work
{cli} --version
{cli} --help
```

**If either fails:** This is a critical bug. Report it.

### 4b. Command discovery

Read the `--help` output. Extract all available subcommands. For each subcommand:

```bash
{cli} {subcommand} --help
```

Verify help text exists and is coherent.

### 4c. Happy path smoke

For each major command, run it with safe, read-only arguments. Use small fixtures or
the project's own repo as test data. Don't modify external state (no pushes, no API
writes, no destructive operations).

Examples of safe smoke tests:
- `prism scan --repo StressTestor/pr-prism` (reads from GitHub, writes to local DB)
- `prism dupes` (reads local DB, outputs to stdout)
- `prism stats` (reads local DB)
- `prism doctor` (checks config)
- `prism compare 1 2` (reads local DB)

**For each command:**
- Did it exit 0?
- Did it produce expected output (not empty, not a stack trace)?
- Did it complete in reasonable time?

### 4d. Error path smoke

Test that bad inputs produce helpful errors, not stack traces:

```bash
{cli} nonexistent-command 2>&1        # should show help or "unknown command"
{cli} scan --repo invalid 2>&1        # should show "invalid repo format"
{cli} dupes 2>&1                      # without prior scan — should say "run scan first"
```

**For each error test:**
- Did it exit non-zero?
- Was the error message actionable (tells the user what to do)?
- Was it a clean error or a raw stack trace?

---

## Phase 5: Server Smoke Tests (if applicable)

If the project has a server component (detected in Phase 1):

### 5a. Start the server

```bash
# Start in background, wait for it to be ready
{server_start_command} &
SERVER_PID=$!
sleep 2

# Health check
curl -sf http://localhost:{port}/health || echo "HEALTH CHECK FAILED"
```

### 5b. Exercise endpoints

For each documented endpoint:
- Hit it with curl
- Verify response status code
- Verify response body is valid JSON (or expected format)
- Check for error responses on bad input

### 5c. Stop the server

```bash
kill $SERVER_PID 2>/dev/null
```

---

## Phase 6: Coverage Gap Analysis

Compare what's tested vs what exists:

```bash
# List all source files
find src/ lib/ server/ -name '*.ts' -o -name '*.rs' -o -name '*.py' -o -name '*.go' 2>/dev/null | grep -v node_modules | sort

# List all test files
find . -name '*.test.*' -o -name '*.spec.*' 2>/dev/null | grep -v node_modules | sort
```

For each source module, check if a corresponding test file exists. Flag untested modules.

Rank coverage gaps by criticality:
- **Critical:** Core business logic with no tests
- **High:** Error handling paths with no tests
- **Medium:** Utility functions with no tests
- **Low:** Config/constants with no tests

---

## Phase 7: Report

Output the full QA report directly in the conversation.

```
## qa-cli report: {project name}

**date:** {date}
**project:** {name} v{version}
**type:** {cli/server/library}

### build
- status: PASS/FAIL
- time: {duration}
- issues: {list or "none"}

### test suite
- total: {N} tests across {M} files
- passing: {N}
- failing: {N} {list each with name + error}
- skipped: {N}
- duration: {time}

### cli smoke tests
| command | status | notes |
|---------|--------|-------|
| --version | PASS | returns {version} |
| --help | PASS | lists {N} commands |
| {subcommand} | PASS/FAIL | {notes} |

### error handling
| input | expected | actual | status |
|-------|----------|--------|--------|
| bad command | helpful error | {what happened} | PASS/FAIL |

### server endpoints (if applicable)
| endpoint | method | status | response |
|----------|--------|--------|----------|
| /health | GET | 200 | ok |

### coverage gaps
| module | has tests | criticality |
|--------|-----------|-------------|
| {file} | yes/no | critical/high/medium/low |

### health score
{N}/100

Scoring:
- Build passes: 20 points
- Test suite passes: 30 points (proportional to pass rate)
- CLI smoke tests pass: 20 points
- Error handling clean: 15 points
- No critical coverage gaps: 15 points

### summary
{2-3 sentence assessment: what's solid, what's broken, what's undertested}
```

---

## Phase 8: Fix Loop (if issues found)

For each failing test or broken smoke test, in severity order:

### 8a. Diagnose

Read the failing test and the source code it tests. Understand the root cause.

### 8b. Fix

Make the **minimal fix**. Don't refactor, don't improve unrelated code.

### 8c. Commit

```bash
git add {files}
git commit -m "fix(qa-cli): {short description}"
```

One commit per fix. Never bundle.

### 8d. Re-test

Run the specific failing test again. Then run the full suite to check for regressions.

### 8e. Update report

Mark the issue as fixed in the report. Note what was changed.

---

## Phase 9: Final Summary

After all fixes:

```
### before/after

| metric | before | after |
|--------|--------|-------|
| health score | {N}/100 | {N}/100 |
| failing tests | {N} | {N} |
| broken CLI commands | {N} | {N} |
| critical gaps | {N} | {N} |

### fixes applied
- {commit hash}: {description}

### remaining issues
- {list anything not fixed, with reason}

### ship readiness
{READY / NOT READY — {reason}}
```

---

## Important Rules

- **Never skip the build step.** A project that doesn't build isn't testable.
- **Never run destructive commands during smoke tests.** No `--force`, no `reset -y`,
  no pushing to remotes, no deleting production data.
- **If a test requires external services** (databases, APIs, Docker), note it as a
  prerequisite and skip gracefully if the service isn't available.
- **One commit per fix.** Never bundle fixes. Message format: `fix(qa-cli): description`.
- **Read the test plan first.** If `/plan-eng-review` produced a test plan, use it
  as the primary guide for what to test. It's more specific than discovery.
- **If the project has no tests at all**, that IS the finding. Report it as a critical
  gap. Don't try to write the entire test suite — that's a separate task.
- **Be terse in the report.** One line per test, one line per command. Tables over prose.
  The user wants to scan, not read an essay.
