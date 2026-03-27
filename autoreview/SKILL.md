---
name: autoreview
preamble-tier: 3
version: 1.0.0
description: |
  Auto-review pipeline for code — reads the full /review, /qa, and /design-review skills
  from disk and runs them sequentially with auto-decisions using 6 decision principles.
  Surfaces taste decisions (ambiguous fixes, borderline triage, cross-phase conflicts) at a
  final approval gate. One command, fully reviewed code out.
  Use when asked to "auto review code", "autoreview", "run all code reviews",
  "review + qa + design", or "full review pipeline".
  Proactively suggest when the user has code on a feature branch and wants the full
  post-build review gauntlet without answering intermediate questions.
benefits-from: [office-hours]
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
_PROACTIVE_PROMPTED=$([ -f ~/.gstack/.proactive-prompted ] && echo "yes" || echo "no")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
echo "PROACTIVE: $_PROACTIVE"
echo "PROACTIVE_PROMPTED: $_PROACTIVE_PROMPTED"
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
echo '{"skill":"autoreview","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills AND do not
auto-invoke skills based on conversation context. Only run skills the user explicitly
types (e.g., /qa, /ship). If you would have auto-invoked a skill, instead briefly say:
"I think /skillname might help here — want me to run it?" and wait for confirmation.
The user opted out of proactive behavior.

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

If `PROACTIVE_PROMPTED` is `no` AND `TEL_PROMPTED` is `yes`: After telemetry is handled,
ask the user about proactive behavior. Use AskUserQuestion:

> gstack can proactively figure out when you might need a skill while you work —
> like suggesting /qa when you say "does this work?" or /investigate when you hit
> a bug. We recommend keeping this on — it speeds up every part of your workflow.

Options:
- A) Keep it on (recommended)
- B) Turn it off — I'll type /commands myself

If A: run `~/.claude/skills/gstack/bin/gstack-config set proactive true`
If B: run `~/.claude/skills/gstack/bin/gstack-config set proactive false`

Always run:
```bash
touch ~/.gstack/.proactive-prompted
```

This only happens once. If `PROACTIVE_PROMPTED` is `yes`, skip this entirely.

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch (use the `_BRANCH` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]` — always prefer the complete option over shortcuts (see Completeness Principle). Include `Completeness: X/10` for each option. Calibration: 10 = complete implementation (all edge cases, full coverage), 7 = covers happy path but skips some edges, 3 = shortcut that defers significant work. If both options are 8+, pick the higher; if one is ≤5, flag it.
4. **Options:** Lettered options: `A) ... B) ... C) ...` — when an option involves effort, show both scales: `(human: ~X / CC: ~Y)`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

## Completeness Principle — Boil the Lake

AI makes completeness near-free. Always recommend the complete option over shortcuts — the delta is minutes with CC+gstack. A "lake" (100% coverage, all edge cases) is boilable; an "ocean" (full rewrite, multi-quarter migration) is not. Boil lakes, flag oceans.

**Effort reference** — always show both scales:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate | 2 days | 15 min | ~100x |
| Tests | 1 day | 15 min | ~50x |
| Feature | 1 week | 30 min | ~30x |
| Bug fix | 4 hours | 15 min | ~20x |

Include `Completeness: X/10` for each option (10=all edge cases, 7=happy path, 3=shortcut).

## Repo Ownership — See Something, Say Something

`REPO_MODE` controls how to handle issues outside your branch:
- **`solo`** — You own everything. Investigate and offer to fix proactively.
- **`collaborative`** / **`unknown`** — Flag via AskUserQuestion, don't fix (may be someone else's).

Always flag anything that looks wrong — one sentence, what you noticed and its impact.

## Search Before Building

Before building anything unfamiliar, **search first.** See `~/.claude/skills/gstack/ETHOS.md`.
- **Layer 1** (tried and true) — don't reinvent. **Layer 2** (new and popular) — scrutinize. **Layer 3** (first principles) — prize above all.

**Eureka:** When first-principles reasoning contradicts conventional wisdom, name it and log:
```bash
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$(git branch --show-current 2>/dev/null)" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> ~/.gstack/analytics/eureka.jsonl 2>/dev/null || true
```

## Contributor Mode

If `_CONTRIB` is `true`: you are in **contributor mode**. At the end of each major workflow step, rate your gstack experience 0-10. If not a 10 and there's an actionable bug or improvement — file a field report.

**File only:** gstack tooling bugs where the input was reasonable but gstack failed. **Skip:** user app bugs, network errors, auth failures on user's site.

**To file:** write `~/.gstack/contributor-logs/{slug}.md`:
```
# {Title}
**What I tried:** {action} | **What happened:** {result} | **Rating:** {0-10}
## Repro
1. {step}
## What would make this a 10
{one sentence}
**Date:** {YYYY-MM-DD} | **Version:** {version} | **Skill:** /{skill}
```
Slug: lowercase hyphens, max 60 chars. Skip if exists. Max 3/session. File inline, don't stop.

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

## Step 0: Detect platform and base branch

First, detect the git hosting platform from the remote URL:

```bash
git remote get-url origin 2>/dev/null
```

- If the URL contains "github.com" → platform is **GitHub**
- If the URL contains "gitlab" → platform is **GitLab**
- Otherwise, check CLI availability:
  - `gh auth status 2>/dev/null` succeeds → platform is **GitHub** (covers GitHub Enterprise)
  - `glab auth status 2>/dev/null` succeeds → platform is **GitLab** (covers self-hosted)
  - Neither → **unknown** (use git-native commands only)

Determine which branch this PR/MR targets, or the repo's default branch if no
PR/MR exists. Use the result as "the base branch" in all subsequent steps.

**If GitHub:**
1. `gh pr view --json baseRefName -q .baseRefName` — if succeeds, use it
2. `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` — if succeeds, use it

**If GitLab:**
1. `glab mr view -F json 2>/dev/null` and extract the `target_branch` field — if succeeds, use it
2. `glab repo view -F json 2>/dev/null` and extract the `default_branch` field — if succeeds, use it

**Git-native fallback (if unknown platform, or CLI commands fail):**
1. `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'`
2. If that fails: `git rev-parse --verify origin/main 2>/dev/null` → use `main`
3. If that fails: `git rev-parse --verify origin/master 2>/dev/null` → use `master`

