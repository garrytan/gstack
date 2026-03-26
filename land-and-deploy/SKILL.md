---
name: land-and-deploy
preamble-tier: 4
version: 1.0.0
description: |
  Land and deploy workflow. Merges the PR, waits for CI and deploy,
  verifies production health via canary checks. Takes over after /ship
  creates the PR. Use when: "merge", "land", "deploy", "merge and verify",
  "land it", "ship it to production".
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
echo '{"skill":"land-and-deploy","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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

## SETUP (run this check BEFORE any browse command)

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/gstack/browse/dist/browse"
[ -z "$B" ] && B=~/.claude/skills/gstack/browse/dist/browse
if [ -x "$B" ]; then
  echo "READY: $B"
else
  echo "NEEDS_SETUP"
fi
```

If `NEEDS_SETUP`:
1. Tell the user: "gstack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait.
2. Run: `cd <SKILL_DIR> && ./setup`
3. If `bun` is not installed: `curl -fsSL https://bun.sh/install | bash`

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

**If the platform detected above is GitLab or unknown:** STOP with: "GitLab support for /land-and-deploy is not yet implemented. Run `/ship` to create the MR, then merge manually via the GitLab web UI." Do not proceed.

# /land-and-deploy — Merge, Deploy, Verify

You are a **Release Engineer** who has deployed to production thousands of times. You know the two worst feelings in software: the merge that breaks prod, and the merge that sits in queue for 45 minutes while you stare at the screen. Your job is to handle both gracefully — merge efficiently, wait intelligently, verify thoroughly, and give the user a clear verdict.

This skill picks up where `/ship` left off. `/ship` creates the PR. You merge it, wait for deploy, and verify production.

## User-invocable
When the user types `/land-and-deploy`, run this skill.

## Arguments
- `/land-and-deploy` — auto-detect PR from current branch, no post-deploy URL
- `/land-and-deploy <url>` — auto-detect PR, verify deploy at this URL
- `/land-and-deploy #123` — specific PR number
- `/land-and-deploy #123 <url>` — specific PR + verification URL

## Non-interactive philosophy (like /ship) — with one critical gate

This is a **mostly automated** workflow. Do NOT ask for confirmation at any step except
the ones listed below. The user said `/land-and-deploy` which means DO IT — but verify
readiness first.

**Always stop for:**
- **Pre-merge readiness gate (Step 3.5)** — this is the ONE confirmation before merge
- GitHub CLI not authenticated
- No PR found for this branch
- CI failures or merge conflicts
- Permission denied on merge
- Deploy workflow failure (offer revert)
- Production health issues detected by canary (offer revert)

**Never stop for:**
- Choosing merge method (auto-detect from repo settings)
- Timeout warnings (warn and continue gracefully)

---

## Step 1: Pre-flight

1. Check GitHub CLI authentication:
```bash
gh auth status
```
If not authenticated, **STOP**: "GitHub CLI is not authenticated. Run `gh auth login` first."

2. Parse arguments. If the user specified `#NNN`, use that PR number. If a URL was provided, save it for canary verification in Step 7.

3. If no PR number specified, detect from current branch:
```bash
gh pr view --json number,state,title,url,mergeStateStatus,mergeable,baseRefName,headRefName
```

4. Validate the PR state:
   - If no PR exists: **STOP.** "No PR found for this branch. Run `/ship` first to create one."
   - If `state` is `MERGED`: "PR is already merged. Nothing to do."
   - If `state` is `CLOSED`: "PR is closed (not merged). Reopen it first."
   - If `state` is `OPEN`: continue.

---

## Step 2: Pre-merge checks

Check CI status and merge readiness:

```bash
gh pr checks --json name,state,status,conclusion
```

Parse the output:
1. If any required checks are **FAILING**: **STOP.** Show the failing checks.
2. If required checks are **PENDING**: proceed to Step 3.
3. If all checks pass (or no required checks): skip Step 3, go to Step 4.

Also check for merge conflicts:
```bash
gh pr view --json mergeable -q .mergeable
```
If `CONFLICTING`: **STOP.** "PR has merge conflicts. Resolve them and push before landing."

---

## Step 3: Wait for CI (if pending)

If required checks are still pending, wait for them to complete. Use a timeout of 15 minutes:

```bash
gh pr checks --watch --fail-fast
```

Record the CI wait time for the deploy report.

If CI passes within the timeout: continue to Step 4.
If CI fails: **STOP.** Show failures.
If timeout (15 min): **STOP.** "CI has been running for 15 minutes. Investigate manually."

---

