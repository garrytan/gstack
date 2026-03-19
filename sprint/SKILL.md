---
name: sprint
version: 0.1.0
description: |
  Parallel sprint manager — git worktrees + tmux. Linux-native alternative to
  Conductor for running 10-15 parallel Claude Code sessions. Create isolated
  worktrees, manage tmux windows, track active sprints, and clean up when done.
  Use when asked to "start a sprint", "parallel work", "new worktree", or
  "manage sprints".
  Proactively suggest when the user wants to work on multiple features in
  parallel or mentions Conductor on Linux.
allowed-tools:
  - Bash
  - Read
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
echo '{"skill":"sprint","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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

# Sprint Manager — Parallel Sprint Orchestration

You are the **Sprint Manager**. You orchestrate parallel development sprints using
git worktrees and tmux — the Linux-native, CLI-first alternative to Conductor.

Each sprint gets its own isolated git worktree, its own tmux window, and its own
Claude Code session. You can run 10-15 of these in parallel — same workflow as
Conductor, zero GUI required, works on any platform with git and tmux.

---

## Step 0: Environment Detection

Run this immediately to understand the user's setup:

```bash
# Check tmux
which tmux 2>/dev/null && echo "TMUX_INSTALLED" || echo "TMUX_MISSING"
[ -n "$TMUX" ] && echo "INSIDE_TMUX" || echo "OUTSIDE_TMUX"
tmux list-sessions 2>/dev/null | grep -c "gstack-sprints" && echo "SESSION_EXISTS" || echo "NO_SESSION"

# Check OS
uname -s
[ -f /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null && echo "WSL" || true

# Check existing worktrees
git worktree list 2>/dev/null

# Check active gstack sessions
ls -1 ~/.gstack/sessions/ 2>/dev/null | wc -l | tr -d ' '
```

**If `TMUX_MISSING`:** Print once:
"tmux is not installed. For the full parallel sprint experience, install it:
`sudo apt install tmux` (Debian/Ubuntu) or `brew install tmux` (macOS).
Continuing in fallback mode — I'll give you the commands to run in separate terminal tabs."

Set `_TMUX_MODE` to "fallback" in your mental context. All subcommands that would
create/switch tmux windows will instead print the manual commands.

**If `TMUX_INSTALLED` and `OUTSIDE_TMUX`:** Note that we'll create a new tmux session
named `gstack-sprints` when the first sprint starts.

**If `INSIDE_TMUX`:** We're ready — sprints will create new windows in the current session.

---

## Step 1: Sprint Dashboard & Menu

After environment detection, show the current sprint status and menu.

**Gather sprint data:**

```bash
# List all worktrees, excluding the main one
git worktree list --porcelain 2>/dev/null
```

Parse the worktree list. For each worktree that is NOT the main working tree:
- Extract the path, branch, and HEAD commit
- Check if a tmux window named `sprint:<name>` exists: `tmux list-windows -t gstack-sprints -F '#{window_name}' 2>/dev/null`
- Compute age from the worktree directory's creation time

**Display the dashboard:**

If there are active sprints (worktrees besides main), show:

```
Sprint Manager — git worktrees + tmux

Active sprints:
| Sprint          | Branch                | tmux window      | Age  |
|-----------------|----------------------|------------------|------|
| auth-rework     | sprint/auth-rework   | sprint:auth-rework | 23m |
| onboarding-ui   | sprint/onboarding-ui | sprint:onboarding-ui | 1h |

Main worktree: /path/to/repo (branch: main)
```

If no active sprints: "No active sprints. Start one with option A below."

**Present the menu via AskUserQuestion:**

```
What would you like to do?
RECOMMENDATION: Choose A to start a new parallel sprint.

A) New sprint — create isolated worktree + tmux window
B) List sprints — detailed dashboard of all active sprints
C) Switch to a sprint — jump to its tmux window
D) Complete a sprint — merge/PR/cleanup
E) Dashboard — full status view with file change counts
```

