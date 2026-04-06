---
name: gstack-openclaw-retro
description: "Weekly engineering retrospective. Analyzes commit history, work patterns, and code quality metrics with persistent history and trend tracking. Team-aware with per-person contributions, praise, and growth areas. Use when asked for weekly retro, what shipped this week, or engineering retrospective."
---

# Weekly Engineering Retrospective

Generates a comprehensive engineering retrospective analyzing commit history, work patterns, and code quality metrics. Team-aware: identifies the user running the command, then analyzes every contributor with per-person praise and growth opportunities.

## Arguments

- Default: last 7 days
- `24h`: last 24 hours
- `14d`: last 14 days
- `30d`: last 30 days
- `compare`: compare current window vs prior same-length window

## Instructions

Parse the argument to determine the time window. Default to 7 days. All times should be reported in the user's **local timezone**.

**Midnight-aligned windows:** For day units, compute an absolute start date at local midnight. For example, if today is 2026-03-18 and the window is 7 days, the start date is 2026-03-11. Use `--since="2026-03-11T00:00:00"` for git log queries. For hour units, use `--since="N hours ago"`.

---

### Step 1: Gather Raw Data

First, fetch origin and identify the current user:

```bash
git fetch origin main --quiet
git config user.name
git config user.email
```

The name returned by `git config user.name` is **"you"** ... the person reading this retro. All other authors are teammates.

Run ALL of these git commands (they are independent):

```bash
# All commits with timestamps, subject, hash, author, files changed
git log origin/main --since="<window>" --format="%H|%aN|%ae|%ai|%s" --shortstat

# Per-commit test vs total LOC breakdown with author
git log origin/main --since="<window>" --format="COMMIT:%H|%aN" --numstat

# Commit timestamps for session detection and hourly distribution
git log origin/main --since="<window>" --format="%at|%aN|%ai|%s" | sort -n

# Files most frequently changed (hotspot analysis)
git log origin/main --since="<window>" --format="" --name-only | grep -v '^$' | sort | uniq -c | sort -rn

# PR numbers from commit messages
git log origin/main --since="<window>" --format="%s" | grep -oE '[#!][0-9]+' | sort -t'#' -k1 | uniq

# Per-author file hotspots
git log origin/main --since="<window>" --format="AUTHOR:%aN" --name-only

# Per-author commit counts
git shortlog origin/main --since="<window>" -sn --no-merges

# Test file count
find . -name '*.test.*' -o -name '*.spec.*' -o -name '*_test.*' -o -name '*_spec.*' 2>/dev/null | grep -v node_modules | wc -l

# Test files changed in window
git log origin/main --since="<window>" --format="" --name-only | grep -E '\.(test|spec)\.' | sort -u | wc -l
```

---

### Step 2: Compute Metrics

Calculate and present these metrics in a summary:

- **Commits to main:** N
- **Contributors:** N
- **PRs merged:** N
- **Total insertions:** N
- **Total deletions:** N
- **Net LOC added:** N
- **Test LOC (insertions):** N
- **Test LOC ratio:** N%
- **Version range:** vX.Y.Z → vX.Y.Z
- **Active days:** N
- **Detected sessions:** N
- **Avg LOC/session-hour:** N

Then show a **per-author leaderboard** immediately below:

```
Contributor         Commits   +/-          Top area
You (garry)              32   +2400/-300   browse/
alice                    12   +800/-150    app/services/
bob                       3   +120/-40     tests/
```

Sort by commits descending. The current user always appears first, labeled "You (name)".

---

### Step 3: Commit Time Distribution

Show hourly histogram in local time:

```
Hour  Commits  ████████████████
 00:    4      ████
 07:    5      █████
 ...
```

Identify:
- Peak hours
- Dead zones
- Bimodal pattern (morning/evening) vs continuous
- Late-night coding clusters (after 10pm)

---

### Step 4: Work Session Detection

Detect sessions using **45-minute gap** threshold between consecutive commits.

Classify sessions:
- **Deep sessions** (50+ min)
- **Medium sessions** (20-50 min)
- **Micro sessions** (<20 min, single-commit)

Calculate:
- Total active coding time
- Average session length
- LOC per hour of active time

---

### Step 5: Commit Type Breakdown

Categorize by conventional commit prefix (feat/fix/refactor/test/chore/docs). Show as percentage bar:

```
feat:     20  (40%)  ████████████████████
fix:      27  (54%)  ███████████████████████████
refactor:  2  ( 4%)  ██
```

Flag if fix ratio exceeds 50% ... signals a "ship fast, fix fast" pattern that may indicate review gaps.

---

### Step 6: Hotspot Analysis

Show top 10 most-changed files. Flag:
- Files changed 5+ times (churn hotspots)
- Test files vs production files in the hotspot list
- VERSION/CHANGELOG frequency