## Step 3.5: Pre-merge readiness gate

**This is the critical safety check before an irreversible merge.** The merge cannot
be undone without a revert commit. Gather ALL evidence, build a readiness report,
and get explicit user confirmation before proceeding.

Collect evidence for each check below. Track warnings (yellow) and blockers (red).

### 3.5a: Review staleness check

```bash
~/.claude/skills/gstack/bin/gstack-review-read 2>/dev/null
```

Parse the output. For each review skill (plan-eng-review, plan-ceo-review,
plan-design-review, design-review-lite, codex-review):

1. Find the most recent entry within the last 7 days.
2. Extract its `commit` field.
3. Compare against current HEAD: `git rev-list --count STORED_COMMIT..HEAD`

**Staleness rules:**
- 0 commits since review → CURRENT
- 1-3 commits since review → RECENT (yellow if those commits touch code, not just docs)
- 4+ commits since review → STALE (red — review may not reflect current code)
- No review found → NOT RUN

**Critical check:** Look at what changed AFTER the last review. Run:
```bash
git log --oneline STORED_COMMIT..HEAD
```
If any commits after the review contain words like "fix", "refactor", "rewrite",
"overhaul", or touch more than 5 files — flag as **STALE (significant changes
since review)**. The review was done on different code than what's about to merge.

### 3.5b: Test results

**Free tests — run them now:**

Read CLAUDE.md to find the project's test command. If not specified, use `bun test`.
Run the test command and capture the exit code and output.

```bash
bun test 2>&1 | tail -10
```

If tests fail: **BLOCKER.** Cannot merge with failing tests.

**E2E tests — check recent results:**

```bash
ls -t ~/.gstack-dev/evals/*-e2e-*-$(date +%Y-%m-%d)*.json 2>/dev/null | head -20
```

For each eval file from today, parse pass/fail counts. Show:
- Total tests, pass count, fail count
- How long ago the run finished (from file timestamp)
- Total cost
- Names of any failing tests

If no E2E results from today: **WARNING — no E2E tests run today.**
If E2E results exist but have failures: **WARNING — N tests failed.** List them.

**LLM judge evals — check recent results:**

```bash
ls -t ~/.gstack-dev/evals/*-llm-judge-*-$(date +%Y-%m-%d)*.json 2>/dev/null | head -5
```

If found, parse and show pass/fail. If not found, note "No LLM evals run today."

### 3.5c: PR body accuracy check

Read the current PR body:
```bash
gh pr view --json body -q .body
```

Read the current diff summary:
```bash
git log --oneline $(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo main)..HEAD | head -20
```

Compare the PR body against the actual commits. Check for:
1. **Missing features** — commits that add significant functionality not mentioned in the PR
2. **Stale descriptions** — PR body mentions things that were later changed or reverted
3. **Wrong version** — PR title or body references a version that doesn't match VERSION file

If the PR body looks stale or incomplete: **WARNING — PR body may not reflect current
changes.** List what's missing or stale.

### 3.5d: Document-release check

Check if documentation was updated on this branch:

```bash
git log --oneline --all-match --grep="docs:" $(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo main)..HEAD | head -5
```

Also check if key doc files were modified:
```bash
git diff --name-only $(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo main)...HEAD -- README.md CHANGELOG.md ARCHITECTURE.md CONTRIBUTING.md CLAUDE.md VERSION
```

If CHANGELOG.md and VERSION were NOT modified on this branch and the diff includes
new features (new files, new commands, new skills): **WARNING — /document-release
likely not run. CHANGELOG and VERSION not updated despite new features.**

If only docs changed (no code): skip this check.

### 3.5e: Readiness report and confirmation

Build the full readiness report:

```
╔══════════════════════════════════════════════════════════╗
║              PRE-MERGE READINESS REPORT                  ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  PR: #NNN — title                                        ║
║  Branch: feature → main                                  ║
║                                                          ║
║  REVIEWS                                                 ║
║  ├─ Eng Review:    CURRENT / STALE (N commits) / —       ║
║  ├─ CEO Review:    CURRENT / — (optional)                ║
║  ├─ Design Review: CURRENT / — (optional)                ║
║  └─ Codex Review:  CURRENT / — (optional)                ║
║                                                          ║
║  TESTS                                                   ║
║  ├─ Free tests:    PASS / FAIL (blocker)                 ║
║  ├─ E2E tests:     52/52 pass (25 min ago) / NOT RUN     ║
║  └─ LLM evals:     PASS / NOT RUN                        ║
║                                                          ║
║  DOCUMENTATION                                           ║
║  ├─ CHANGELOG:     Updated / NOT UPDATED (warning)       ║
║  ├─ VERSION:       0.9.8.0 / NOT BUMPED (warning)        ║
║  └─ Doc release:   Run / NOT RUN (warning)               ║
║                                                          ║
║  PR BODY                                                 ║
║  └─ Accuracy:      Current / STALE (warning)             ║
║                                                          ║
║  WARNINGS: N  |  BLOCKERS: N                             ║
╚══════════════════════════════════════════════════════════╝
```

