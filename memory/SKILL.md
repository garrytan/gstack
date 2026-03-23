---
name: memory
version: 1.0.0
description: |
  Persistent session memory across Claude Code sessions. Indexes patterns, fixes,
  and lessons from past work so future sessions compound instead of starting from
  zero. Automatically hooks into /investigate, /review, /ship, and /solve.
  Use when asked to "remember this", "what did we fix before", "search memory",
  or "show patterns". Also triggered automatically by other skills.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
echo "PROACTIVE: $_PROACTIVE"
eval "$(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null || true)"
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
echo '{"skill":"memory","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done

# Memory-specific: count indexed knowledge
MEMORY_DIR="$HOME/.gstack/memory"
mkdir -p "$MEMORY_DIR"
PATTERN_COUNT=$(grep -c "^## Pattern:" "$MEMORY_DIR/patterns.md" 2>/dev/null || echo "0")
FIX_COUNT=$(grep -c "^## Fix:" "$MEMORY_DIR/fixes.md" 2>/dev/null || echo "0")
LESSON_COUNT=$(grep -c "^## Lesson:" "$MEMORY_DIR/lessons.md" 2>/dev/null || echo "0")

echo "MEMORY_DIR: $MEMORY_DIR"
echo "PATTERNS: $PATTERN_COUNT"
echo "FIXES: $FIX_COUNT"
echo "LESSONS: $LESSON_COUNT"
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills — only invoke
them when the user explicitly asks. The user opted out of proactive suggestions.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow".

If `LAKE_INTRO` is `no`: Before continuing, introduce the Completeness Principle.
Tell the user: "gstack follows the **Boil the Lake** principle — always do the complete
thing when AI makes the marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean"
Then run `touch ~/.gstack/.completeness-intro-seen` to mark as seen.

# /memory — Persistent Session Memory

You are a **knowledge curator** who makes every session smarter than the last.
Every bug found, fix shipped, and lesson learned gets indexed so future sessions
can retrieve it instantly.

## Arguments

- `/memory` — show memory stats and recent entries
- `/memory search <query>` — search across all memory for a pattern, fix, or lesson
- `/memory add pattern` — manually add a pattern (interactive)
- `/memory add lesson` — manually add a lesson learned
- `/memory import` — backfill from git history (one-time)
- `/memory prune` — remove outdated or low-quality entries

## Storage Format

Memory lives in `~/.gstack/memory/` as markdown files:

```
~/.gstack/memory/
  patterns.md    — Bug patterns (what goes wrong and why)
  fixes.md       — Fixes that worked (what we did and how)
  lessons.md     — Lessons learned (decisions, preferences, style)
  anti-patterns.md — Fixes that failed or were reverted
```

### patterns.md format

```markdown
## Pattern: [Short descriptive name]
**First seen:** [TICKET or PR] on [DATE]
**Seen again:** [TICKET, TICKET, ...] (updated each time)
**Domain:** [payment | auth | notifications | voice | ui | config | ...]
**Bug:** [One-line: what goes wrong]
**Root cause:** [One-line: why it happens]
**Detection:** [How to spot this pattern in code — grep pattern or code smell]
**Files:** [Common file patterns where this occurs]
**Tags:** [comma-separated searchable tags]
```

### fixes.md format

```markdown
## Fix: [TICKET] — [Short description]
**Date:** [DATE]
**PR:** #[NUMBER]
**Domain:** [domain]
**What broke:** [one line]
**What fixed it:** [one line]
**Diff summary:** [key changes — not the full diff, just the insight]
**Quality:** [merged_clean | had_review_feedback | was_reverted | caused_followup]
**Files:** [files modified]
**Tags:** [comma-separated]
```

### lessons.md format

```markdown
## Lesson: [Short name]
**Source:** [Who said it — user feedback, code review, prod incident]
**Date:** [DATE]
**Context:** [What happened]
**Rule:** [The lesson in one sentence]
**Tags:** [comma-separated]
```

### anti-patterns.md format

```markdown
## Anti-pattern: [Short name]
**Source:** [TICKET or PR that was reverted/failed]
**Date:** [DATE]
**What was tried:** [The fix that didn't work]
**Why it failed:** [Root cause of failure]
**Better approach:** [What should have been done instead]
**Tags:** [comma-separated]
```

## How Memory Is Used By Other Skills

### During /investigate
At the START of investigation, before reading any code:
```bash
if [ -f ~/.gstack/memory/patterns.md ]; then
  echo "🧠 Searching memory for related patterns..."
  grep -i -B 1 -A 8 "KEYWORD" ~/.gstack/memory/patterns.md 2>/dev/null || true
fi
```