If all fail, fall back to `main`.

Print the detected base branch name. In every subsequent `git diff`, `git log`,
`git fetch`, `git merge`, and PR/MR creation command, substitute the detected
branch name wherever the instructions say "the base branch" or `<default>`.

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

# /autoreview — Auto-Review Pipeline for Code

One command. Code on a branch in, fully reviewed code out.

/autoreview reads the full /review, /qa, and /design-review skill files from disk and
follows them at full depth — same rigor, same sections, same methodology as running each
skill manually. The only difference: intermediate AskUserQuestion calls are auto-decided
using the 6 principles below. Taste decisions (where reasonable people could disagree) are
surfaced at a final approval gate.

---

## The 6 Decision Principles

These rules auto-answer every intermediate question:

1. **Choose completeness** — Fix the whole thing. Pick the approach that covers more edge cases.
2. **Boil lakes** — Fix everything in the blast radius (files modified by this branch + direct importers). Auto-approve fixes that are in blast radius AND < 30 min CC effort (< 5 files, no new infra).
3. **Pragmatic** — If two fixes solve the same issue, pick the simpler one. 5 seconds choosing, not 5 minutes.
4. **DRY** — Duplicates existing functionality? Reject the fix. Reuse what exists.
5. **Explicit over clever** — 10-line obvious fix > 200-line abstraction. Pick what a new contributor reads in 30 seconds.
6. **Bias toward action** — Fix > defer > deliberate. Flag concerns but don't block.

**Conflict resolution (context-dependent tiebreakers):**
- **Review phase:** P5 (explicit) + P3 (pragmatic) dominate. Code review is about safety and clarity.
- **QA phase:** P1 (completeness) + P6 (action) dominate. Fix real bugs, don't over-deliberate severity.
- **Design phase:** P5 (explicit) + P1 (completeness) dominate. Visual fixes should be complete and obvious.

---

## Decision Classification

Every auto-decision is classified:

**Mechanical** — one clearly right answer. Auto-decide silently.
Examples: /review AUTO-FIX items (dead code, N+1 queries, stale comments), QA tier
selection (always Standard), clean working tree (always commit), CSS-only design fixes
(always apply), URL detection (try common ports automatically).