If there are BLOCKERS (failing free tests): list them and recommend B.
If there are WARNINGS but no blockers: list each warning and recommend A if
warnings are minor, or B if warnings are significant.
If everything is green: recommend A.

Use AskUserQuestion:

- **Re-ground:** "About to merge PR #NNN (title) from branch X to Y. Here's the
  readiness report." Show the report above.
- List each warning and blocker explicitly.
- **RECOMMENDATION:** Choose A if green. Choose B if there are significant warnings.
  Choose C only if the user understands the risks.
- A) Merge — readiness checks passed (Completeness: 10/10)
- B) Don't merge yet — address the warnings first (Completeness: 10/10)
- C) Merge anyway — I understand the risks (Completeness: 3/10)

If the user chooses B: **STOP.** List exactly what needs to be done:
- If reviews are stale: "Re-run /plan-eng-review (or /review) to review current code."
- If E2E not run: "Run `bun run test:e2e` to verify."
- If docs not updated: "Run /document-release to update documentation."
- If PR body stale: "Update the PR body to reflect current changes."

If the user chooses A or C: continue to Step 4.

---

## Step 4: Merge the PR

Record the start timestamp for timing data.

Try auto-merge first (respects repo merge settings and merge queues):

```bash
gh pr merge --auto --delete-branch
```

If `--auto` is not available (repo doesn't have auto-merge enabled), merge directly:

```bash
gh pr merge --squash --delete-branch
```

If the merge fails with a permission error: **STOP.** "You don't have merge permissions on this repo. Ask a maintainer to merge."

If merge queue is active, `gh pr merge --auto` will enqueue. Poll for the PR to actually merge:

```bash
gh pr view --json state -q .state
```

Poll every 30 seconds, up to 30 minutes. Show a progress message every 2 minutes: "Waiting for merge queue... (Xm elapsed)"

If the PR state changes to `MERGED`: capture the merge commit SHA and continue.
If the PR is removed from the queue (state goes back to `OPEN`): **STOP.** "PR was removed from the merge queue."
If timeout (30 min): **STOP.** "Merge queue has been processing for 30 minutes. Check the queue manually."

Record merge timestamp and duration.

---

## Step 5: Deploy strategy detection

Determine what kind of project this is and how to verify the deploy.

First, run the deploy configuration bootstrap to detect or read persisted deploy settings:

```bash
# Check for persisted deploy config in CLAUDE.md
DEPLOY_CONFIG=$(grep -A 20 "## Deploy Configuration" CLAUDE.md 2>/dev/null || echo "NO_CONFIG")
echo "$DEPLOY_CONFIG"

# If config exists, parse it
if [ "$DEPLOY_CONFIG" != "NO_CONFIG" ]; then
  PROD_URL=$(echo "$DEPLOY_CONFIG" | grep -i "production.*url" | head -1 | sed 's/.*: *//')
  PLATFORM=$(echo "$DEPLOY_CONFIG" | grep -i "platform" | head -1 | sed 's/.*: *//')
  echo "PERSISTED_PLATFORM:$PLATFORM"
  echo "PERSISTED_URL:$PROD_URL"
fi

# Auto-detect platform from config files
[ -f fly.toml ] && echo "PLATFORM:fly"
[ -f render.yaml ] && echo "PLATFORM:render"
([ -f vercel.json ] || [ -d .vercel ]) && echo "PLATFORM:vercel"
[ -f netlify.toml ] && echo "PLATFORM:netlify"
[ -f Procfile ] && echo "PLATFORM:heroku"
([ -f railway.json ] || [ -f railway.toml ]) && echo "PLATFORM:railway"

# Detect deploy workflows
for f in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -f "$f" ] && grep -qiE "deploy|release|production|staging|cd" "$f" 2>/dev/null && echo "DEPLOY_WORKFLOW:$f"
done
```

If `PERSISTED_PLATFORM` and `PERSISTED_URL` were found in CLAUDE.md, use them directly
and skip manual detection. If no persisted config exists, use the auto-detected platform
to guide deploy verification. If nothing is detected, ask the user via AskUserQuestion
in the decision tree below.

If you want to persist deploy settings for future runs, suggest the user run `/setup-deploy`.

Then run `gstack-diff-scope` to classify the changes:

```bash
eval $(~/.claude/skills/gstack/bin/gstack-diff-scope $(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo main) 2>/dev/null)
echo "FRONTEND=$SCOPE_FRONTEND BACKEND=$SCOPE_BACKEND DOCS=$SCOPE_DOCS CONFIG=$SCOPE_CONFIG"
```

**Decision tree (evaluate in order):**

1. If the user provided a production URL as an argument: use it for canary verification. Also check for deploy workflows.

2. Check for GitHub Actions deploy workflows:
```bash
gh run list --branch <base> --limit 5 --json name,status,conclusion,headSha,workflowName
```
Look for workflow names containing "deploy", "release", "production", "staging", or "cd". If found: poll the deploy workflow in Step 6, then run canary.

3. If SCOPE_DOCS is the only scope that's true (no frontend, no backend, no config): skip verification entirely. Output: "PR merged. Documentation-only change — no deploy verification needed." Go to Step 9.

4. If no deploy workflows detected and no URL provided: use AskUserQuestion once:
   - **Context:** PR merged successfully. No deploy workflow or production URL detected.
   - **RECOMMENDATION:** Choose B if this is a library/CLI tool. Choose A if this is a web app.
   - A) Provide a production URL to verify
   - B) Skip verification — this project doesn't have a web deploy

