---
name: autoplan
version: 1.0.0
description: |
  Auto-review pipeline — reads the full CEO, design, and eng review skills from disk
  and runs them sequentially with auto-decisions using 6 decision principles. Surfaces
  taste decisions (close approaches, borderline scope, codex disagreements) at a final
  approval gate. One command, fully reviewed plan out.
  Use when asked to "auto review", "autoplan", "run all reviews", "review this plan
  automatically", or "make the decisions for me".
  Proactively suggest when the user has a plan file and wants to run the full review
  gauntlet without answering 15-30 intermediate questions.
benefits-from: [office-hours]
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - WebSearch
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
echo '{"skill":"autoplan","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
for _PF in ~/.gstack/analytics/.pending-*; do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
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

## Step 0: Detect base branch

Determine which branch this PR targets. Use the result as "the base branch" in all subsequent steps.

1. Check if a PR already exists for this branch:
   `gh pr view --json baseRefName -q .baseRefName`
   If this succeeds, use the printed branch name as the base branch.

2. If no PR exists (command fails), detect the repo's default branch:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`

3. If both commands fail, fall back to `main`.

Print the detected base branch name. In every subsequent `git diff`, `git log`,
`git fetch`, `git merge`, and `gh pr create` command, substitute the detected
branch name wherever the instructions say "the base branch."

---

## Prerequisite Skill Offer

When the design doc check above prints "No design doc found," offer the prerequisite
skill before proceeding.

Say to the user via AskUserQuestion:

> "No design doc found for this branch. `/office-hours` produces a structured problem
> statement, premise challenge, and explored alternatives — it gives this review much
> sharper input to work with. Takes about 10 minutes. The design doc is per-feature,
> not per-product — it captures the thinking behind this specific change."

Options:
- A) Run /office-hours now (we'll pick up the review right after)
- B) Skip — proceed with standard review

If they skip: "No worries — standard review. If you ever want sharper input, try
/office-hours first next time." Then proceed normally. Do not re-offer later in the session.

If they choose A:

Say: "Running /office-hours inline. Once the design doc is ready, I'll pick up
the review right where we left off."

Read the office-hours skill file from disk using the Read tool:
`~/.claude/skills/gstack/office-hours/SKILL.md`

Follow it inline, **skipping these sections** (already handled by the parent skill):
- Preamble (run first)
- AskUserQuestion Format
- Completeness Principle — Boil the Lake
- Search Before Building
- Contributor Mode
- Completion Status Protocol
- Telemetry (run last)

If the Read fails (file not found), say:
"Could not load /office-hours — proceeding with standard review."

After /office-hours completes, re-run the design doc check:
```bash
SLUG=$(~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' || echo 'no-branch')
DESIGN=$(ls -t ~/.gstack/projects/$SLUG/*-$BRANCH-design-*.md 2>/dev/null | head -1)
[ -z "$DESIGN" ] && DESIGN=$(ls -t ~/.gstack/projects/$SLUG/*-design-*.md 2>/dev/null | head -1)
[ -n "$DESIGN" ] && echo "Design doc found: $DESIGN" || echo "No design doc found"
```

If a design doc is now found, read it and continue the review.
If none was produced (user may have cancelled), proceed with standard review.

# /autoplan — Auto-Review Pipeline

One command. Rough plan in, fully reviewed plan out.

/autoplan reads the full CEO, design, and eng review skill files from disk and follows
them at full depth — same rigor, same sections, same methodology as running each skill
manually. The only difference: intermediate AskUserQuestion calls are auto-decided using
the 6 principles below. Taste decisions (where reasonable people could disagree) are
surfaced at a final approval gate.

---

## The 6 Decision Principles

These rules auto-answer every intermediate question:

1. **Choose completeness** — Ship the whole thing. Pick the approach that covers more edge cases.
2. **Boil lakes** — Fix everything in the blast radius (files modified by this plan + direct importers). Auto-approve expansions that are in blast radius AND < 1 day CC effort (< 5 files, no new infra).
3. **Pragmatic** — If two options fix the same thing, pick the cleaner one. 5 seconds choosing, not 5 minutes.
4. **DRY** — Duplicates existing functionality? Reject. Reuse what exists.
5. **Explicit over clever** — 10-line obvious fix > 200-line abstraction. Pick what a new contributor reads in 30 seconds.
6. **Bias toward action** — Merge > review cycles > stale deliberation. Flag concerns but don't block.

**Conflict resolution (context-dependent tiebreakers):**
- **CEO phase:** P1 (completeness) + P2 (boil lakes) dominate.
- **Eng phase:** P5 (explicit) + P3 (pragmatic) dominate.
- **Design phase:** P5 (explicit) + P1 (completeness) dominate.

---

## Decision Classification

Every auto-decision is classified:

**Mechanical** — one clearly right answer. Auto-decide silently.
Examples: run codex (always yes), run evals (always yes), reduce scope on a complete plan (always no).

**Taste** — reasonable people could disagree. Auto-decide with recommendation, but surface at the final gate. Three natural sources:
1. **Close approaches** — top two are both viable with different tradeoffs.
2. **Borderline scope** — in blast radius but 3-5 files, or ambiguous radius.
3. **Codex disagreements** — codex recommends differently and has a valid point.

---

## What "Auto-Decide" Means

Auto-decide replaces the USER'S judgment with the 6 principles. It does NOT replace
the ANALYSIS. Every section in the loaded skill files must still be executed at the
same depth as the interactive version. The only thing that changes is who answers the
AskUserQuestion: you do, using the 6 principles, instead of the user.

**You MUST still:**
- READ the actual code, diffs, and files each section references
- PRODUCE every output the section requires (diagrams, tables, registries, artifacts)
- IDENTIFY every issue the section is designed to catch
- DECIDE each issue using the 6 principles (instead of asking the user)
- LOG each decision in the audit trail
- WRITE all required artifacts to disk

**You MUST NOT:**
- Compress a review section into a one-liner table row
- Write "no issues found" without showing what you examined
- Skip a section because "it doesn't apply" without stating what you checked and why
- Produce a summary instead of the required output (e.g., "architecture looks good"
  instead of the ASCII dependency graph the section requires)

"No issues found" is a valid output for a section — but only after doing the analysis.
State what you examined and why nothing was flagged (1-2 sentences minimum).
"Skipped" is never valid for a non-skip-listed section.

---

## Phase 0: Intake + Restore Point

### Step 1: Capture restore point

Before doing anything, save the plan file's current state to an external file:

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')
DATETIME=$(date +%Y%m%d-%H%M%S)
echo "RESTORE_PATH=$HOME/.gstack/projects/$SLUG/${BRANCH}-autoplan-restore-${DATETIME}.md"
```

Write the plan file's full contents to the restore path with this header:
```
# /autoplan Restore Point
Captured: [timestamp] | Branch: [branch] | Commit: [short hash]

## Re-run Instructions
1. Copy "Original Plan State" below back to your plan file
2. Invoke /autoplan

