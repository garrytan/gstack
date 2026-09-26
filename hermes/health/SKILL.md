---
name: health
description: Use when code quality dashboard. (Ported from gstack to Hermes)
version: 1.0.0
author: gstack (port: Hermes Agent)
license: MIT
metadata:
  hermes:
    tags: [gstack, ported, workflow]
    related_skills: [hermes-agent, hermes-agent-skill-authoring]
    upstream: https://github.com/garrytan/gstack/blob/main/health/SKILL.md
---
## When to Use

Wraps existing project tools (type checker, linter,
test runner, dead code detector, shell linter), computes a weighted composite
0-10 score, and tracks trends over time. Use when: "health check",
"code quality", "how healthy is the codebase", "run all checks",
"quality score".

## Preamble

_Replaces the gstack `gstack-skill-start` preamble. In Hermes, use `session_search` to recover prior context, then proceed._

## Decision-Brief Format

_Adapted from gstack's Claude Code AskUserQuestion spec. Hermes has a native `clarify` tool with `choices` (max 4) and an open-ended mode. Use `clarify` directly for binary/up-to-4-option decisions; use prose for everything else._

## Artifacts Sync

_Replaces gstack artifacts sync. In Hermes, `session_search` handles cross-session context recovery automatically._

## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

**Todo-list discipline.** When working through a multi-step plan, mark each task
complete individually as you finish it. Do not batch-complete at the end. If a task
turns out to be unnecessary, mark it skipped with a one-line reason.

**Think before heavy actions.** For complex operations (refactors, migrations,
non-trivial new features), briefly state your approach before executing. This lets
the user course-correct cheaply instead of mid-flight.

**Dedicated tools over Bash.** Prefer Read, Edit, Write, Glob, Grep over shell
equivalents (cat, sed, find, grep). The dedicated tools are cheaper and clearer.

## Voice

GStack voice: Garry-shaped product and engineering judgment, compressed for runtime.

- Lead with the point. Say what it does, why it matters, and what changes for the builder.
- Be concrete. Name files, functions, line numbers, commands, outputs, evals, and real numbers.
- Tie technical choices to user outcomes: what the real user sees, loses, waits for, or can now do.
- Be direct about quality. Bugs matter. Edge cases matter. Fix the whole thing, not the demo path.
- Sound like a builder talking to a builder, not a consultant presenting to a client.
- Never corporate, academic, PR, or hype. Avoid filler, throat-clearing, generic optimism, and founder cosplay.
- No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, additionally, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant.
- The user has context you do not: domain knowledge, timing, relationships, taste. Cross-model agreement is a recommendation, not a decision. The user decides.

Good: "auth.ts:47 returns undefined when the session cookie expires. Users hit a white screen. Fix: add a null check and redirect to /login. Two lines."
Bad: "I've identified a potential issue in the authentication flow that may cause problems under certain conditions."

## Context Recovery

At session start or after compaction, recover recent project context.

```bash
eval "$(~/.hermes/skills/gstack/# session_search tool 2>/dev/null)"
_PROJ="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  find "$_PROJ/ceo-plans" "$_PROJ/checkpoints" -type f -name "*.md" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -3
  [ -f "$_PROJ/${BRANCH:-unknown}-reviews.jsonl" ] && echo "REVIEWS: $(wc -l < "$_PROJ/${BRANCH:-unknown}-reviews.jsonl" | tr -d ' ') entries"
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  if [ -f "$_PROJ/timeline.jsonl" ]; then
    _LAST=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -1)
    [ -n "$_LAST" ] && echo "LAST_SESSION: $_LAST"
    _RECENT_SKILLS=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -3 | grep -o '"skill":"[^"]*"' | sed 's/"skill":"//;s/"//' | tr '\n' ',')
    [ -n "$_RECENT_SKILLS" ] && echo "RECENT_PATTERN: $_RECENT_SKILLS"
  fi
  _LATEST_CP=$(find "$_PROJ/checkpoints" -name "*.md" -type f 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  [ -n "$_LATEST_CP" ] && echo "LATEST_CHECKPOINT: $_LATEST_CP"
  if [ -f "$_PROJ/decisions.active.json" ]; then
    echo "--- ACTIVE DECISIONS (recent, scope-relevant) ---"
    ~/.hermes/skills/gstack/# session_search tool --recent 5 2>/dev/null
    echo "--- END DECISIONS ---"
  fi
  echo "--- END ARTIFACTS ---"
fi
```