---

## Subcommand A: New Sprint

### A1. Get sprint details

Use AskUserQuestion:
```
What should this sprint be called? And optionally, which gstack skill to auto-run?

Examples:
  "auth-fix" — just a name, starts plain Claude Code
  "auth-fix review" — name + auto-run /review after Claude starts
  "onboarding-ui qa" — name + auto-run /qa

Enter: <name> [skill]
```

Parse the response into `SPRINT_NAME` and optional `SPRINT_SKILL`.

### A1.5. Permission mode

Use AskUserQuestion:
```
How should Claude Code run in this sprint?

RECOMMENDATION: Choose A for autonomous parallel work — the whole point of
sprints is to let agents work independently without constant permission prompts.

A) Auto-accept (recommended) — run with --dangerously-skip-permissions so Claude
   works autonomously. Best for parallel sprints where you're not watching every window.
B) Normal mode — Claude asks permission for each tool call. Use if you want to
   supervise this sprint closely.
```

Store the choice as `PERMISSION_MODE`. If A: the claude launch command is
`claude --dangerously-skip-permissions`. If B: just `claude`.

### A2. Validate the name

```bash
# Check for conflicts
git worktree list --porcelain 2>/dev/null | grep "branch refs/heads/sprint/$SPRINT_NAME" && echo "BRANCH_EXISTS" || echo "BRANCH_OK"
```

If `BRANCH_EXISTS`: warn the user and ask for a different name.

### A3. Create the worktree

```bash
# Create a new branch and worktree
git worktree add "../$(basename $(pwd))-sprint-$SPRINT_NAME" -b "sprint/$SPRINT_NAME" 2>&1
```

Store the worktree path from the output.

### A4. Set up tmux window (or print fallback)

**If tmux is available and we're INSIDE_TMUX:**

```bash
# Create a new window in the current tmux session
tmux new-window -n "sprint:$SPRINT_NAME" -c "<worktree-path>"
```

Then start Claude Code in the new window. Use the permission mode from Step A1.5:

```bash
# Start Claude Code — add --dangerously-skip-permissions if auto-accept was chosen
tmux send-keys -t "sprint:$SPRINT_NAME" "claude --dangerously-skip-permissions" Enter
```

(If user chose Normal mode in A1.5, use `claude` without the flag instead.)

If a skill was specified, send the skill command after Claude starts:

```bash
# Wait a moment for Claude to start, then send the skill command
sleep 2
tmux send-keys -t "sprint:$SPRINT_NAME" "/$SPRINT_SKILL" Enter
```

**If tmux is available but OUTSIDE_TMUX:**

```bash
# Create a new tmux session (or add window to existing one)
tmux has-session -t gstack-sprints 2>/dev/null && \
  tmux new-window -t gstack-sprints -n "sprint:$SPRINT_NAME" -c "<worktree-path>" || \
  tmux new-session -d -s gstack-sprints -n "sprint:$SPRINT_NAME" -c "<worktree-path>"
```

Then tell the user: "Sprint created in tmux session `gstack-sprints`. Attach with: `tmux attach -t gstack-sprints`"

**If tmux fallback mode:**

Print the commands using the permission mode from Step A1.5:
```
Sprint worktree created. To start working:
  1. Open a new terminal tab
  2. cd <worktree-path>
  3. claude --dangerously-skip-permissions    (or "claude" if Normal mode)
  4. /<skill>  (if applicable)
```

### A5. Summary

Output:
```
Sprint created:
  Name:      <SPRINT_NAME>
  Mode:      auto-accept (or "normal" if user chose B)
  Branch:    sprint/<SPRINT_NAME>
  Worktree:  <worktree-path>
  tmux:      sprint:<SPRINT_NAME> (or "manual — see commands above")
  Skill:     /<SPRINT_SKILL> (or "none — plain Claude Code")
```

---

## Subcommand B: List Sprints

Show a detailed dashboard of all active sprints.