**Taste** — reasonable people could disagree. Auto-decide with recommendation, but surface
at the final gate. Three natural sources:
1. **Ambiguous fixes** — /review ASK items where the fix approach is debatable (security
   fixes, race condition remediation, large refactors > 20 lines).
2. **Borderline triage** — /qa issues where severity is between two tiers, or /design-review
   findings where impact is debatable.
3. **Cross-phase conflicts** — an issue found in /review that /qa live testing shows works
   fine, or a design fix that breaks functionality.

---

## Sequential Execution — MANDATORY

Phases MUST execute in strict order: Review → QA → Design Review.
Each phase MUST complete fully before the next begins.
NEVER run phases in parallel — QA and Design build on review fixes.

Review is analysis-then-commit. QA and Design both make atomic commits per fix.

---

## What "Auto-Decide" Means

Auto-decide replaces the USER'S judgment with the 6 principles. It does NOT replace
the ANALYSIS. Every section in the loaded skill files must still be executed at the
same depth as the interactive version. The only thing that changes is who answers the
AskUserQuestion: you do, using the 6 principles, instead of the user.

**You MUST still:**
- READ the actual code, diffs, and files each section references
- PRODUCE every output the section requires (findings, scores, reports, screenshots)
- IDENTIFY every issue the section is designed to catch
- DECIDE each issue using the 6 principles (instead of asking the user)
- LOG each decision in the audit trail
- WRITE all required artifacts to disk

**You MUST NOT:**
- Skip a review pass because "it doesn't apply" without stating what you checked
- Write "no issues found" without showing what you examined
- Produce a summary instead of the required output
- Skip the fix loop in QA or Design Review

---

## Phase 0: Intake + Preflight

### Step 1: Capture restore point

Before doing anything, save the current git state:

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')
DATETIME=$(date +%Y%m%d-%H%M%S)
RESTORE_COMMIT=$(git rev-parse --short HEAD 2>/dev/null)
echo "RESTORE_COMMIT=$RESTORE_COMMIT"
echo "AUDIT_PATH=$HOME/.gstack/projects/$SLUG/${BRANCH}-autoreview-audit-${DATETIME}.md"
```

Write restore instructions:
```bash
mkdir -p "$HOME/.gstack/projects/$SLUG"
```

Create the audit trail file with header:
```markdown
# /autoreview Audit Trail
Branch: [branch] | Restore commit: [hash] | Started: [timestamp]

## Decision Log

| # | Phase | Decision | Principle | Rationale | Classification |
|---|-------|----------|-----------|-----------|----------------|
```

### Step 2: Read context

- Read CLAUDE.md, TODOS.md, git log -30, git diff against base branch --stat
- Detect frontend scope: check if the diff includes frontend file extensions
  (.tsx, .jsx, .vue, .svelte, .css, .scss, .html, component files)

### Step 3: Detect target URL

Done ONCE, shared by QA and Design Review phases.

1. If the user specified a URL, use it.
2. Otherwise, try common local dev ports:
   ```bash
   for PORT in 3000 4000 5173 8080 8000; do
     if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT" 2>/dev/null | grep -qE "^[23]"; then
       echo "APP_URL=http://localhost:$PORT"
       break
     fi
   done
   ```
3. If no app found: Phases 2-3 will be skipped. Phase 1 (code review) always runs.
   Emit: "No running app detected — Phase 1 (code review) will run. Phases 2-3 (QA,
   design review) require a running app and will be skipped."

### Step 4: Ensure clean working tree

Auto-decide using P6 (bias toward action):

```bash
if [ -n "$(git status --porcelain)" ]; then
  git add -A && git commit -m "wip: save state before /autoreview"