If artifacts are listed, read the newest useful one. If `LAST_SESSION` or `LATEST_CHECKPOINT` appears, give a 2-sentence welcome back summary. If `RECENT_PATTERN` clearly implies a next skill, suggest it once.

**Cross-session decisions.** If `ACTIVE DECISIONS` are listed, treat them as prior settled calls with their rationale — do not silently re-litigate them; if you're about to reverse one, say so explicitly. Reach for `~/.hermes/skills/gstack/# session_search tool` whenever a question touches a past decision ("what did we decide / why / did we try"). When you or the user make a DURABLE decision (architecture, scope, tool/vendor choice, or a reversal) — NOT a turn-level or trivial choice — log it with `~/.hermes/skills/gstack/# memory tool` (`--supersede <id>` for a reversal). Reliable and local; gbrain not required.

## Writing Style (skip entirely if `EXPLAIN_LEVEL: terse` appears in the preamble echo OR the user's current message explicitly requests terse / no-explanations output)

Applies to AskUserQuestion, user replies, and findings. AskUserQuestion Format is structure; this is prose quality.

- Gloss curated jargon on first use per skill invocation, even if the user pasted the term.
- Frame questions in outcome terms: what pain is avoided, what capability unlocks, what user experience changes.
- Use short sentences, concrete nouns, active voice.
- Close decisions with user impact: what the user sees, waits for, loses, or gains.
- User-turn override wins: if the current message asks for terse / no explanations / just the answer, skip this section.
- Terse mode (EXPLAIN_LEVEL: terse): no glosses, no outcome-framing layer, shorter responses.

Curated jargon list lives at `~/.hermes/skills/gstack/scripts/jargon-list.json` (80+ terms). On the first jargon term you encounter this session, Read that file once; treat the `terms` array as the canonical list. The list is repo-owned and may grow between releases.


## Completeness Principle — Boil the Ocean

AI makes completeness cheap, so the complete thing is the goal. Recommend full coverage (tests, edge cases, error paths) — boil the ocean one lake at a time. The only thing out of scope is genuinely unrelated work (rewrites, multi-quarter migrations); flag that as separate scope, never as an excuse for a shortcut.

When options differ in coverage, include `Completeness: X/10` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: `Note: options differ in kind, not coverage — no completeness score.` Do not fabricate scores.

## Confusion Protocol

For high-stakes ambiguity (architecture, data model, destructive scope, missing context), STOP. Name it in one sentence, present 2-3 options with tradeoffs, and ask. Do not use for routine coding or obvious changes.

## Claimed Limitations Need Evidence

A claimed limitation or requirement ("the API can't do this", "X requires a credential", "that's impossible on this platform") is a material claim. State one only with the verbatim error, the documented statement, or a live probe in hand — pattern-matching a failure to a familiar story is not evidence. When a cheap probe settles the question, run it BEFORE asking the user anything or declaring a step blocked.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

_Replaces gstack `gstack-learnings-log`. In Hermes, durable learnings are saved via the `memory` tool, and reusable workflows become `skill_manage` entries._

## Telemetry

_Replaces `gstack-skill-end`. In Hermes, log durable facts to `memory` and continue. The Hermes gateway handles cross-session metrics._

## User-invocable
When the user types `/health`, run this skill.

---

## Step 1: Detect Health Stack