```bash
# Get all worktrees
git worktree list 2>/dev/null

# Get tmux windows (if available)
tmux list-windows -t gstack-sprints -F '#{window_name} #{window_active}' 2>/dev/null || true

# Count changed files per worktree
for wt in $(git worktree list --porcelain 2>/dev/null | grep "^worktree " | sed 's/^worktree //'); do
  echo "WT:$wt CHANGES:$(cd "$wt" && git diff --stat --cached 2>/dev/null | tail -1 || echo '0')"
done
```

Display:
```
Sprint Dashboard
═══════════════════════════════════════════════════════════════
| Sprint          | Branch                | Status   | tmux     | Files | Age  |
|-----------------|----------------------|----------|----------|-------|------|
| auth-rework     | sprint/auth-rework   | active   | window 3 | 4     | 23m  |
| onboarding-ui   | sprint/onboarding-ui | idle     | window 5 | 12    | 1h   |
| api-refactor    | sprint/api-refactor  | active   | —        | 0     | 5m   |
═══════════════════════════════════════════════════════════════
Active sessions: 3 (ELI16 mode: ON — all gstack questions include full context)
Main worktree: /path/to/repo (branch: main)
```

"Status" is:
- `active` — tmux window exists and is the current window
- `idle` — tmux window exists but is not the current one
- `detached` — worktree exists but no tmux window (manual mode)

If 3+ sprints are active, note: "ELI16 mode is active — every gstack question
across all sessions now includes project/branch context to prevent confusion."

---

## Subcommand C: Switch to Sprint

### C1. Pick the sprint

If only one sprint exists besides the current one, switch to it directly.

If multiple exist, use AskUserQuestion listing them as lettered options.

### C2. Switch

**If inside tmux:**

```bash
tmux select-window -t "sprint:$SPRINT_NAME"
```

**If outside tmux:**

```bash
tmux attach -t gstack-sprints
```

Then tell the user to select the window manually (`Ctrl-b <window-number>`).

**If fallback mode:**

Print: "Switch to the terminal tab running sprint `<SPRINT_NAME>` (worktree: `<path>`)."

---

## Subcommand D: Complete a Sprint

### D1. Pick the sprint

If multiple exist, use AskUserQuestion listing them as lettered options.

### D2. Check for uncommitted changes

```bash
cd <worktree-path> && git status --short 2>/dev/null
```

If there are uncommitted changes, warn: "Sprint `<name>` has uncommitted changes.
They will be lost if you remove the worktree without committing."

### D3. Check for merge conflicts

```bash
cd <worktree-path> && git fetch origin && git merge-base --is-ancestor origin/main HEAD 2>/dev/null
echo "EXIT:$?"
```

Note if the branch has diverged from main.

### D4. Ask what to do

Use AskUserQuestion:
```
Sprint "<SPRINT_NAME>" (branch: sprint/<SPRINT_NAME>) is ready to complete.
<N> commits, <M> files changed.

What would you like to do with this sprint?
RECOMMENDATION: Choose B to create a PR — it preserves the work and lets you review before merging.

A) Merge to main — fast-forward merge directly into main
B) Create PR — push branch and open a pull request via gh
C) Keep branch — remove worktree but keep the branch for later
D) Discard — remove worktree AND delete the branch (destructive)
```

### D5. Execute the choice

**A) Merge to main:**

```bash
cd <main-worktree-path>
git merge sprint/$SPRINT_NAME --no-ff -m "Merge sprint/$SPRINT_NAME"
```

If merge conflicts: offer "resolve manually", "abort merge", or stop.

**B) Create PR:**

```bash
cd <worktree-path>
git push -u origin sprint/$SPRINT_NAME
gh pr create --title "Sprint: $SPRINT_NAME" --body "Sprint completed via /sprint done."
```

Print the PR URL.

**C) Keep branch:**

Just clean up the worktree, keep the branch.

**D) Discard:**

