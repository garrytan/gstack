<!-- AUTO-GENERATED from report-format.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
Structure the output as:

---

**Tweetable summary** (first line, before everything else):
```
Week of Mar 1: 47 commits (3 contributors), 3.2k LOC, 38% tests, 12 PRs, peak: 10pm | Streak: 47d
```

## Engineering Retro: [date range]

### Summary Table
(from Step 2)

### Trends vs Last Retro
(from Step 12, loaded before save — skip if first retro)

### Time & Session Patterns
(from Steps 3-4)

Narrative interpreting what the team-wide patterns mean:
- When the most productive hours are and what drives them
- Whether sessions are getting longer or shorter over time
- Estimated hours per day of active coding (team aggregate)
- Notable patterns: do team members code at the same time or in shifts?

### Shipping Velocity
(from Steps 5-7)

Narrative covering:
- Commit type mix and what it reveals
- PR size distribution and what it reveals about shipping cadence
- Fix-chain detection (sequences of fix commits on the same subsystem)
- Version bump discipline

### Code Quality Signals
- Test LOC ratio trend
- Hotspot analysis (are the same files churning?)
- Greptile signal ratio and trend (if history exists): "Greptile: X% signal (Y valid catches, Z false positives)"

### Test Health
- Total test files: N (`TEST_FILES_TOTAL`)
- Tests added this period: M (`TEST_FILES_CHANGED` — test files changed in the window)
- Regression test commits: list the `REGRESSION_COMMIT` lines (`test(qa):`, `test(design):`, and `test: coverage` commits)
- If prior retro exists and has `test_health`: show delta "Test count: {last} → {now} (+{delta})"
- If test ratio < 20%: flag as growth area — "100% test coverage is the goal. Tests make vibe coding safe."

### Plan Completion
Check review JSONL logs for plan completion data from /ship runs this period:

```bash
setopt +o nomatch 2>/dev/null || true  # zsh compat
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
cat ~/.gstack/projects/$SLUG/*-reviews.jsonl 2>/dev/null | grep '"skill":"ship"' | grep '"plan_items_total"' || echo "NO_PLAN_DATA"
```

If plan completion data exists within the retro time window:
- Count branches shipped with plans (entries that have `plan_items_total` > 0)
- Compute average completion: sum of `plan_items_done` / sum of `plan_items_total`
- Identify most-skipped item category if data supports it

Output:
```
Plan Completion This Period:
  {N} branches shipped with plans
  Average completion: {X}% ({done}/{total} items)
```

If no plan data exists, skip this section silently.

### Focus & Highlights
(from Step 8)
- Focus score with interpretation
- Ship of the week callout

### Your Week (personal deep-dive)
(from Step 9, for the current user only)

This is the section the user cares most about. Include:
- Their personal commit count, LOC, test ratio
- Their session patterns and peak hours
- Their focus areas
- Their biggest ship
- **What you did well** (2-3 specific things anchored in commits)
- **Where to level up** (1-2 specific, actionable suggestions)

### Team Breakdown
(from Step 9, for each teammate — skip if solo repo)

For each teammate (sorted by commits descending), write a section:

#### [Name]
- **What they shipped**: 2-3 sentences on their contributions, areas of focus, and commit patterns
- **Praise**: 1-2 specific things they did well, anchored in actual commits. Be genuine — what would you actually say in a 1:1? Examples:
  - "Cleaned up the entire auth module in 3 small, reviewable PRs — textbook decomposition"
  - "Added integration tests for every new endpoint, not just happy paths"
  - "Fixed the N+1 query that was causing 2s load times on the dashboard"
- **Opportunity for growth**: 1 specific, constructive suggestion. Frame as investment, not criticism. Examples:
  - "Test coverage on the payment module is at 8% — worth investing in before the next feature lands on top of it"
  - "Most commits land in a single burst — spacing work across the day could reduce context-switching fatigue"
  - "All commits land between 1-4am — sustainable pace matters for code quality long-term"

**AI collaboration note:** If many commits have `Co-Authored-By` AI trailers (e.g., Claude, Copilot), note the AI-assisted commit percentage as a team metric. Frame it neutrally — "N% of commits were AI-assisted" — without judgment.

### Top 3 Team Wins
Identify the 3 highest-impact things shipped in the window across the whole team. For each:
- What it was
- Who shipped it
- Why it matters (product/architecture impact)

### 3 Things to Improve
Specific, actionable, anchored in actual commits. Mix personal and team-level suggestions. Phrase as "to get even better, the team could..."

### 3 Habits for Next Week
Small, practical, realistic. Each must be something that takes <5 minutes to adopt. At least one should be team-oriented (e.g., "review each other's PRs same-day").

### Week-over-Week Trends
(if applicable, from Step 10)