If a match is found, cite it and apply the pattern:
> 💡 **Memory match:** Pattern "[NAME]" (seen in [TICKETS]).
> Root cause was [X]. Checking if same pattern applies here...

### During /review
Check if the diff introduces a known anti-pattern:
```bash
if [ -f ~/.gstack/memory/anti-patterns.md ]; then
  # Extract file paths from diff, search anti-patterns for matches
  grep -i "CHANGED_FILE_PATTERN" ~/.gstack/memory/anti-patterns.md 2>/dev/null || true
fi
```

### During /ship (Phase 6 — post-ship)
Append to fixes.md:
```bash
cat >> ~/.gstack/memory/fixes.md << EOF

## Fix: [IDENTIFIER] — [TITLE]
**Date:** $(date +%Y-%m-%d)
**PR:** #[NUMBER]
**Domain:** [domain]
**What broke:** [summary]
**What fixed it:** [summary]
**Diff summary:** [key insight]
**Quality:** merged_clean
**Files:** [files]
**Tags:** [tags]
EOF
```

### During /solve (Phase 6 — post-solve)
Append both a fix AND check if a new pattern emerged:
- If the same root cause was seen before → update the "Seen again" field
- If it's a new root cause → append a new pattern entry

## Commands

### `/memory search <query>`

Search all memory files for the query. Show matches with context:

```bash
MEMORY_DIR="$HOME/.gstack/memory"
echo "🔍 Searching memory for: $QUERY"
echo ""
for file in patterns.md fixes.md lessons.md anti-patterns.md; do
  if [ -f "$MEMORY_DIR/$file" ]; then
    MATCHES=$(grep -i -B 1 -A 8 "$QUERY" "$MEMORY_DIR/$file" 2>/dev/null)
    if [ -n "$MATCHES" ]; then
      echo "📁 $file:"
      echo "$MATCHES"
      echo "---"
    fi
  fi
done
```

Present results grouped by file, with the most relevant match highlighted.

### `/memory add pattern`

Interactive — ask for:
1. Short name
2. Domain
3. Bug description (one line)
4. Root cause (one line)
5. Detection method (grep pattern or code smell)
6. Tags

Then append to patterns.md.

### `/memory import`

One-time backfill from git history:

```bash
# Get last 6 months of merged PRs with their commit messages
git log --oneline --since="6 months ago" --merges --format="%h %s" |
  head -100
```

For each PR:
1. Extract the ticket ID from the title (e.g., `[RES-4662]`)
2. Read the commit message for context
3. Classify: is this a bug fix, feature, refactor, or chore?
4. For bug fixes: extract the pattern and add to patterns.md
5. Skip: docs changes, config changes, dependency updates

**Quality filter during import:**
- Check if the commit was reverted within 7 days → anti-pattern, not pattern
- Check if there was a follow-up fix on the same files within 48h → incomplete fix
- Only index commits that survived without follow-up issues

### `/memory prune`

Review entries and remove:
- Patterns that haven't been "seen again" in 6+ months
- Fixes for code that no longer exists (check if files still exist)
- Duplicate patterns (merge them)

### `/memory` (no args)

Show memory dashboard:

```
🧠 gstack Memory — [PROJECT]
━━━━━━━━━━━━━━━━━━━━
Patterns:  12 indexed (3 seen 2+ times)
Fixes:     47 indexed (oldest: 2024-09-15)
Lessons:    8 indexed
Anti-pats:  3 indexed

Top domains: notifications (8), payment (6), voice (4)
Last updated: 2024-03-23

Recent patterns:
  • "Operator Precedence in PHP Guards" (seen 3x)
  • "Missing Terminal Status Guard" (seen 2x)
  • "Null Check on Optional Relation" (seen 2x)
```

## Integration with conductor.json

Projects can configure memory behavior in `conductor.json`:

```json
{
  "memory": {
    "auto_index": true,
    "domains": ["payment", "auth", "voice", "notifications", "ui"],
    "exclude_paths": ["tests/", "docs/", "config/"],
    "quality_threshold": "merged_clean"
  }
}
```

## Philosophy

**Search Your Own History First.** Before investigating any bug, check if you've
seen this pattern before. The cost of checking is near-zero. The cost of
re-investigating from scratch is 10 minutes you'll never get back.

This extends gstack's "Search Before Building" principle from external knowledge
(Layer 1-3) to internal knowledge (Layer 0 — your own past work). Layer 0 is
the highest-confidence source because it's YOUR codebase, YOUR bugs, YOUR fixes.

Memory compounds. After 100 sessions, you've indexed 100 patterns. Session 101
starts with 100 patterns to search against. That's the difference between a tool
and a teammate.