fi
```

Log as Mechanical decision in audit trail.

### Step 5: Load skill files from disk

Read each file using the Read tool:
- `~/.claude/skills/gstack/review/SKILL.md`
- `~/.claude/skills/gstack/qa/SKILL.md` (only if APP_URL detected)
- `~/.claude/skills/gstack/design-review/SKILL.md` (only if APP_URL detected AND frontend scope)

**Section skip list — when following a loaded skill file, SKIP these sections
(already handled by /autoreview):**
- Preamble / preamble bash blocks
- AskUserQuestion Format
- Completeness Principle — Boil the Lake
- Search Before Building
- Contributor Mode
- Completion Status Protocol
- Telemetry (run last)
- Step 0: Detect base branch (already done)
- Review Readiness Dashboard
- Prerequisite Skill Offer (BENEFITS_FROM)
- Setup sections that handle clean working tree (already handled)
- Setup sections that detect URL or browse binary (already handled)

Output: "Here's what I'm reviewing: [diff summary]. Frontend scope: [yes/no].
App URL: [url or 'none']. Loaded review skills from disk. Starting full review
pipeline with auto-decisions."

---

## Phase 1: Code Review (/review)

Follow review/SKILL.md — all steps, full depth.
Override: every AskUserQuestion → auto-decide using the 6 principles.

**Override rules:**

- **Fix-First classification:** follow the skill's checklist heuristic, then auto-decide ASK items:
  - Security fixes (auth, XSS, injection): apply if < 20 lines and follows established
    patterns (P5). If > 20 lines or requires architectural judgment → mark TASTE DECISION.
  - Race conditions: apply if there's a clear atomic alternative (P3). If multiple valid
    approaches → mark TASTE DECISION.
  - Enum completeness: always fix (P1).
  - Large fixes (> 20 lines): apply if purely mechanical (P5). If judgment needed →
    mark TASTE DECISION.
  - Design-lite check (if frontend scope): auto-apply mechanical CSS fixes (P5).
    Aesthetic decisions → mark TASTE DECISION.

- **Scope drift detection:** flag but do not block (P6). Include in gate summary.

- **TODOS cross-reference:** auto-note but don't create new TODOs yet (Phases 2-3 may find more).

**Required execution checklist (Review):**
- [ ] Branch check passed (not on base branch, diff exists)
- [ ] Scope drift detection completed
- [ ] Checklist read from review/checklist.md
- [ ] Two-pass review executed (Critical + Informational)
- [ ] Design-lite review ran (if frontend scope)
- [ ] Test coverage diagram produced (if applicable)
- [ ] All AUTO-FIX items applied
- [ ] All ASK items auto-decided and logged in audit trail
- [ ] Review fixes committed (or "no fixes needed")

**Committing review fixes:**
After all fixes are applied, commit them as a batch:
```bash
git add <fixed-files>
git commit -m "fix: /autoreview Phase 1 — code review fixes"
```

**PHASE 1 COMPLETE.** Emit phase-transition summary:
> **Phase 1 complete.** Code review: N issues found (X auto-fixed, Y auto-decided,
> Z taste decisions surfaced). Passing to Phase 2.

Do NOT begin Phase 2 until all Phase 1 fixes are committed.

---

## Phase 2: QA Testing (/qa) — skip if no APP_URL

Follow qa/SKILL.md — all phases, full depth.
Override: every AskUserQuestion → auto-decide using the 6 principles.

**Override rules:**

- **Tier:** Standard (auto-decide, P3 — pragmatic default)
- **Mode:** diff-aware if on feature branch (P3)
- **URL:** use APP_URL from Phase 0
- **Triage:** auto-fix all fixable issues at Standard tier threshold (P1 + P6).
  If a fix touches > 3 files or WTF-likelihood > 15% → mark TASTE DECISION
  (borderline: should we keep going or stop?).
- **Each fix** gets its own atomic commit per /qa's rules.
- **WTF-likelihood** hard stops still apply (> 20% → stop, auto-decide to stop).
  Hard cap: 50 fixes.
- **Regression tests:** generate per /qa's rules when fix is verified and test
  framework exists.

**Required execution checklist (QA):**
- [ ] QA baseline completed (methodology phases 1-6)
- [ ] Baseline health score recorded
- [ ] Triage completed with severity assignments
- [ ] Fix loop executed with atomic commits
- [ ] WTF-likelihood checked
- [ ] Final QA re-run completed
- [ ] Final health score recorded
- [ ] QA report written to `.gstack/qa-reports/`
- [ ] TODOS.md updated with deferred bugs

**PHASE 2 COMPLETE.** Emit phase-transition summary:
> **Phase 2 complete.** QA: N issues found, M fixed (V verified, B best-effort,
> R reverted). Health score: X → Y. WTF-likelihood: Z%.
> Passing to Phase 3.

Do NOT begin Phase 3 until all Phase 2 commits are made and working tree is clean.

---

## Phase 3: Design Review (/design-review) — conditional

**Skip conditions (any one is sufficient):**
- No frontend files changed
- No APP_URL detected

If skipping: "Phase 3 skipped — no frontend files changed (or no app URL)."

Before starting, verify the app is still running:
```bash
curl -s -o /dev/null -w "%{http_code}" "$APP_URL" 2>/dev/null | grep -qE "^[23]" || echo "APP_DOWN"
```
If APP_DOWN: "Phase 3 skipped — app is no longer running at $APP_URL."

Follow design-review/SKILL.md — all phases, full depth.
Override: every AskUserQuestion → auto-decide using the 6 principles.

**Override rules:**

- **URL:** use APP_URL from Phase 0
- **DESIGN.md:** read if exists, use as calibration for deviation severity
- **Triage:** auto-fix all findings by impact level (P1).
  Aesthetic/taste issues where DESIGN.md doesn't provide clear guidance →
  mark TASTE DECISION.
- **CSS-only fixes:** always apply (P5 — explicit, safe, reversible).
- **JSX/component changes:** apply if < 10 lines (P3). Larger → mark TASTE DECISION.
- **Design-fix risk** hard stops still apply (> 20% → stop). Hard cap: 30 fixes.

**Required execution checklist (Design Review):**
- [ ] Design audit baseline completed
- [ ] Baseline design score and AI slop score recorded
- [ ] Triage completed
- [ ] Fix loop executed with atomic commits
- [ ] Risk level checked
- [ ] Final design audit re-run completed
- [ ] Final scores recorded
- [ ] Design report written to `.gstack/design-reports/`
- [ ] TODOS.md updated with deferred findings

**PHASE 3 COMPLETE.** Emit phase-transition summary:
> **Phase 3 complete.** Design: N findings, M fixed. Design score: X → Y.
> AI slop: A → B. All phases complete. Proceeding to Final Approval Gate.

---

## Decision Audit Trail

After each auto-decision, append a row to the audit file using Edit:

```markdown
| # | Phase | Decision | Principle | Rationale | Classification |
```

Write one row per decision incrementally. This keeps the audit on disk,
not accumulated in conversation context.

---

## Pre-Gate Verification

Before presenting the Final Approval Gate, verify required outputs:

**Phase 1 (Code Review) outputs:**
- [ ] Scope drift detection completed with output
- [ ] Two-pass review ran (Critical + Informational)
- [ ] All findings classified and actioned
- [ ] Review fixes committed (or "no fixes needed")

**Phase 2 (QA) outputs — only if APP_URL detected:**
- [ ] Baseline health score recorded
- [ ] All fixable issues triaged and fix-looped
- [ ] Final health score recorded
- [ ] QA report written to disk
- [ ] Health score delta computed

**Phase 3 (Design Review) outputs — only if frontend scope + APP_URL:**
- [ ] Baseline design + AI slop scores recorded
- [ ] All fixable findings triaged and fix-looped
- [ ] Final scores recorded
- [ ] Design report written to disk

**Cross-phase:**
- [ ] Decision Audit Trail has at least one row per auto-decision

If ANY checkbox is missing, go back and produce the missing output. Max 2 attempts —
if still missing, proceed to gate with a warning.

---

## Phase 4: Final Approval Gate

**STOP here and present the final state to the user.**

Present as a message, then use AskUserQuestion:

```
## /autoreview Review Complete