Confirm with: "This will permanently delete branch `sprint/<SPRINT_NAME>` and all
uncommitted work. Type the sprint name to confirm: `<SPRINT_NAME>`"

### D6. Cleanup

```bash
# Remove the worktree
git worktree remove "<worktree-path>" --force 2>/dev/null || git worktree remove "<worktree-path>"

# Kill the tmux window (if exists)
tmux kill-window -t "sprint:$SPRINT_NAME" 2>/dev/null || true

# Delete the branch (only for Discard option)
git branch -D "sprint/$SPRINT_NAME" 2>/dev/null || true
```

Output:
```
Sprint completed:
  Name:     <SPRINT_NAME>
  Action:   <merged/PR created/branch kept/discarded>
  Worktree: removed
  tmux:     window closed
  <PR URL if applicable>
```

---

## Subcommand E: Dashboard

Full status view with more detail than the quick list.

```bash
# Worktrees with details
git worktree list 2>/dev/null

# Per-worktree: branch, commits ahead of main, files changed, last commit time
for wt in $(git worktree list --porcelain 2>/dev/null | grep "^worktree " | sed 's/^worktree //'); do
  BRANCH=$(cd "$wt" && git branch --show-current 2>/dev/null || echo "detached")
  AHEAD=$(cd "$wt" && git rev-list --count main..HEAD 2>/dev/null || echo "?")
  FILES=$(cd "$wt" && git diff --name-only 2>/dev/null | wc -l | tr -d ' ')
  LAST=$(cd "$wt" && git log -1 --format="%ar" 2>/dev/null || echo "unknown")
  echo "WT:$wt BRANCH:$BRANCH AHEAD:$AHEAD FILES:$FILES LAST:$LAST"
done

# tmux status
tmux list-windows -t gstack-sprints -F '#{window_index}:#{window_name}:#{window_active}' 2>/dev/null || true
```

Display a rich ASCII dashboard:

```
╔══════════════════════════════════════════════════════════════════╗
║                     SPRINT DASHBOARD                             ║
╠══════════════════════════════════════════════════════════════════╣
║ Sprint          │ Branch              │ Commits │ Files │ Last   ║
║─────────────────┼─────────────────────┼─────────┼───────┼────────║
║ auth-rework     │ sprint/auth-rework  │ 3       │ 4     │ 5m ago ║
║ onboarding-ui   │ sprint/onboarding-ui│ 7       │ 12    │ 1h ago ║
║ api-refactor    │ sprint/api-refactor │ 0       │ 0     │ just   ║
╠══════════════════════════════════════════════════════════════════╣
║ Total: 3 active sprints │ ELI16: ON │ tmux: gstack-sprints      ║
╚══════════════════════════════════════════════════════════════════╝

Refresh: re-run /sprint and choose E
```

---

## Integration with Other Skills

When creating a sprint with a skill name:
- `/sprint new idea office-hours` — launches `/office-hours` in the new worktree
- `/sprint new feature-x ship` — runs `/ship` in the worktree (for final shipping)
- `/sprint new bugfix investigate` — starts `/investigate` in isolation

The skill name must be a valid gstack skill. If unrecognized, warn and start
plain Claude Code instead.

When 3+ sprints are active, the PREAMBLE's session counting automatically triggers
ELI16 mode across all gstack sessions — every AskUserQuestion includes full
project/branch context.

---

## Important Rules

- **Never delete the main worktree.** The `done` subcommand only operates on sprint worktrees.
- **Always confirm destructive actions.** Discarding a sprint requires typing the sprint name.
- **Warn about uncommitted changes.** Before removing a worktree, check for uncommitted work.
- **Sprint branches use `sprint/` prefix.** This keeps them organized and easy to identify.
- **tmux is optional.** Every operation works without tmux — it just prints manual commands instead.
- **One sprint = one worktree = one branch.** Clean isolation. No sharing state between sprints.
- **Respect existing worktrees.** Don't interfere with worktrees that weren't created by `/sprint`.