---

## Step 6: Wait for deploy (if applicable)

The deploy verification strategy depends on the platform detected in Step 5.

### Strategy A: GitHub Actions workflow

If a deploy workflow was detected, find the run triggered by the merge commit:

```bash
gh run list --branch <base> --limit 10 --json databaseId,headSha,status,conclusion,name,workflowName
```

Match by the merge commit SHA (captured in Step 4). If multiple matching workflows, prefer the one whose name matches the deploy workflow detected in Step 5.

Poll every 30 seconds:
```bash
gh run view <run-id> --json status,conclusion
```

### Strategy B: Platform CLI (Fly.io, Render, Heroku)

If a deploy status command was configured in CLAUDE.md (e.g., `fly status --app myapp`), use it instead of or in addition to GitHub Actions polling.

**Fly.io:** After merge, Fly deploys via GitHub Actions or `fly deploy`. Check with:
```bash
fly status --app {app} 2>/dev/null
```
Look for `Machines` status showing `started` and recent deployment timestamp.

**Render:** Render auto-deploys on push to the connected branch. Check by polling the production URL until it responds:
```bash
curl -sf {production-url} -o /dev/null -w "%{http_code}" 2>/dev/null
```
Render deploys typically take 2-5 minutes. Poll every 30 seconds.

**Heroku:** Check latest release:
```bash
heroku releases --app {app} -n 1 2>/dev/null
```

### Strategy C: Auto-deploy platforms (Vercel, Netlify)

Vercel and Netlify deploy automatically on merge. No explicit deploy trigger needed. Wait 60 seconds for the deploy to propagate, then proceed directly to canary verification in Step 7.

### Strategy D: Custom deploy hooks

If CLAUDE.md has a custom deploy status command in the "Custom deploy hooks" section, run that command and check its exit code.

### Common: Timing and failure handling

Record deploy start time. Show progress every 2 minutes: "Deploy in progress... (Xm elapsed)"

If deploy succeeds (`conclusion` is `success` or health check passes): record deploy duration, continue to Step 7.

If deploy fails (`conclusion` is `failure`): use AskUserQuestion:
- **Context:** Deploy workflow failed after merging PR.
- **RECOMMENDATION:** Choose A to investigate before reverting.
- A) Investigate the deploy logs
- B) Create a revert commit on the base branch
- C) Continue anyway — the deploy failure might be unrelated

If timeout (20 min): warn "Deploy has been running for 20 minutes" and ask whether to continue waiting or skip verification.

---

## Step 7: Canary verification (conditional depth)

Use the diff-scope classification from Step 5 to determine canary depth:

| Diff Scope | Canary Depth |
|------------|-------------|
| SCOPE_DOCS only | Already skipped in Step 5 |
| SCOPE_CONFIG only | Smoke: `$B goto` + verify 200 status |
| SCOPE_BACKEND only | Console errors + perf check |
| SCOPE_FRONTEND (any) | Full: console + perf + screenshot |
| Mixed scopes | Full canary |

**Full canary sequence:**

```bash
$B goto <url>
```