Read AGENTS.md and look for a `## Health Stack` section. If found, parse the tools
listed there and skip auto-detection.

If no `## Health Stack` section exists, auto-detect available tools:

```bash
# Type checker
[ -f tsconfig.json ] && echo "TYPECHECK: tsc --noEmit"

# Linter
[ -f biome.json ] || [ -f biome.jsonc ] && echo "LINT: biome check ."
setopt +o nomatch 2>/dev/null || true
ls eslint.config.* .eslintrc.* .eslintrc 2>/dev/null | head -1 | xargs -I{} echo "LINT: eslint ."
[ -f .pylintrc ] || [ -f pyproject.toml ] && grep -q "pylint\|ruff" pyproject.toml 2>/dev/null && echo "LINT: ruff check ."

# Test runner
[ -f package.json ] && grep -q '"test"' package.json 2>/dev/null && echo "TEST: $(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts.test)" 2>/dev/null)"
[ -f pyproject.toml ] && grep -q "pytest" pyproject.toml 2>/dev/null && echo "TEST: pytest"
[ -f Cargo.toml ] && echo "TEST: cargo test"
[ -f go.mod ] && echo "TEST: go test ./..."

# Dead code
command -v knip >/dev/null 2>&1 && echo "DEADCODE: knip"
[ -f package.json ] && grep -q '"knip"' package.json 2>/dev/null && echo "DEADCODE: npx knip"

# Shell linting
command -v shellcheck >/dev/null 2>&1 && ls *.sh scripts/*.sh bin/*.sh 2>/dev/null | head -1 | xargs -I{} echo "SHELL: shellcheck"

# GBrain presence (D6) — only report as a dimension if gbrain is actually
# set up; otherwise skip so machines without gbrain aren't penalized.
if command -v gbrain >/dev/null 2>&1 && [ -f "$HOME/.gbrain/config.json" ]; then
  echo "GBRAIN: gbrain doctor --json (wrapped in timeout 5s)"
fi
```

Use Glob to search for shell scripts:
- `**/*.sh` (shell scripts in the repo)

After auto-detection, present the detected tools via AskUserQuestion:

"I detected these health check tools for this project:

- Type check: `tsc --noEmit`
- Lint: `biome check .`
- Tests: `bun test`
- Dead code: `knip`
- Shell lint: `shellcheck *.sh`

A) Looks right -- persist to AGENTS.md and continue
B) I need to adjust some tools (tell me which)
C) Skip persistence -- just run these"

If the user chooses A or B (after adjustments), append or update a `## Health Stack`
section in AGENTS.md:

```markdown
## Health Stack

- typecheck: tsc --noEmit
- lint: biome check .
- test: bun test
- deadcode: knip
- shell: shellcheck *.sh scripts/*.sh
```

---

## Step 2: Run Tools

Run each detected tool. For each tool:

1. Record the start time
2. Run the command, capturing both stdout and stderr
3. Record the exit code
4. Record the end time
5. Capture the last 50 lines of output for the report

```bash
# Example for each tool — run each independently
START=$(date +%s)
tsc --noEmit 2>&1 | tail -50
EXIT_CODE=$?
END=$(date +%s)
echo "TOOL:typecheck EXIT:$EXIT_CODE DURATION:$((END-START))s"
```

Run tools sequentially (some may share resources or lock files). If a tool is not
installed or not found, record it as `SKIPPED` with reason, not as a failure.

---

## Step 3: Score Each Category

Score each category on a 0-10 scale using this rubric:

