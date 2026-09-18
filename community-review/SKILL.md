---
name: community-review
version: 1.0.0
description: |
  Review and prioritize open community PRs. Analyzes each PR for impact,
  effort, template compliance, and code quality. Outputs a prioritized
  digest and auto-comments on PRs with specific feedback.
  Use when asked to "review community PRs", "check open PRs", "PR inbox",
  or "what should I merge".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
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
echo '{"skill":"community-review","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
# /community-review — Community PR Inbox

You are a **Release Manager** who triages community contributions. Your job is to
help the maintainer spend their review time on the PRs that matter most. You read
every open PR, understand what it does and why it matters, score it, check it for
compliance, and present a prioritized digest.

## Arguments

- `/community-review` — analyze all open PRs, output prioritized digest
- `/community-review --post` — same + auto-comment on each PR with feedback
- `/community-review --issue` — same + create a GitHub Issue with the weekly digest

## Step 1: Fetch all open PRs

```bash
gh pr list --state open --json number,title,author,createdAt,additions,deletions,files,labels,body,headRefName,updatedAt --limit 100
```

For each PR, also fetch the diff:
```bash
gh pr diff NUMBER --name-only  # file list
gh pr diff NUMBER              # full diff (read first 500 lines)
```

## Step 2: Score each PR

For every PR, evaluate two dimensions:

### Impact Score (1-10)

What does this PR do for gstack users?

| Score | Meaning | Examples |
|-------|---------|---------|
| 9-10 | **New capability** — unlocks something impossible before | New skill, new platform support, new integration |
| 7-8 | **Major improvement** — significantly better experience | Performance 2x+, critical bug fix, UX overhaul |
| 5-6 | **Nice to have** — useful but not essential | Minor bug fix, edge case handling, error messages |
| 3-4 | **Cosmetic** — barely noticeable to users | Typo, formatting, comment cleanup |
| 1-2 | **Noise** — no user value, or duplicate of existing work | README badge, empty commit, duplicate PR |

To assess impact, read the PR description AND the actual diff. Don't trust the title alone.
Ask: "If I were a gstack user, would I notice this change? Would I care?"

### Effort Score (1-10)

How much work for the maintainer to review and merge?

| Score | Meaning | Examples |
|-------|---------|---------|
| 1-2 | **Trivial** — glance and merge | 1-10 lines, obvious fix, no architecture impact |
| 3-4 | **Quick review** — 5 minutes | 10-50 lines, localized change, follows patterns |
| 5-6 | **Moderate** — 15-30 minutes | 50-200 lines, touches multiple files, needs testing |
| 7-8 | **Significant** — 1+ hour | 200-500 lines, new feature, architecture decisions |
| 9-10 | **Major** — half-day or more | 500+ lines, cross-cutting, needs design discussion |

### Priority Calculation

```
Priority = Impact × (11 - Effort)
```

High impact + low effort = highest priority. This surfaces the "quick wins" first.

### Staleness Penalty

- PR updated > 30 days ago: flag as "stale"
- PR updated > 90 days ago: recommend close unless high impact
- PR with merge conflicts: flag, lower priority

## Step 3: Template Compliance Check

For each PR that touches skill files, verify:

| Check | How | Pass/Fail |
|-------|-----|-----------|
| `.tmpl` file exists | `ls SKILLNAME/SKILL.md.tmpl` | Required for new skills |
| `{{PREAMBLE}}` used | `grep PREAMBLE SKILL.md.tmpl` | Required — no hardcoded preamble |
| Auto-generated marker | `grep AUTO-GENERATED SKILL.md` | Required in generated file |
| Description < 1024 chars | Count chars in description field | Required for Codex compat |
| Bash compat | No `source <(gstack-slug)` | Must use `eval "$(gstack-slug)"` |
| Telemetry line | `grep skill-usage.jsonl SKILL.md` | Required in preamble |

Report compliance as: `6/6 ✅` or `4/6 ⚠️ (missing: .tmpl, telemetry)`

## Step 4: Code Quality Quick Scan

For each PR diff, check:
- Does it follow existing patterns in the codebase?
- Are there obvious bugs (unclosed files, missing error handling)?
- Does it duplicate functionality that already exists?
- Are there security issues (hardcoded secrets, unsafe eval)?

This is NOT a full /review — just a quick scan for red flags.

## Step 5: Generate Prioritized Digest

Output format:

```
🔍 Community PR Digest — [DATE]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[X] open PRs analyzed

🟢 MERGE NOW (high impact, low effort, compliant)
  #123 — "Add Firefox support" by @user (Impact: 8, Effort: 3, Score: 64)
    → New browser support, 45 lines, template compliant 6/6
  #456 — "Fix zsh glob error" by @user (Impact: 7, Effort: 1, Score: 70)
    → Bug fix, 3 lines, affects all zsh users

🟡 FIX THEN MERGE (high impact, minor issues)
  #789 — "Add /delegate skill" by @user (Impact: 8, Effort: 5, Score: 48)
    → Missing .tmpl file, hardcoded preamble. Concept is solid.
    → Fix needed: convert to .tmpl, use {{PREAMBLE}}

🟠 REVIEW WHEN FREE (medium impact or moderate effort)
  #101 — "Add Lighthouse scores" by @user (Impact: 6, Effort: 6, Score: 30)
    → Useful feature, needs architecture discussion on where scores live

⚪ BACKLOG (low impact or major rework needed)
  #202 — "Update README" by @user (Impact: 2, Effort: 1, Score: 18)
    → Cosmetic only, no urgency

❌ RECOMMEND CLOSE
  #303 — "Create index.ts" by @user (Impact: 1, Effort: 1, stale: 45 days)
    → Empty file, no description, no response to feedback

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Summary: 2 merge now, 1 fix-then-merge, 1 review, 1 backlog, 1 close
Estimated review time: ~25 minutes for top 3
```

Sort within each category by Priority score (descending).

## Step 6: Auto-Comment (if --post)

For each PR, post a comment with specific, actionable feedback:

**For "MERGE NOW":**
```
🤖 **Community Review — Ready to merge**

This PR looks good:
- [specific thing that's well done]
- Template compliance: 6/6 ✅
- No code quality issues detected

Recommendation: merge as-is.
```

**For "FIX THEN MERGE":**
```
🤖 **Community Review — Minor fixes needed**

The concept is solid. A few things to fix before merge:
- [ ] [specific fix 1 with file path]
- [ ] [specific fix 2 with file path]

Template compliance: 4/6 ⚠️
Missing: [specific items]

Once fixed, this is ready to merge.
```

**For "RECOMMEND CLOSE":**
```
🤖 **Community Review — Recommend closing**

[Reason: stale / duplicate of #X / doesn't match project direction]

Thank you for the contribution! If you'd like to revisit, please [specific guidance].
```

Always be respectful. These are people who took time to contribute.

## Step 7: Create GitHub Issue (if --issue)

```bash
gh issue create --title "📋 Community PR Digest — $(date +%Y-%m-%d)" \
  --body "[DIGEST_CONTENT]" \
  --label "community-digest"
```

## Weekly Automation

To run every Sunday evening automatically, the maintainer can add to their crontab
or launchd:

```bash
# Run community review every Sunday at 8 PM, create GitHub issue
cd /path/to/gstack && claude --print -p "/community-review --issue --post"
```

This creates a GitHub Issue digest AND auto-comments on PRs, so Monday morning
the maintainer opens one issue and sees everything prioritized.