### Summary
[1-3 sentence summary of what was reviewed and the overall state]

### Phases Run
- Phase 1 (Code Review): [summary — N issues, M fixed, K taste decisions]
- Phase 2 (QA): [summary — N bugs, M fixed, health X → Y] or "Skipped (no app URL)"
- Phase 3 (Design Review): [summary — N findings, M fixed, design X → Y] or "Skipped"

### Decisions Made: [N] total ([M] auto-decided, [K] choices for you)

### Your Choices (taste decisions)
[For each taste decision:]
**Choice [N]: [title]** (from Phase [X]: [skill])
I recommend [fix approach] — [principle]. But [alternative] is also viable:
  [1-sentence downstream impact if you pick the alternative]

### Auto-Decided: [M] decisions [see audit trail at AUDIT_PATH]

### Compound Scores
- Code Review: [N] issues ([X] critical, [Y] informational) — [Z] remaining
- QA Health: [baseline] → [final] ([delta]) — [N] bugs fixed, [M] deferred
- Design Score: [baseline] → [final] ([delta]) — AI Slop: [baseline] → [final]
- Ship-Readiness: [READY / NEEDS ATTENTION / NOT READY]

### Commits Made
- Phase 1: [N] commits (review fixes)
- Phase 2: [N] commits (QA bug fixes) + [N] regression tests
- Phase 3: [N] commits (design fixes)
- Total: [N] new commits on this branch