| Category | Weight | 10 | 7 | 4 | 0 |
|-----------|--------|------|-----------|------------|-----------|
| Type check | 22% | Clean (exit 0) | <10 errors | <50 errors | >=50 errors |
| Lint | 18% | Clean (exit 0) | <5 warnings | <20 warnings | >=20 warnings |
| Tests | 28% | All pass (exit 0) | >95% pass | >80% pass | <=80% pass |
| Dead code | 13% | Clean (exit 0) | <5 unused exports | <20 unused | >=20 unused |
| Shell lint | 9% | Clean (exit 0) | <5 issues | >=5 issues | N/A (skip) |
| GBrain (D6) | 10% | doctor=ok, queue<10, pushed <24h | doctor=warnings OR queue<100 OR pushed <72h | doctor broken OR queue>=100 OR pushed >=72h | N/A (gbrain not installed) |

**Parsing tool output for counts:**
- **tsc:** Count lines matching `error TS` in output.
- **biome/eslint/ruff:** Count lines matching error/warning patterns. Parse the summary line if available.
- **Tests:** Parse pass/fail counts from the test runner output. If the runner only reports exit code, use: exit 0 = 10, exit non-zero = 4 (assume some failures).
- **knip:** Count lines reporting unused exports, files, or dependencies.
- **shellcheck:** Count distinct findings (lines starting with "In ... line").

**Composite score:**
```
composite = (typecheck_score * 0.22) + (lint_score * 0.18) + (test_score * 0.28) + (deadcode_score * 0.13) + (shell_score * 0.09) + (gbrain_score * 0.10)
```

If a category is skipped (tool not available — includes GBrain when gbrain
is not installed), redistribute its weight proportionally among the
remaining categories.

**GBrain sub-score computation (D6):**

```
doctor_component: 10 if `gbrain doctor --json | jq -r .status` == "ok";
                   7 if "warnings"; 0 otherwise (or command times out after 5s).
queue_component:   10 if ~/.hermes/gstack/.brain-queue.jsonl has <10 lines;
                    7 if 10-100; 0 if >=100 (suggests secret-scan rejections
                    piling up). N/A if artifacts_sync_mode == off.
push_component:    10 if (now - mtime of ~/.hermes/gstack/.brain-last-push) < 24h;
                    7 if <72h; 0 if >=72h. N/A if artifacts_sync_mode == off.
gbrain_score     = 0.5 * doctor_component + 0.3 * queue_component + 0.2 * push_component
                   (redistribute 0.3 + 0.2 into doctor when sync_mode is off:
                   gbrain_score = doctor_component in that case)
```

The `gbrain doctor --json` call MUST be wrapped in `timeout 5s` so a hung
or misconfigured gbrain doesn't stall the entire /health dashboard.

---

## Step 4: Present Dashboard

Present results as a clear table:

```
CODE HEALTH DASHBOARD
=====================

Project: <project name>
Branch:  <current branch>
Date:    <today>

Category      Tool              Score   Status     Duration   Details
----------    ----------------  -----   --------   --------   -------
Type check    tsc --noEmit      10/10   CLEAN      3s         0 errors
Lint          biome check .      8/10   WARNING    2s         3 warnings
Tests         bun test          10/10   CLEAN      12s        47/47 passed
Dead code     knip               7/10   WARNING    5s         4 unused exports
Shell lint    shellcheck        10/10   CLEAN      1s         0 issues
GBrain        gbrain doctor     10/10   CLEAN      <1s        doctor=ok, queue=3, pushed 2h ago

COMPOSITE SCORE: 9.1 / 10

Duration: 23s total
```

Use these status labels:
- 10: `CLEAN`
- 7-9: `WARNING`
- 4-6: `NEEDS WORK`
- 0-3: `CRITICAL`

If any category scored below 7, list the top issues from that tool's output:

```
DETAILS: Lint (3 warnings)
  biome check . output:
    src/utils.ts:42 — lint/complexity/noForEach: Prefer for...of
    src/api.ts:18 — lint/style/useConst: Use const instead of let
    src/api.ts:55 — lint/suspicious/noExplicitAny: Unexpected any
```

---

## Step 5: Persist to Health History

```bash
eval "$(~/.hermes/skills/gstack/# session_search tool 2>/dev/null)" && mkdir -p ~/.hermes/gstack/projects/$SLUG
```

