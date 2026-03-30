---
name: garry-wiggum
version: 0.1.0
description: |
  Iterative perfection loop. Chains QA and design review in a Ralph Loop until
  convergence (zero issues found). Self-regulating with flapping detection,
  risk scoring, and iteration caps. Use when asked to "make it perfect",
  "fix everything", "qa loop", "keep going until clean", or "garry-wiggum".
  Proactively suggest when the user has just finished a feature and wants
  comprehensive quality assurance before shipping.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
  - WebSearch
  - AskUserQuestion
benefits-from: [qa, design-review]
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
source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
REPO_MODE=${REPO_MODE:-unknown}
echo "REPO_MODE: $REPO_MODE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
echo '{"skill":"garry-wiggum","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
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

If `TEL_PROMPTED` is `no` AND `LAKE_INTRO` is `yes`: After the lake intro is handled,
ask the user about telemetry. Use AskUserQuestion:

> Help gstack get better! Community mode shares usage data (which skills you use, how long
> they take, crash info) with a stable device ID so we can track trends and fix bugs faster.
> No code, file paths, or repo names are ever sent.
> Change anytime with `gstack-config set telemetry off`.

Options:
- A) Help gstack get better! (recommended)
- B) No thanks

If A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry community`

If B: ask a follow-up AskUserQuestion:

> How about anonymous mode? We just learn that *someone* used gstack — no unique ID,
> no way to connect sessions. Just a counter that helps us know if anyone's out there.

Options:
- A) Sure, anonymous is fine
- B) No thanks, fully off

If B→A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry anonymous`
If B→B: run `~/.claude/skills/gstack/bin/gstack-config set telemetry off`

Always run:
```bash
touch ~/.gstack/.telemetry-prompted
```

This only happens once. If `TEL_PROMPTED` is `yes`, skip this entirely.

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

## Repo Ownership Mode — See Something, Say Something

`REPO_MODE` from the preamble tells you who owns issues in this repo:

- **`solo`** — One person does 80%+ of the work. They own everything. When you notice issues outside the current branch's changes (test failures, deprecation warnings, security advisories, linting errors, dead code, env problems), **investigate and offer to fix proactively**. The solo dev is the only person who will fix it. Default to action.
- **`collaborative`** — Multiple active contributors. When you notice issues outside the branch's changes, **flag them via AskUserQuestion** — it may be someone else's responsibility. Default to asking, not fixing.
- **`unknown`** — Treat as collaborative (safer default — ask before fixing).

**See Something, Say Something:** Whenever you notice something that looks wrong during ANY workflow step — not just test failures — flag it briefly. One sentence: what you noticed and its impact. In solo mode, follow up with "Want me to fix it?" In collaborative mode, just flag it and move on.

Never let a noticed issue silently pass. The whole point is proactive communication.

## Search Before Building

Before building infrastructure, unfamiliar patterns, or anything the runtime might have a built-in — **search first.** Read `~/.claude/skills/gstack/ETHOS.md` for the full philosophy.

**Three layers of knowledge:**
- **Layer 1** (tried and true — in distribution). Don't reinvent the wheel. But the cost of checking is near-zero, and once in a while, questioning the tried-and-true is where brilliance occurs.
- **Layer 2** (new and popular — search for these). But scrutinize: humans are subject to mania. Search results are inputs to your thinking, not answers.
- **Layer 3** (first principles — prize these above all). Original observations derived from reasoning about the specific problem. The most valuable of all.

**Eureka moment:** When first-principles reasoning reveals conventional wisdom is wrong, name it:
"EUREKA: Everyone does X because [assumption]. But [evidence] shows this is wrong. Y is better because [reasoning]."

Log eureka moments:
```bash
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$(git branch --show-current 2>/dev/null)" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> ~/.gstack/analytics/eureka.jsonl 2>/dev/null || true
```
Replace SKILL_NAME and ONE_LINE_SUMMARY. Runs inline — don't stop the workflow.