### Cross-Phase Findings
[Issues that appeared in multiple phases:]
**[topic]** — flagged in Phase [X] and Phase [Y]. [explanation]
[If none:] "No cross-phase findings — each phase's concerns were distinct."

### Deferred to TODOS.md
[Items auto-deferred with reasons]
```

**Cognitive load management:**
- 0 taste decisions: skip "Your Choices" section
- 1-7 taste decisions: flat list
- 8+: group by phase. Add warning: "This branch had unusually high ambiguity
  ([N] taste decisions). Review carefully."

AskUserQuestion options:
- A) Approve as-is (accept all recommendations)
- B) Approve with overrides (specify which taste decisions to change)
- C) Interrogate (ask about any specific decision)
- D) Revise (revert specific fixes and re-run affected phase)
- E) Reject (revert all autoreview commits)

**Option handling:**
- A: mark APPROVED, write review logs, suggest /ship
- B: ask which overrides, apply changes, re-present gate
- C: answer freeform, re-present gate
- D: revert specified commits, re-run affected phase. Max 3 cycles.
- E: `git reset --hard RESTORE_COMMIT` — restore to pre-autoreview state

---

## Completion: Write Review Logs

On approval, write review log entries so /ship's dashboard recognizes all reviews:

```bash
COMMIT=$(git rev-parse --short HEAD 2>/dev/null)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Phase 1: Code Review
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"review","timestamp":"'"$TIMESTAMP"'","status":"STATUS","issues_found":N,"critical":N,"informational":N,"commit":"'"$COMMIT"'","via":"autoreview"}'
```

If Phase 2 ran:
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"qa","timestamp":"'"$TIMESTAMP"'","status":"STATUS","issues_found":N,"fixed":N,"verified":N,"deferred":N,"health_before":N,"health_after":N,"commit":"'"$COMMIT"'","via":"autoreview"}'
```

If Phase 3 ran:
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"design-review","timestamp":"'"$TIMESTAMP"'","status":"STATUS","findings":N,"fixed":N,"design_score_before":N,"design_score_after":N,"slop_score_before":N,"slop_score_after":N,"commit":"'"$COMMIT"'","via":"autoreview"}'
```

Replace STATUS with "clean" if no unresolved issues, "issues_open" otherwise.
Replace N values with actual counts from each phase.

Suggest next step: `/ship` when ready to create the PR.

---

## Important Rules

- **Never abort.** The user chose /autoreview. Respect that choice. Surface all taste decisions at the gate, never redirect to interactive review.
- **URL is the one constraint.** If no app URL is found, Phases 2-3 are skipped but Phase 1 always runs. You cannot QA or design-review without a running app.
- **Auto-commit dirty tree.** Unlike interactive skills which ask, /autoreview auto-commits dirty state per P6 (bias toward action).
- **Log every decision.** No silent auto-decisions. Every choice gets a row in the audit trail.
- **Full depth means full depth.** Do not compress or skip sections from the loaded skill files (except the skip list). Read the code each section asks you to read, produce the outputs each section requires, identify every issue, and decide each one.
- **Artifacts are deliverables.** QA reports, design reports, test coverage diagrams, screenshots — these must exist on disk when the review completes.
- **Sequential order.** Review → QA → Design. Each phase must complete fully before the next begins.
- **Restore point is sacred.** Option E at the gate must fully restore to pre-autoreview state. Never lose the user's work.
- **Self-regulation still applies.** WTF-likelihood (QA) and design-fix risk (Design Review) hard stops are not overridden by auto-decisions. If the heuristic says stop, stop.
