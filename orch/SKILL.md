---
name: orch
version: 1.0.0
description: |
  Multi-agent orchestration via orch. Bridges gstack planning workflows into
  parallel Claude Code agent execution. Detects plans, generates role specs,
  spins up agents. Use when asked to "spin up agents", "run orch", "execute
  this plan", "start building", or when a task is too large for one session.
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
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
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
```

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

# Orch: Multi-Agent Orchestration

You are running the `/orch` skill. This bridges gstack planning into orch execution.

## What is orch?

Orch runs multiple Claude Code instances in parallel via tmux. Each agent has its
own context window, runs autonomously, and can communicate with other agents via
file-based messaging. Agents persist even if you close your terminal.

Use orch when:
- The task will take 1+ hours of autonomous work
- There's parallel work (backend + frontend, multiple subsystems)
- You want a persistent reviewer watching the engineer's output
- You want to walk away and check back later

Don't use orch when:
- The task fits in one session (< 30 min)
- You want tight interactive control
- The work is purely serial

## Step 0: Detect orch

```bash
PATH="$HOME/go/bin:$PATH" which orch 2>/dev/null && echo "ORCH_FOUND" || echo "ORCH_NOT_FOUND"
```

If `ORCH_NOT_FOUND`:
Tell the user:
"orch is not installed. Install it from: https://github.com/jeffdhooton/orch
Then run: `go install github.com/jeffdhooton/orch/cmd/orch@latest`"
**STOP.** Do not continue.

## Step 1: Check context

Run these checks to understand the current state:

```bash
# Check for recent gstack review artifacts
eval $(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' || echo 'no-branch')
echo "SLUG: $SLUG"
echo "BRANCH: $BRANCH"

# Recent review artifacts
REVIEW_LOG=$(ls -t ~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl 2>/dev/null | head -1)
[ -n "$REVIEW_LOG" ] && echo "REVIEW_LOG: $REVIEW_LOG" && tail -1 "$REVIEW_LOG" || echo "NO_REVIEW_LOG"

# Recent test plan from /plan-eng-review
TEST_PLAN=$(ls -t ~/.gstack/projects/$SLUG/*-$BRANCH-test-plan-*.md 2>/dev/null | head -1)
[ -n "$TEST_PLAN" ] && echo "TEST_PLAN: $TEST_PLAN" || echo "NO_TEST_PLAN"

# Recent CEO plan
CEO_PLAN=$(ls -t ~/.gstack/projects/$SLUG/ceo-plans/*.md 2>/dev/null | head -1)
[ -n "$CEO_PLAN" ] && echo "CEO_PLAN: $CEO_PLAN" || echo "NO_CEO_PLAN"

# Check for plan documents in the repo
echo "---REPO_PLANS---"
ls specs/*/SPEC.md specs/*/*.md 2>/dev/null | head -10
ls *.md 2>/dev/null | grep -i -E 'plan|spec' | head -5

# Check if orch agents are already running
echo "---ORCH_STATUS---"
PATH="$HOME/go/bin:$PATH" orch ps 2>/dev/null || echo "NO_AGENTS"
```

## Step 2: Decide path

Based on the context detected in Step 1, follow the appropriate branch:

### If agents are already running
Show the orch ps output. Then AskUserQuestion:

"Orch agents are already running. What would you like to do?

A) Attach to an agent — jump into its tmux session
B) Send a message to an agent
C) Tear down all agents — stop everything
D) Show logs — see what agents have been doing"

Handle the user's choice:
- A: Ask which agent, then run `PATH="$HOME/go/bin:$PATH" orch attach <name>`
- B: Ask which agent and what message, then run `PATH="$HOME/go/bin:$PATH" orch send <name> "<message>"`
- C: Run `PATH="$HOME/go/bin:$PATH" orch down --all`
- D: Run `PATH="$HOME/go/bin:$PATH" orch logs`

### If a recent gstack review exists (REVIEW_LOG found)
Read the review log to check status. Then AskUserQuestion:

"Found reviewed plan from /plan-eng-review. Ready to execute.

RECOMMENDATION: Choose A — the plan has been reviewed, generate specs and spin up agents.

A) Generate specs from this plan and spin up agents
B) I want to review the plan first (show it)
C) I'll handle it manually"

- A: Proceed to Step 3
- B: Read and display the plan, then re-offer A or C
- C: Stop

### If plan documents exist but no review
Show the plans found. Then AskUserQuestion:

"Found plan document(s) but no review on record.

RECOMMENDATION: Choose B — running /plan-eng-review first catches issues before agents burn context on a flawed plan. (human: ~30min / CC+gstack: ~5min)

A) Generate specs from [plan] and spin up agents anyway
B) Run /plan-eng-review first (recommended)
C) Skip review, just execute"

- A: Proceed to Step 3 with the plan path
- B: Tell user to run `/plan-eng-review` and come back
- C: Proceed to Step 3

### If nothing exists
AskUserQuestion:

"No existing plans or review artifacts found. What do you want to build?

Tell me the task, and I'll help you decide the best path.

A) Write a plan first, then execute (recommended for large tasks — 2+ hours of work)
B) Generate specs directly from a task description
C) This is small enough to do right here without orch"

- A: Tell user to write a plan or run `/plan-eng-review` or `/plan-ceo-review`
- B: Ask for the task description, proceed to Step 3 with `--task`
- C: Stop — tell user to proceed normally in their current session

## Step 3: Generate and launch

### Determine the specgen command

If a plan document path is available (from review artifacts or repo):
```bash
PATH="$HOME/go/bin:$PATH" orch specgen --from-plan <plan-path> --skills gstack --dir <project-dir>
```

If only a task description:
```bash
PATH="$HOME/go/bin:$PATH" orch specgen --task "<task description>" --skills gstack --dir <project-dir>
```

Where `<project-dir>` is the current working directory (from `pwd`).

### Show generated specs

After specgen completes, briefly summarize what was generated:
```bash
ls -la <output-dir>/*.md
```

Read each generated spec file and give a 1-2 line summary of what each agent will do.

### Confirm launch

AskUserQuestion:

"Specs generated. Ready to spin up agents?

A) Launch agents now
B) Let me review the specs first (I'll show you the files)
C) Cancel — I'll launch manually later"

- A: Proceed to launch
- B: Read and display each spec, then re-offer A or C
- C: Stop with instructions for manual launch

### Launch agents

```bash
PATH="$HOME/go/bin:$PATH" orch up-dir <spec-dir> --skills gstack --dir <project-dir>
```

### Show status

```bash
PATH="$HOME/go/bin:$PATH" orch ps
```

Display the result in a formatted table:

```
+================================================+
|              AGENTS RUNNING                     |
+================================================+
| Agent     | Role      | Status   | Spec         |
|-----------|-----------|----------|--------------|
| engineer  | builder   | running  | engineer.md  |
| reviewer  | reviewer  | running  | reviewer.md  |
+------------------------------------------------+

Commands:
  orch ps              — check status
  orch logs engineer   — see what engineer is doing
  orch attach engineer — jump into the session
  orch send engineer "focus on the API first"
  orch down --all      — stop everything
+================================================+
```

Tell the user: "Agents are running. You can close this terminal. Check back with `orch ps` or run `/orch` again to manage them."