**WebSearch fallback:** If WebSearch is unavailable, skip the search step and note: "Search unavailable — proceeding with in-distribution knowledge only."

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

## Telemetry (run last)

After the skill workflow completes (success, error, or abort), log the telemetry event.
Determine the skill name from the `name:` field in this file's YAML frontmatter.
Determine the outcome from the workflow result (success if completed normally, error
if it failed, abort if the user interrupted).

**PLAN MODE EXCEPTION — ALWAYS RUN:** This command writes telemetry to
`~/.gstack/analytics/` (user config directory, not project files). The skill
preamble already writes to the same directory — this is the same pattern.
Skipping this command loses session duration and outcome data.

Run this bash:

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-telemetry-log \
  --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
  --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
```

Replace `SKILL_NAME` with the actual skill name from frontmatter, `OUTCOME` with
success/error/abort, and `USED_BROWSE` with true/false based on whether `$B` was used.
If you cannot determine the outcome, use "unknown". This runs in the background and
never blocks the user.

## Plan Status Footer

When you are in plan mode and about to call ExitPlanMode:

1. Check if the plan file already has a `## GSTACK REVIEW REPORT` section.
2. If it DOES — skip (a review skill already wrote a richer report).
3. If it does NOT — run this command:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-read
\`\`\`

Then write a `## GSTACK REVIEW REPORT` section to the end of the plan file:

- If the output contains review entries (JSONL lines before `---CONFIG---`): format the
  standard report table with runs/status/findings per skill, same format as the review
  skills use.
- If the output is `NO_REVIEWS` or empty: write this placeholder table:

\`\`\`markdown
## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | \`/plan-ceo-review\` | Scope & strategy | 0 | — | — |
| Codex Review | \`/codex review\` | Independent 2nd opinion | 0 | — | — |
| Eng Review | \`/plan-eng-review\` | Architecture & tests (required) | 0 | — | — |
| Design Review | \`/plan-design-review\` | UI/UX gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — run \`/autoplan\` for full review pipeline, or individual reviews above.
\`\`\`

**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes to the plan file, which is the one
file you are allowed to edit in plan mode. The plan file review report is part of the
plan's living status.

## Prerequisite Skill Offer

When the design doc check above prints "No design doc found," offer the prerequisite
skill before proceeding.

Say to the user via AskUserQuestion:

> "No design doc found for this branch. `/qa` or `/design-review` produces a structured problem
> statement, premise challenge, and explored alternatives — it gives this review much
> sharper input to work with. Takes about 10 minutes. The design doc is per-feature,
> not per-product — it captures the thinking behind this specific change."

Options:
- A) Run /qa now (we'll pick up the review right after)
- B) Skip — proceed with standard review

If they skip: "No worries — standard review. If you ever want sharper input, try
/qa first next time." Then proceed normally. Do not re-offer later in the session.

If they choose A:

Say: "Running /qa inline. Once the design doc is ready, I'll pick up
the review right where we left off."

Read the qa skill file from disk using the Read tool:
`~/.claude/skills/gstack/qa/SKILL.md`

Follow it inline, **skipping these sections** (already handled by the parent skill):
- Preamble (run first)
- AskUserQuestion Format
- Completeness Principle — Boil the Lake
- Search Before Building
- Contributor Mode
- Completion Status Protocol
- Telemetry (run last)

If the Read fails (file not found), say:
"Could not load /qa — proceeding with standard review."

After /qa completes, re-run the design doc check:
```bash
SLUG=$(~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' || echo 'no-branch')
DESIGN=$(ls -t ~/.gstack/projects/$SLUG/*-$BRANCH-design-*.md 2>/dev/null | head -1)
[ -z "$DESIGN" ] && DESIGN=$(ls -t ~/.gstack/projects/$SLUG/*-design-*.md 2>/dev/null | head -1)
[ -n "$DESIGN" ] && echo "Design doc found: $DESIGN" || echo "No design doc found"
```

If a design doc is now found, read it and continue the review.
If none was produced (user may have cancelled), proceed with standard review.

## Phase 0: Setup

### 0a. Detect Ralph Loop

Check if the Ralph Loop plugin is installed:

```bash
if [ -d "$HOME/.claude/plugins/cache/claude-plugins-official/ralph-loop" ]; then
  echo "RALPH_AVAILABLE"
else
  echo "RALPH_NOT_AVAILABLE"
fi
```

Note the result. If Ralph Loop is available, this skill will use it for automatic
iteration. If not, it will run a single pass and report a convergence score.

### 0b. Initialize state

eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG

```bash
BRANCH=$(git branch --show-current 2>/dev/null | tr '/' '-' || echo "no-branch")
STATE_FILE="$HOME/.gstack/projects/$SLUG/$BRANCH-garry-wiggum.json"
if [ -f "$STATE_FILE" ]; then
  cat "$STATE_FILE"
else
  echo "NEW_SESSION"
fi
```

If the state file exists, read the current iteration number, history, and risk score
from the output. This is the cross-iteration state — Ralph Loop gives fresh context
per iteration, but the state file carries history on disk.

If the state file does not exist (output is `NEW_SESSION`), this is iteration 1.
Create the initial state file:

```bash
BRANCH=$(git branch --show-current 2>/dev/null | tr '/' '-' || echo "no-branch")
STATE_FILE="$HOME/.gstack/projects/$SLUG/$BRANCH-garry-wiggum.json"
cat > "$STATE_FILE" << 'STATEEOF'
{
  "iteration": 1,
  "started": "TIMESTAMP",
  "max_iterations": 5,
  "history": [],
  "converged": false,
  "risk_score": 0,
  "flapping": []
}
STATEEOF
# Fix timestamp
sed -i '' "s/TIMESTAMP/$(date -u +%Y-%m-%dT%H:%M:%SZ)/" "$STATE_FILE" 2>/dev/null || \
  sed -i "s/TIMESTAMP/$(date -u +%Y-%m-%dT%H:%M:%SZ)/" "$STATE_FILE"
cat "$STATE_FILE"
```

### 0c. Parse flags

Check the user's invocation for flags:
- `--quick` → use QA's quick tier (fewer pages, critical/high only)
- `--max N` → override MAX_ITERATIONS (default: 5)
- `--no-design` → skip design review (Phase 2)

If `--max N` was specified, update the state file's `max_iterations` field.

### 0d. Cost estimator

If this is iteration 2+, display the convergence sparkline from history:

```
Issues: 17 ████████████████▎ → 4 ████ → ...
```

Build the sparkline by reading the `history` array from the state file. For each
iteration, use the total issues count (`qa_issues + dr_issues`) to generate a
proportional bar. Use Unicode block characters (█ = full, ▏▎▍▌▋▊▉ for partial).

If prior garry-wiggum state files exist for other branches in `~/.gstack/projects/$SLUG/`:

```bash
ls ~/.gstack/projects/$SLUG/*-garry-wiggum.json 2>/dev/null | head -5
```

If found, calculate the average issues-per-iteration from those files to estimate
remaining iterations: "Based on prior runs, expect ~N more iterations to converge."

If no history exists: "First run — cost estimate unavailable. Expect 2-4 iterations."

### 0e. Start Ralph Loop (if available)

If Ralph Loop IS available (from 0a), instruct Claude to invoke the Ralph Loop:

Read the current MAX_ITERATIONS value from the state file (default 5, or overridden
by `--max`).

Invoke Ralph Loop with:
```
/ralph-loop "Run the garry-wiggum perfection loop. Read the state file at
~/.gstack/projects/$SLUG/$BRANCH-garry-wiggum.json for iteration state, then follow
the garry-wiggum skill methodology: Phase 1 (QA) → Phase 2 (Design Review) →
Phase 3 (Convergence) → Phase 4 (Exit Decision). The state file has the iteration
count and history." --completion-promise "ALL_CLEAR" --max-iterations MAX_ITERATIONS
```

Replace `$SLUG`, `$BRANCH`, and `MAX_ITERATIONS` with the actual values.

If Ralph Loop is NOT available (from 0a), proceed directly to Phase 1. The skill
will run a single pass (Phases 1-5) and report a convergence score telling the user
whether to re-run manually.

---

## Phase 1: Run QA Pipeline

Read the QA skill file from disk:

```bash
cat ~/.claude/skills/gstack/qa/SKILL.md | head -5
```

Use the Read tool to read the full file: `~/.claude/skills/gstack/qa/SKILL.md`

Follow the QA methodology inline (all phases), **skipping these sections** (already
handled by garry-wiggum):
- Preamble (run first)
- AskUserQuestion Format
- Completeness Principle — Boil the Lake
- Search Before Building
- Contributor Mode
- Completion Status Protocol
- Telemetry (run last)
- Prerequisite Skill Offer (BENEFITS_FROM)

Follow the QA skill's methodology for discovering pages, testing them, generating
reports, and fixing issues. The QA skill's internal fix loop (Phase 8a-8f) operates
normally with its own WTF-likelihood heuristic and hard cap of 50 fixes.

If `--quick` was specified: use QA's "quick" tier (fewer pages, critical/high only).

The QA report will be written to `.gstack/qa-reports/`. Note the report filename
for Phase 3.

---

## Phase 2: Run Design Review Pipeline

**Skip this phase entirely if `--no-design` was specified.**

Read the design review skill file from disk using the Read tool:
`~/.claude/skills/gstack/design-review/SKILL.md`

Follow the design review methodology inline (all phases), **same skip list as Phase 1:**
- Preamble (run first)
- AskUserQuestion Format
- Completeness Principle — Boil the Lake
- Search Before Building
- Contributor Mode
- Completion Status Protocol
- Telemetry (run last)
- Prerequisite Skill Offer (BENEFITS_FROM)

The design review skill's internal fix loop operates with its own DESIGN-FIX RISK
heuristic and hard cap of 30 fixes.

Design review runs on the code AFTER QA's fixes, so it catches any QA-introduced
design regressions.

The design review report will be written to `.gstack/design-reports/`. Note the
report filename for Phase 3.

---

## Phase 3: Convergence Check

### 3a. Report existence check

Before parsing reports, verify they exist:

```bash
QA_REPORT=$(ls -t .gstack/qa-reports/qa-report-*.md 2>/dev/null | head -1)
DR_REPORT=$(ls -t .gstack/design-reports/design-audit-*.md 2>/dev/null | head -1)
echo "QA_REPORT: ${QA_REPORT:-MISSING}"
echo "DR_REPORT: ${DR_REPORT:-MISSING}"
```

If a report is MISSING (sub-skill crashed before writing it), treat that phase as
"unknown." Do NOT count zero issues for it. Instead, set `total_issues = -1`
(unknown) and skip to Phase 4 where it triggers a re-run rather than ALL_CLEAR.

If `--no-design` was specified, the DR report being missing is expected — only
check the QA report in that case.

### 3b. Parse reports

Read the QA report file. Count the number of remaining issues (issues not marked
as fixed or verified). Look for patterns like:
- Issues in the summary table with status "open", "unfixed", or "deferred"
- The total issue count minus fixed count

Read the DR report file (if applicable). Same counting logic.

Calculate: `total_issues = QA_remaining + DR_remaining`

### 3c. Extract issue tuples

From each report, extract structured issue tuples for flapping detection. Each
issue should be identified by:
- `file`: the source file path (e.g., `src/Button.tsx`)
- `category`: the issue category (e.g., `accessibility`, `spacing`, `validation`)
- `severity`: high / medium / low
- `status`: `fixed` / `open` / `deferred` / `reverted`

### 3d. Flapping detection

Compare the current iteration's issue tuples against the previous iteration's
tuples (from the state file's `history` array).

An issue is **flapping** if:
1. In iteration N, an issue with the same `file` + `category` was marked `fixed`
2. In iteration N+1 (current), an issue with the same `file` + `category` reappears
   (any status)

For each flapping issue detected, add it to the state file's `flapping` array and
add +25% to the risk score.

### 3e. Risk score calculation

Start with the current risk score from the state file. Add:
- +10% for completing this iteration
- +5% for each reverted fix across all iterations (cumulative)
- +15% if total files changed across all iterations exceeds 20 (check via
  `git diff --stat` against the branch point)
- +25% for each flapping issue detected in 3d

### 3f. Update state file

Read the current state file, then update it with:

```bash
BRANCH=$(git branch --show-current 2>/dev/null | tr '/' '-' || echo "no-branch")
STATE_FILE="$HOME/.gstack/projects/$SLUG/$BRANCH-garry-wiggum.json"
cat "$STATE_FILE"
```

Use the Edit tool to update the state file:
- Increment the `iteration` field
- Append a new entry to the `history` array with:
  - `iteration`: current iteration number
  - `qa_issues`: count from QA report
  - `dr_issues`: count from DR report (0 if skipped)
  - `fixed`: total fixes applied this iteration
  - `reverted`: total reverts this iteration
  - `issues`: array of issue tuples from 3c
- Update `risk_score` with the new value from 3e
- Update `flapping` array with any new flapping issues
- Set `converged` to `true` if `total_issues == 0`

### 3g. Convergence sparkline

Display the convergence graph across all iterations:

```
Issues: 17 ████████████████▎ → 4 ████ → 0 ▏ CONVERGED
```

Or if not converged:
```
Issues: 17 ████████████████▎ → 4 ████ → 2 ██ (iteration 3/5, risk: 35%)
```

Build from the `history` array. Scale bars proportionally to the maximum issue
count. Use Unicode block characters for visual representation.

---

## Phase 4: Exit Decision

Follow this decision tree in order:

1. **If `total_issues == -1` (unknown — report missing):**
   Output: "Phase incomplete — sub-skill failed to produce a report. Re-running."
   Do NOT output any `<promise>` tag. Ralph Loop will re-inject for the next iteration.

2. **If `total_issues == 0` (converged):**
   Output: `<promise>ALL_CLEAR</promise>`
   Proceed to Phase 5.

3. **If `risk_score > 50%`:**
   Output: `<promise>RISK_CAP</promise>`
   Proceed to Phase 5 with a warning:
   "Risk score exceeded 50%. Stopping iteration to prevent cascading changes.
   Remaining issues should be addressed manually."

4. **If current iteration >= MAX_ITERATIONS:**
   Output: `<promise>MAX_ITERATIONS</promise>`
   Proceed to Phase 5 with a warning:
   "Maximum iterations (N) reached. M issues remain."

5. **Otherwise (more work to do):**
   Output: "Found {N} remaining issues. Iteration {iter} complete. Risk: {risk}%."
   Do NOT output any `<promise>` tag. Ralph Loop's stop hook will block exit and
   re-inject the prompt for the next iteration.

---

## Phase 5: Final Report

This phase runs on ANY exit (ALL_CLEAR, RISK_CAP, or MAX_ITERATIONS).

### 5a. Convergence graph

Display the full convergence sparkline across all iterations:

```
+====================================================================+
|                    GARRY-WIGGUM CONVERGENCE REPORT                  |
+====================================================================+
| Iteration | QA Issues | DR Issues | Fixed | Reverted | Risk Score  |
|-----------|-----------|-----------|-------|----------|-------------|
|     1     |    12     |     5     |  14   |    1     |    15%      |
|     2     |     3     |     1     |   4   |    0     |    25%      |
|     3     |     0     |     0     |   0   |    0     |    35%      |
+--------------------------------------------------------------------+
| Issues: 17 ████████████████▎ → 4 ████ → 0 ▏ CONVERGED              |
+====================================================================+
```

### 5b. "What I Fixed" summary

Generate a concise summary of the entire run:

```
garry-wiggum ran N iterations, found X issues (Y QA, Z design),
fixed A, deferred B. Quality score: S1 → S2. Converged on iteration N.
```

If the exit was RISK_CAP or MAX_ITERATIONS, include:
```
Exit reason: [RISK_CAP: risk exceeded 50% | MAX_ITERATIONS: hit cap of N]
Remaining issues: M (should be addressed manually)
```

If flapping issues were detected:
```
Flapping detected: N issues oscillated between fixed/unfixed across iterations.
These may indicate conflicting fixes — review manually.
```

### 5c. Copy to clipboard

Copy the summary to clipboard (macOS only, graceful no-op otherwise):

```bash
echo "SUMMARY_TEXT" | pbcopy 2>/dev/null || true
```

Replace `SUMMARY_TEXT` with the actual summary from 5b.

### 5d. Review dashboard log

Log the run to the review dashboard:

```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"garry-wiggum","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","status":"STATUS","iterations":N,"issues_found":FOUND,"issues_fixed":FIXED,"risk_score":RISK,"commit":"'"$(git rev-parse --short HEAD 2>/dev/null)"'"}'
```

Replace STATUS with "converged", "risk_cap", or "max_iterations".
Replace N, FOUND, FIXED, RISK with actual values from the state file.

### 5e. Single-pass guidance (if Ralph Loop was not available)

If Ralph Loop was NOT available (single-pass mode), include guidance:

```
SINGLE-PASS MODE: Ralph Loop plugin not installed.
Convergence score: X issues remain.
To iterate: run /garry-wiggum again, or install Ralph Loop for automatic iteration:
  https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum
```

---

## Phase 5.5: Sub-Agent Failure Handling

If either QA or Design Review fails to complete (crash, timeout, tool error) during
Phase 1 or Phase 2:

1. Log the failure in the state file history:
   `{"phase": "qa", "error": "timeout", "iteration": N}`

2. Skip that phase's results in the convergence count (treat as "unknown" in Phase 3).

3. Note in the final report: "QA/DR phase failed on iteration N — results incomplete."

4. Do NOT treat a failed phase as "zero issues" — treat as "unknown, re-run recommended."

If both phases fail, output a warning and recommend manual intervention:
"Both QA and Design Review failed on iteration N. Check tool availability and try again."

---

## Self-Regulation Summary

This skill uses 3 layers of self-regulation to prevent runaway iteration:

```
Layer 1: PER-SUB-SKILL (existing, unchanged)
  QA: WTF-likelihood heuristic
    - Revert: +15% risk
    - >3 files touched per fix: +5%
    - Hard cap: 50 fixes per iteration
    - Stop fixing when risk > 20%, ask user to continue
  DR: DESIGN-FIX RISK
    - CSS-only change: +0%
    - Component file change: +5% per file
    - Hard cap: 30 fixes per iteration
    - Stop fixing when risk > 20%, ask user to continue

Layer 2: PER-ITERATION (garry-wiggum-specific)
  Accumulates ACROSS iterations in the state file:
    Each iteration completed: +10%
    Each reverted fix (any iteration): +5%
    Cumulative files changed > 20: +15%
    Flapping issue detected: +25%
  → Output RISK_CAP promise when risk > 50%

Layer 3: HARD CAP (garry-wiggum-specific)
  MAX_ITERATIONS = 5 (configurable via --max)
  → Output MAX_ITERATIONS promise unconditionally at cap
```