Append one JSONL line to `~/.hermes/gstack/projects/$SLUG/health-history.jsonl`:

```json
{"ts":"2026-03-31T14:30:00Z","branch":"main","score":9.1,"typecheck":10,"lint":8,"test":10,"deadcode":7,"shell":10,"gbrain":10,"duration_s":23}
```

Fields:
- `ts` -- ISO 8601 timestamp
- `branch` -- current git branch
- `score` -- composite score (one decimal)
- `typecheck`, `lint`, `test`, `deadcode`, `shell`, `gbrain` -- individual category scores (integer 0-10)
- `duration_s` -- total time for all tools in seconds

If a category was skipped, set its value to `null`. Pre-D6 history entries
won't have a `gbrain` field — treat them as `null` for trend comparison
and start new tracking from the first post-D6 run.

---

## Step 6: Trend Analysis + Recommendations

Read the last 10 entries from `~/.hermes/gstack/projects/$SLUG/health-history.jsonl` (if the
file exists and has prior entries).

```bash
eval "$(~/.hermes/skills/gstack/# session_search tool 2>/dev/null)" && mkdir -p ~/.hermes/gstack/projects/$SLUG
tail -10 ~/.hermes/gstack/projects/$SLUG/health-history.jsonl 2>/dev/null || echo "NO_HISTORY"
```

**If prior entries exist, show the trend:**

```
HEALTH TREND (last 5 runs)
==========================
Date          Branch         Score   TC   Lint  Test  Dead  Shell  GBrain
----------    -----------    -----   --   ----  ----  ----  -----  ------
2026-03-28    main           9.4     10   9     10    8     10     10
2026-03-29    feat/auth      8.8     10   7     10    7     10     10
2026-03-30    feat/auth      8.2     10   6     9     7     10      7
2026-03-31    feat/auth      9.1     10   8     10    7     10     10

Trend: IMPROVING (+0.9 since last run)
```

**If score dropped vs the previous run:**
1. Identify WHICH categories declined
2. Show the delta for each declining category
3. Correlate with tool output -- what specific errors/warnings appeared?

```
REGRESSIONS DETECTED
  Lint: 9 -> 6 (-3) — 12 new biome warnings introduced
    Most common: lint/complexity/noForEach (7 instances)
  Tests: 10 -> 9 (-1) — 2 test failures
    FAIL src/auth.test.ts > should validate token expiry
    FAIL src/auth.test.ts > should reject malformed JWT
```

**Health improvement suggestions (always show these):**

Prioritize suggestions by impact (weight * score deficit):

```
RECOMMENDATIONS (by impact)
============================
1. [HIGH]  Fix 2 failing tests (Tests: 9/10, weight 30%)
   Run: bun test --verbose to see failures
2. [MED]   Address 12 lint warnings (Lint: 6/10, weight 20%)
   Run: biome check . --write to auto-fix
3. [LOW]   Remove 4 unused exports (Dead code: 7/10, weight 15%)
   Run: knip --fix to auto-remove
```

Rank by `weight * (10 - score)` descending. Only show categories below 10.

---

## Important Rules

1. **Wrap, don't replace.** Run the project's own tools. Never substitute your own analysis for what the tool reports.
2. **Read-only.** Never fix issues. Present the dashboard and let the user decide.
3. **Respect AGENTS.md.** If `## Health Stack` is configured, use those exact commands. Do not second-guess.
4. **Skipped is not failed.** If a tool isn't available, skip it gracefully and redistribute weight. Do not penalize the score.
5. **Show raw output for failures.** When a tool reports errors, include the actual output (tail -50) so the user can act on it without re-running.
6. **Trends require history.** On first run, say "First health check -- no trend data yet. Run /health again after making changes to track progress."
7. **Be honest about scores.** A codebase with 100 type errors and all tests passing is not healthy. The composite score should reflect reality.