---

### Step 7: PR Size Distribution

Estimate PR sizes and bucket them:
- **Small** (<100 LOC)
- **Medium** (100-500 LOC)
- **Large** (500-1500 LOC)
- **XL** (1500+ LOC)

---

### Step 8: Focus Score + Ship of the Week

**Focus score:** Percentage of commits touching the single most-changed top-level directory. Higher = deeper focused work. Lower = scattered context-switching.

**Ship of the week:** The single highest-LOC PR in the window. Highlight PR number, LOC changed, and why it matters.

---

### Step 9: Team Member Analysis

For each contributor (including the current user), compute:

1. **Commits and LOC** ... total commits, insertions, deletions, net LOC
2. **Areas of focus** ... which directories/files they touched most (top 3)
3. **Commit type mix** ... their personal feat/fix/refactor/test breakdown
4. **Session patterns** ... when they code (peak hours), session count
5. **Test discipline** ... their personal test LOC ratio
6. **Biggest ship** ... their single highest-impact commit or PR

**For the current user ("You"):** Deepest treatment. Include all session analysis, time patterns, focus score. Frame in first person.

**For each teammate:** 2-3 sentences covering what they shipped and their pattern. Then:

- **Praise** (1-2 specific things): Anchor in actual commits. Not "great work" ... say exactly what was good.
- **Opportunity for growth** (1 specific thing): Frame as leveling-up, not criticism. Anchor in actual data.

**If solo repo:** Skip team breakdown.

**AI collaboration:** If commits have `Co-Authored-By` AI trailers, track "AI-assisted commits" as a separate metric.

---

### Step 10: Week-over-Week Trends (if window >= 14d)

Split into weekly buckets and show trends:
- Commits per week (total and per-author)
- LOC per week
- Test ratio per week
- Fix ratio per week
- Session count per week

---

### Step 11: Streak Tracking

Count consecutive days with at least 1 commit, going back from today:

```bash
# Team streak
git log origin/main --format="%ad" --date=format:"%Y-%m-%d" | sort -u

# Personal streak
git log origin/main --author="<user_name>" --format="%ad" --date=format:"%Y-%m-%d" | sort -u
```

Display both:
- "Team shipping streak: 47 consecutive days"
- "Your shipping streak: 32 consecutive days"

---

### Step 12: Load History & Compare

Check for prior retro history in `memory/`:

If prior retros exist, load the most recent one and calculate deltas:

```
                    Last        Now         Delta
Test ratio:         22%    →    41%         ↑19pp
Sessions:           10     →    14          ↑4
LOC/hour:           200    →    350         ↑75%
Fix ratio:          54%    →    30%         ↓24pp (improving)
```

If no prior retros exist, note "First retro recorded, run again next week to see trends."

---

### Step 13: Save Retro History

Save a JSON snapshot to `memory/retro-YYYY-MM-DD.json` with metrics, authors, version range, streak, and tweetable summary.

---

### Step 14: Write the Narrative

**Format for Telegram** (bullets, bold, no markdown tables in the final output).

Structure:

**Tweetable summary** (first line):
> Week of Mar 1: 47 commits (3 contributors), 3.2k LOC, 38% tests, 12 PRs, peak: 10pm | Streak: 47d

Then sections:

- **Summary** ... key metrics
- **Trends vs Last Retro** ... deltas (skip if first retro)
- **Time & Session Patterns** ... when the team codes, session lengths, deep vs micro
- **Shipping Velocity** ... commit types, PR sizes, fix-chain detection
- **Code Quality Signals** ... test ratio, hotspots, churn
- **Focus & Highlights** ... focus score, ship of the week
- **Your Week** ... personal deep-dive for the current user
- **Team Breakdown** ... per-teammate analysis with praise + growth (skip if solo)
- **Top 3 Team Wins** ... highest-impact things shipped
- **3 Things to Improve** ... specific, actionable, anchored in commits
- **3 Habits for Next Week** ... small, practical, realistic (<5 min to adopt)

---

## Compare Mode

When the user says "compare":
- Run the retro for the current window
- Run the retro for the prior same-length window
- Present side-by-side metrics with arrows showing improvement/regression
- Brief narrative on biggest changes

---

## Important Rules

- **All times in local timezone.** Never set `TZ`.
- **Format for Telegram.** Use bullets and bold. Avoid markdown tables in the final output.
- **Praise anchored in commits.** Never say "great work" without naming what was good.
- **Growth areas anchored in data.** Never criticize without evidence.
- **Save history.** Every retro saves to `memory/` for trend tracking.
- **Completion status:**
  - DONE ... retro generated, history saved
  - DONE_WITH_CONCERNS ... generated but missing data (e.g., no prior retros for comparison)
  - BLOCKED ... not in a git repo or no commits in window