## Original Plan State
[verbatim plan file contents]
```

Then prepend a one-line HTML comment to the plan file:
`<!-- /autoplan restore point: [RESTORE_PATH] -->`

### Step 2: Read context

- Read CLAUDE.md, TODOS.md, git log -30, git diff against the base branch --stat
- Discover design docs: `ls -t ~/.gstack/projects/$SLUG/*-design-*.md 2>/dev/null | head -1`
- Detect UI scope: grep the plan for view/rendering terms (component, screen, form,
  button, modal, layout, dashboard, sidebar, nav, dialog). Require 2+ matches. Exclude
  false positives ("page" alone, "UI" in acronyms).

### Step 3: Load skill files from disk

Read each file using the Read tool:
- `~/.claude/skills/gstack/plan-ceo-review/SKILL.md`
- `~/.claude/skills/gstack/plan-design-review/SKILL.md` (only if UI scope detected)
- `~/.claude/skills/gstack/plan-eng-review/SKILL.md`

**Section skip list — when following a loaded skill file, SKIP these sections
(they are already handled by /autoplan):**
- Preamble (run first)
- AskUserQuestion Format
- Completeness Principle — Boil the Lake
- Search Before Building
- Contributor Mode
- Completion Status Protocol
- Telemetry (run last)
- Step 0: Detect base branch
- Review Readiness Dashboard
- Plan File Review Report
- Prerequisite Skill Offer (BENEFITS_FROM)

Follow ONLY the review-specific methodology, sections, and required outputs.

Output: "Here's what I'm working with: [plan summary]. UI scope: [yes/no].
Loaded review skills from disk. Starting full review pipeline with auto-decisions."

---

## Phase 1: CEO Review (Strategy & Scope)

Follow plan-ceo-review/SKILL.md — all sections, full depth.
Override: every AskUserQuestion → auto-decide using the 6 principles.

**Override rules:**
- Mode selection: SELECTIVE EXPANSION
- Premises: accept reasonable ones (P6), challenge only clearly wrong ones
- **GATE: Present premises to user for confirmation** — this is the ONE AskUserQuestion
  that is NOT auto-decided. Premises require human judgment.
- Alternatives: pick highest completeness (P1). If tied, pick simplest (P5).
  If top 2 are close → mark TASTE DECISION.
- Scope expansion: in blast radius + <1d CC → approve (P2). Outside → defer to TODOS.md (P3).
  Duplicates → reject (P4). Borderline (3-5 files) → mark TASTE DECISION.
- All 10 review sections: run fully, auto-decide each issue, log every decision.

**Required execution checklist (CEO):**

Step 0 (0A-0F) — run each sub-step and produce:
- 0A: Premise challenge with specific premises named and evaluated
- 0B: Existing code leverage map (sub-problems → existing code)
- 0C: Dream state diagram (CURRENT → THIS PLAN → 12-MONTH IDEAL)
- 0C-bis: Implementation alternatives table (2-3 approaches with effort/risk/pros/cons)
- 0D: Mode-specific analysis with scope decisions logged
- 0E: Temporal interrogation (HOUR 1 → HOUR 6+)
- 0F: Mode selection confirmation

Sections 1-10 — for EACH section, run the evaluation criteria from the loaded skill file:
- Sections WITH findings: full analysis, auto-decide each issue, log to audit trail
- Sections with NO findings: 1-2 sentences stating what was examined and why nothing
  was flagged. NEVER compress a section to just its name in a table row.
- Section 11 (Design): run only if UI scope was detected in Phase 0

**Mandatory outputs from Phase 1:**
- "NOT in scope" section with deferred items and rationale
- "What already exists" section mapping sub-problems to existing code
- Error & Rescue Registry table (from Section 2)
- Failure Modes Registry table (from review sections)
- Dream state delta (where this plan leaves us vs 12-month ideal)
- Completion Summary (the full summary table from the CEO skill)

---

## Phase 2: Design Review (conditional — skip if no UI scope)

Follow plan-design-review/SKILL.md — all 7 dimensions, full depth.
Override: every AskUserQuestion → auto-decide using the 6 principles.

**Override rules:**
- Focus areas: all relevant dimensions (P1)
- Structural issues (missing states, broken hierarchy): auto-fix (P5)
- Aesthetic/taste issues: mark TASTE DECISION
- Design system alignment: auto-fix if DESIGN.md exists and fix is obvious

---

## Phase 3: Eng Review + Codex

Follow plan-eng-review/SKILL.md — all sections, full depth.
Override: every AskUserQuestion → auto-decide using the 6 principles.

**Override rules:**
- Scope challenge: never reduce (P2)
- Codex review: always run if available (P6)
  Command: `codex exec "Review this plan for architectural issues, missing edge cases, and hidden complexity. Be adversarial. File: <plan_path>" -s read-only --enable web_search_cached`
  Timeout: 10 minutes, then proceed with "Codex timed out — single-reviewer mode"
- Architecture choices: explicit over clever (P5). If codex disagrees with valid reason → TASTE DECISION.
- Evals: always include all relevant suites (P1)
- Test plan: generate artifact at `~/.gstack/projects/$SLUG/{user}-{branch}-test-plan-{datetime}.md`
- TODOS.md: collect all deferred scope expansions from Phase 1, auto-write

**Required execution checklist (Eng):**

1. Step 0 (Scope Challenge): Read actual code referenced by the plan. Map each
   sub-problem to existing code. Run the complexity check. Produce concrete findings.

2. Step 0.5 (Codex): Run if available. Present full output under CODEX SAYS header.

3. Section 1 (Architecture): Produce ASCII dependency graph showing new components
   and their relationships to existing ones. Evaluate coupling, scaling, security.

4. Section 2 (Code Quality): Identify DRY violations, naming issues, complexity.
   Reference specific files and patterns. Auto-decide each finding.

5. **Section 3 (Test Review) — NEVER SKIP OR COMPRESS.**
   This section requires reading actual code, not summarizing from memory.
   - Read the diff or the plan's affected files
   - Build the test diagram: list every NEW UX flow, data flow, codepath, and branch
   - For EACH item in the diagram: what type of test covers it? Does one exist? Gaps?
   - For LLM/prompt changes: which eval suites must run?
   - Auto-deciding test gaps means: identify the gap → decide whether to add a test
     or defer (with rationale and principle) → log the decision. It does NOT mean
     skipping the analysis.
   - Write the test plan artifact to disk

6. Section 4 (Performance): Evaluate N+1 queries, memory, caching, slow paths.

**Mandatory outputs from Phase 3:**
- "NOT in scope" section
- "What already exists" section
- Architecture ASCII diagram (Section 1)
- Test diagram mapping codepaths to coverage (Section 3)
- Test plan artifact written to disk (Section 3)
- Failure modes registry with critical gap flags
- Completion Summary (the full summary from the Eng skill)
- TODOS.md updates (collected from all phases)

---

## Decision Audit Trail

After each auto-decision, append a row to the plan file using Edit:

```markdown
<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|
```

Write one row per decision incrementally (via Edit). This keeps the audit on disk,
not accumulated in conversation context.

---

## Pre-Gate Verification

Before presenting the Final Approval Gate, verify that required outputs were actually
produced. Check the plan file and conversation for each item.

**Phase 1 (CEO) outputs:**
- [ ] Premise challenge with specific premises named (not just "premises accepted")
- [ ] All applicable review sections have findings OR explicit "examined X, nothing flagged"
- [ ] Error & Rescue Registry table produced (or noted N/A with reason)
- [ ] Failure Modes Registry table produced (or noted N/A with reason)
- [ ] "NOT in scope" section written
- [ ] "What already exists" section written
- [ ] Dream state delta written
- [ ] Completion Summary produced

**Phase 2 (Design) outputs — only if UI scope detected:**
- [ ] All 7 dimensions evaluated with scores
- [ ] Issues identified and auto-decided

**Phase 3 (Eng) outputs:**
- [ ] Scope challenge with actual code analysis (not just "scope is fine")
- [ ] Architecture ASCII diagram produced
- [ ] Test diagram mapping codepaths to test coverage
- [ ] Test plan artifact written to disk at ~/.gstack/projects/$SLUG/
- [ ] "NOT in scope" section written
- [ ] "What already exists" section written
- [ ] Failure modes registry with critical gap assessment
- [ ] Completion Summary produced

**Audit trail:**
- [ ] Decision Audit Trail has at least one row per auto-decision (not empty)

If ANY checkbox above is missing, go back and produce the missing output. Max 2
attempts — if still missing after retrying twice, proceed to the gate with a warning
noting which items are incomplete. Do not loop indefinitely.

---

## Phase 4: Final Approval Gate

**STOP here and present the final state to the user.**

Present as a message, then use AskUserQuestion:

```
## /autoplan Review Complete

### Plan Summary
[1-3 sentence summary]

### Decisions Made: [N] total ([M] auto-decided, [K] choices for you)

### Your Choices (taste decisions)
[For each taste decision:]
**Choice [N]: [title]** (from [phase])
I recommend [X] — [principle]. But [Y] is also viable:
  [1-sentence downstream impact if you pick Y]

### Auto-Decided: [M] decisions [see Decision Audit Trail in plan file]

### Review Scores
- CEO: [summary]
- Design: [summary or "skipped, no UI scope"]
- Eng: [summary]
- Codex: [summary or "unavailable"]

### Deferred to TODOS.md
[Items auto-deferred with reasons]
```

**Cognitive load management:**
- 0 taste decisions: skip "Your Choices" section
- 1-7 taste decisions: flat list
- 8+: group by phase. Add warning: "This plan had unusually high ambiguity ([N] taste decisions). Review carefully."

AskUserQuestion options:
- A) Approve as-is (accept all recommendations)
- B) Approve with overrides (specify which taste decisions to change)
- C) Interrogate (ask about any specific decision)
- D) Revise (the plan itself needs changes)
- E) Reject (start over)

**Option handling:**
- A: mark APPROVED, write review logs, suggest /ship
- B: ask which overrides, apply, re-present gate
- C: answer freeform, re-present gate
- D: make changes, re-run affected phases (scope→1B, design→2, test plan→3, arch→3). Max 3 cycles.
- E: start over

---

## Completion: Write Review Logs

On approval, write 3 separate review log entries so /ship's dashboard recognizes them:

```bash
COMMIT=$(git rev-parse --short HEAD 2>/dev/null)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"plan-ceo-review","timestamp":"'"$TIMESTAMP"'","status":"clean","unresolved":0,"critical_gaps":0,"mode":"SELECTIVE_EXPANSION","via":"autoplan","commit":"'"$COMMIT"'"}'

~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"plan-eng-review","timestamp":"'"$TIMESTAMP"'","status":"clean","unresolved":0,"critical_gaps":0,"issues_found":0,"mode":"FULL_REVIEW","via":"autoplan","commit":"'"$COMMIT"'"}'
```

If Phase 2 ran (UI scope):
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"plan-design-review","timestamp":"'"$TIMESTAMP"'","status":"clean","unresolved":0,"via":"autoplan","commit":"'"$COMMIT"'"}'
```

Replace field values with actual counts from the review.

Suggest next step: `/ship` when ready to create the PR.

---

## Important Rules

- **Never abort.** The user chose /autoplan. Respect that choice. Surface all taste decisions, never redirect to interactive review.
- **Premises are the one gate.** The only non-auto-decided AskUserQuestion is the premise confirmation in Phase 1.
- **Log every decision.** No silent auto-decisions. Every choice gets a row in the audit trail.
- **Full depth means full depth.** Do not compress or skip sections from the loaded skill files (except the skip list in Phase 0). "Full depth" means: read the code the section asks you to read, produce the outputs the section requires, identify every issue, and decide each one. A one-sentence summary of a section is not "full depth" — it is a skip. If you catch yourself writing fewer than 3 sentences for any review section, you are likely compressing.
- **Artifacts are deliverables.** Test plan artifact, failure modes registry, error/rescue table, ASCII diagrams — these must exist on disk or in the plan file when the review completes. If they don't exist, the review is incomplete.
- **Sequential order.** CEO → Design → Eng. Each phase builds on the last.