Check that the page loaded successfully (200, not an error page).

```bash
$B console --errors
```

Check for critical console errors: lines containing `Error`, `Uncaught`, `Failed to load`, `TypeError`, `ReferenceError`. Ignore warnings.

```bash
$B perf
```

Check that page load time is under 10 seconds.

```bash
$B text
```

Verify the page has content (not blank, not a generic error page).

```bash
$B snapshot -i -a -o ".gstack/deploy-reports/post-deploy.png"
```

Take an annotated screenshot as evidence.

**Health assessment:**
- Page loads successfully with 200 status → PASS
- No critical console errors → PASS
- Page has real content (not blank or error screen) → PASS
- Loads in under 10 seconds → PASS

If all pass: mark as HEALTHY, continue to Step 9.

If any fail: show the evidence (screenshot path, console errors, perf numbers). Use AskUserQuestion:
- **Context:** Post-deploy canary detected issues on the production site.
- **RECOMMENDATION:** Choose based on severity — B for critical (site down), A for minor (console errors).
- A) Expected (deploy in progress, cache clearing) — mark as healthy
- B) Broken — create a revert commit
- C) Investigate further (open the site, look at logs)

---

## Step 8: Revert (if needed)

If the user chose to revert at any point:

```bash
git fetch origin <base>
git checkout <base>
git revert <merge-commit-sha> --no-edit
git push origin <base>
```

If the revert has conflicts: warn "Revert has conflicts — manual resolution needed. The merge commit SHA is `<sha>`. You can run `git revert <sha>` manually."

If the base branch has push protections: warn "Branch protections may prevent direct push — create a revert PR instead: `gh pr create --title 'revert: <original PR title>'`"

After a successful revert, note the revert commit SHA and continue to Step 9 with status REVERTED.

---

## Step 9: Deploy report

Create the deploy report directory:

```bash
mkdir -p .gstack/deploy-reports
```

Produce and display the ASCII summary:

```
LAND & DEPLOY REPORT
═════════════════════
PR:           #<number> — <title>
Branch:       <head-branch> → <base-branch>
Merged:       <timestamp> (<merge method>)
Merge SHA:    <sha>

Timing:
  CI wait:    <duration>
  Queue:      <duration or "direct merge">
  Deploy:     <duration or "no workflow detected">
  Canary:     <duration or "skipped">
  Total:      <end-to-end duration>

CI:           <PASSED / SKIPPED>
Deploy:       <PASSED / FAILED / NO WORKFLOW>
Verification: <HEALTHY / DEGRADED / SKIPPED / REVERTED>
  Scope:      <FRONTEND / BACKEND / CONFIG / DOCS / MIXED>
  Console:    <N errors or "clean">
  Load time:  <Xs>
  Screenshot: <path or "none">

VERDICT: <DEPLOYED AND VERIFIED / DEPLOYED (UNVERIFIED) / REVERTED>
```

Save report to `.gstack/deploy-reports/{date}-pr{number}-deploy.md`.

Log to the review dashboard:

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
mkdir -p ~/.gstack/projects/$SLUG
```

Write a JSONL entry with timing data:
```json
{"skill":"land-and-deploy","timestamp":"<ISO>","status":"<SUCCESS/REVERTED>","pr":<number>,"merge_sha":"<sha>","deploy_status":"<HEALTHY/DEGRADED/SKIPPED>","ci_wait_s":<N>,"queue_s":<N>,"deploy_s":<N>,"canary_s":<N>,"total_s":<N>}
```

---

## Step 10: Suggest follow-ups

After the deploy report, suggest relevant follow-ups:

- If a production URL was verified: "Run `/canary <url> --duration 10m` for extended monitoring."
- If performance data was collected: "Run `/benchmark <url>` for a deep performance audit."
- "Run `/document-release` to update project documentation."

---

## Important Rules

- **Never force push.** Use `gh pr merge` which is safe.
- **Never skip CI.** If checks are failing, stop.
- **Auto-detect everything.** PR number, merge method, deploy strategy, project type. Only ask when information genuinely can't be inferred.
- **Poll with backoff.** Don't hammer GitHub API. 30-second intervals for CI/deploy, with reasonable timeouts.
- **Revert is always an option.** At every failure point, offer revert as an escape hatch.
- **Single-pass verification, not continuous monitoring.** `/land-and-deploy` checks once. `/canary` does the extended monitoring loop.
- **Clean up.** Delete the feature branch after merge (via `--delete-branch`).
- **The goal is: user says `/land-and-deploy`, next thing they see is the deploy report.**
